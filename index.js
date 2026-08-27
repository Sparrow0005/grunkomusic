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
const config = require('./config');

const prefix = '-';
const guildQueues = new Map();
const guildQueueInitializations = new Map();
let ytdlpUpdatePromise = null;

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

async function updateYtdlp(reason = 'scheduled maintenance', force = false) {
  const now = Date.now();
  if (!force && now - lastYtdlpUpdateAttempt < config.ytdlpUpdateCooldown) return false;
  if (ytdlpUpdatePromise) return ytdlpUpdatePromise;
  lastYtdlpUpdateAttempt = now;
  try {
    fs.writeFileSync(config.maintenanceStatePath, JSON.stringify({ lastYtdlpUpdateAttempt }, null, 2));
  } catch (error) {
    console.error('[RECOVERY] Could not persist yt-dlp maintenance state:', errorText(error));
  }
  console.log(`[RECOVERY] Checking yt-dlp for updates: ${reason}`);
  ytdlpUpdatePromise = ytdlp.exec('--update')
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

function logAndSend(channel, content) {
  console.log(`[BOT → ${channel?.guild?.name ?? 'Unknown'}#${channel?.name ?? 'Unknown'}] ${content}`);
  return channel.send(content).catch((error) => console.error('Could not send Discord message:', error));
}

function logAndReply(message, content) {
  console.log(`[BOT → ${message.guild?.name ?? 'Unknown'}#${message.channel?.name ?? 'Unknown'}] ${content}`);
  return message.reply(content).catch((error) => console.error('Could not reply in Discord:', error));
}

async function sendQueue(message, songs) {
  const pages = [];
  let page = 'Current Queue:\n';
  songs.forEach((song, index) => {
    const line = `${index + 1}. ${song.title}\n`;
    if (page.length + line.length > 1900) {
      pages.push(page.trimEnd());
      page = `Current Queue (continued):\n${line}`;
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
    ? pageSongs.map((song, index) => `**${firstIndex + index + 1}.** ${song.title}`).join('\n')
    : 'The queue is currently empty.';
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Current Queue')
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

function youtubeMusicAccessOptions(enabled = false) {
  if (!enabled) return {};
  return {
    jsRuntimes: `node:${process.execPath}`,
    remoteComponents: 'ejs:github',
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

function containsYouTubePlaylist(input) {
  try {
    const parsed = new URL(sanitizeUrlInput(input));
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(hostname) &&
      Boolean(parsed.searchParams.get('list'));
  } catch {
    return false;
  }
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
    retries: 3,
    fragmentRetries: 3,
    socketTimeout: 15,
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
  clearIdleTimer(state);
  state.current?.cleanup();
  state.player.stop(true);
  state.connection.destroy();
  guildQueues.delete(guildId);
}

function scheduleDisconnect(guildId) {
  const state = guildQueues.get(guildId);
  if (!state || state.idleTimer) return;
  state.idleTimer = setTimeout(() => destroyQueue(guildId), config.inactivityTimeout);
}

async function playNext(guildId) {
  const state = guildQueues.get(guildId);
  if (!state || state.playing) return;
  const song = state.songs.shift();
  if (!song) return scheduleDisconnect(guildId);

  clearIdleTimer(state);
  state.playing = true;
  state.nowPlaying = song;

  try {
    const pipeline = createAudioPipeline(song.url, song.requiresCookies, song.youtubeMusicFallback);
    const generation = Symbol('playback');
    state.current = { ...pipeline, generation };
    state.player.play(createAudioResource(pipeline.stream, {
      inputType: StreamType.Raw,
      metadata: { generation },
    }));
    await logAndSend(state.textChannel, `🎶 Now playing: **${song.title}**`);
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
  };
  player.on('stateChange', (oldState, newState) => {
    if (newState.status === AudioPlayerStatus.Playing) clearIdleTimer(state);
    if (newState.status === AudioPlayerStatus.Paused || newState.status === AudioPlayerStatus.AutoPaused) {
      scheduleDisconnect(guildId);
    }
    if (newState.status === AudioPlayerStatus.Idle && oldState.resource) {
      const generation = oldState.resource.metadata?.generation;
      if (state.recoveringGeneration !== generation) finishCurrent(guildId, generation);
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
    if (state.current?.usedCookies && isCookieError(error)) {
      markCookiesUnhealthy(error);
    }
    if (isPermanentMediaError(error) && !song.youtubeMusicFallbackAttempted) {
      song.youtubeMusicFallbackAttempted = true;
      song.youtubeMusicFallback = true;
      state.songs.unshift(song);
      await logAndSend(state.textChannel, `The standard stream for **${song.title}** is unavailable—trying YouTube Music access.`);
      finishRecovery();
      return;
    }
    if (isPermanentMediaError(error) && song.sourcePlaylist && !song.replacementAttempted) {
      song.replacementAttempted = true;
      const channelContext = song.sourceChannel ? ` from **${song.sourceChannel}**` : '';
      await logAndSend(state.textChannel, `The original upload for **${song.title}**${channelContext} is unavailable—searching for the same artist and song.`);
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
      logAndSend(state.textChannel, `Playback hiccup—retrying **${song.title}**.`);
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
    if (containsYouTubePlaylist(url)) {
      return logAndReply(message, 'That link contains a playlist. Use `-pl <URL>` or `-playlist <URL>` to queue it.');
    }
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
    await logAndReply(message, `Added to the queue: ${song.title}`);
    playNext(message.guild.id);
  }

  if (command === 'playlist' || command === 'pl') {
    if (!message.member.voice.channel) return logAndReply(message, 'You need to be in a voice channel to queue a playlist!');
    const url = args[0];
    if (!url) return logAndReply(message, 'You need to provide a YouTube playlist URL!');
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

    let state;
    try {
      state = await getOrCreateQueue(message);
    } catch (error) {
      console.error('Error connecting to voice for playlist:', error);
      return logAndReply(message, 'I joined, but Discord could not establish the audio connection. Please try again.');
    }

    const availableSlots = Math.max(0, config.maxQueueSize - state.songs.length);
    const songsToAdd = playlist.songs.slice(0, availableSlots);
    if (!songsToAdd.length) {
      const reason = availableSlots === 0 ? `The queue is full (${config.maxQueueSize} songs).` : 'I could not find any playable videos in that playlist.';
      return logAndReply(message, reason);
    }

    state.textChannel = message.channel;
    state.songs.push(...songsToAdd);
    const omitted = playlist.songs.length - songsToAdd.length;
    const suffix = omitted > 0 ? ` The queue limit left out ${omitted} song${omitted === 1 ? '' : 's'}.` : '';
    await logAndReply(message, `Added **${songsToAdd.length}** songs from **${playlist.title}**.${suffix}`);
    playNext(message.guild.id);
  }

  if (command === 'skip' || command === 's') {
    const state = guildQueues.get(message.guild.id);
    if (!state?.nowPlaying) return logAndReply(message, 'There is no song currently playing to skip!');
    const generation = state.current?.generation;
    state.current?.cleanup();
    state.player.stop(true);
    finishCurrent(message.guild.id, generation);
    return logAndReply(message, 'Skipping to the next song.');
  }

  if (command === 'leave' || command === 'l') {
    if (!guildQueues.has(message.guild.id)) return logAndReply(message, 'I am not in a voice channel.');
    destroyQueue(message.guild.id);
    return logAndReply(message, 'I have left the voice channel and cleared the queue!');
  }

  if (command === 'shuffle') {
    const state = guildQueues.get(message.guild.id);
    if (!state?.songs.length) return logAndReply(message, 'The queue is empty, nothing to shuffle.');
    for (let i = state.songs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.songs[i], state.songs[j]] = [state.songs[j], state.songs[i]];
    }
    return logAndReply(message, 'Queue shuffled!');
  }

  if (command === 'queue' || command === 'q') {
    const state = guildQueues.get(message.guild.id);
    if (!state?.songs.length) return logAndReply(message, 'The queue is currently empty.');
    if (state.songs.length > 10) {
      console.log(`[BOT → ${message.guild.name}#${message.channel.name}] Displaying paginated queue.`);
      return message.reply(buildQueueEmbed(message.guild.id, 0))
        .catch((error) => console.error('Could not send paginated queue:', error));
    }
    return sendQueue(message, state.songs);
  }

  if (command === 'playing' || command === 'np') {
    const song = guildQueues.get(message.guild.id)?.nowPlaying;
    if (!song) return logAndReply(message, 'No song is currently playing.');
    return logAndReply(message, `🎶 Now playing: **${song.title}**`);
  }

  if (command === 'health') {
    const status = cookieStatus();
    const cookieMessage = status === 'active'
      ? 'YouTube cookies are active.'
      : status === 'expired'
        ? 'YouTube cookies appear expired; public-video fallback is active.'
        : 'YouTube cookies are missing; public videos may still work.';
    return logAndReply(message, `Music systems are online. ${cookieMessage}`);
  }

  if (command === 'help' || command === 'h') {
    return logAndReply(message,
      '**Commands List:**\n' +
      '`-play <URL>` or `-p <URL>` - Plays the requested song\n' +
      '`-playlist <URL>` or `-pl <URL>` - Adds a YouTube playlist\n' +
      '`-skip` or `-s` - Skips the current song\n' +
      '`-leave` or `-l` - Disconnects bot from the voice channel\n' +
      '`-shuffle` - Shuffles the current queue\n' +
      '`-queue` or `-q` - Lists the current queue\n' +
      '`-playing` or `-np` - Displays the current song title\n' +
      '`-health` - Displays playback and YouTube cookie health\n' +
      '`-help` or `-h` - Displays this help message');
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith('queue:')) return;
  const match = /^queue:(\d+):(-?\d+)$/.exec(interaction.customId);
  if (!match || interaction.guildId !== match[1]) {
    return interaction.reply({ content: 'That queue control is no longer valid.', ephemeral: true });
  }
  const page = Number.parseInt(match[2], 10);
  try {
    await interaction.update(buildQueueEmbed(interaction.guildId, page));
  } catch (error) {
    console.error('Could not update paginated queue:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'I could not update that queue page.', ephemeral: true }).catch(() => {});
    }
  }
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateYtdlp('startup maintenance');
  setInterval(() => updateYtdlp('scheduled daily maintenance'), config.ytdlpUpdateInterval).unref();
});
client.on('error', (error) => console.error('Discord client error:', error));

function shutdown(code = 0) {
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
