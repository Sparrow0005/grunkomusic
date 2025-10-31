const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const fs = require('fs');
const config = require('./config');  // Import config.js

// Read the token from token.txt using the path from config
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

// Timeout settings for inactivity
const INACTIVITY_TIMEOUT = config.inactivityTimeout; // 10 minutes default
let inactivityTimeouts = new Map();

// ───────────────────────────────────────────────
// Helper: Create audio stream with yt-dlp + ffmpeg
// ───────────────────────────────────────────────
function createStream(url) {
  console.log(`Starting yt-dlp stream for URL: ${url}`);

  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '-o', '-',
    '--quiet',
    '--no-warnings',
    '--cookies', config.cookiesFilePath,
    '--extractor-args', 'youtube:player_client=android',
    url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  ytdlp.stdout.pipe(ffmpeg.stdin);

  // ── Clean Logging ──
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
    // Only show real ffmpeg errors, skip progress spam
    if (
      msg.includes('Error') ||
      msg.includes('Invalid') ||
      msg.includes('failed') ||
      msg.includes('Could not')
    ) {
      console.error(`ffmpeg: ${msg.trim()}`);
    }
  });

  ytdlp.on('error', (err) => console.error('yt-dlp process error:', err));
  ffmpeg.on('error', (err) => console.error('ffmpeg process error:', err));

  return ffmpeg.stdout;
}

// ───────────────────────────────────────────────
// Event: messageCreate (commands)
// ───────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(prefix) || message.author.bot) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ── Play command ──
  if (command === 'play' || command === 'p') {
    if (!message.member.voice.channel) {
      return message.reply('You need to be in a voice channel to play music!');
    }

    const voiceChannel = message.member.voice.channel;
    const guildId = message.guild.id;

    let serverQueue = queue.get(guildId);
    if (!serverQueue) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      serverQueue = {
        connection,
        songs: [],
        playing: false,
        player: createAudioPlayer(),
        textChannel: message.channel,
      };
      queue.set(guildId, serverQueue);
    }

    const url = args[0];
    if (!url) {
      return message.reply('You need to provide a YouTube URL to play a song!');
    }

    try {
      const songTitle = await fetchSongTitle(url);
      serverQueue.songs.push({ url, title: songTitle });
      console.log(`Added to queue: "${songTitle}"`);

      if (!serverQueue.playing) {
        playNextInQueue(guildId);
      }
      message.reply(`Added to the queue: ${songTitle}`);
    } catch (error) {
      console.error('Error processing the video:', error);
      message.reply('There was an error trying to play the video.');
      handleCriticalError(error);
    }
  }

  // ── Skip command ──
  if (command === 'skip' || command === 's') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue) {
      return message.reply('There is no song currently playing to skip!');
    }
    serverQueue.player.stop();
    message.reply('Skipping to the next song.');
    console.log('Skipping current song...');
  }

  // ── Leave command ──
  if (command === 'leave' || command === 'l') {
    const serverQueue = queue.get(message.guild.id);
    if (serverQueue) {
      clearInactivityTimeout(message.guild.id);
      serverQueue.connection.destroy();
      queue.delete(message.guild.id);
      message.reply('I have left the voice channel and cleared the queue!');
      console.log('Bot left the voice channel.');
    } else {
      message.reply('I am not in a voice channel.');
    }
  }

  // ── Help command ──
  if (command === 'help' || command === 'h') {
    message.reply(
      "**Commands List:**\n" +
      "`-play <URL>` or `-p <URL>` - Plays the requested song\n" +
      "`-skip` or `-s` - Skips the current song\n" +
      "`-leave` or `-l` - Disconnects bot from the voice channel\n" +
      "`-shuffle` - Shuffles the current queue\n" +
      "`-queue` or `-q` - Lists the current queue\n" +
      "`-playing` or `-np` - Displays the current song title\n" +
      "`-help` or `-h` - Displays this help message"
    );
  }

  // ── Queue command ──
  if (command === 'queue' || command === 'q') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
      return message.reply('The queue is currently empty.');
    }

    let queueList = 'Current Queue:\n';
    serverQueue.songs.forEach((song, index) => {
      queueList += `${index + 1}. ${song.title}\n`;
    });

    message.reply(queueList);
  }

  // ── Now playing command ──
  if (command === 'playing' || command === 'np') {
    if (!currentPlaying) {
      return message.reply('No song is currently playing.');
    }
    message.reply(`🎶 Now playing: **${currentPlaying}**`);
  }
});

// ───────────────────────────────────────────────
// Play next song in queue
// ───────────────────────────────────────────────
const playNextInQueue = async (guildId) => {
  const serverQueue = queue.get(guildId);
  if (!serverQueue || serverQueue.songs.length === 0) {
    console.log('Queue empty. Starting inactivity timer...');
    startInactivityTimeout(guildId);
    return;
  }

  const song = serverQueue.songs.shift();
  console.log(`Playing next song: ${song.title}`);

  try {
    const stream = createStream(song.url);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });

    serverQueue.player.play(resource);
    serverQueue.connection.subscribe(serverQueue.player);
    serverQueue.playing = true;
    currentPlaying = song.title;

    setTimeout(() => {
      serverQueue.textChannel.send(`🎶 Now playing: **${song.title}**`);
    }, PLAYBACK_COOLDOWN);

    serverQueue.player.once(AudioPlayerStatus.Idle, () => {
      console.log('Audio player is idle. Song finished.');
      serverQueue.playing = false;
      playNextInQueue(guildId);
    });

    serverQueue.player.on('error', (error) => {
      console.error('Playback error:', error);
      serverQueue.playing = false;
      playNextInQueue(guildId);
    });
  } catch (error) {
    console.error('Error playing audio stream:', error);
    serverQueue.playing = false;
    playNextInQueue(guildId);
  }
};

// ───────────────────────────────────────────────
// Fetch song title using yt-dlp
// ───────────────────────────────────────────────
const fetchSongTitle = (url) => {
  return new Promise((resolve, reject) => {
    const ytDlpProcess = spawn('yt-dlp', [
      '--get-title',
      '--cookies', config.cookiesFilePath,
      url
    ]);

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
      if (code === 0) {
        resolve(title.trim());
      } else {
        reject(new Error('Failed to fetch song title.'));
      }
    });
  });
};

// ───────────────────────────────────────────────
// Inactivity Timer Logic
// ───────────────────────────────────────────────
const startInactivityTimeout = (guildId) => {
  if (inactivityTimeouts.has(guildId)) return;
  console.log(`Starting inactivity timeout for guild ${guildId}`);
  inactivityTimeouts.set(
    guildId,
    setTimeout(() => {
      const serverQueue = queue.get(guildId);
      if (serverQueue) {
        console.log(`Bot leaving voice channel due to inactivity in guild ${guildId}`);
        serverQueue.connection.destroy();
        queue.delete(guildId);
      }
    }, INACTIVITY_TIMEOUT)
  );
};

const clearInactivityTimeout = (guildId) => {
  const timeout = inactivityTimeouts.get(guildId);
  if (timeout) {
    clearTimeout(timeout);
    inactivityTimeouts.delete(guildId);
  }
};

// ───────────────────────────────────────────────
// Critical Error Handling
// ───────────────────────────────────────────────
const handleCriticalError = (error) => {
  console.error('Critical error:', error);
  queue.forEach(({ textChannel }) => {
    textChannel.send('Encountered an error. Attempting to fix...');
  });
  const updateProcess = spawn('yt-dlp', ['-U'], { stdio: 'inherit' });
  updateProcess.on('close', (code) => {
    console.log(`yt-dlp updated, restarting bot (exit code ${code})...`);
    spawn('pm2', ['restart', 'all', '--update-env'], { stdio: 'inherit' });
    process.exit(1);
  });
};

// Global unhandled errors
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  handleCriticalError(reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  handleCriticalError(error);
});

client.on('error', handleCriticalError);

// ───────────────────────────────────────────────
// Bot ready
// ───────────────────────────────────────────────
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Login
client.login(token).catch((error) => {
  console.error('Failed to login:', error.message);
});
