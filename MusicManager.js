'use strict';

const { MessageFlags } = require('discord.js');
const GuildQueue = require('./GuildQueue');
const { buildNpEmbed, buildNpComponents } = require('./ui');
const { getComputedPosition } = require('./utils');
const { getFavorites, addFavorite } = require('./favorites');

const AUTO_LEAVE_MS      = 30_000;
const PROGRESS_UPDATE_MS = 5_000;
const MAX_NP_ERRORS      = 3;

/**
 * Safely defer an ephemeral reply.
 * Returns false and bails out silently if the interaction is already
 * acknowledged (40060) or has expired (10062).
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>}
 */
async function safeDefer(interaction) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return true;
  } catch (err) {
    if (err.code === 40060 || err.code === 10062) return false;
    throw err;
  }
}

// Button custom ID constants
const BTN = {
  FAV:     'np_fav',
  RESTART: 'np_restart',
  PAUSE:   'np_pause',
  SKIP:    'np_skip',
  LOOP:    'np_loop',
};

class MusicManager {
  /** @param {import('discord.js').Client} client */
  constructor(client) {
    this.client = client;
    /** @type {Map<string, GuildQueue>} */
    this.queues = new Map();
    /** @type {Map<string, Promise<GuildQueue>>} */
    this._pending = new Map();
  }

  // ─── Slash command handlers ────────────────────────────────────────────────

  async handleLucifer(interaction) {
    return this.handlePlay(interaction, 'https://youtu.be/EPO7f7hMnOk');
  }

  async handlePlay(interaction, fixedUrl) {
    if (!await safeDefer(interaction)) return;

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return interaction.editReply('Join a voice channel first.');

    const query   = fixedUrl ?? interaction.options.getString('url', true);
    const guildId = interaction.guildId;

    try {
      const queue = await this._getOrCreateQueue(
        guildId, voiceChannel, interaction.channelId, interaction.guild.shardId ?? 0,
      );

      const isUrl      = /^https?:\/\//i.test(query);
      const identifier = isUrl ? query : `ytsearch:${query}`;
      const result     = await queue.player.node.rest.resolve(identifier);

      if (!result || result.loadType === 'empty') return interaction.editReply('No results found.');
      if (result.loadType === 'error') return interaction.editReply(`Source error: ${result.data?.message ?? 'unknown'}`);

      const { tracks, replyMsg } = this._extractTracks(result);
      if (!tracks.length) return interaction.editReply('No playable tracks found.');

      for (const track of tracks) track.requester = interaction.user;
      queue.tracks.push(...tracks);
      if (!queue.playing) await this._playNext(guildId);

      await interaction.editReply(replyMsg);
    } catch (err) {
      if (!err.userFacing) console.error(`[MusicManager] handlePlay (guild:${guildId}):`, err);
      await interaction.editReply(err.userMessage ?? 'Playback error. Please try again.').catch(() => {});
    }
  }

  async handleClear(interaction) {
    if (!await safeDefer(interaction)) return;

    const guildId = interaction.guildId;
    const queue   = this.queues.get(guildId);

    if (!queue?.current) return interaction.editReply('Nothing is playing.');
    if (interaction.member?.voice?.channelId !== queue.voiceChannelId) {
      return interaction.editReply('Join the same voice channel first.');
    }

    const count = queue.tracks.length;
    queue.tracks = [];
    await interaction.editReply(count > 0 ? `Cleared **${count}** track(s) from the queue.` : 'The queue is already empty.');
  }

  // ─── Button & Select Menu handlers ────────────────────────────────────────

  async handleButton(interaction) {
    // ❤️ 最愛：不需要在語音頻道，回覆 ephemeral 而非更新 NP 訊息
    if (interaction.customId === BTN.FAV) {
      return this._handleFav(interaction);
    }

    const guildId = interaction.guildId;
    const queue   = this.queues.get(guildId);

    if (!queue?.current) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.member?.voice?.channelId !== queue.voiceChannelId) {
      return interaction.reply({ content: 'Join the same voice channel first.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    try {
      switch (interaction.customId) {
        case BTN.RESTART: {
          await queue.player.seekTo(0);
          this._updateTimestamps(queue, 0);
          break;
        }
        case BTN.PAUSE: {
          queue.paused = !queue.paused;
          await queue.player.setPaused(queue.paused);
          if (queue.paused) {
            queue.pausedPositionMs = getComputedPosition(queue);
            this._stopProgressUpdater(guildId);
          } else {
            this._updateTimestamps(queue, queue.pausedPositionMs ?? 0);
            queue.pausedPositionMs = null;
            this._startProgressUpdater(guildId);
          }
          break;
        }
        case BTN.SKIP:
          queue.skipping = true;
          await queue.player.stopTrack();
          break;
        case BTN.LOOP: {
          const modes = ['OFF', 'TRACK', 'QUEUE'];
          queue.loopMode = modes[(modes.indexOf(queue.loopMode) + 1) % 3];
          break;
        }
      }
    } catch (err) {
      console.error(`[MusicManager] handleButton (guild:${guildId}):`, err);
      interaction.followUp({ content: 'Action failed. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    await this._refreshNowPlaying(guildId);
  }

  async handleSelectMenu(interaction) {
    if (interaction.customId !== 'np_queue_select') return;

    const guildId = interaction.guildId;
    const queue   = this.queues.get(guildId);

    if (!queue?.current) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.member?.voice?.channelId !== queue.voiceChannelId) {
      return interaction.reply({ content: 'Join the same voice channel first.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    const idx = parseInt(interaction.values[0], 10);
    if (isNaN(idx) || idx < 0 || idx >= queue.tracks.length) return;

    // Move selected track to front of queue, then skip current
    const [track] = queue.tracks.splice(idx, 1);
    queue.tracks.unshift(track);
    queue.skipping = true;
    await queue.player.stopTrack();
  }

  async handlePlayFav(interaction) {
    if (!await safeDefer(interaction)) return;

    const favs = getFavorites(interaction.user.id);
    if (!favs.length) return interaction.editReply('你的最愛歌單是空的，播放音樂時按 ♡ 新增。');

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return interaction.editReply('請先加入語音頻道。');

    const guildId = interaction.guildId;
    try {
      const queue = await this._getOrCreateQueue(guildId, voiceChannel, interaction.channelId, interaction.guild.shardId ?? 0);

      let added = 0;
      for (const fav of favs) {
        try {
          const result = await queue.player.node.rest.resolve(fav.uri);
          const { tracks } = this._extractTracks(result);
          if (tracks.length) {
            tracks[0].requester = interaction.user;
            queue.tracks.push(tracks[0]);
            added++;
          }
        } catch { /* 跳過無法解析的歌曲 */ }
      }

      if (!added) return interaction.editReply('無法播放最愛歌單中的任何歌曲。');
      if (!queue.playing) await this._playNext(guildId);

      await interaction.editReply(`♡ 已將 **${added}** 首最愛歌曲加入佇列！`);
    } catch (err) {
      if (!err.userFacing) console.error(`[MusicManager] handlePlayFav (guild:${guildId}):`, err);
      await interaction.editReply(err.userMessage ?? '播放失敗，請稍後再試。').catch(() => {});
    }
  }

  async _handleFav(interaction) {
    const queue = this.queues.get(interaction.guildId);
    if (!queue?.current) {
      return interaction.reply({ content: '目前沒有播放中的音樂。', flags: MessageFlags.Ephemeral });
    }
    const added = addFavorite(interaction.user.id, queue.current.info);
    await interaction.reply({
      content: added
        ? `♡ 已將 **${queue.current.info.title}** 加入最愛歌單！`
        : `**${queue.current.info.title}** 已在你的最愛歌單中。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ─── Lavalink node cleanup ─────────────────────────────────────────────────

  async cleanup(nodeName) {
    for (const [guildId, queue] of this.queues.entries()) {
      if (queue.player?.node?.name === nodeName) {
        await this._sendToText(guildId, `Lavalink node **${nodeName}** disconnected. Playback stopped.`);
        this._stopProgressUpdater(guildId);
        this.queues.delete(guildId);
      }
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  async _getOrCreateQueue(guildId, voiceChannel, textChannelId, shardId) {
    const existing = this.queues.get(guildId);
    if (existing) return existing;

    if (this._pending.has(guildId)) return this._pending.get(guildId);

    const promise = (async () => {
      if (this.client.shoukaku.nodes.size === 0 ||
          ![...this.client.shoukaku.nodes.values()].some(n => n.state === 1 /* CONNECTED */)) {
        throw Object.assign(new Error('No Lavalink nodes available'), { userFacing: true, userMessage: 'Music service is not ready yet. Please wait a moment and try again.' });
      }
      const player = await this.client.shoukaku.joinVoiceChannel({
        guildId, channelId: voiceChannel.id, shardId, deaf: true,
      });
      const queue = new GuildQueue(voiceChannel.id, textChannelId);
      queue.player = player;
      this.queues.set(guildId, queue);
      this._attachPlayerEvents(guildId, player);
      return queue;
    })();

    this._pending.set(guildId, promise);
    try {
      return await promise;
    } finally {
      this._pending.delete(guildId);
    }
  }

  _attachPlayerEvents(guildId, player) {
    player.on('start', () => {
      const queue = this.queues.get(guildId);
      if (!queue) return;
      queue.playing = true;
      queue.paused  = false;
      queue.pausedPositionMs = null;
      this._updateTimestamps(queue, 0);
      this._startProgressUpdater(guildId);
    });

    player.on('end', async (data) => {
      if (data?.reason === 'replaced') return;
      this._stopProgressUpdater(guildId);
      try { await this._playNext(guildId); } catch (err) {
        console.error(`[MusicManager] end._playNext (guild:${guildId}):`, err);
      }
    });

    player.on('exception', async (data) => {
      console.error(`[MusicManager] exception (guild:${guildId}):`, data);
      this._stopProgressUpdater(guildId);
      this._sendToText(guildId, `Playback error: ${data?.exception?.message ?? 'unknown'}. Skipping.`);
      const q = this.queues.get(guildId);
      if (q) q.skipping = true;
      try { await this._playNext(guildId); } catch (err) {
        console.error(`[MusicManager] exception._playNext (guild:${guildId}):`, err);
      }
    });

    player.on('stuck', async () => {
      this._stopProgressUpdater(guildId);
      this._sendToText(guildId, 'Playback stuck. Skipping.');
      const q = this.queues.get(guildId);
      if (q) q.skipping = true;
      try { await this._playNext(guildId); } catch (err) {
        console.error(`[MusicManager] stuck._playNext (guild:${guildId}):`, err);
      }
    });

    player.on('closed', async () => {
      this._stopProgressUpdater(guildId);
      try { await this._destroyQueue(guildId); } catch (err) {
        console.error(`[MusicManager] closed._destroyQueue (guild:${guildId}):`, err);
      }
    });
  }

  async _playNext(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue || queue.advancing) return;
    queue.advancing = true;

    try {
      while (true) {
        // Loop: re-insert the just-finished track unless it was deliberately skipped
        const wasSkipping = queue.skipping;
        queue.skipping = false;
        if (!wasSkipping && queue.current && queue.loopMode !== 'OFF') {
          if (queue.loopMode === 'TRACK') {
            queue.tracks.unshift(queue.current);
          } else {
            queue.tracks.push(queue.current);
          }
        }

        if (queue.tracks.length === 0) {
          queue.playing = false;
          queue.current = null;
          this._stopProgressUpdater(guildId);
          if (queue.npMessage) {
            queue.npMessage.delete().catch(() => {});
            queue.npMessage = null;
          }
          queue.leaveTimer = setTimeout(() => this._destroyQueue(guildId), AUTO_LEAVE_MS);
          return;
        }

        queue.clearLeaveTimer();
        const track = queue.tracks.shift();
        queue.current = track;
        queue.playing = true;

        try {
          await queue.player.playTrack({ track: { encoded: track.encoded } });
          return; // success — wait for 'start' event
        } catch (err) {
          console.error(`[MusicManager] playTrack failed (guild:${guildId}):`, err);
          this._sendToText(guildId, 'Failed to play track. Skipping.');
          queue.current = null;
          queue.playing = false;
          // loop continues to next track
        }
      }
    } finally {
      queue.advancing = false;
    }
  }

  // ─── Progress updater ──────────────────────────────────────────────────────

  _startProgressUpdater(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue) return;

    queue.clearProgressInterval();
    queue.npErrorCount = 0;
    queue.npUpdating   = false;
    this._sendFreshNowPlaying(guildId);

    queue.progressInterval = setInterval(
      () => this._refreshNowPlaying(guildId),
      PROGRESS_UPDATE_MS,
    );
  }

  _stopProgressUpdater(guildId) {
    const queue = this.queues.get(guildId);
    if (queue) queue.clearProgressInterval();
  }

  async _sendFreshNowPlaying(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue?.current) return;

    // If an NP message already exists, edit it in place instead of sending a new one.
    if (queue.npMessage) {
      try {
        await queue.npMessage.edit({
          embeds:     [buildNpEmbed(queue)],
          components: buildNpComponents(queue),
        });
        queue.npErrorCount = 0;
        return;
      } catch {
        // Message was deleted externally; fall through to send a fresh one.
        queue.npMessage = null;
      }
    }

    try {
      const channel = await this._fetchChannel(queue.textChannelId);
      if (!channel?.isTextBased()) return;

      const msg = await channel.send({
        embeds:     [buildNpEmbed(queue)],
        components: buildNpComponents(queue),
      });
      queue.npMessage    = msg;
      queue.npErrorCount = 0;
    } catch (err) {
      console.warn(`[MusicManager] sendFreshNowPlaying (guild:${guildId}):`, err.message);
    }
  }

  async _refreshNowPlaying(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue?.current) return;

    // Prevent concurrent requests from piling up during network outage
    if (queue.npUpdating) return;

    // If npMessage was lost (error / deleted), try to re-send (network may have recovered)
    if (!queue.npMessage) {
      await this._sendFreshNowPlaying(guildId);
      return;
    }

    queue.npUpdating = true;
    try {
      await queue.npMessage.edit({
        embeds:     [buildNpEmbed(queue)],
        components: buildNpComponents(queue),
      });
      queue.npErrorCount = 0;
    } catch (err) {
      queue.npMessage = null;
      queue.npErrorCount += 1;

      if (queue.npErrorCount >= MAX_NP_ERRORS) {
        // Discord is unreachable — stop hammering the API until next track
        this._stopProgressUpdater(guildId);
        console.warn(`[MusicManager] refreshNowPlaying (guild:${guildId}): pausing updates after ${MAX_NP_ERRORS} consecutive errors — ${err.message}`);
      } else {
        console.warn(`[MusicManager] refreshNowPlaying (guild:${guildId}):`, err.message);
      }
    } finally {
      queue.npUpdating = false;
    }
  }

  // ─── Timestamp helpers ─────────────────────────────────────────────────────

  _updateTimestamps(queue, positionMs) {
    queue.effectiveStartUnix = Math.floor((Date.now() - positionMs) / 1000);
  }

  // ─── Misc helpers ──────────────────────────────────────────────────────────

  async _destroyQueue(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue) return;

    queue.clearLeaveTimer();
    queue.clearProgressInterval();
    if (queue.npMessage) {
      queue.npMessage.delete().catch(() => {});
      queue.npMessage = null;
    }
    this.queues.delete(guildId);

    if (queue.player) queue.player.removeAllListeners();

    try {
      await this.client.shoukaku.leaveVoiceChannel(guildId);
    } catch (err) {
      console.warn(`[MusicManager] leaveVoiceChannel (guild:${guildId}):`, err.message);
    }
  }

  async _sendToText(guildId, message) {
    const queue = this.queues.get(guildId);
    if (!queue?.textChannelId) return;
    try {
      const ch = await this._fetchChannel(queue.textChannelId);
      if (ch?.isTextBased()) await ch.send(message);
    } catch (err) {
      console.warn(`[MusicManager] sendToText (guild:${guildId}):`, err.message);
    }
  }

  /** Cache-first channel lookup — avoids an HTTP round-trip for cached channels. */
  _fetchChannel(channelId) {
    return this.client.channels.cache.get(channelId)
      ?? this.client.channels.fetch(channelId);
  }

  _extractTracks(result) {
    switch (result.loadType) {
      case 'track':
        return { tracks: [result.data], replyMsg: `Queued: **${result.data.info.title}**` };
      case 'playlist':
        return { tracks: result.data.tracks, replyMsg: `Playlist: **${result.data.info.name}** (${result.data.tracks.length} tracks)` };
      case 'search':
        return { tracks: [result.data[0]], replyMsg: `Queued: **${result.data[0].info.title}**` };
      default:
        return { tracks: [], replyMsg: '' };
    }
  }
}

module.exports = MusicManager;
