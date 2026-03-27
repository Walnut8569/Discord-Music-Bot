'use strict';

const { MessageFlags } = require('discord.js');
const GuildQueue = require('./GuildQueue');
const { buildNpEmbed, buildNpComponents } = require('./ui');
const { getComputedPosition } = require('./utils');
const { getFavorites, addFavorite } = require('./favorites');

// 無人使用語音頻道後，幾毫秒自動離開
const AUTO_LEAVE_MS      = 30_000;
// NP 訊息進度條更新間隔（毫秒）
const PROGRESS_UPDATE_MS = 5_000;
// 連續失敗幾次後停止更新 NP 訊息
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
    // 40060: 已回覆過；10062: interaction 已過期
    if (err.code === 40060 || err.code === 10062) return false;
    throw err;
  }
}

// NP 訊息上各按鈕的 custom ID 常數
const BTN = {
  FAV:     'np_fav',     // 加入最愛
  RESTART: 'np_restart', // 從頭播放
  PAUSE:   'np_pause',   // 暫停 / 繼續
  SKIP:    'np_skip',    // 跳過
  LOOP:    'np_loop',    // 切換循環模式
};

class MusicManager {
  /** @param {import('discord.js').Client} client */
  constructor(client) {
    this.client = client;
    /** @type {Map<string, GuildQueue>} 每個伺服器對應一個播放佇列 */
    this.queues = new Map();
    /** @type {Map<string, Promise<GuildQueue>>} 建立中的佇列，防止重複建立 */
    this._pending = new Map();
  }

  // ─── Slash command handlers ────────────────────────────────────────────────

  /** /lucifer31415926536：立即插播固定曲目，替換掉正在播放的歌 */
  async handleLucifer(interaction) {
    if (!await safeDefer(interaction)) return;

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return interaction.editReply('Join a voice channel first.');

    const guildId = interaction.guildId;
    const URL = 'https://youtu.be/EPO7f7hMnOk';

    try {
      const queue = await this._getOrCreateQueue(
        guildId, voiceChannel, interaction.channelId, interaction.guild.shardId ?? 0,
      );

      const result = await queue.player.node.rest.resolve(URL);
      if (!result || result.loadType === 'empty') return interaction.editReply('No results found.');
      if (result.loadType === 'error') return interaction.editReply(`Source error: ${result.data?.message ?? 'unknown'}`);

      const { tracks } = this._extractTracks(result);
      if (!tracks.length) return interaction.editReply('No playable tracks found.');
      tracks[0].requester = interaction.user;

      if (queue.playing) {
        // 清空佇列，把目標曲目放到最前面，標記跳過後停止當前曲目
        // end event 觸發後 _playNext 會立即播放它
        queue.tracks.unshift(tracks[0]);
        queue.skipping = true;
        await queue.player.stopTrack();
        if (queue.npMessage) {
          queue.npMessage.delete().catch(() => {});
          queue.npMessage = null;
        }
      } else {
        // 目前沒在播放，直接加入並開始
        queue.tracks.push(tracks[0]);
        await this._playNext(guildId);
      }

      await interaction.editReply(`⚡ 插播：**${tracks[0].info.title}**`);
    } catch (err) {
      if (!err.userFacing) console.error(`[MusicManager] handleLucifer (guild:${guildId}):`, err);
      await interaction.editReply(err.userMessage ?? 'Playback error. Please try again.').catch(() => {});
    }
  }

  /** /play：接受 YouTube URL 或關鍵字搜尋，加入佇列並開始播放 */
  async handlePlay(interaction, fixedUrl) {
    if (!await safeDefer(interaction)) return;

    // 確認使用者在語音頻道中
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return interaction.editReply('Join a voice channel first.');

    const query   = fixedUrl ?? interaction.options.getString('url', true);
    const guildId = interaction.guildId;

    try {
      // 取得（或建立）此伺服器的播放佇列
      const queue = await this._getOrCreateQueue(
        guildId, voiceChannel, interaction.channelId, interaction.guild.shardId ?? 0,
      );

      // URL 直接傳給 Lavalink；非 URL 加上 ytsearch: 前綴進行搜尋
      const isUrl      = /^https?:\/\//i.test(query);
      const identifier = isUrl ? query : `ytsearch:${query}`;
      const result     = await queue.player.node.rest.resolve(identifier);

      if (!result || result.loadType === 'empty') return interaction.editReply('No results found.');
      if (result.loadType === 'error') return interaction.editReply(`Source error: ${result.data?.message ?? 'unknown'}`);

      const { tracks, replyMsg } = this._extractTracks(result);
      if (!tracks.length) return interaction.editReply('No playable tracks found.');

      // 標記每首歌的請求者，加入佇列
      for (const track of tracks) track.requester = interaction.user;
      queue.tracks.push(...tracks);
      // 若目前沒在播放則立即開始
      if (!queue.playing) await this._playNext(guildId);

      await interaction.editReply(replyMsg);
    } catch (err) {
      if (!err.userFacing) console.error(`[MusicManager] handlePlay (guild:${guildId}):`, err);
      await interaction.editReply(err.userMessage ?? 'Playback error. Please try again.').catch(() => {});
    }
  }

  /** /clear：清空待播佇列（不停止當前歌曲） */
  async handleClear(interaction) {
    if (!await safeDefer(interaction)) return;

    const guildId = interaction.guildId;
    const queue   = this.queues.get(guildId);

    if (!queue?.current) return interaction.editReply('Nothing is playing.');
    // 僅限在同一語音頻道的使用者才能操作
    if (interaction.member?.voice?.channelId !== queue.voiceChannelId) {
      return interaction.editReply('Join the same voice channel first.');
    }

    const count = queue.tracks.length;
    queue.tracks = [];
    await interaction.editReply(count > 0 ? `Cleared **${count}** track(s) from the queue.` : 'The queue is already empty.');
  }

  // ─── Button & Select Menu handlers ────────────────────────────────────────

  /** 處理 NP 訊息上所有按鈕的點擊事件 */
  async handleButton(interaction) {
    // 「加入最愛」按鈕不需要在語音頻道，單獨處理並回覆 ephemeral
    if (interaction.customId === BTN.FAV) {
      return this._handleFav(interaction);
    }

    const guildId = interaction.guildId;
    const queue   = this.queues.get(guildId);

    if (!queue?.current) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }
    // 只有在同一語音頻道的使用者才能操作按鈕
    if (interaction.member?.voice?.channelId !== queue.voiceChannelId) {
      return interaction.reply({ content: 'Join the same voice channel first.', flags: MessageFlags.Ephemeral });
    }

    // deferUpdate：告知 Discord 我們會更新原訊息，而非回覆新訊息
    await interaction.deferUpdate();

    try {
      switch (interaction.customId) {
        case BTN.RESTART: {
          // 從頭播放：seek 到 0 並重置時間戳
          await queue.player.seekTo(0);
          this._updateTimestamps(queue, 0);
          break;
        }
        case BTN.PAUSE: {
          // 切換暫停狀態；暫停時記錄當前進度，繼續時還原
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
          // 標記為主動跳過（避免 loop 模式重新插入），停止播放
          queue.skipping = true;
          await queue.player.stopTrack();
          // 立即刪除舊 NP 訊息，新曲的 NP 由 'start' event 發出
          if (queue.npMessage) {
            queue.npMessage.delete().catch(() => {});
            queue.npMessage = null;
          }
          return;
        case BTN.LOOP: {
          // 循環模式順序：OFF → TRACK（單曲）→ QUEUE（整個佇列）→ OFF
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

    // 操作完成後更新 NP 訊息（反映最新狀態）
    await this._refreshNowPlaying(guildId);
  }

  /** 處理佇列下拉選單：跳到指定曲目 */
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

    // 將選取的曲目移至佇列最前方，然後跳過當前曲目
    const [track] = queue.tracks.splice(idx, 1);
    queue.tracks.unshift(track);
    queue.skipping = true;
    await queue.player.stopTrack();
  }

  /** /playfav：將使用者的最愛歌曲打亂後全部加入佇列 */
  async handlePlayFav(interaction) {
    if (!await safeDefer(interaction)) return;

    const favs = getFavorites(interaction.user.id);
    if (!favs.length) return interaction.editReply('你的最愛歌單是空的，播放音樂時按 ♡ 新增。');

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return interaction.editReply('請先加入語音頻道。');

    const guildId = interaction.guildId;
    try {
      const queue = await this._getOrCreateQueue(guildId, voiceChannel, interaction.channelId, interaction.guild.shardId ?? 0);

      // 逐一解析最愛歌曲的 URI，跳過無法解析的項目
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

      // Fisher-Yates 洗牌：只對新加入的段落打亂，不影響已在佇列中的歌曲
      const start = queue.tracks.length - added;
      for (let i = queue.tracks.length - 1; i > start; i--) {
        const j = start + Math.floor(Math.random() * (i - start + 1));
        [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
      }

      if (!queue.playing) await this._playNext(guildId);

      await interaction.editReply(`♡ 已將 **${added}** 首最愛歌曲加入佇列！`);
    } catch (err) {
      if (!err.userFacing) console.error(`[MusicManager] handlePlayFav (guild:${guildId}):`, err);
      await interaction.editReply(err.userMessage ?? '播放失敗，請稍後再試。').catch(() => {});
    }
  }

  /** 處理「加入最愛」按鈕：將當前播放曲目加入使用者的最愛 */
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

  /** Lavalink 節點斷線時，清除該節點上所有伺服器的佇列 */
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

  /**
   * 取得現有佇列，或建立新佇列並加入語音頻道。
   * 使用 _pending 防止同時發出多個 joinVoiceChannel 請求。
   */
  async _getOrCreateQueue(guildId, voiceChannel, textChannelId, shardId) {
    const existing = this.queues.get(guildId);
    if (existing) return existing;

    // 若已有相同 guild 的建立請求在進行中，等待它完成即可
    if (this._pending.has(guildId)) return this._pending.get(guildId);

    const promise = (async () => {
      // 確認至少有一個 Lavalink 節點已連線
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
      // 不論成功或失敗，都移除 pending 記錄
      this._pending.delete(guildId);
    }
  }

  /** 綁定 Lavalink player 的各種事件監聽器 */
  _attachPlayerEvents(guildId, player) {
    // 曲目開始播放
    player.on('start', () => {
      const queue = this.queues.get(guildId);
      if (!queue) return;
      queue.playing = true;
      queue.paused  = false;
      queue.pausedPositionMs = null;
      this._updateTimestamps(queue, 0);
      // 啟動進度條更新並發出新的 NP 訊息
      this._startProgressUpdater(guildId);
    });

    // 曲目結束（replaced 表示被新 playTrack 取代，不需要處理）
    player.on('end', async (data) => {
      if (data?.reason === 'replaced') return;
      this._stopProgressUpdater(guildId);
      // 刪除舊 NP 訊息，下一首的 NP 由 'start' event 重新發出
      const q = this.queues.get(guildId);
      if (q?.npMessage) {
        q.npMessage.delete().catch(() => {});
        q.npMessage = null;
      }
      try { await this._playNext(guildId); } catch (err) {
        console.error(`[MusicManager] end._playNext (guild:${guildId}):`, err);
      }
    });

    // 播放發生錯誤（例如來源不可用）
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

    // 播放卡住（長時間無音訊輸出）
    player.on('stuck', async () => {
      this._stopProgressUpdater(guildId);
      this._sendToText(guildId, 'Playback stuck. Skipping.');
      const q = this.queues.get(guildId);
      if (q) q.skipping = true;
      try { await this._playNext(guildId); } catch (err) {
        console.error(`[MusicManager] stuck._playNext (guild:${guildId}):`, err);
      }
    });

    // WebSocket 連線關閉，清除整個佇列
    player.on('closed', async () => {
      this._stopProgressUpdater(guildId);
      try { await this._destroyQueue(guildId); } catch (err) {
        console.error(`[MusicManager] closed._destroyQueue (guild:${guildId}):`, err);
      }
    });
  }

  /**
   * 播放佇列中的下一首歌。
   * 使用 advancing flag 防止同時觸發多次（例如 end + exception 同時發生）。
   */
  async _playNext(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue || queue.advancing) return;
    queue.advancing = true;

    try {
      while (true) {
        // 若不是主動跳過，且有循環模式，將剛播完的曲目重新插回佇列
        const wasSkipping = queue.skipping;
        queue.skipping = false;
        if (!wasSkipping && queue.current && queue.loopMode !== 'OFF') {
          if (queue.loopMode === 'TRACK') {
            queue.tracks.unshift(queue.current); // 單曲循環：插回最前
          } else {
            queue.tracks.push(queue.current);    // 整列循環：插回最後
          }
        }

        // 佇列已空：停止播放並啟動自動離開計時器
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
          return; // 成功送出播放指令，等待 'start' event
        } catch (err) {
          // 播放失敗則繼續嘗試下一首
          console.error(`[MusicManager] playTrack failed (guild:${guildId}):`, err);
          this._sendToText(guildId, 'Failed to play track. Skipping.');
          queue.current = null;
          queue.playing = false;
        }
      }
    } finally {
      queue.advancing = false;
    }
  }

  // ─── Progress updater ──────────────────────────────────────────────────────

  /** 啟動 NP 進度條更新：先發一則新 NP 訊息，再每隔固定時間 refresh */
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

  /** 停止 NP 進度條更新（清除 interval） */
  _stopProgressUpdater(guildId) {
    const queue = this.queues.get(guildId);
    if (queue) queue.clearProgressInterval();
  }

  /** 刪除舊 NP 訊息並在頻道底部重新發一則新的 NP 訊息 */
  async _sendFreshNowPlaying(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue?.current) return;

    // 先刪除舊訊息，確保新訊息出現在最下方
    if (queue.npMessage) {
      queue.npMessage.delete().catch(() => {});
      queue.npMessage = null;
    }

    try {
      const channel = await this._fetchChannel(queue.textChannelId);
      if (!channel?.isTextBased()) return;

      const msg = await channel.send({
        embeds:     [buildNpEmbed(queue)],
        components: buildNpComponents(queue),
        flags:      MessageFlags.SuppressNotifications, // 不發送通知
      });
      queue.npMessage    = msg;
      queue.npErrorCount = 0;
    } catch (err) {
      console.warn(`[MusicManager] sendFreshNowPlaying (guild:${guildId}):`, err.message);
    }
  }

  /**
   * 更新現有 NP 訊息的進度條與狀態。
   * 若 NP 訊息已不在頻道最底部，則刪除後重新發送以維持最新。
   * 連續失敗 MAX_NP_ERRORS 次後暫停更新。
   */
  async _refreshNowPlaying(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue?.current || queue.npUpdating) return;

    // NP 訊息不存在時重新發送
    if (!queue.npMessage) {
      await this._sendFreshNowPlaying(guildId);
      return;
    }

    queue.npUpdating = true;
    try {
      const channel = await this._fetchChannel(queue.textChannelId);

      // 若頻道最新訊息不是 NP，代表有人傳了其他訊息，需重新置底
      if (channel?.lastMessageId && channel.lastMessageId !== queue.npMessage.id) {
        await queue.npMessage.delete().catch(() => {});
        queue.npMessage = null;
        const msg = await channel.send({
          embeds:     [buildNpEmbed(queue)],
          components: buildNpComponents(queue),
        });
        queue.npMessage    = msg;
        queue.npErrorCount = 0;
        return;
      }

      // 原地 edit，只更新內容不重新發送
      await queue.npMessage.edit({
        embeds:     [buildNpEmbed(queue)],
        components: buildNpComponents(queue),
      });
      queue.npErrorCount = 0;
    } catch (err) {
      queue.npMessage = null;
      queue.npErrorCount += 1;

      if (queue.npErrorCount >= MAX_NP_ERRORS) {
        // 錯誤次數過多，暫停更新避免洗頻道
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

  /**
   * 根據目前播放進度重新計算「有效開始時間」。
   * effectiveStartUnix 用於計算 Discord 的動態時間戳（進度條）。
   */
  _updateTimestamps(queue, positionMs) {
    queue.effectiveStartUnix = Math.floor((Date.now() - positionMs) / 1000);
  }

  // ─── Misc helpers ──────────────────────────────────────────────────────────

  /** 完整銷毀佇列：清除計時器、刪除 NP 訊息、離開語音頻道 */
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

    // 移除所有 player 事件監聽器，避免記憶體洩漏
    if (queue.player) queue.player.removeAllListeners();

    try {
      await this.client.shoukaku.leaveVoiceChannel(guildId);
    } catch (err) {
      console.warn(`[MusicManager] leaveVoiceChannel (guild:${guildId}):`, err.message);
    }
  }

  /** 向文字頻道發送系統提示訊息（例如錯誤、跳過通知） */
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

  /**
   * 將 Lavalink 解析結果轉換為曲目陣列與回覆訊息。
   * playlist 最多只取第 1 首（避免一次加入過多曲目）。
   */
  _extractTracks(result) {
    switch (result.loadType) {
      case 'track':
        return { tracks: [result.data], replyMsg: `Queued: **${result.data.info.title}**` };
      case 'playlist': {
        const tracks = result.data.tracks.slice(0, 1);
        return { tracks, replyMsg: `Playlist: **${result.data.info.name}** (${tracks.length} tracks)` };
      }
      case 'search':
        return { tracks: [result.data[0]], replyMsg: `Queued: **${result.data[0].info.title}**` };
      default:
        return { tracks: [], replyMsg: '' };
    }
  }
}

module.exports = MusicManager;
