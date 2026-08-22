// config.js
const path = require('path');

// Get the path to the current script directory (useful for cookie and token paths)
const scriptDirectory = __dirname;

// Define paths for the bot's configuration files
module.exports = {
  tokenFilePath: path.join(scriptDirectory, 'token.txt'),
  cookiesFilePath: path.join(scriptDirectory, 'cookies.txt'),
  maintenanceStatePath: path.join(scriptDirectory, 'maintenance-state.json'),
  cookieHealthStatePath: path.join(scriptDirectory, 'cookie-health.json'),
  inactivityTimeout: 10 * 60 * 1000, // 10 minutes
  metadataRetries: 2,
  playbackRetries: 2,
  voiceConnectionRetries: 1,
  retryBaseDelay: 1500,
  ytdlpUpdateInterval: 24 * 60 * 60 * 1000,
  ytdlpUpdateCooldown: 6 * 60 * 60 * 1000,
  maxQueueSize: 100,
  cookieWarningCooldown: 60 * 60 * 1000,
};
