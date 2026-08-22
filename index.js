const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { Client, GatewayIntentBits } = require('discord.js');
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

function isPermanentMediaError(error) {
  return /private video|video unavailable|removed by the uploader|copyright|members-only|sign in to confirm your age|unsupported url|invalid url/i.test(errorText(error));
}

function suggestsYtdlpUpdate(error) {
  return /signature|nsig|extractor|player response|requested format is not available|unable to extract/i.test(errorText(error));
}

function isCookieError(error) {
  return /cookie|log[ -]?in|sign in|authentication|account.*required|confirm you('| a)re not a bot|po token/i.test(errorText(error));
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

function ytdlpOptions(useCookies = true) {
  return useCookies && cookiesAreUsable() ? { cookies: config.cookiesFilePath } : {};
}

async function resolveSong(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported URL');
  const usedCookies = cookiesAreUsable();
  const lookup = (useCookies) => withRecovery(() => ytdlp(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true,
      socketTimeout: 15,
      ...ytdlpOptions(useCookies),
    }), { label: 'YouTube metadata lookup', retries: config.metadataRetries, allowYtdlpUpdate: true });
  let info;
  try {
    info = await lookup(usedCookies);
  } catch (error) {
    if (!usedCookies || !isCookieError(error)) throw error;
    markCookiesUnhealthy(error);
    console.log('[RECOVERY] Retrying metadata lookup without cookies.');
    info = await lookup(false);
  }
  return { url, title: info.title || 'Unknown title' };
}

function createAudioPipeline(url) {
  let intentionalShutdown = false;
  let downloadErrors = '';
  let ffmpegErrors = '';
  const output = new PassThrough();
  const usedCookies = cookiesAreUsable();
  const download = ytdlp.exec(url, {
    format: 'bestaudio/best',
    output: '-',
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    retries: 3,
    fragmentRetries: 3,
    socketTimeout: 15,
    ...ytdlpOptions(usedCookies),
  }, { stdio: ['ignore', 'pipe', 'pipe'] });

  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  download.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(output);
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
    const pipeline = createAudioPipeline(song.url);
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
      finishCurrent(guildId, oldState.resource.metadata?.generation);
    }
  });
  player.on('error', (error) => {
    console.error('Playback error:', error);
    const generation = error.resource?.metadata?.generation;
    if (generation && state.current?.generation !== generation) return;
    const song = state.nowPlaying;
    if (!song) return finishCurrent(guildId, generation);
    if (state.current?.usedCookies && isCookieError(error)) {
      markCookiesUnhealthy(error);
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
    finishCurrent(guildId, generation);
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

  if (command === 'skip' || command === 's') {
    const state = guildQueues.get(message.guild.id);
    if (!state?.nowPlaying) return logAndReply(message, 'There is no song currently playing to skip!');
    state.current?.cleanup();
    state.player.stop(true);
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
      '`-skip` or `-s` - Skips the current song\n' +
      '`-leave` or `-l` - Disconnects bot from the voice channel\n' +
      '`-shuffle` - Shuffles the current queue\n' +
      '`-queue` or `-q` - Lists the current queue\n' +
      '`-playing` or `-np` - Displays the current song title\n' +
      '`-health` - Displays playback and YouTube cookie health\n' +
      '`-help` or `-h` - Displays this help message');
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
