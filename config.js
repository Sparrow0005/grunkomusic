// config.js
const path = require('path');

// Get the path to the current script directory (useful for cookie and token paths)
const scriptDirectory = __dirname;

// Define paths for the bot's configuration files
module.exports = {
  // Stable Discord application owner ID for private maintenance alerts and mentions.
  ownerUserId: '343142799111094272',
  tokenFilePath: path.join(scriptDirectory, 'token.txt'),
  cookiesFilePath: path.join(scriptDirectory, 'cookies.txt'),
  maintenanceStatePath: path.join(scriptDirectory, 'maintenance-state.json'),
  cookieHealthStatePath: path.join(scriptDirectory, 'cookie-health.json'),
  // Age-restricted video used only to verify that YouTube accepts the saved cookies.
  cookieVerificationUrl: 'https://www.youtube.com/watch?v=6cUT0U1nBXE',
  inactivityTimeout: 10 * 60 * 1000, // 10 minutes
  metadataRetries: 2,
  playbackRetries: 2,
  downloadRetries: 10,
  voiceConnectionRetries: 1,
  retryBaseDelay: 1500,
  ytdlpUpdateInterval: 24 * 60 * 60 * 1000,
  ytdlpUpdateCooldown: 6 * 60 * 60 * 1000,
  maxQueueSize: 100,
  maxUploadSize: 25 * 1024 * 1024,
  cookieWarningCooldown: 24 * 60 * 60 * 1000, // 24 hours
};
