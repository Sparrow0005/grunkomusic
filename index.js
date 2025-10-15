const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
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
const INACTIVITY_TIMEOUT = config.inactivityTimeout; // 10 minutes
let inactivityTimeouts = new Map();

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(prefix) || message.author.bot) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

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
      if (!serverQueue.playing) {
        playNextInQueue(guildId);
      }
      message.reply(`Added to the queue: ${songTitle}`);
      console.log(`"${songTitle}" added to queue.`);
    } catch (error) {
      console.error('Error processing the video:', error);
      message.reply('There was an error trying to play the video.');
      handleCriticalError(error);
    }
  }

  if (command === 'skip' || command === 's') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue) {
      return message.reply('There is no song currently playing to skip!');
    }

    serverQueue.player.stop();
    message.reply('Skipping to the next song.');
    console.log('Skipping song...');
  }

  if (command === 'leave' || command === 'l') {
    const serverQueue = queue.get(message.guild.id);
    if (serverQueue) {
      clearInactivityTimeout(message.guild.id);
      serverQueue.connection.destroy();
      queue.delete(message.guild.id);
      message.reply('I have left the voice channel and cleared the queue!');
      console.log('Left the voice channel.');
    } else {
      message.reply('I am not in a voice channel.');
    }
  }

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
    console.log(`Help command was used`);
  }
});

const playNextInQueue = async (guildId) => {
  const serverQueue = queue.get(guildId);
  if (!serverQueue || serverQueue.songs.length === 0) {
    console.log('Queue is empty. Starting inactivity timer...');
    startInactivityTimeout(guildId);
    return;
  }

  const song = serverQueue.songs.shift();

  try {
    const audioUrl = await fetchSongUrl(song.url);
    const resource = createAudioResource(audioUrl);
    serverQueue.player.play(resource);
    serverQueue.connection.subscribe(serverQueue.player);
    serverQueue.playing = true;

    currentPlaying = song.title;
    setTimeout(() => {
      serverQueue.textChannel.send(`🎶 Now playing: **${song.title}**`);
      console.log(`Now playing: ${song.title}`);
    }, PLAYBACK_COOLDOWN);

    serverQueue.player.on(AudioPlayerStatus.Idle, () => {
      console.log('Song finished, playing next in queue.');
      serverQueue.playing = false;
      playNextInQueue(guildId);
    });

    serverQueue.player.on('error', (error) => {
      console.error('Error during playback:', error);
      serverQueue.playing = false;
      playNextInQueue(guildId);
    });
  } catch (error) {
    console.error('Error playing audio stream:', error);
    serverQueue.playing = false;
    playNextInQueue(guildId);
  }
};

const fetchSongTitle = (url) => {
  return new Promise((resolve, reject) => {
    console.log(`Fetching song title for: ${url}`);
    const ytDlpProcess = spawn('yt-dlp', [
      '--get-title',
      '--cookies', config.cookiesFilePath,  // Use cookies path from config
      url
    ]);

    let title = '';
    ytDlpProcess.stdout.on('data', (data) => {
      title += data.toString();
    });

    ytDlpProcess.stderr.on('data', (error) => {
      console.error(`yt-dlp error: ${error}`);
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

const fetchSongUrl = (url) => {
  return new Promise((resolve, reject) => {
    console.log(`Fetching song URL for: ${url}`);
    const ytDlpProcess = spawn('yt-dlp', [
      '-f', 'bestaudio',
      '-g',
      '--cookies', config.cookiesFilePath,  // Use cookies path from config
      url
    ]);

    let audioUrl = '';
    ytDlpProcess.stdout.on('data', (data) => {
      audioUrl += data.toString();
    });

    ytDlpProcess.stderr.on('data', (error) => {
      console.error(`yt-dlp error: ${error}`);
    });

    ytDlpProcess.on('close', (code) => {
      if (code === 0) {
        resolve(audioUrl.trim());
      } else {
        reject(new Error('Failed to fetch audio URL.'));
      }
    });
  });
};

const startInactivityTimeout = (guildId) => {
  if (inactivityTimeouts.has(guildId)) return;
  inactivityTimeouts.set(
    guildId,
    setTimeout(() => {
      const serverQueue = queue.get(guildId);
      if (serverQueue) {
        serverQueue.connection.destroy();
        queue.delete(guildId);
        console.log(`Bot left due to inactivity in guild ${guildId}`);
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

// Global error handlers: update yt-dlp and restart bot
const handleCriticalError = (error) => {
  console.error('Critical error encountered:', error);
  // Notify users in all active text channels
  queue.forEach(({ textChannel }) => {
    textChannel.send('Encountered an error. Attempting to fix...');
  });
  const updateProcess = spawn('yt-dlp', ['-U'], { stdio: 'inherit' });
  updateProcess.on('close', (code) => {
    console.log(`yt-dlp updated, exiting with code ${code}. Restarting bot…`);
    spawn('pm2', ['restart', 'all', '--update-env'], { stdio: 'inherit' });
    process.exit(1);
  });
};

// Catch unhandled promise rejections
process.on('unhandledRejection', handleCriticalError);
// Catch uncaught exceptions
process.on('uncaughtException', handleCriticalError);
// Catch Discord client errors
client.on('error', handleCriticalError);

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Notify every guild that we just restarted
  client.guilds.cache.forEach(guild => {
    const channel = guild.systemChannel
      || guild.channels.cache.find(c =>
           c.isTextBased() &&
           c.permissionsFor(client.user).has('SendMessages')
         );
    if (channel) channel.send('Bot is now Online!');
  });
});

client.login(token).catch((error) => {
  console.error('Failed to login:', error.message);
});
