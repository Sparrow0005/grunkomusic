# Grunko Music

Discord bot for music playing from YouTube

## Setup

1. Install Node.js 20 or newer.
2. Put the Discord bot token in `token.txt`.
3. Run `npm install`.
4. In the Discord Developer Portal, enable **Message Content Intent** for the bot.
5. Run `npm start`.

Use `npm run watchdog` for automatic restarting 10secs after it detects a crash, clearing any bloated logs

The bot checks for `yt-dlp` updates at startup and once daily. Transient metadata, download, playback, and voice-connection errors are retried with bounded backoff, unavailable or private videos are skipped.

`cookies.txt` is optional for when YouTube hates you and decides you will no longer play music

## Commands

`-play <URL>` / `-p <URL>`, `-skip` / `-s`, `-leave` / `-l`, `-shuffle`, `-queue` / `-q`, `-playing` / `-np`, and `-help` / `-h`.
