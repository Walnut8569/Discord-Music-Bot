# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install   # install dependencies
npm start     # run the bot (node index.js)
```

Lavalink must be running before starting the bot:
```bash
./lavalink/start.sh   # start Lavalink server (requires Java 21+)
```

There is no test runner or linter configured.

## Architecture

The bot has two source files:

- **`index.js`** — Entry point. Creates the Discord `Client`, attaches Shoukaku (Lavalink WebSocket wrapper), registers slash commands on `clientReady`, and routes all interactions (`interactionCreate`) to `MusicManager`.
- **`MusicManager.js`** — All playback logic. Exposes `handlePlay`, `handleSeek`, `handleNowPlaying`, `handleButton`, `handleSelectMenu`, and `cleanup` as the public API called by `index.js`.

### Per-guild state

`MusicManager` keeps a `Map<guildId, GuildQueue>`. Each `GuildQueue` holds:
- The Shoukaku `player` instance
- The track queue array and currently playing track
- A reference to the live "now playing" Discord message (`npMessage`)
- A `progressInterval` (2 s) that edits the NP message with an updated progress bar
- A `leaveTimer` (30 s) that destroys the queue after the queue empties

### Playback flow

1. `/play` → `_getOrCreateQueue` (joins voice channel via Shoukaku) → resolves tracks via Lavalink REST → pushes to `queue.tracks` → calls `_playNext` if idle.
2. `_playNext` shifts the next track and calls `player.playTrack`.
3. Player `start` event → `_startProgressUpdater` sends a fresh NP message and begins the 2 s edit interval.
4. Player `end` event → `_stopProgressUpdater` → `_playNext` (loops until queue empty, then starts the leave timer).
5. Buttons/select menu call `player.seekTo` / `player.setPaused` / `player.stopTrack` and force-refresh the NP message.

### External dependency: Lavalink

The bot requires a running **Lavalink** server. The included `application.yml` configures it with the `youtube-source` plugin. If the Lavalink node disconnects, `cleanup(nodeName)` destroys all affected guild queues.

## Environment variables

Copy `.env.example` to `.env`:

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Bot token (required) |
| `GUILD_ID` | Guild-scoped commands (instant update); omit for global (up to 1 h delay) |
| `LAVALINK_HOST` | Lavalink host (default: `localhost`) |
| `LAVALINK_PORT` | Lavalink port (default: `2333`) |
| `LAVALINK_PASSWORD` | Must match `password` in `application.yml` (default: `youshallnotpass`) |
| `LAVALINK_SECURE` | Set `true` if Lavalink uses HTTPS/WSS |
