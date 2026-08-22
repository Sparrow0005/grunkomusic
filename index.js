const fs = require('node:fs');
const { spawn } = require('node:child_process');
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

function ytdlpOptions() {
  return fs.existsSync(config.cookiesFilePath) ? { cookies: config.cookiesFilePath } : {};
}

async function resolveSong(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported URL');
  const info = await ytdlp(url, {
    dumpSingleJson: true,
    noPlaylist: true,
    noWarnings: true,
    ...ytdlpOptions(),
  });
  return { url, title: info.title || 'Unknown title' };
}

function createAudioPipeline(url) {
  const download = ytdlp.exec(url, {
    format: 'bestaudio/best',
    output: '-',
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    ...ytdlpOptions(),
  }, { stdio: ['ignore', 'pipe', 'pipe'] });

  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  download.stdout.pipe(ffmpeg.stdin);
  download.stderr.on('data', (data) => console.error(`yt-dlp: ${data.toString().trim()}`));
  ffmpeg.stderr.on('data', (data) => console.error(`ffmpeg: ${data.toString().trim()}`));
  download.on('error', (error) => ffmpeg.stdout.destroy(error));
  ffmpeg.on('error', (error) => ffmpeg.stdout.destroy(error));

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    download.stdout?.unpipe(ffmpeg.stdin);
    download.kill();
    ffmpeg.kill();
  };

  return { stream: ffmpeg.stdout, cleanup };
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
    state.current = pipeline;
    state.player.play(createAudioResource(pipeline.stream, { inputType: StreamType.Raw }));
    await logAndSend(state.textChannel, `🎶 Now playing: **${song.title}**`);
  } catch (error) {
    console.error('Could not start playback:', error);
    await logAndSend(state.textChannel, `There was an error trying to play **${song.title}**.`);
    finishCurrent(guildId);
  }
}

function finishCurrent(guildId) {
  const state = guildQueues.get(guildId);
  if (!state) return;
  state.current?.cleanup();
  state.current = null;
  state.playing = false;
  state.nowPlaying = null;
  setImmediate(() => playNext(guildId));
}

async function getOrCreateQueue(message) {
  const guildId = message.guild.id;
  let state = guildQueues.get(guildId);
  if (state) return state;

  const voiceChannel = message.member.voice.channel;
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (error) {
    connection.destroy();
    throw new Error('Discord voice connection did not become ready.', { cause: error });
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  state = {
    connection, player, songs: [], playing: false, nowPlaying: null,
    current: null, textChannel: message.channel, idleTimer: null,
  };
  player.on(AudioPlayerStatus.Idle, () => finishCurrent(guildId));
  player.on('error', (error) => {
    console.error('Playback error:', error);
    logAndSend(state.textChannel, 'There was an error trying to play the video.');
    finishCurrent(guildId);
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
    let song;
    try {
      song = await resolveSong(url);
    } catch (error) {
      console.error('Error processing video:', error);
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
    state.songs.push(song);
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
    return logAndReply(message, `Current Queue:\n${state.songs.map((song, i) => `${i + 1}. ${song.title}`).join('\n')}`);
  }

  if (command === 'playing' || command === 'np') {
    const song = guildQueues.get(message.guild.id)?.nowPlaying;
    if (!song) return logAndReply(message, 'No song is currently playing.');
    return logAndReply(message, `🎶 Now playing: **${song.title}**`);
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
      '`-help` or `-h` - Displays this help message');
  }
});

client.once('clientReady', () => console.log(`Logged in as ${client.user.tag}`));
client.on('error', (error) => console.error('Discord client error:', error));
process.on('SIGINT', () => { guildQueues.forEach((_, id) => destroyQueue(id)); client.destroy(); process.exit(0); });
process.on('SIGTERM', () => { guildQueues.forEach((_, id) => destroyQueue(id)); client.destroy(); process.exit(0); });

client.login(readToken()).catch((error) => {
  console.error('Discord login failed:', error.message);
  process.exitCode = 1;
});
