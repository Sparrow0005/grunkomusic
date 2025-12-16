const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const fs = require('fs');
const config = require('./config');

const token = fs.readFileSync(config.tokenFilePath, 'utf8').trim();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const prefix = '-';
const queue = new Map();
let currentPlaying = null;

const PLAYBACK_COOLDOWN = 2000;
const INACTIVITY_TIMEOUT = config.inactivityTimeout;
const inactivityTimeouts = new Map();

/**
 * Logs and sends a message to a channel.
 *
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {string} content
 * @returns {Promise<import('discord.js').Message>}
 */
function logAndSend(channel, content) {
  const guildName = channel?.guild?.name ?? 'DM/UnknownGuild';
  const channelName = channel?.name ?? 'UnknownChannel';
  console.log(`[BOT → ${guildName}#${channelName}] ${content}`);
  return channel.send(content);
}

/**
 * Logs and replies to a message.
 *
 * @param {import('discord.js').Message} message
 * @param {string} content
 * @returns {Promise<import('discord.js').Message>}
 */
function logAndReply(message, content) {
  const guildName = message?.guild?.name ?? 'DM/UnknownGuild';
  const channelName = message?.channel?.name ?? 'UnknownChannel';
  console.log(`[BOT → ${guildName}#${channelName}] ${content}`);
  return message.reply(content);
}

/**
 * Checks whether an error is expected when a stream is intentionally stopped
 * (e.g., skip/leave/stop).
 *
 * @param {any} err
 * @returns {boolean}
 */
function isNonCriticalPipeError(err) {
  if (!err) return false;
  const code = err.code || '';
  const msg = String(err.message || '');
  return (
    code === 'EOF' ||
    code === 'EPIPE' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    msg.includes('write EOF') ||
    msg.includes('Premature close')
  );
}

/**
 * Safely kills a child process without throwing.
 *
 * @param {import('child_process').ChildProcess | null | undefined} proc
 * @param {NodeJS.Signals} [signal='SIGKILL']
 * @returns {void}
 */
function safeKill(proc, signal = 'SIGKILL') {
  try {
    if (proc && !proc.killed) proc.kill(signal);
  } catch (_) {}
}

/**
 * Creates a raw PCM (s16le 48kHz stereo) audio stream using yt-dlp -> ffmpeg.
 *
 * @param {string} url
 * @returns {{ stream: import('stream').Readable, cleanup: () => void }}
 */
function createStream(url) {
  const ytdlp = spawn(
    'yt-dlp',
    [
      '-f',
      'bestaudio[ext=m4a]/bestaudio/best',
      '-o',
      '-',
      '--quiet',
      '--no-warnings',
      '--cookies',
      config.cookiesFilePath,
      '--extractor-args',
      'youtube:player_client=android',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );

  const ffmpeg = spawn(
    'ffmpeg',
    ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);

  /**
   * Builds an error handler that suppresses expected pipe errors.
   *
   * @param {string} label
   * @returns {(err: any) => void}
   */
  const ignoreIfExpected = (label) => (err) => {
    if (isNonCriticalPipeError(err)) {
      console.log(`Non-critical ${label} (ignored): ${err.message || err}`);
      return;
    }
    console.error(`${label}:`, err);
  };

  ytdlp.stderr.on('data', (data) => {
    const msg = data.toString();
    if (
      msg.includes('ERROR') ||
      msg.includes('nsig') ||
      msg.includes('Requested format') ||
      msg.includes('failed')
    ) {
      console.error(`yt-dlp: ${msg.trim()}`);
    }
  });

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString();
    if (
      msg.includes('Error') ||
      msg.includes('Invalid') ||
      msg.includes('failed') ||
      msg.includes('Could not')
    ) {
      console.error(`ffmpeg: ${msg.trim()}`);
    }
  });

  ytdlp.on('error', ignoreIfExpected('yt-dlp process error'));
  ffmpeg.on('error', ignoreIfExpected('ffmpeg process error'));

  // Stream-level handlers prevent "write EOF" from becoming an uncaught exception on skip/stop.
  ffmpeg.stdin.on('error', ignoreIfExpected('ffmpeg stdin pipe error'));
  ffmpeg.stdout.on('error', ignoreIfExpected('ffmpeg stdout pipe error'));
  ytdlp.stdout.on('error', ignoreIfExpected('yt-dlp stdout pipe error'));

  ytdlp.on('close', () => {
    try {
      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
    } catch (_) {}
  });

  ffmpeg.on('close', () => {
    safeKill(ytdlp, 'SIGKILL');
  });

  /**
   * Stops piping and tears down the pipeline immediately.
   *
   * @returns {void}
   */
  const cleanup = () => {
    try {
      ytdlp.stdout?.unpipe(ffmpeg.stdin);
    } catch (_) {}

    try {
      ffmpeg.stdin?.destroy();
    } catch (_) {}

    try {
      ffmpeg.stdout?.destroy();
    } catch (_) {}

    try {
      ytdlp.stdout?.destroy();
    } catch (_) {}

    safeKill(ffmpeg, 'SIGKILL');
    safeKill(ytdlp, 'SIGKILL');
  };

  return { stream: ffmpeg.stdout, cleanup };
}

/**
 * Starts the inactivity timeout for a guild (no-op if already running).
 *
 * @param {string} guildId
 * @returns {void}
 */
const startInactivityTimeout = (guildId) => {
  if (inactivityTimeouts.has(guildId)) return;

  inactivityTimeouts.set(
    guildId,
    setTimeout(() => {
      const serverQueue = queue.get(guildId);
      if (!serverQueue) return;

      try {
        serverQueue.current?.cleanup?.();
      } catch (_) {}
      serverQueue.connection.destroy();
      queue.delete(guildId);
    }, INACTIVITY_TIMEOUT)
  );
};

/**
 * Clears the inactivity timeout for a guild.
 *
 * @param {string} guildId
 * @returns {void}
 */
const clearInactivityTimeout = (guildId) => {
  const timeout = inactivityTimeouts.get(guildId);
  if (!timeout) return;
  clearTimeout(timeout);
  inactivityTimeouts.delete(guildId);
};

/**
 * Plays the next song in the guild queue.
 *
 * @param {string} guildId
 * @returns {Promise<void>}
 */
const playNextInQueue = async (guildId) => {
  const serverQueue = queue.get(guildId);
  if (!serverQueue || serverQueue.songs.length === 0) {
    startInactivityTimeout(guildId);
    return;
  }

  try {
    serverQueue.current?.cleanup?.();
  } catch (_) {}
  serverQueue.current = null;

  clearInactivityTimeout(guildId);

  const song = serverQueue.songs.shift();

  try {
    const { stream, cleanup } = createStream(song.url);
    serverQueue.current = { cleanup };

    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    serverQueue.player.play(resource);
    serverQueue.connection.subscribe(serverQueue.player);

    serverQueue.playing = true;
    currentPlaying = song.title;

    setTimeout(() => {
      logAndSend(serverQueue.textChannel, `🎶 Now playing: **${song.title}**`);
    }, PLAYBACK_COOLDOWN);

    serverQueue.player.once(AudioPlayerStatus.Idle, () => {
      serverQueue.playing = false;

      try {
        serverQueue.current?.cleanup?.();
      } catch (_) {}
      serverQueue.current = null;

      playNextInQueue(guildId);
    });

    serverQueue.player.once('error', (error) => {
      if (isNonCriticalPipeError(error)) {
        console.log(`Non-critical playback error (ignored): ${error.message || error}`);
      } else {
        console.error('Playback error:', error);
      }

      serverQueue.playing = false;

      try {
        serverQueue.current?.cleanup?.();
      } catch (_) {}
      serverQueue.current = null;

      playNextInQueue(guildId);
    });
  } catch (error) {
    console.error('Error playing audio stream:', error);

    serverQueue.playing = false;

    try {
      serverQueue.current?.cleanup?.();
    } catch (_) {}
    serverQueue.current = null;

    playNextInQueue(guildId);
  }
};

/**
 * Fetches a video's title using yt-dlp.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
const fetchSongTitle = (url) =>
  new Promise((resolve, reject) => {
    const ytDlpProcess = spawn(
      'yt-dlp',
      ['--get-title', '--cookies', config.cookiesFilePath, url],
      { windowsHide: true }
    );

    let title = '';
    ytDlpProcess.stdout.on('data', (data) => {
      title += data.toString();
    });

    ytDlpProcess.stderr.on('data', (error) => {
      const msg = error.toString();
      if (msg.includes('ERROR') || msg.includes('failed')) {
        console.error(`yt-dlp: ${msg.trim()}`);
      }
    });

    ytDlpProcess.on('close', (code) => {
      if (code === 0) return resolve(title.trim());
      reject(new Error('Failed to fetch song title.'));
    });
  });

/**
 * Handles errors and attempts a recovery (yt-dlp update + PM2 restart).
 * Expected pipe errors are ignored.
 *
 * @param {any} error
 * @returns {void}
 */
const handleCriticalError = (error) => {
  if (isNonCriticalPipeError(error)) {
    console.log(`Non-critical pipe error (ignored): ${error.message || error}`);
    return;
  }

  console.error('Critical error:', error);
  queue.forEach(({ textChannel }) => {
    logAndSend(textChannel, 'Encountered an error. Attempting to fix.');
  });

  const updateProcess = spawn('yt-dlp', ['-U'], { stdio: 'inherit', windowsHide: true });
  updateProcess.on('close', (code) => {
    console.log(`yt-dlp updated, restarting bot (exit code ${code})...`);
    spawn('pm2', ['restart', 'all', '--update-env'], { stdio: 'inherit', windowsHide: true });
    process.exit(1);
  });
};

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  handleCriticalError(reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  handleCriticalError(error);
});

client.on('error', handleCriticalError);

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(prefix) || message.author.bot) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'play' || command === 'p') {
    if (!message.member.voice.channel) {
      return logAndReply(message, 'You need to be in a voice channel to play music!');
    }

    const voiceChannel = message.member.voice.channel;
    const guildId = message.guild.id;

    let serverQueue = queue.get(guildId);
    if (!serverQueue) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      serverQueue = {
        connection,
        songs: [],
        playing: false,
        player: createAudioPlayer(),
        textChannel: message.channel,
        current: null,
      };

      queue.set(guildId, serverQueue);
    }

    clearInactivityTimeout(guildId);

    const url = args[0];
    if (!url) return logAndReply(message, 'You need to provide a YouTube URL to play a song!');

    try {
      const songTitle = await fetchSongTitle(url);
      serverQueue.songs.push({ url, title: songTitle });

      if (!serverQueue.playing) playNextInQueue(guildId);

      logAndReply(message, `Added to the queue: ${songTitle}`);
    } catch (error) {
      console.error('Error processing the video:', error);
      logAndReply(message, 'There was an error trying to play the video.');
      handleCriticalError(error);
    }
  }

  if (command === 'skip' || command === 's') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue) return logAndReply(message, 'There is no song currently playing to skip!');

    try {
      serverQueue.current?.cleanup?.();
    } catch (_) {}
    serverQueue.current = null;

    serverQueue.player.stop(true);
    logAndReply(message, 'Skipping to the next song.');
  }

  if (command === 'leave' || command === 'l') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue) return logAndReply(message, 'I am not in a voice channel.');

    clearInactivityTimeout(message.guild.id);

    try {
      serverQueue.current?.cleanup?.();
    } catch (_) {}
    serverQueue.current = null;

    serverQueue.connection.destroy();
    queue.delete(message.guild.id);
    logAndReply(message, 'I have left the voice channel and cleared the queue!');
  }

  if (command === 'shuffle') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
      return logAndReply(message, 'The queue is empty, nothing to shuffle.');
    }

    for (let i = serverQueue.songs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [serverQueue.songs[i], serverQueue.songs[j]] = [serverQueue.songs[j], serverQueue.songs[i]];
    }

    logAndReply(message, 'Queue shuffled!');
  }

  if (command === 'queue' || command === 'q') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
      return logAndReply(message, 'The queue is currently empty.');
    }

    let queueList = 'Current Queue:\n';
    serverQueue.songs.forEach((song, index) => {
      queueList += `${index + 1}. ${song.title}\n`;
    });

    logAndReply(message, queueList);
  }

  if (command === 'playing' || command === 'np') {
    if (!currentPlaying) return logAndReply(message, 'No song is currently playing.');
    logAndReply(message, `🎶 Now playing: **${currentPlaying}**`);
  }

  if (command === 'help' || command === 'h') {
    logAndReply(
      message,
      '**Commands List:**\n' +
        '`-play <URL>` or `-p <URL>` - Plays the requested song\n' +
        '`-skip` or `-s` - Skips the current song\n' +
        '`-leave` or `-l` - Disconnects bot from the voice channel\n' +
        '`-shuffle` - Shuffles the current queue\n' +
        '`-queue` or `-q` - Lists the current queue\n' +
        '`-playing` or `-np` - Displays the current song title\n' +
        '`-help` or `-h` - Displays this help message'
    );
  }
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(token);
