// config.js
const path = require('path');

// Get the path to the current script directory (useful for cookie and token paths)
const scriptDirectory = __dirname;

// Define paths for the bot's configuration files
module.exports = {
  tokenFilePath: path.join(scriptDirectory, 'token.txt'),
  cookiesFilePath: path.join(scriptDirectory, 'cookies.txt'),
  inactivityTimeout: 10 * 60 * 1000, // 10 minutes
};
