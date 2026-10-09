const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ActivityType,
  Routes,
} = require('discord.js');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const ffmpegPath = require('ffmpeg-static');
const ytdlp = require('youtube-dl-exec');
const { getDetails: getSpotifyDetails, getPreview: getSpotifyPreview } = require('spotify-url-info')(fetch);
const config = require('./config');

const prefix = '-';
// Each guild owns an independent connection, player, queue, and recovery state.
const guildQueues = new Map();
const guildQueueInitializations = new Map();
let ytdlpUpdatePromise = null;
let presenceTimer = null;

function readLastYtdlpUpdateAttempt() {
  try {
    return JSON.parse(fs.readFileSync(config.maintenanceStatePath, 'utf8')).lastYtdlpUpdateAttempt || 0;
  } catch {
    return 0;
  }
}

let lastYtdlpUpdateAttempt = readLastYtdlpUpdateAttempt();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function errorText(error) {
  return [error?.message, error?.stderr, error?.cause?.message].filter(Boolean).join('\n');
}

function isExpectedPipeError(error) {
  return ['EPIPE', 'EOF', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error?.code) ||
    /write epipe|premature close|broken pipe/i.test(errorText(error));
}

function isPermanentMediaError(error) {
  return /private video|video unavailable|video is not available|removed by the uploader|copyright|members-only|unsupported url|invalid url/i.test(errorText(error));
}

function suggestsYtdlpUpdate(error) {
  return /signature|nsig|extractor|player response|requested format is not available|unable to extract/i.test(errorText(error));
}

function isCookieError(error) {
  return /cookie|log[ -]?in|sign in|authentication|account.*required|confirm you('| a)re not a bot|po token|page needs to be reloaded/i.test(errorText(error));
}

function isCookieRejectionError(error) {
  return /cookies? (?:are|is|have been) (?:expired|invalid|rejected)|invalid cookies?|expired cookies?|authentication cookies? (?:are|is|have been) (?:expired|invalid|rejected)|login session (?:has )?expired|session cookies? (?:are|is|have been) (?:expired|invalid|rejected)|sign in to confirm you('| a)re not a bot|confirm you('| a)re not a bot|page needs to be reloaded/i.test(errorText(error));
}

function cookieFileSignature() {
  try {
    const stat = fs.statSync(config.cookiesFilePath);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function readCookieHealth() {
  try {
    return JSON.parse(fs.readFileSync(config.cookieHealthStatePath, 'utf8'));
  } catch {
    return {};
  }
}

let cookieHealth = readCookieHealth();

function writeCookieHealth() {
  try {
    fs.writeFileSync(config.cookieHealthStatePath, JSON.stringify(cookieHealth, null, 2));
  } catch (error) {
    console.error('[RECOVERY] Could not persist cookie health:', errorText(error));
  }
}

function cookiesAreUsable() {
  const signature = cookieFileSignature();
  if (!signature) return false;
  if (cookieHealth.unhealthySignature && cookieHealth.unhealthySignature !== signature) {
    console.log('[RECOVERY] A replacement cookies.txt was detected; cookies are active again.');
    cookieHealth = {};
    writeCookieHealth();
  }
  return cookieHealth.unhealthySignature !== signature;
}

function cookieStatus() {
  if (!cookieFileSignature()) return 'missing';
  return cookiesAreUsable() ? 'active' : 'expired';
}

function markCookiesUnhealthy(error) {
  const signature = cookieFileSignature();
  if (!signature) return;
  cookieHealth.unhealthySignature = signature;
  cookieHealth.lastFailure = new Date().toISOString();
  cookieHealth.lastError = errorText(error).slice(0, 500);
  writeCookieHealth();
  console.error('[RECOVERY] cookies.txt appears expired or rejected; public playback will fall back to cookie-free mode.');
}

async function warnAboutExpiredCookies(message) {
  if (cookieStatus() !== 'expired') return;
  if (cookieHealth.lastWarningAt &&
      Date.now() - cookieHealth.lastWarningAt < config.cookieWarningCooldown) return;
  cookieHealth.lastWarningAt = Date.now();
  writeCookieHealth();
  await logAndReply(message, 'YouTube login cookies appear to be expired. I’ll still try public videos, but restricted videos need a refreshed `cookies.txt`.');
}

async function updateYtdlp(reason = 'scheduled maintenance') {
  const now = Date.now();
  if (now - lastYtdlpUpdateAttempt < config.ytdlpUpdateCooldown) return false;
  if (ytdlpUpdatePromise) return ytdlpUpdatePromise;
  lastYtdlpUpdateAttempt = now;
  try {
    fs.writeFileSync(config.maintenanceStatePath, JSON.stringify({ lastYtdlpUpdateAttempt }, null, 2));
  } catch (error) {
    console.error('[RECOVERY] Could not persist yt-dlp maintenance state:', errorText(error));
  }
  console.log(`[RECOVERY] Checking yt-dlp for updates: ${reason}`);
  ytdlpUpdatePromise = ytdlp.update()
    .then(() => {
      console.log('[RECOVERY] yt-dlp update check completed.');
      return true;
    })
    .catch((error) => {
      console.error('[RECOVERY] yt-dlp update failed; continuing with the installed version:', errorText(error));
      return false;
    })
    .finally(() => { ytdlpUpdatePromise = null; });
  return ytdlpUpdatePromise;
}

async function withRecovery(operation, { label, retries, allowYtdlpUpdate = false }) {
  let updated = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const permanent = isPermanentMediaError(error);
      console.error(`[RECOVERY] ${label} failed (attempt ${attempt + 1}/${retries + 1}, permanent=${permanent}):`, errorText(error));
      if (permanent || attempt >= retries) throw error;
      if (allowYtdlpUpdate && !updated && suggestsYtdlpUpdate(error)) {
        updated = await updateYtdlp(`${label} extractor failure`);
      }
      const delay = config.retryBaseDelay * (2 ** attempt);
      console.log(`[RECOVERY] Retrying ${label} in ${delay}ms.`);
      await sleep(delay);
    }
  }
}

function readToken() {
  if (process.env.DISCORD_TOKEN?.trim()) return process.env.DISCORD_TOKEN.trim();
  if (!fs.existsSync(config.tokenFilePath)) {
    throw new Error(`Discord token not found. Put it in ${config.tokenFilePath} or set DISCORD_TOKEN.`);
  }
  return fs.readFileSync(config.tokenFilePath, 'utf8').trim();
}

function themedContent(content) {
  if (typeof content !== 'string' || /^[🎶📻📜🔎🎛️⏭️👋🔀🩺⚠️🛠️🎵]/u.test(content)) return content;
  if (/retry|recover|searching|replacement|fallback|standard stream|ended early|hiccup/i.test(content)) {
    return `🛠️ ${content}`;
  }
  if (/error|couldn(?:'t| not)|cannot|can't|need|no song|not available|unavailable|expired|missing|invalid|timed out|cancelled|queue is full|already have|provide |that's not|there is no/i.test(content)) {
    return `⚠️ ${content}`;
  }
  return `🎵 ${content}`;
}

function logAndSend(channel, content) {
  const themed = themedContent(content);
  console.log(`[BOT → ${channel?.guild?.name ?? 'Unknown'}#${channel?.name ?? 'Unknown'}] ${themed}`);
  return channel.send(themed).catch((error) => console.error('Could not send Discord message:', error));
}

function logAndReply(message, content) {
  const themed = themedContent(content);
  console.log(`[BOT → ${message.guild?.name ?? 'Unknown'}#${message.channel?.name ?? 'Unknown'}] ${themed}`);
  return message.reply(themed).catch((error) => console.error('Could not reply in Discord:', error));
}

async function sendQueue(message, songs) {
  const pages = [];
  let page = '📜 **Grunko Queue**\n';
  songs.forEach((song, index) => {
    const line = `${index + 1}. ${song.title} -- (${formatDuration(song.duration)})\n`;
    if (page.length + line.length > 1900) {
      pages.push(page.trimEnd());
      page = `📜 **Grunko Queue -- continued**\n${line}`;
    } else {
      page += line;
    }
  });
  if (page.trim()) pages.push(page.trimEnd());
  await logAndReply(message, pages[0]);
  for (const continuation of pages.slice(1)) await logAndSend(message.channel, continuation);
}

function buildQueueEmbed(guildId, requestedPage = 0) {
  const songs = guildQueues.get(guildId)?.songs || [];
  const pageCount = Math.max(1, Math.ceil(songs.length / 10));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const firstIndex = page * 10;
  const pageSongs = songs.slice(firstIndex, firstIndex + 10);
  const description = pageSongs.length
    ? pageSongs.map((song, index) => `**${firstIndex + index + 1}.** ${song.title} -- \`${formatDuration(song.duration)}\``).join('\n')
    : 'No songs are waiting in the wings.';
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📜 Grunko Queue')
    .setDescription(description)
    .setFooter({ text: `Page ${page + 1} of ${pageCount} • ${songs.length} upcoming song${songs.length === 1 ? '' : 's'}` });

  if (pageCount === 1) return { embeds: [embed], components: [] };
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue:${guildId}:${page - 1}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`queue:${guildId}:${page + 1}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === pageCount - 1),
  );
  return { embeds: [embed], components: [row] };
}

function ytdlpOptions(useCookies = true) {
  return useCookies && cookiesAreUsable() ? { cookies: config.cookiesFilePath } : {};
}

function youtubeChallengeOptions() {
  return {
    jsRuntimes: `node:${process.execPath}`,
    remoteComponents: 'ejs:github',
  };
}

function youtubeMusicAccessOptions(enabled = false) {
  if (!enabled) return {};
  return {
    ...youtubeChallengeOptions(),
    extractorArgs: 'youtube:player_client=web_music',
  };
}

function sanitizeUrlInput(input) {
  let value = String(input || '').trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  value = value.replace(/^(?:\*\*|__|~~|`)+/, '').replace(/(?:\*\*|__|~~|`)+$/, '');
  return value;
}

function normalizeMediaUrl(input) {
  const parsed = new URL(sanitizeUrlInput(input));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported URL');

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const youtubeHosts = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'youtu.be']);
  if (!youtubeHosts.has(hostname)) return parsed.toString();

  let videoId = null;
  if (hostname === 'youtu.be') {
    videoId = parsed.pathname.split('/').filter(Boolean)[0];
  } else if (parsed.pathname === '/watch') {
    videoId = parsed.searchParams.get('v');
  } else {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (['shorts', 'live', 'embed'].includes(parts[0])) videoId = parts[1];
  }

  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error('Invalid YouTube video URL');
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function normalizePlaylistUrl(input) {
  const parsed = new URL(sanitizeUrlInput(input));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported URL');
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const youtubeHosts = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
  if (!youtubeHosts.has(hostname)) throw new Error('Playlists must be YouTube URLs');
  const playlistId = parsed.searchParams.get('list');
  if (!playlistId || !/^[A-Za-z0-9_-]{10,}$/.test(playlistId)) {
    throw new Error('Invalid YouTube playlist URL');
  }
  const seedVideoId = parsed.searchParams.get('v');
  if (playlistId.startsWith('RD') && seedVideoId && /^[A-Za-z0-9_-]{11}$/.test(seedVideoId)) {
    return `https://www.youtube.com/watch?v=${seedVideoId}&list=${playlistId}`;
  }
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}

function classifyYouTubePlaylistInput(input) {
  try {
    const sanitized = sanitizeUrlInput(input);
    const parsed = new URL(sanitized);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(hostname)) return 'none';
    if (!parsed.searchParams.get('list')) return 'none';

    const radioAtEnd = parsed.pathname === '/watch' && /[?&]start_radio=1(?:#.*)?$/i.test(sanitized);
    if (radioAtEnd) return 'radio';
    if (parsed.pathname === '/playlist') return 'playlist';

    const videoId = parsed.searchParams.get('v');
    if (parsed.pathname === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(videoId || '')) return 'ambiguous';
    return 'playlist';
  } catch {
    return 'none';
  }
}

function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '?:??';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatDuration(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? formatTimestamp(seconds) : 'unknown length';
}

function playbackElapsedSeconds(state) {
  const resourceElapsed = Number(state?.player?.state?.resource?.playbackDuration) / 1000;
  if (Number.isFinite(resourceElapsed) && resourceElapsed >= 0) return resourceElapsed;
  if (state?.current?.startedAt) return Math.max(0, (Date.now() - state.current.startedAt) / 1000);
  return 0;
}

function playbackProgress(state) {
  const elapsed = playbackElapsedSeconds(state);
  const total = Number(state?.nowPlaying?.duration) || null;
  const displayElapsed = total ? Math.min(elapsed, total) : elapsed;
  return `${formatTimestamp(displayElapsed)}/${total ? formatTimestamp(total) : '?:??'}`;
}

function updateVoiceChannelStatus(state, force = false) {
  if (!state?.voiceChannelId || !client.user) return;
  const suffix = state.nowPlaying ? ` -- (${playbackProgress(state)})` : '';
  const maxTitleLength = Math.max(1, 500 - '🎶 '.length - suffix.length);
  const title = state.nowPlaying?.title || '';
  const shortenedTitle = title.length > maxTitleLength
    ? `${title.slice(0, Math.max(1, maxTitleLength - 1))}…`
    : title;
  const status = state.nowPlaying ? `🎶 ${shortenedTitle}${suffix}` : null;
  const now = Date.now();
  if (status === state.voiceStatusTarget) return;
  if (status && !force && now - (state.voiceStatusLastAttempt || 0) < 30_000) return;
  state.voiceStatusLastAttempt = now;
  state.voiceStatusTarget = status;
  // Serialize status writes so a delayed song update cannot overwrite a later clear.
  state.voiceStatusPromise = (state.voiceStatusPromise || Promise.resolve())
    .then(() => client.rest.put(Routes.channelVoiceStatus(state.voiceChannelId), { body: { status } }))
    .then(() => {
      state.voiceStatusLastText = status;
      state.voiceStatusPermissionWarned = false;
    })
    .catch((error) => {
      if (state.voiceStatusTarget === status) state.voiceStatusTarget = state.voiceStatusLastText;
      if (!state.voiceStatusPermissionWarned) {
        console.error('[STATUS] Could not update voice channel status. Ensure the bot has Set Voice Channel Status permission:', errorText(error));
        state.voiceStatusPermissionWarned = true;
      }
    });
}

function updateBotPresence() {
  if (!client.user) return;
  // A bot has one global presence, so keep it private and show only an active-server count.
  const activeStates = [...guildQueues.values()]
    .filter((state) => state.nowPlaying)
    .sort((a, b) => (b.current?.startedAt || 0) - (a.current?.startedAt || 0));
  for (const state of activeStates) updateVoiceChannelStatus(state);
  if (!activeStates.length) {
    client.user.setActivity('requests | -help', { type: ActivityType.Listening });
    return;
  }
  const serverLabel = activeStates.length === 1 ? 'server' : 'servers';
  client.user.setActivity(`music in ${activeStates.length} ${serverLabel}`, { type: ActivityType.Playing });
}

function musicSearchScore(entry, index, query) {
  const title = String(entry.title || '').toLowerCase();
  const channel = String(entry.channel || entry.uploader || '').toLowerCase();
  const terms = normalizeSearchText(query).split(' ').filter((term) => term.length > 1);
  const matchingTerms = terms.filter((term) => title.includes(term) || channel.includes(term)).length;
  let score = 100 - index * 4 + matchingTerms * 5;
  if (/\s-\stopic$/.test(channel)) score += 18;
  if (/official (?:audio|video)|lyrics?|audio|music video|soundtrack/.test(title)) score += 10;
  if (Number(entry.duration) >= 60 && Number(entry.duration) <= 15 * 60) score += 4;
  if (/shorts?|clip|trailer|reaction/.test(title)) score -= 8;
  return score;
}

async function searchYouTube(query, resultLimit = 5) {
  const info = await withRecovery(() => ytdlp(`ytsearch12:${query}`, {
    dumpSingleJson: true,
    flatPlaylist: true,
    playlistEnd: 12,
    noWarnings: true,
    socketTimeout: 15,
    ...youtubeChallengeOptions(),
  }), { label: 'YouTube search', retries: config.metadataRetries, allowYtdlpUpdate: true });

  return (info.entries || [])
    .filter((entry) => entry?.id && /^[A-Za-z0-9_-]{11}$/.test(entry.id))
    .map((entry, index) => ({
      url: `https://www.youtube.com/watch?v=${entry.id}`,
      title: entry.title || 'Unknown title',
      sourceChannel: entry.channel || entry.uploader || 'Unknown channel',
      duration: Number(entry.duration) || null,
      score: musicSearchScore(entry, index, query),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(12, resultLimit)));
}

function extractSpotifyUrls(input) {
  const matches = String(input || '').match(/https?:\/\/open\.spotify\.com\/[^\s<>]+/gi) || [];
  const found = [];
  for (const match of matches) {
    try {
      const parsed = new URL(match.replace(/[),.;]+$/, ''));
      const parts = parsed.pathname.split('/').filter(Boolean);
      const typeIndex = parts.findIndex((part) => ['track', 'playlist'].includes(part.toLowerCase()));
      const type = typeIndex >= 0 ? parts[typeIndex].toLowerCase() : null;
      const id = typeIndex >= 0 ? parts[typeIndex + 1] : null;
      if (!type || !id || !/^[A-Za-z0-9]+$/.test(id)) continue;
      const url = `https://open.spotify.com/${type}/${id}`;
      if (!found.some((item) => item.url === url)) found.push({ type, url });
    } catch {
      // Ignore malformed URLs and let the command return a useful message.
    }
  }
  return found;
}

function spotifyTrackToQueueSong(track, playlistTitle = null) {
  const name = String(track.name || track.track || track.title || '').trim();
  const artist = String(track.artist || '').trim();
  if (!name) return null;
  return {
    title: artist ? `${artist} - ${name}` : name,
    spotifyQuery: [artist, name].filter(Boolean).join(' '),
    spotifyTrackName: name,
    spotifyArtist: artist,
    spotifyDuration: Number(track.duration || track.duration_ms) / 1000 || null,
    sourcePlaylist: playlistTitle,
    sourceChannel: artist || null,
    playbackAttempts: 0,
  };
}

function significantWords(value) {
  const ignored = new Set(['a', 'an', 'and', 'the', 'feat', 'featuring', 'ft', 'official', 'audio', 'video', 'lyrics', 'lyric']);
  return normalizeSearchText(value).split(' ').filter((word) => word.length > 1 && !ignored.has(word));
}

function wordCoverage(expected, actual) {
  const words = significantWords(expected);
  if (!words.length) return 0;
  const actualWords = new Set(significantWords(actual));
  return words.filter((word) => actualWords.has(word)).length / words.length;
}

function externalMatchDetails(song, candidate) {
  const title = normalizeSearchText(song.spotifyTrackName || song.appleMusicTrackName);
  const artist = normalizeSearchText(song.spotifyArtist || song.appleMusicArtist);
  const expectedDuration = song.spotifyDuration || song.appleMusicDuration;
  const candidateTitle = normalizeSearchText(candidate.title);
  const candidateChannel = normalizeSearchText(candidate.sourceChannel);
  const titleCoverage = wordCoverage(title, candidateTitle);
  const artistCoverage = artist ? wordCoverage(artist, `${candidateTitle} ${candidateChannel}`) : 1;
  const titleExact = Boolean(title && candidateTitle.includes(title));
  const durationDifference = expectedDuration && candidate.duration
    ? Math.abs(expectedDuration - candidate.duration)
    : null;
  const durationTolerance = expectedDuration ? Math.max(25, expectedDuration * 0.20) : null;
  const durationAcceptable = durationDifference === null || durationDifference <= durationTolerance;
  const titleAcceptable = titleExact || titleCoverage >= 0.75;
  const artistAcceptable = !artist || artistCoverage >= 0.5 || (titleExact && title.split(' ').length >= 2);
  const requestedVariant = /live|remix|cover|sped up|slowed/.test(title);
  const unwantedVariant = !requestedVariant && /live|remix|cover|sped up|slowed/.test(candidateTitle);
  let score = candidate.score || 0;
  score += titleCoverage * 70;
  score += artistCoverage * 45;
  if (titleExact) score += 35;
  if (/topic|official audio/.test(`${candidateChannel} ${candidateTitle}`)) score += 15;
  if (durationDifference !== null) score += Math.max(0, 25 - durationDifference / 2);
  if (unwantedVariant) score -= 25;
  return {
    accepted: titleAcceptable && artistAcceptable && durationAcceptable && !unwantedVariant,
    score,
    titleCoverage,
    artistCoverage,
    durationDifference,
    reason: !titleAcceptable ? 'title mismatch'
      : !artistAcceptable ? 'artist mismatch'
        : !durationAcceptable ? 'duration mismatch'
          : unwantedVariant ? 'unrequested version'
            : 'accepted',
  };
}

async function resolveExternalSong(song) {
  const artist = song.spotifyArtist || song.appleMusicArtist;
  const title = song.spotifyTrackName || song.appleMusicTrackName;
  const queries = [
    `${artist} ${title} official audio`,
    `"${title}" "${artist}"`,
    `${artist} ${title}`,
  ].filter((query, index, all) => query.trim() && all.indexOf(query) === index);
  const candidatesByUrl = new Map();
  for (const query of queries) {
    const results = await searchYouTube(query, 12);
    for (const candidate of results) {
      const existing = candidatesByUrl.get(candidate.url);
      if (!existing || candidate.score > existing.score) candidatesByUrl.set(candidate.url, candidate);
    }
  }
  const candidates = [...candidatesByUrl.values()]
    .map((candidate) => ({ candidate, match: externalMatchDetails(song, candidate) }))
    .sort((a, b) => b.match.score - a.match.score);
  const sourceName = song.spotifyQuery ? 'SPOTIFY' : 'APPLE MUSIC';
  const rejected = candidates.filter(({ match }) => !match.accepted);
  if (rejected.length) {
    console.log(`[${sourceName}] Rejected ${rejected.length} candidate(s) for ${song.title}: ` +
      rejected.slice(0, 5).map(({ candidate, match }) => `${candidate.title} (${match.reason})`).join('; '));
  }
  let lastError;
  for (const { candidate, match } of candidates) {
    if (!match.accepted) continue;
    try {
      const resolved = await resolveSong(candidate.url);
      return {
        ...song,
        ...resolved,
        sourcePlaylist: song.sourcePlaylist,
        sourceChannel: artist || resolved.sourceChannel,
        metadataValidated: true,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`No playable YouTube match found for ${song.title}`);
}

function extractAppleMusicUrls(input) {
  const matches = String(input || '').match(/https?:\/\/(?:music\.)?apple\.com\/[^\s<>]+/gi) || [];
  const found = [];
  for (const match of matches) {
    try {
      const parsed = new URL(match.replace(/[),.;]+$/, ''));
      if (parsed.hostname.toLowerCase() !== 'music.apple.com') continue;
      const path = parsed.pathname.toLowerCase();
      let type = null;
      if (path.includes('/playlist/')) type = 'playlist';
      else if (path.includes('/song/') || (path.includes('/album/') && parsed.searchParams.get('i'))) type = 'track';
      if (!type) continue;
      parsed.hash = '';
      const url = parsed.toString();
      if (!found.some((item) => item.url === url)) found.push({ type, url });
    } catch {
      // Ignore malformed URLs and let the command return a useful message.
    }
  }
  return found;
}

function isoDurationToSeconds(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function scriptJson(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Apple Music page is missing ${marker}`);
  const start = html.indexOf('>', markerIndex) + 1;
  const end = html.indexOf('</script>', start);
  if (!start || end < 0) throw new Error(`Apple Music page has invalid ${marker}`);
  return JSON.parse(html.slice(start, end));
}

async function fetchAppleMusicPage(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'music.apple.com') {
    throw new Error('Unsupported Apple Music URL');
  }
  const response = await fetch(parsed, {
    headers: { 'user-agent': 'Mozilla/5.0 GrunkoMusicBot/2.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Apple Music returned HTTP ${response.status}`);
  const html = await response.text();
  if (html.length > 10_000_000) throw new Error('Apple Music response was unexpectedly large');
  return html;
}

function appleMusicTrackToQueueSong(track, playlistTitle = null) {
  const name = String(track.name || track.title || '').trim();
  const artist = String(track.artist || track.artistName || '').trim();
  if (!name) return null;
  return {
    title: artist ? `${artist} - ${name}` : name,
    appleMusicQuery: [artist, name].filter(Boolean).join(' '),
    appleMusicTrackName: name,
    appleMusicArtist: artist,
    appleMusicDuration: Number(track.duration) || null,
    sourcePlaylist: playlistTitle,
    sourceChannel: artist || null,
    playbackAttempts: 0,
  };
}

async function readAppleMusic(url, type) {
  const html = await fetchAppleMusicPage(url);
  if (type === 'track') {
    const structured = scriptJson(html, 'application/ld+json');
    const recording = structured.audio?.['@type'] === 'MusicRecording' ? structured.audio : structured;
    const artists = recording.byArtist || recording.inAlbum?.byArtist || [];
    return {
      type,
      title: recording.name || structured.name,
      artist: artists.map((artist) => artist.name).filter(Boolean).join(', '),
      duration: isoDurationToSeconds(recording.duration || structured.timeRequired),
    };
  }

  const serverData = scriptJson(html, 'serialized-server-data');
  const tracks = [];
  const seen = new Set();
  let playlistTitle = null;
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (!playlistTitle && value.contentDescriptor?.kind === 'playlist' && value.title) {
      playlistTitle = String(value.title).trim();
    }
    if (value.contentDescriptor?.kind === 'song' && value.title && value.artistName) {
      const id = value.contentDescriptor.identifiers?.storeAdamID || value.contentDescriptor.url || `${value.artistName}:${value.title}`;
      if (!seen.has(id)) {
        seen.add(id);
        tracks.push({ title: value.title, artist: value.artistName, duration: Number(value.duration) / 1000 || null });
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(serverData);
  if (!playlistTitle) {
    try {
      playlistTitle = scriptJson(html, 'application/ld+json').name;
    } catch {
      // Some valid Apple Music playlist pages omit JSON-LD.
    }
  }
  return { type, title: playlistTitle || 'Apple Music playlist', tracks };
}

async function resolvePlaylist(url, maxEntries) {
  const normalizedUrl = normalizePlaylistUrl(url);
  const cookiesAvailable = cookiesAreUsable();
  const lookup = (useCookies) => withRecovery(() => ytdlp(normalizedUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      playlistEnd: maxEntries,
      noWarnings: true,
      socketTimeout: 15,
      ...youtubeChallengeOptions(),
      ...ytdlpOptions(useCookies),
    }), { label: 'YouTube playlist lookup', retries: config.metadataRetries, allowYtdlpUpdate: true });

  let info;
  let requiresCookies = false;
  try {
    info = await lookup(false);
  } catch (error) {
    if (!cookiesAvailable || !isCookieError(error)) throw error;
    console.log('[RECOVERY] Playlist needs authentication; retrying with cookies.');
    try {
      info = await lookup(true);
      requiresCookies = true;
    } catch (cookieError) {
      if (isCookieError(cookieError)) markCookiesUnhealthy(cookieError);
      throw cookieError;
    }
  }

  const songs = (info.entries || [])
    .filter((entry) => entry?.id && /^[A-Za-z0-9_-]{11}$/.test(entry.id))
    .filter((entry) => !/\[(private|deleted) video\]/i.test(entry.title || ''))
    .slice(0, maxEntries)
    .map((entry) => ({
      url: `https://www.youtube.com/watch?v=${entry.id}`,
      title: entry.title || 'Unknown title',
      duration: Number(entry.duration) || null,
      playbackAttempts: 0,
      requiresCookies,
      sourcePlaylist: info.title || null,
      sourceChannel: entry.channel || entry.uploader || null,
      youtubeMusicFallback: /\s*-\s*Topic\s*$/i.test(entry.channel || entry.uploader || ''),
      youtubeMusicFallbackAttempted: /\s*-\s*Topic\s*$/i.test(entry.channel || entry.uploader || ''),
    }));

  return { title: info.title || 'YouTube playlist', songs };
}

async function resolveSong(url) {
  const normalizedUrl = normalizeMediaUrl(url);
  const cookiesAvailable = cookiesAreUsable();
  const lookup = (useCookies, useYouTubeMusic = false) => withRecovery(() => ytdlp(normalizedUrl, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true,
      socketTimeout: 15,
      ...(useYouTubeMusic ? { format: 'bestaudio/best' } : {}),
      ...youtubeChallengeOptions(),
      ...youtubeMusicAccessOptions(useYouTubeMusic),
      ...ytdlpOptions(useCookies),
    }), { label: 'YouTube metadata lookup', retries: config.metadataRetries, allowYtdlpUpdate: true });
  let info;
  let requiresCookies = false;
  let youtubeMusicFallback = false;
  let triedYouTubeMusic = false;
  try {
    info = await lookup(false);
  } catch (error) {
    if (isPermanentMediaError(error)) {
      triedYouTubeMusic = true;
      try {
        console.log('[RECOVERY] Standard YouTube access unavailable; trying the YouTube Music client.');
        info = await lookup(false, true);
        youtubeMusicFallback = true;
      } catch (musicError) {
        error = musicError;
      }
    }
    if (!info) {
      if (!cookiesAvailable || !isCookieError(error)) throw error;
      console.log('[RECOVERY] Video needs authentication; retrying with cookies.');
      try {
        info = await lookup(true, triedYouTubeMusic);
        requiresCookies = true;
        youtubeMusicFallback = triedYouTubeMusic;
      } catch (cookieError) {
        if (isCookieError(cookieError)) markCookiesUnhealthy(cookieError);
        throw cookieError;
      }
    }
  }
  return {
    url: normalizedUrl,
    title: info.title || 'Unknown title',
    duration: Number(info.duration) || null,
    sourceChannel: info.channel || info.uploader || null,
    requiresCookies,
    youtubeMusicFallback,
    youtubeMusicFallbackAttempted: youtubeMusicFallback,
  };
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s*-\s*topic\s*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isContextualReplacement(song, candidate) {
  const targetTitle = normalizeSearchText(song.title);
  const candidateTitle = normalizeSearchText(candidate.title);
  if (!targetTitle || !candidateTitle.includes(targetTitle)) return false;

  const sourceArtist = normalizeSearchText(song.sourceChannel);
  if (!sourceArtist) return true;
  const candidateArtist = normalizeSearchText(candidate.sourceChannel);
  return candidateArtist.includes(sourceArtist) || candidateTitle.includes(sourceArtist);
}

async function findPlayableReplacement(song) {
  const originalId = new URL(song.url).searchParams.get('v');
  const sourceArtist = String(song.sourceChannel || '').replace(/\s*-\s*Topic\s*$/i, '').trim();
  const context = [song.title, sourceArtist, song.sourcePlaylist].filter(Boolean).join(' ');
  let search;
  try {
    search = await withRecovery(() => ytdlp(`ytsearch10:${context}`, {
      dumpSingleJson: true,
      flatPlaylist: true,
      playlistEnd: 10,
      noWarnings: true,
      socketTimeout: 15,
    }), { label: 'replacement search', retries: 1, allowYtdlpUpdate: true });
  } catch (error) {
    console.error('[RECOVERY] Replacement search failed:', errorText(error));
    return null;
  }

  for (const entry of (search.entries || []).slice(0, 10)) {
    if (!entry?.id || entry.id === originalId || !/^[A-Za-z0-9_-]{11}$/.test(entry.id)) continue;
    const searchCandidate = {
      title: entry.title || '',
      sourceChannel: entry.channel || entry.uploader || null,
    };
    if (!isContextualReplacement(song, searchCandidate)) continue;
    try {
      const replacement = await resolveSong(`https://www.youtube.com/watch?v=${entry.id}`);
      if (replacement.duration && replacement.duration > 20 * 60) continue;
      if (!isContextualReplacement(song, replacement)) continue;
      return { ...replacement, playbackAttempts: 0, replacementAttempted: true };
    } catch (error) {
      console.error(`[RECOVERY] Replacement candidate ${entry.id} was not playable:`, errorText(error));
    }
  }
  return null;
}

function createAudioPipeline(url, requiresCookies = false, youtubeMusicFallback = false) {
  let intentionalShutdown = false;
  let downloadErrors = '';
  let ffmpegErrors = '';
  const output = new PassThrough();
  const usedCookies = requiresCookies && cookiesAreUsable();
  const download = ytdlp.exec(url, {
    format: 'bestaudio/best',
    output: '-',
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    retries: config.downloadRetries,
    fragmentRetries: config.downloadRetries,
    fileAccessRetries: config.downloadRetries,
    retrySleep: 'http:linear=1::5',
    socketTimeout: 15,
    ...youtubeChallengeOptions(),
    ...youtubeMusicAccessOptions(youtubeMusicFallback),
    ...ytdlpOptions(usedCookies),
  }, { stdio: ['ignore', 'pipe', 'pipe'] });
  download.catch((error) => {
    if (intentionalShutdown) {
      console.log('[RECOVERY] Expected yt-dlp termination during playback cleanup.');
      return;
    }
    output.destroy(new Error(`yt-dlp process failed: ${errorText(error).slice(0, 2000)}`));
  });

  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  download.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(output);
  const handlePipeError = (label) => (error) => {
    if (intentionalShutdown || isExpectedPipeError(error)) {
      console.log(`[RECOVERY] Expected ${label} pipe closure.`);
      return;
    }
    output.destroy(new Error(`${label} pipe failed: ${errorText(error).slice(0, 2000)}`));
  };
  download.stdout.on('error', handlePipeError('yt-dlp stdout'));
  ffmpeg.stdin.on('error', handlePipeError('FFmpeg stdin'));
  ffmpeg.stdout.on('error', handlePipeError('FFmpeg stdout'));
  download.stderr.on('data', (data) => {
    downloadErrors = `${downloadErrors}${data}`.slice(-8000);
    console.error(`yt-dlp: ${data.toString().trim()}`);
  });
  ffmpeg.stderr.on('data', (data) => {
    ffmpegErrors = `${ffmpegErrors}${data}`.slice(-8000);
    console.error(`ffmpeg: ${data.toString().trim()}`);
  });
  download.on('error', (error) => { if (!intentionalShutdown) output.destroy(error); });
  ffmpeg.on('error', (error) => { if (!intentionalShutdown) output.destroy(error); });
  download.on('close', (code) => {
    if (!intentionalShutdown && code !== 0) {
      output.destroy(new Error(`yt-dlp exited with code ${code}: ${downloadErrors}`));
    }
  });
  ffmpeg.on('close', (code) => {
    if (!intentionalShutdown && code !== 0) {
      output.destroy(new Error(`FFmpeg exited with code ${code}: ${ffmpegErrors}`));
    }
  });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    intentionalShutdown = true;
    download.stdout?.unpipe(ffmpeg.stdin);
    ffmpeg.stdout?.unpipe(output);
    output.destroy();
    download.kill();
    ffmpeg.kill();
  };

  return { stream: output, cleanup, usedCookies };
}

function clearIdleTimer(state) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

function destroyQueue(guildId) {
  const state = guildQueues.get(guildId);
  if (!state) return;
  state.shuttingDown = true;
  if (state.current) state.current.intentionalStop = true;
  clearIdleTimer(state);
  state.current?.cleanup();
  state.player.stop(true);
  state.connection.destroy();
  state.nowPlaying = null;
  updateVoiceChannelStatus(state, true);
  guildQueues.delete(guildId);
  updateBotPresence();
}

function scheduleDisconnect(guildId) {
  const state = guildQueues.get(guildId);
  if (!state || state.idleTimer) return;
  state.idleTimer = setTimeout(() => destroyQueue(guildId), config.inactivityTimeout);
}

async function playNext(guildId) {
  const state = guildQueues.get(guildId);
  if (!state || state.playing) return;
  let song = state.songs.shift();
  if (!song) return scheduleDisconnect(guildId);

  clearIdleTimer(state);
  state.playing = true;
  state.nowPlaying = song;

  try {
    if ((song.spotifyQuery || song.appleMusicQuery) && !song.metadataValidated) {
      try {
        const externalTitle = song.title;
        const sourceName = song.spotifyQuery ? 'SPOTIFY' : 'APPLE MUSIC';
        song = await resolveExternalSong(song);
        state.nowPlaying = song;
        console.log(`[${sourceName}] Resolved ${externalTitle} to ${song.title}.`);
      } catch (error) {
        const sourceName = song.spotifyQuery ? 'Spotify' : 'Apple Music';
        console.error(`[${sourceName.toUpperCase()}] Could not resolve ${song.title}:`, errorText(error));
        await logAndSend(state.textChannel, `I couldn't find a playable match for ${sourceName} track **${song.title}**, so I'm skipping it.`);
        state.playing = false;
        state.nowPlaying = null;
        setImmediate(() => playNext(guildId));
        return;
      }
    }
    if (song.sourcePlaylist && !song.metadataValidated) {
      try {
        const resolved = await resolveSong(song.url);
        song = {
          ...song,
          ...resolved,
          sourcePlaylist: song.sourcePlaylist,
          sourceChannel: resolved.sourceChannel || song.sourceChannel,
          metadataValidated: true,
        };
        state.nowPlaying = song;
      } catch (error) {
        console.error(`[RECOVERY] Playlist entry validation failed for ${song.title}:`, errorText(error));
        if (!song.replacementAttempted) {
          song.replacementAttempted = true;
          const replacement = await findPlayableReplacement(song);
          if (replacement) {
            state.songs.unshift({ ...replacement, metadataValidated: true });
            await logAndSend(state.textChannel, `The original **${song.title}** is unavailable. Found a playable replacement: **${replacement.title}**.`);
          } else {
            await logAndSend(state.textChannel, `The playlist entry **${song.title}** is unavailable, so I'm skipping it.`);
          }
        }
        state.playing = false;
        state.nowPlaying = null;
        setImmediate(() => playNext(guildId));
        return;
      }
    }
    const pipeline = createAudioPipeline(song.url, song.requiresCookies, song.youtubeMusicFallback);
    const generation = Symbol('playback');
    state.current = { ...pipeline, generation, startedAt: Date.now(), intentionalStop: false };
    state.player.play(createAudioResource(pipeline.stream, {
      inputType: StreamType.Raw,
      metadata: { generation },
    }));
    updateVoiceChannelStatus(state, true);
    updateBotPresence();
    await logAndSend(state.textChannel, `🎶 **Grunko is playing:** ${song.title} -- \`${playbackProgress(state)}\``);
  } catch (error) {
    console.error('Could not start playback:', error);
    await logAndSend(state.textChannel, `There was an error trying to play **${song.title}**.`);
    finishCurrent(guildId);
  }
}

function finishCurrent(guildId, generation = null) {
  const state = guildQueues.get(guildId);
  if (!state) return;
  if (generation && state.current?.generation !== generation) return;
  state.current?.cleanup();
  state.current = null;
  state.playing = false;
  state.nowPlaying = null;
  updateVoiceChannelStatus(state, true);
  updateBotPresence();
  setImmediate(() => playNext(guildId));
}

async function initializeQueue(message) {
  const guildId = message.guild.id;
  let state = guildQueues.get(guildId);
  if (state) return state;

  const voiceChannel = message.member.voice.channel;
  let connection;
  for (let attempt = 0; attempt <= config.voiceConnectionRetries; attempt++) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      break;
    } catch (error) {
      connection.destroy();
      console.error(`[RECOVERY] Voice connection failed (attempt ${attempt + 1}/${config.voiceConnectionRetries + 1}):`, errorText(error));
      if (attempt >= config.voiceConnectionRetries) {
        throw new Error('Discord voice connection did not become ready.', { cause: error });
      }
      await sleep(config.retryBaseDelay * (attempt + 1));
    }
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  state = {
    connection, player, songs: [], playing: false, nowPlaying: null,
    current: null, textChannel: message.channel, idleTimer: null,
    voiceChannelId: voiceChannel.id, voiceStatusLastText: null, voiceStatusTarget: null,
    voiceStatusLastAttempt: 0, voiceStatusPromise: Promise.resolve(),
  };
  player.on('stateChange', (oldState, newState) => {
    if (newState.status === AudioPlayerStatus.Playing) clearIdleTimer(state);
    if (newState.status === AudioPlayerStatus.Paused || newState.status === AudioPlayerStatus.AutoPaused) {
      scheduleDisconnect(guildId);
    }
    if (newState.status === AudioPlayerStatus.Idle && oldState.resource) {
      const generation = oldState.resource.metadata?.generation;
      if (state.recoveringGeneration === generation) return;
      const current = state.current;
      const song = state.nowPlaying;
      const elapsedSeconds = current?.startedAt ? (Date.now() - current.startedAt) / 1000 : null;
      const endedEarly = !state.shuttingDown && !current?.intentionalStop && song?.duration && elapsedSeconds !== null &&
        elapsedSeconds < song.duration - Math.max(15, song.duration * 0.05);
      if (endedEarly && (song.playbackAttempts || 0) < config.playbackRetries) {
        song.playbackAttempts = (song.playbackAttempts || 0) + 1;
        state.songs.unshift(song);
        console.error(`[RECOVERY] Stream for ${song.title} ended after ${elapsedSeconds.toFixed(1)}s of ${song.duration}s; retrying (${song.playbackAttempts}/${config.playbackRetries}).`);
        logAndSend(state.textChannel, `Playback ended early--retrying **${song.title}**.`);
      } else if (elapsedSeconds !== null) {
        console.log(`[PLAYBACK] ${song?.title || 'Unknown title'} ended after ${elapsedSeconds.toFixed(1)}s${song?.duration ? ` (expected ${song.duration}s)` : ''}.`);
      }
      finishCurrent(guildId, generation);
    }
  });
  player.on('error', async (error) => {
    console.error('Playback error:', errorText(error).slice(0, 4000));
    const generation = error.resource?.metadata?.generation;
    if (generation && state.current?.generation !== generation) return;
    const song = state.nowPlaying;
    if (!song) return finishCurrent(guildId, generation);
    state.recoveringGeneration = generation;
    const finishRecovery = () => {
      if (state.recoveringGeneration === generation) state.recoveringGeneration = null;
      finishCurrent(guildId, generation);
    };
    if (!state.current?.usedCookies && isCookieError(error) && cookiesAreUsable() && !song.cookieFallbackAttempted) {
      song.cookieFallbackAttempted = true;
      song.requiresCookies = true;
      state.songs.unshift(song);
      console.log(`[RECOVERY] ${song.title} needs authentication; retrying playback with cookies.`);
      finishRecovery();
      return;
    }
    if (state.current?.usedCookies && isCookieRejectionError(error)) {
      markCookiesUnhealthy(error);
    }
    if (isPermanentMediaError(error) && !song.youtubeMusicFallbackAttempted) {
      song.youtubeMusicFallbackAttempted = true;
      song.youtubeMusicFallback = true;
      state.songs.unshift(song);
      await logAndSend(state.textChannel, `The standard stream for **${song.title}** is unavailable--trying YouTube Music access.`);
      finishRecovery();
      return;
    }
    if (isPermanentMediaError(error) && song.sourcePlaylist && !song.replacementAttempted) {
      song.replacementAttempted = true;
      const channelContext = song.sourceChannel ? ` from **${song.sourceChannel}**` : '';
      await logAndSend(state.textChannel, `The original upload for **${song.title}**${channelContext} is unavailable--searching for the same artist and song.`);
      const replacement = await findPlayableReplacement(song);
      if (guildQueues.get(guildId) !== state || state.current?.generation !== generation) return;
      if (replacement) {
        state.songs.unshift(replacement);
        await logAndSend(state.textChannel, `Found a playable replacement: **${replacement.title}**.`);
      } else {
        await logAndSend(state.textChannel, `I couldn't find a playable replacement for **${song.title}**, so I'm skipping it.`);
      }
      finishRecovery();
      return;
    }
    song.playbackAttempts = (song.playbackAttempts || 0) + 1;
    if (!isPermanentMediaError(error) && song.playbackAttempts <= config.playbackRetries) {
      console.log(`[RECOVERY] Re-queueing ${song.title} after playback failure (${song.playbackAttempts}/${config.playbackRetries}).`);
      state.songs.unshift(song);
      logAndSend(state.textChannel, `Playback hiccup--retrying **${song.title}**.`);
      if (suggestsYtdlpUpdate(error)) updateYtdlp('playback extractor failure');
    } else {
      logAndSend(state.textChannel, `I couldn't recover **${song.title}**, so I'm skipping it.`);
    }
    finishRecovery();
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyQueue(guildId);
    }
  });
  connection.subscribe(player);
  guildQueues.set(guildId, state);
  return state;
}

async function getOrCreateQueue(message) {
  const guildId = message.guild.id;
  const existing = guildQueues.get(guildId);
  if (existing) return existing;
  const pending = guildQueueInitializations.get(guildId);
  if (pending) return pending;

  const initialization = initializeQueue(message).finally(() => {
    if (guildQueueInitializations.get(guildId) === initialization) {
      guildQueueInitializations.delete(guildId);
    }
  });
  guildQueueInitializations.set(guildId, initialization);
  return initialization;
}

const activePrompts = new Set();

function waitForUserChoice(message, validChoices, timeoutMs = 45_000) {
  const allowed = new Set(validChoices.map((choice) => String(choice).toLowerCase()));
  return new Promise((resolve) => {
    let settled = false;
    const collector = message.channel.createMessageCollector({
      filter: (reply) => reply.author.id === message.author.id && !reply.author.bot,
      time: timeoutMs,
    });
    collector.on('collect', (reply) => {
      const choice = reply.content.trim().toLowerCase();
      if (!allowed.has(choice)) {
        reply.reply(`Choose ${validChoices.join(', ')}.`).catch(() => {});
        return;
      }
      settled = true;
      collector.stop('selected');
      resolve(choice);
    });
    collector.on('end', () => {
      if (!settled) resolve(null);
    });
  });
}

async function enqueueSong(message, song) {
  let state;
  try {
    state = await getOrCreateQueue(message);
  } catch (error) {
    console.error('Error connecting to voice:', error);
    return logAndReply(message, 'I joined, but Discord could not establish the audio connection. Please try again.');
  }

  state.textChannel = message.channel;
  if (state.songs.length >= config.maxQueueSize) {
    return logAndReply(message, `The queue is full (${config.maxQueueSize} songs). Try again later.`);
  }
  state.songs.push({ ...song, playbackAttempts: 0 });
  await logAndReply(message, `📻 **Queued:** ${song.title} -- \`${formatDuration(song.duration)}\``);
  playNext(message.guild.id);
}

async function enqueueSongBatch(message, songs, title, label = 'Playlist') {
  let state;
  try {
    state = await getOrCreateQueue(message);
  } catch (error) {
    console.error(`Error connecting to voice for ${label}:`, error);
    return logAndReply(message, 'I joined, but Discord could not establish the audio connection. Please try again.');
  }

  const availableSlots = Math.max(0, config.maxQueueSize - state.songs.length);
  const songsToAdd = songs.slice(0, availableSlots);
  if (!songsToAdd.length) {
    const reason = availableSlots === 0
      ? `The queue is full (${config.maxQueueSize} songs).`
      : `I could not find any playable songs in that ${label.toLowerCase()}.`;
    return logAndReply(message, reason);
  }

  state.textChannel = message.channel;
  state.songs.push(...songsToAdd);
  const omitted = songs.length - songsToAdd.length;
  const suffix = omitted > 0 ? ` The queue limit left out ${omitted} song${omitted === 1 ? '' : 's'}.` : '';
  await logAndReply(message, `📻 **${label} queued:** ${songsToAdd.length} songs from **${title}**.${suffix}`);
  playNext(message.guild.id);
}

async function handleSongRequest(message, url) {
  await warnAboutExpiredCookies(message);
  let song;
  try {
    song = await resolveSong(url);
    await warnAboutExpiredCookies(message);
  } catch (error) {
    console.error('Error processing video:', error);
    if (isCookieError(error) && cookieStatus() !== 'active') {
      return logAndReply(message, `This video needs YouTube login, but the bot's cookies are ${cookieStatus()}. A fresh \`cookies.txt\` is required.`);
    }
    return logAndReply(message, 'There was an error trying to play the video.');
  }
  return enqueueSong(message, song);
}

async function handlePlaylistRequest(message, url) {
  await warnAboutExpiredCookies(message);
  let playlist;
  try {
    playlist = await resolvePlaylist(url, config.maxQueueSize);
    await warnAboutExpiredCookies(message);
  } catch (error) {
    console.error('Error processing playlist:', error);
    if (isCookieError(error) && cookieStatus() !== 'active') {
      return logAndReply(message, `This playlist needs YouTube login, but the bot's cookies are ${cookieStatus()}. A fresh \`cookies.txt\` is required.`);
    }
    return logAndReply(message, 'There was an error trying to queue the playlist.');
  }

  return enqueueSongBatch(message, playlist.songs, playlist.title);
}

async function handleSearchRequest(message, query) {
  const promptKey = `${message.guild.id}:${message.author.id}`;
  if (activePrompts.has(promptKey)) {
    return logAndReply(message, 'You already have a selection waiting. Reply with a number or `x` first.');
  }
  activePrompts.add(promptKey);
  try {
    let results;
    try {
      results = await searchYouTube(query);
    } catch (error) {
      console.error('Error searching YouTube:', error);
      return logAndReply(message, 'There was an error searching YouTube.');
    }
    if (!results.length) return logAndReply(message, 'I could not find any results for that search.');

    const choices = results.map((result, index) =>
      `**${index + 1}. ${result.title}** -- ${result.sourceChannel} -- ${formatDuration(result.duration)}`,
    ).join('\n');
    await logAndReply(message, `🔎 **Choose a tune:** reply with **1-5**, or reply **x** to cancel.\n${choices}`);
    const choice = await waitForUserChoice(message, ['1', '2', '3', '4', '5', 'x']);
    if (!choice) return logAndReply(message, 'Search timed out and was cancelled.');
    if (choice === 'x') return logAndReply(message, 'Search cancelled.');
    const selected = results[Number(choice) - 1];
    if (!selected) return logAndReply(message, 'That result is not available.');
    return handleSongRequest(message, selected.url);
  } finally {
    activePrompts.delete(promptKey);
  }
}

async function handleSpotifyRequest(message, input) {
  const urls = extractSpotifyUrls(input);
  const trackUrl = urls.find((item) => item.type === 'track');
  const playlistUrl = urls.find((item) => item.type === 'playlist');
  if (!trackUrl && !playlistUrl) {
    return logAndReply(message, 'Provide a Spotify track or playlist URL after `-spotify`.');
  }

  let selected = trackUrl || playlistUrl;
  if (trackUrl && playlistUrl) {
    const promptKey = `${message.guild.id}:${message.author.id}`;
    if (activePrompts.has(promptKey)) {
      return logAndReply(message, 'You already have a selection waiting. Reply to it first.');
    }
    activePrompts.add(promptKey);
    let choice;
    try {
      await logAndReply(message,
        '🎛️ **Spotify choice:** reply **s** for the song, **p** for the playlist, or **x** to cancel.');
      choice = await waitForUserChoice(message, ['s', 'p', 'x']);
    } finally {
      activePrompts.delete(promptKey);
    }
    if (!choice) return logAndReply(message, 'Spotify choice timed out and was cancelled.');
    if (choice === 'x') return logAndReply(message, 'Spotify request cancelled.');
    selected = choice === 's' ? trackUrl : playlistUrl;
  }

  if (selected.type === 'track') {
    let preview;
    try {
      preview = await withRecovery(() => getSpotifyPreview(selected.url), {
        label: 'Spotify track lookup', retries: config.metadataRetries,
      });
    } catch (error) {
      console.error('Error processing Spotify track:', error);
      return logAndReply(message, 'There was an error reading that Spotify track.');
    }
    const song = spotifyTrackToQueueSong({
      name: preview.track || preview.title,
      artist: preview.artist,
      duration: preview.duration,
    });
    if (!song) return logAndReply(message, 'I could not read the title from that Spotify track.');
    return enqueueSong(message, song);
  }

  let details;
  try {
    details = await withRecovery(() => getSpotifyDetails(selected.url), {
      label: 'Spotify playlist lookup', retries: config.metadataRetries,
    });
  } catch (error) {
    console.error('Error processing Spotify playlist:', error);
    return logAndReply(message, 'There was an error reading that Spotify playlist.');
  }

  const playlistTitle = details.preview?.title || 'Spotify playlist';
  const spotifySongs = (details.tracks || [])
    .map((track) => spotifyTrackToQueueSong(track, playlistTitle))
    .filter(Boolean)
    .slice(0, config.maxQueueSize);
  if (!spotifySongs.length) return logAndReply(message, 'I could not find any tracks in that Spotify playlist.');

  return enqueueSongBatch(message, spotifySongs, playlistTitle, 'Spotify playlist');
}

async function handleAppleMusicRequest(message, input) {
  const urls = extractAppleMusicUrls(input);
  const trackUrl = urls.find((item) => item.type === 'track');
  const playlistUrl = urls.find((item) => item.type === 'playlist');
  if (!trackUrl && !playlistUrl) {
    return logAndReply(message, 'Provide an Apple Music song or playlist URL after `-applemusic`.');
  }

  let selected = trackUrl || playlistUrl;
  if (trackUrl && playlistUrl) {
    const promptKey = `${message.guild.id}:${message.author.id}`;
    if (activePrompts.has(promptKey)) return logAndReply(message, 'You already have a selection waiting. Reply to it first.');
    activePrompts.add(promptKey);
    let choice;
    try {
      await logAndReply(message,
        '🎛️ **Apple Music choice:** reply **s** for the song, **p** for the playlist, or **x** to cancel.');
      choice = await waitForUserChoice(message, ['s', 'p', 'x']);
    } finally {
      activePrompts.delete(promptKey);
    }
    if (!choice) return logAndReply(message, 'Apple Music choice timed out and was cancelled.');
    if (choice === 'x') return logAndReply(message, 'Apple Music request cancelled.');
    selected = choice === 's' ? trackUrl : playlistUrl;
  }

  let details;
  try {
    details = await withRecovery(() => readAppleMusic(selected.url, selected.type), {
      label: 'Apple Music lookup', retries: config.metadataRetries,
    });
  } catch (error) {
    console.error('Error processing Apple Music link:', error);
    return logAndReply(message, `There was an error reading that Apple Music ${selected.type === 'track' ? 'song' : 'playlist'}.`);
  }

  if (selected.type === 'track') {
    const song = appleMusicTrackToQueueSong(details);
    if (!song) return logAndReply(message, 'I could not read the title from that Apple Music song.');
    return enqueueSong(message, song);
  }

  const appleSongs = details.tracks
    .map((track) => appleMusicTrackToQueueSong(track, details.title))
    .filter(Boolean)
    .slice(0, config.maxQueueSize);
  if (!appleSongs.length) return logAndReply(message, 'I could not find any tracks in that Apple Music playlist.');

  return enqueueSongBatch(message, appleSongs, details.title, 'Apple Music playlist');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot || !message.content.startsWith(prefix)) return;
  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  if (command === 'play' || command === 'p') {
    if (!message.member.voice.channel) return logAndReply(message, 'You need to be in a voice channel to play music!');
    const url = args[0];
    if (!url) return logAndReply(message, 'You need to provide a YouTube URL to play a song!');
    let parsedInput;
    try {
      parsedInput = new URL(sanitizeUrlInput(url));
      if (!['http:', 'https:'].includes(parsedInput.protocol)) throw new Error('Unsupported protocol');
    } catch {
      return logAndReply(message, "That's not a link. If you're trying to search with plain text, please use `-search <words>`.");
    }
    if (parsedInput.hostname.toLowerCase() === 'open.spotify.com') {
      return logAndReply(message, 'That is a Spotify link. Use `-spotify <URL>` to queue Spotify songs or playlists.');
    }
    if (parsedInput.hostname.toLowerCase() === 'music.apple.com') {
      return logAndReply(message, 'That is an Apple Music link. Use `-applemusic <URL>` to queue Apple Music songs or playlists.');
    }
    const playlistType = classifyYouTubePlaylistInput(url);
    if (playlistType === 'playlist') {
      return logAndReply(message, 'That link contains a playlist. Use `-pl <URL>` or `-playlist <URL>` to queue it.');
    }
    if (playlistType === 'ambiguous') {
      const promptKey = `${message.guild.id}:${message.author.id}`;
      if (activePrompts.has(promptKey)) {
        return logAndReply(message, 'You already have a selection waiting. Reply to it first.');
      }
      activePrompts.add(promptKey);
      let choice;
      try {
        await logAndReply(message,
          '🎛️ **Pick what Grunko should play:** reply **p** for the whole playlist, **s** for only this song, or **x** to cancel.');
        choice = await waitForUserChoice(message, ['p', 's', 'x']);
      } finally {
        activePrompts.delete(promptKey);
      }
      if (!choice) return logAndReply(message, 'Playlist choice timed out and was cancelled.');
      if (choice === 'x') return logAndReply(message, 'Request cancelled.');
      if (choice === 'p') return handlePlaylistRequest(message, url);
    }
    return handleSongRequest(message, url);
  }

  if (command === 'playlist' || command === 'pl') {
    if (!message.member.voice.channel) return logAndReply(message, 'You need to be in a voice channel to queue a playlist!');
    const url = args[0];
    if (!url) return logAndReply(message, 'You need to provide a YouTube playlist URL!');
    return handlePlaylistRequest(message, url);
  }

  if (command === 'search') {
    if (!message.member.voice.channel) return logAndReply(message, 'You need to be in a voice channel to search for music!');
    const query = args.join(' ').trim();
    if (!query) return logAndReply(message, 'You need to provide something to search for!');
    return handleSearchRequest(message, query);
  }

  if (command === 'spotify') {
    if (!message.member.voice.channel) return logAndReply(message, 'You need to be in a voice channel to queue Spotify music!');
    const input = args.join(' ').trim();
    if (!input) return logAndReply(message, 'Provide a Spotify track or playlist URL after `-spotify`.');
    return handleSpotifyRequest(message, input);
  }

  if (command === 'applemusic' || command === 'apple') {
    if (!message.member.voice.channel) return logAndReply(message, 'You need to be in a voice channel to queue Apple Music!');
    const input = args.join(' ').trim();
    if (!input) return logAndReply(message, 'Provide an Apple Music song or playlist URL after `-applemusic`.');
    return handleAppleMusicRequest(message, input);
  }

  if (command === 'skip' || command === 's') {
    const state = guildQueues.get(message.guild.id);
    if (!state?.nowPlaying) return logAndReply(message, 'There is no song currently playing to skip!');
    const generation = state.current?.generation;
    if (state.current) state.current.intentionalStop = true;
    state.current?.cleanup();
    state.player.stop(true);
    finishCurrent(message.guild.id, generation);
    return logAndReply(message, '⏭️ **Skipping:** bringing up the next song.');
  }

  if (command === 'leave' || command === 'l') {
    if (!guildQueues.has(message.guild.id)) return logAndReply(message, 'I am not in a voice channel.');
    destroyQueue(message.guild.id);
    return logAndReply(message, '👋 **Grunko has left the stage:** voice disconnected and queue cleared.');
  }

  if (command === 'shuffle') {
    const state = guildQueues.get(message.guild.id);
    if (!state?.songs.length) return logAndReply(message, '📜 **Grunko Queue:** nothing is waiting to be shuffled.');
    for (let i = state.songs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.songs[i], state.songs[j]] = [state.songs[j], state.songs[i]];
    }
    return logAndReply(message, '🔀 **Grunko Queue shuffled!**');
  }

  if (command === 'queue' || command === 'q') {
    const state = guildQueues.get(message.guild.id);
    if (!state?.songs.length) return logAndReply(message, '📜 **Grunko Queue:** no songs are waiting in the wings.');
    if (state.songs.length > 10) {
      console.log(`[BOT → ${message.guild.name}#${message.channel.name}] Displaying paginated queue.`);
      return message.reply(buildQueueEmbed(message.guild.id, 0))
        .catch((error) => console.error('Could not send paginated queue:', error));
    }
    return sendQueue(message, state.songs);
  }

  if (command === 'playing' || command === 'np') {
    const state = guildQueues.get(message.guild.id);
    const song = state?.nowPlaying;
    if (!song) return logAndReply(message, '🎶 **Grunko is quiet:** no song is currently playing.');
    return logAndReply(message, `🎶 **Grunko is playing:** ${song.title} -- \`${playbackProgress(state)}\``);
  }

  if (command === 'health') {
    const status = cookieStatus();
    const cookieMessage = status === 'active'
      ? 'YouTube cookies are active.'
      : status === 'expired'
        ? 'YouTube cookies appear expired; public-video fallback is active.'
        : 'YouTube cookies are missing; public videos may still work.';
    return logAndReply(message, `🩺 **Grunko health:** music systems are online. ${cookieMessage}`);
  }

  if (command === 'help' || command === 'h') {
    return logAndReply(message,
      '🎛️ **Grunko Music Commands**\n' +
      '`-play <URL>` or `-p <URL>` - Plays the requested song\n' +
      '`-search <words>` - Searches YouTube and offers five choices\n' +
      '`-spotify <URL>` - Queues a Spotify song or playlist\n' +
      '`-applemusic <URL>` or `-apple <URL>` - Queues an Apple Music song or playlist\n' +
      '`-playlist <URL>` or `-pl <URL>` - Adds a YouTube playlist\n' +
      '`-skip` or `-s` - Skips the current song\n' +
      '`-leave` or `-l` - Disconnects bot from the voice channel\n' +
      '`-shuffle` - Shuffles the current queue\n' +
      '`-queue` or `-q` - Lists the current queue\n' +
      '`-playing` or `-np` - Displays the current song and playback timestamp\n' +
      '`-health` - Displays playback and YouTube cookie health\n' +
      '`-help` or `-h` - Displays this help message');
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith('queue:')) return;
  const match = /^queue:(\d+):(-?\d+)$/.exec(interaction.customId);
  if (!match || interaction.guildId !== match[1]) {
    return interaction.reply({ content: '📜 That Grunko Queue control is no longer valid.', ephemeral: true });
  }
  const page = Number.parseInt(match[2], 10);
  try {
    await interaction.update(buildQueueEmbed(interaction.guildId, page));
  } catch (error) {
    console.error('Could not update paginated queue:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '⚠️ Grunko could not update that queue page.', ephemeral: true }).catch(() => {});
    }
  }
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateBotPresence();
  presenceTimer = setInterval(updateBotPresence, 15_000);
  presenceTimer.unref();
  updateYtdlp('startup maintenance');
  setInterval(() => updateYtdlp('scheduled daily maintenance'), config.ytdlpUpdateInterval).unref();
});
client.on('error', (error) => console.error('Discord client error:', error));

function shutdown(code = 0) {
  if (presenceTimer) clearInterval(presenceTimer);
  guildQueues.forEach((_, id) => destroyQueue(id));
  client.destroy();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (error) => {
  if (isExpectedPipeError(error)) {
    console.log(`[RECOVERY] Contained an expected pipe closure: ${errorText(error)}`);
    return;
  }
  console.error('[FATAL] Uncaught exception; watchdog will restart the bot:', error);
  shutdown(1);
});
process.on('unhandledRejection', (error) => {
  console.error('[FATAL] Unhandled rejection; watchdog will restart the bot:', error);
  shutdown(1);
});

client.login(readToken()).catch((error) => {
  console.error('Discord login failed:', error.message);
  process.exitCode = 1;
});
