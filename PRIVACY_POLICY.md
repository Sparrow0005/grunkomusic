# Grunko Music Privacy Policy

**Effective date: October 21, 2026**

This Privacy Policy explains how Grunko Music (the "Bot"), operated by Sparrow ("we," "us," or "our"), accesses, uses, stores, and shares information when it is used through Discord.

The short version: the Bot processes Discord commands and voice-channel information needed to play music. It does not sell personal information, run advertisements, build user profiles, or use user content to train artificial intelligence models. It has no user database.

## 1. Scope

This policy applies to information processed by the Bot. Discord and the media services used by the Bot have separate privacy policies and process information independently.

## 2. Information the Bot processes

Depending on how you use the Bot, it may process:

### Discord account and server information

- Discord user IDs needed to associate a command or selection reply with the requesting user;
- server, channel, and voice-channel IDs needed to maintain separate playback sessions;
- usernames, server names, and channel names when Discord supplies them and when they appear in operational logs; and
- voice-channel membership and connection state needed to join, play audio, recover connections, and leave inactive channels.

### Commands and interactions

- command messages beginning with the Bot's command prefix;
- search terms, media links, playlist links, and numbered or cancellation responses to active prompts;
- song titles, artist names, channel names, durations, queue state, and playback status; and
- button interactions used to navigate long queues.

Discord may deliver message events to the Bot because it uses the Message Content privileged intent. The Bot's command handler ignores messages from bots, direct messages, and guild messages that do not begin with its command prefix. During an active selection prompt, it temporarily reads replies from the requesting user in the same channel to identify a valid choice.

### Attachments

When you use file playback, the Bot processes the attachment's filename, media type, size, and Discord-hosted URL. Supported files are streamed from Discord to FFmpeg for metadata inspection and playback. The Bot does not intentionally save uploaded media files to permanent local storage.

### Operational and diagnostic information

The Bot creates local operational logs that can include server and channel names, the Bot's outgoing messages, requested or resolved song titles, provider or playback errors, recovery events, and timestamps. Error output from media tools may sometimes contain a submitted media URL or provider response.

The Bot also stores small local maintenance files containing update timestamps and YouTube-cookie health information. These files are for operation of the Bot and are not used to profile Discord users.

### Operator credentials

The Bot uses its own Discord token and optional YouTube cookies supplied by the operator. These are not user data, are excluded from the public repository, and are not requested from Bot users. Never send your Discord password, token, browser cookies, or other login credentials to the Bot.

## 3. How information is used

We process information only as reasonably necessary to:

- respond to commands and selection prompts;
- connect to voice channels and play requested audio;
- create and manage a separate queue for each server;
- retrieve media metadata and locate playable matches;
- display the current song, playback time, queue, and service status;
- prevent duplicate prompts, enforce queue and upload limits, and disconnect inactive sessions;
- diagnose failures, retry interrupted playback, maintain dependencies, and improve reliability;
- protect the Bot, its users, and third-party services from misuse; and
- comply with applicable law and Discord's requirements.

We do not use Discord API data for advertising, data brokerage, eligibility decisions, surveillance, relationship mapping, or unrelated purposes.

## 4. When information is shared

We do not sell personal information. Information is transmitted only as needed to provide the requested feature:

- **Discord:** supplies commands, interactions, attachments, identifiers, and voice connections, and receives the Bot's replies and status updates.
- **YouTube or Google:** may receive YouTube URLs, playlist identifiers, search queries, and ordinary network request information when the Bot searches for or retrieves media.
- **Spotify:** may receive a submitted Spotify URL when the Bot retrieves track or playlist metadata.
- **Apple Music:** may receive a submitted Apple Music URL when the Bot retrieves song or playlist metadata.
- **Infrastructure and software providers:** the Bot runs on operator-controlled hardware and uses open-source components such as yt-dlp and FFmpeg to process media locally. Network providers necessarily handle traffic used to reach Discord and media services.
- **Legal and safety disclosures:** information may be disclosed if reasonably necessary to comply with law, enforce these policies, respond to valid legal process, or protect rights, safety, and security.

The Bot does not authorize third parties to use Discord API data for their own advertising or data-broker purposes.

## 5. Retention

The Bot minimizes retention as follows:

- queue, current-track, voice-session, and prompt state is held in memory and is removed when cleared, when the Bot leaves, when the process restarts, or when it is otherwise no longer needed;
- ordinary selection prompts time out after approximately 45 seconds;
- uploaded media is streamed for inspection and playback and is not intentionally stored as a local media file;
- Discord itself controls retention of messages and attachments on its service;
- operational logs are stored locally, rotate when they exceed 10 MiB, and may remain in the current log and one rotated backup until overwritten or manually deleted; and
- maintenance and cookie-health records remain until replaced, reset, or no longer needed to operate the Bot.

We may retain information longer when required by law, needed to investigate abuse or a security incident, or necessary to establish or defend legal claims. When the Bot permanently ceases operation, locally retained Discord API data will be deleted unless retention is legally required.

## 6. Security

Reasonable safeguards include limiting requested Discord permissions, isolating queues by server, restricting file playback to supported media types and Discord-hosted HTTPS URLs, enforcing file and queue limits, keeping credentials out of Git, hiding the local process console, and restricting operational files to the host machine. No system is completely secure, and we cannot guarantee absolute security.

## 7. Your choices and requests

You can:

- stop using the Bot;
- delete commands or attachments from Discord when Discord permits;
- ask a server administrator to restrict or remove the Bot;
- use `-clear` to remove upcoming tracks from the in-memory queue;
- use `-leave` to clear the server queue and end the voice session; and
- request access to or deletion of locally retained information reasonably associated with you.

To make a privacy request, contact `@sparrow05` on Discord. Be prepared to provide enough information to verify the request and locate relevant records. We will respond and delete eligible data within a reasonable period, subject to legal obligations and the technical limits of minimally identifying logs. As a public fallback, you may open an issue titled "Privacy Request" at the [Grunko Music GitHub repository](https://github.com/Sparrow0005/grunkomusic/issues), but do not put private information in the issue.

Deleting a Discord message does not necessarily remove an existing local diagnostic log entry. Requests concerning information retained by Discord or a media provider must be directed to that provider.

## 8. Children

The Bot is not intended for anyone below Discord's minimum required age in their country. We do not knowingly collect information from a child who is not permitted to use Discord. Contact us if you believe such information has been processed so that it can be reviewed and deleted where appropriate.

## 9. International processing

Discord and third-party media services may process information in countries other than your own. Their privacy policies describe their international transfer practices. The Bot itself runs on operator-controlled hardware.

## 10. Changes to this policy

We may update this policy when the Bot's features, data practices, law, or Discord requirements change. The effective date at the top will be updated when a revised policy is published.

## 11. Contact

For privacy questions or requests, contact `@sparrow05` on Discord. A public fallback is available through the [Grunko Music GitHub repository](https://github.com/Sparrow0005/grunkomusic/issues). Do not include passwords, tokens, cookies, private messages, or other sensitive information in a public issue.

