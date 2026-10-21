# Grunko Music

Discord music bot for YouTube playback with Spotify and Apple Music metadata support. Audio is resolved through yt-dlp and transcoded through FFmpeg.

[Terms of Service](TERMS_OF_SERVICE.md) | [Privacy Policy](PRIVACY_POLICY.md)

## Requirements

- Node.js 20 or newer
- Discord bot token in `token.txt`, or the `DISCORD_TOKEN` environment variable
- Optional Netscape-format YouTube cookies in `cookies.txt`
- Discord **Message Content Intent** enabled

On Windows, install dependencies with `$env:YOUTUBE_DL_SKIP_PYTHON_CHECK='1'; npm install`, then run `npm start`. The skip is safe here because `youtube-dl-exec` uses its bundled standalone executable rather than a Python installation. Use `npm run watchdog` for automatic crash recovery and log rotation.

## Discord permissions

OAuth2 scope: `bot`

Required bot permissions:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Connect
- Speak
- Set Voice Channel Status

Permission integer: `281474979941376`

Administrator and moderation permissions are not required. Channel-specific overrides must allow the permissions above wherever the bot is used.

## Commands

| Command | Purpose |
| --- | --- |
| `-play <URL or text>` / `-p <URL or text>` | Search or play YouTube, Spotify, and Apple Music |
| `-playlist <URL>` / `-pl <URL>` | Queue a YouTube playlist |
| `-insert <URL or text>` / `-i <URL or text>` | Insert one song at queue position 1 |
| `-fileplay` / `-fp` with an attachment or Discord attachment URL | Play one uploaded media file up to 25 MiB |
| `-skip` / `-s` | Skip the current song |
| `-leave` / `-l` | Disconnect and clear the server queue |
| `-clear` | Clear upcoming songs while the current song keeps playing |
| `-shuffle` | Shuffle upcoming songs |
| `-queue` / `-q` | Show upcoming songs and durations |
| `-playing` / `-np` | Show the current song and elapsed/total time |
| `-health` | Report bot and cookie health |
| `-help` / `-h` | Show the command list |

Search selections accept `1` through `5`, or `x` to cancel. Queue displays use buttons when more than 10 songs are waiting.

`-insert` accepts a YouTube video URL or plain search text. A text search offers five choices and inserts exactly one selected song. It does not interrupt the current song; it places the requested song first among the upcoming tracks and shifts the existing queue back one position.

## Link handling

- YouTube radio links ending in `start_radio=1` are normalized to one song.
- A dedicated `/playlist` URL is accepted by `-playlist`.
- A `/watch` URL inside a normal playlist asks whether to queue the song or playlist.
- Plain text sent to `-play` or `-p` opens a five-result chooser.
- Spotify and Apple Music song and playlist links are accepted directly by `-play` or `-p`.
- File playback accepts one attached file or pasted Discord attachment URL from a restricted audio/video format list, up to 25 MiB.
- Spotify and Apple Music provide metadata only. Playback uses a title-, artist-, and duration-matched YouTube source.
- External playlists are limited to 100 queued songs.

## Status and privacy

- The public bot presence only reports `Playing music in X server(s)`.
- Each active voice channel shows its own song and timestamp status.
- `-playing` and `-queue` are isolated per server.
- Voice-channel status is cleared when playback stops or the bot leaves.

## Recovery behavior

- Metadata, voice connection, and playback operations use bounded retries.
- The bot tries public YouTube access first and only uses cookies when authentication is required.
- Cookies that still receive an authentication challenge are marked unhealthy.
- Cookie maintenance warnings are directed only to the application owner, Sparrow. If another user discovers expired cookies through playback, the bot mentions Sparrow and gives the requester only a generic playback failure. Owner and discovery warnings have separate cooldowns to prevent spam.
- Unavailable playlist entries may be replaced only by a context-matched result.
- Spotify and Apple Music matches require strong title, artist, and duration agreement.
- yt-dlp checks for updates at startup, once daily, and after recognized extractor failures.
- The watchdog restarts crashes with exponential backoff and rotates logs larger than 10 MB.
- Empty voice sessions disconnect after 10 minutes.

## Local files

| File | Purpose | Committed? |
| --- | --- | --- |
| `config.js` | Retry, queue, timeout, and maintenance settings | Yes |
| `token.txt` | Discord bot token | No |
| `cookies.txt` | Optional YouTube login cookies | No |
| `cookie-health.json` | Cookie rejection state | No |
| `maintenance-state.json` | yt-dlp update cooldown state | No |
| `bot.log` | Normal runtime log | No |
| `bot-error.log` | Error and recovery log | No |
| `watchdog.ps1` | Hidden-window process supervisor | Yes |
| `run-hidden.vbs` | Scheduled-task launcher | Yes |

## Maintenance checks

```powershell
npm run check
npm audit
npm outdated
```

The scheduled task is named `GrunkoMusicBot`. The watchdog intentionally keeps the bot console hidden while writing readable logs in the repository directory.
