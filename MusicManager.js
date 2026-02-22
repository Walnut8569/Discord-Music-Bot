'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const PROGRESS_BAR_LENGTH = 20;
const AUTO_LEAVE_MS = 30_000;
const PROGRESS_UPDATE_MS = 2_000;

// Button custom ID constants
const BTN = {
  RESTART:  'np_restart',
  BACK:     'np_back',
  PAUSE:    'np_pause',
  FORWARD:  'np_forward',
  SKIP:     'np_skip',
  STOP:     'np_stop',
  SEEK_MENU:'np_seek',
};

class GuildQueue {
  constructor(voiceChannelId, textChannelId) {
    this.voiceChannelId = voiceChannelId;
    this.textChannelId  = textChannelId;
    /** @type {import('shoukaku').Player|null} */
    this.player = null;
    /** @type {Array<{encoded:string,info:object}>} */
    this.tracks  = [];
    /** @type {{encoded:string,info:object}|null} */
    this.current = null;
    this.playing = false;
    this.paused  = false;
    /** Unix timestamp (seconds) of when position 0 was — used for client-side countdown */
    this.effectiveStartUnix  = null;
    this.estimatedEndUnix    = null;
    /** @type {import('discord.js').Message|null} */
    this.npMessage = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.progressInterval = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.leaveTimer = null;
  }

  clearLeaveTimer() {
    if (this.leaveTimer) { clearTimeout(this.leaveTimer); this.leaveTimer = null; }
  }

  clearProgressInterval() {
    if (this.progressInterval) { clearInterval(this.progressInterval); this.progressInterval = null; }
  }
}

class MusicManager {
  /** @param {import('discord.js').Client} client */
  constructor(client) {
    this.client = client;
    /** @type {Map<string, GuildQueue>} */
    this.queues = new Map();
  }

  // ─── Slash command handlers ────────────────────────────────────────────────

  async handlePlay(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return interaction.editReply('你需要先加入語音頻道！');

    const query   = interaction.options.getString('url', true);
    const guildId = interaction.guildId;

    try {
      const queue = await this._getOrCreateQueue(
        guildId, voiceChannel, interaction.channelId, interaction.guild.shardId ?? 0,
      );

      const isUrl     = /^https?:\/\//i.test(query);
      const identifier = isUrl ? query : `ytsearch:${query}`;
      const result    = await queue.player.node.rest.resolve(identifier);

      if (!result || result.loadType === 'empty') return interaction.editReply('找不到音樂，請確認連結或關鍵字。');
      if (result.loadType === 'error') return interaction.editReply(`來源錯誤：${result.data?.message ?? '未知錯誤'}`);

      const { tracks, replyMsg } = this._extractTracks(result);
      if (!tracks.length) return interaction.editReply('無法從該來源取得曲目。');

      queue.tracks.push(...tracks);
      if (!queue.playing) await this._playNext(guildId);

      await interaction.editReply(replyMsg);
    } catch (err) {
      console.error(`[MusicManager] handlePlay (guild:${guildId}):`, err);
      await interaction.editReply('播放時發生錯誤，請稍後再試。').catch(() => {});
    }
  }

  async handleSeek(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const queue = this.queues.get(interaction.guildId);
    if (!queue?.playing || !queue.current) return interaction.editReply('目前沒有在播放任何音樂。');

    const positionMs = parseTimeToMs(interaction.options.getString('time', true));
    if (positionMs === null) return interaction.editReply('格式無效，請用秒數（90）或 mm:ss（1:30）。');
    if (positionMs > queue.current.info.length) return interaction.editReply(`超出歌曲長度（${formatMs(queue.current.info.length)}）。`);

    await queue.player.seekTo(positionMs);
    this._updateTimestamps(queue, positionMs);
    await interaction.editReply(`已跳至 **${formatMs(positionMs)}**`);
  }

  async handleNowPlaying(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const queue = this.queues.get(interaction.guildId);
    if (!queue?.playing || !queue.current) return interaction.editReply('目前沒有在播放任何音樂。');
    await interaction.editReply('已在頻道中顯示播放進度 👇');
  }

  // ─── Button & Select Menu handlers (called from index.js) ─────────────────

  async handleButton(interaction) {
    const guildId = interaction.guildId;
    const queue   = this.queues.get(guildId);

    if (!queue?.current) {
      return interaction.reply({ content: '目前沒有在播放任何音樂。', ephemeral: true });
    }

    // Only allow users in the same voice channel
    if (interaction.member?.voice?.channelId !== queue.voiceChannelId) {
      return interaction.reply({ content: '你需要在同一個語音頻道才能操作。', ephemeral: true });
    }

    await interaction.deferUpdate();

    switch (interaction.customId) {
      case BTN.RESTART: {
        await queue.player.seekTo(0);
        this._updateTimestamps(queue, 0);
        break;
      }
      case BTN.BACK: {
        const newPos = Math.max(0, queue.player.position - 30_000);
        await queue.player.seekTo(newPos);
        this._updateTimestamps(queue, newPos);
        break;
      }
      case BTN.PAUSE:
        queue.paused = !queue.paused;
        await queue.player.setPaused(queue.paused);
        break;

      case BTN.FORWARD: {
        const newPos = Math.min(queue.current.info.length, queue.player.position + 30_000);
        await queue.player.seekTo(newPos);
        this._updateTimestamps(queue, newPos);
        break;
      }

      case BTN.SKIP:
        await queue.player.stopTrack();
        break;

      case BTN.STOP:
        queue.tracks = [];
        await queue.player.stopTrack();
        break;
    }

    // Force-refresh the now-playing message immediately
    await this._refreshNowPlaying(guildId);
  }

  async handleSelectMenu(interaction) {
    const guildId = interaction.guildId;
    const queue   = this.queues.get(guildId);

    if (!queue?.current) {
      return interaction.reply({ content: '目前沒有在播放任何音樂。', ephemeral: true });
    }
    if (interaction.member?.voice?.channelId !== queue.voiceChannelId) {
      return interaction.reply({ content: '你需要在同一個語音頻道才能操作。', ephemeral: true });
    }

    await interaction.deferUpdate();
    const posMs = parseInt(interaction.values[0], 10);
    await queue.player.seekTo(posMs);
    this._updateTimestamps(queue, posMs);
    await this._refreshNowPlaying(guildId);
  }

  // ─── Lavalink node cleanup ─────────────────────────────────────────────────

  async cleanup(nodeName) {
    for (const [guildId, queue] of this.queues.entries()) {
      if (queue.player?.node?.name === nodeName) {
        await this._sendToText(guildId, `Lavalink 節點 **${nodeName}** 斷線，播放已停止。`);
        this._stopProgressUpdater(guildId);
        this.queues.delete(guildId);
      }
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  async _getOrCreateQueue(guildId, voiceChannel, textChannelId, shardId) {
    const existing = this.queues.get(guildId);
    if (existing) return existing;

    const player = await this.client.shoukaku.joinVoiceChannel({
      guildId, channelId: voiceChannel.id, shardId, deaf: true,
    });

    const queue = new GuildQueue(voiceChannel.id, textChannelId);
    queue.player = player;
    this.queues.set(guildId, queue);
    this._attachPlayerEvents(guildId, player);
    return queue;
  }

  _attachPlayerEvents(guildId, player) {
    player.on('start', () => {
      const queue = this.queues.get(guildId);
      if (!queue) return;
      queue.playing = true;
      queue.paused  = false;
      this._updateTimestamps(queue, 0);
      this._startProgressUpdater(guildId);
    });

    player.on('end', (data) => {
      if (data?.reason === 'replaced') return;
      this._stopProgressUpdater(guildId);
      this._playNext(guildId);
    });

    player.on('exception', (data) => {
      console.error(`[MusicManager] exception (guild:${guildId}):`, data);
      this._stopProgressUpdater(guildId);
      this._sendToText(guildId, `播放錯誤：${data?.exception?.message ?? '未知'}，跳至下一首。`);
      this._playNext(guildId);
    });

    player.on('stuck', () => {
      this._stopProgressUpdater(guildId);
      this._sendToText(guildId, '播放卡住了，跳至下一首。');
      this._playNext(guildId);
    });

    player.on('closed', () => {
      this._stopProgressUpdater(guildId);
      this._destroyQueue(guildId);
    });
  }

  async _playNext(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue) return;

    if (queue.tracks.length === 0) {
      queue.playing = false;
      queue.current = null;
      this._stopProgressUpdater(guildId);
      // Mark old NP message as ended
      await this._updateNpMessage(guildId, { ended: true });
      this._sendToText(guildId, `隊列結束，${AUTO_LEAVE_MS / 1000} 秒後自動離開。`);
      queue.leaveTimer = setTimeout(() => this._destroyQueue(guildId), AUTO_LEAVE_MS);
      return;
    }

    queue.clearLeaveTimer();
    const track  = queue.tracks.shift();
    queue.current = track;
    queue.playing = true;

    try {
      await queue.player.playTrack({ track: { encoded: track.encoded } });
    } catch (err) {
      console.error(`[MusicManager] playTrack failed (guild:${guildId}):`, err);
      this._sendToText(guildId, '播放失敗，跳至下一首。');
      queue.current = null;
      this._playNext(guildId);
    }
  }

  // ─── Progress updater ──────────────────────────────────────────────────────

  _startProgressUpdater(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue) return;

    queue.clearProgressInterval();

    // Send initial now-playing message (replaces old one)
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

  /** Send a brand-new now-playing message (called when a new track starts). */
  async _sendFreshNowPlaying(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue?.current) return;

    // Delete old message if it still exists
    if (queue.npMessage) {
      queue.npMessage.delete().catch(() => {});
      queue.npMessage = null;
    }

    try {
      const channel = await this.client.channels.fetch(queue.textChannelId);
      if (!channel?.isTextBased()) return;

      const msg = await channel.send({
        embeds: [this._buildNpEmbed(queue)],
        components: this._buildNpComponents(queue),
      });
      queue.npMessage = msg;
    } catch (err) {
      console.warn(`[MusicManager] sendFreshNowPlaying (guild:${guildId}):`, err.message);
    }
  }

  /** Edit the existing now-playing message in place. */
  async _refreshNowPlaying(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue?.npMessage) return;

    try {
      await queue.npMessage.edit({
        embeds: [this._buildNpEmbed(queue)],
        components: this._buildNpComponents(queue),
      });
    } catch (err) {
      // Message was deleted — clear reference so we don't keep failing
      queue.npMessage = null;
      console.warn(`[MusicManager] refreshNowPlaying (guild:${guildId}):`, err.message);
    }
  }

  /** Update only the embed content (e.g. when track ends). */
  async _updateNpMessage(guildId, { ended = false } = {}) {
    const queue = this.queues.get(guildId);
    if (!queue?.npMessage) return;

    try {
      const embed = ended
        ? new EmbedBuilder().setTitle('播放結束').setColor(0x808080)
        : this._buildNpEmbed(queue);

      await queue.npMessage.edit({ embeds: [embed], components: [] });
      queue.npMessage = null;
    } catch {
      queue.npMessage = null;
    }
  }

  // ─── Timestamp helpers (client-side auto-update) ──────────────────────────

  /**
   * Recalculate the Discord Unix timestamps used for client-side countdown.
   * Call this whenever playback position changes (start, seek).
   * @param {GuildQueue} queue
   * @param {number} positionMs  Current playback position in ms
   */
  _updateTimestamps(queue, positionMs) {
    const duration = queue.current?.info?.length ?? 0;
    // Wall-clock second when position 0 was
    queue.effectiveStartUnix = Math.floor((Date.now() - positionMs) / 1000);
    // Wall-clock second when the track will end (at current playback speed)
    queue.estimatedEndUnix   = queue.effectiveStartUnix + Math.floor(duration / 1000);
  }

  // ─── Embed & component builders ───────────────────────────────────────────

  _buildNpEmbed(queue) {
    const { info } = queue.current;
    const position = queue.player.position;
    const duration = info.length;

    // <t:unix:R> is rendered and auto-updated every second on the Discord client
    // side — no API call needed. This gives the "live countdown" effect.
    const countdown = queue.estimatedEndUnix
      ? `<t:${queue.estimatedEndUnix}:R> 結束`
      : formatMs(duration - position);

    return new EmbedBuilder()
      .setTitle(queue.paused ? '⏸ 已暫停' : '▶ 正在播放')
      .setDescription(`**[${info.title}](${info.uri})**`)
      .addFields(
        { name: '作者',            value: info.author || '未知',      inline: true },
        { name: '總長',            value: formatMs(duration),         inline: true },
        { name: '⏱ 剩餘（即時）', value: countdown,                  inline: true },
        { name: '待播',            value: `${queue.tracks.length} 首`, inline: true },
        { name: '進度（每 2 秒）', value: buildProgressBar(position, duration) },
      )
      .setColor(queue.paused ? 0xffa500 : 0x1db954);
  }

  _buildNpComponents(queue) {
    const isStream = queue.current?.info?.isStream ?? false;

    // Row 1: control buttons
    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(BTN.RESTART)
        .setLabel('⏮')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isStream),
      new ButtonBuilder()
        .setCustomId(BTN.BACK)
        .setLabel('⏪ -30s')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isStream),
      new ButtonBuilder()
        .setCustomId(BTN.PAUSE)
        .setLabel(queue.paused ? '▶ 繼續' : '⏸ 暫停')
        .setStyle(queue.paused ? ButtonStyle.Success : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(BTN.FORWARD)
        .setLabel('+30s ⏩')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isStream),
      new ButtonBuilder()
        .setCustomId(BTN.SKIP)
        .setLabel('⏭ 跳過')
        .setStyle(ButtonStyle.Danger),
    );

    // Row 2: seek select menu (disabled for live streams)
    const duration = queue.current?.info?.length ?? 0;
    const options  = buildSeekOptions(queue.player.position, duration);

    const seekRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(BTN.SEEK_MENU)
        .setPlaceholder(isStream ? '直播無法跳轉' : '🎯 拖拉到指定時間點...')
        .setDisabled(isStream)
        .addOptions(options),
    );

    return [controlRow, seekRow];
  }

  // ─── Misc helpers ──────────────────────────────────────────────────────────

  async _destroyQueue(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue) return;

    queue.clearLeaveTimer();
    queue.clearProgressInterval();
    await this._updateNpMessage(guildId, { ended: true });
    this.queues.delete(guildId);

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
      const ch = await this.client.channels.fetch(queue.textChannelId);
      if (ch?.isTextBased()) await ch.send(message);
    } catch (err) {
      console.warn(`[MusicManager] sendToText (guild:${guildId}):`, err.message);
    }
  }

  _extractTracks(result) {
    switch (result.loadType) {
      case 'track':
        return { tracks: [result.data], replyMsg: `已加入隊列：**${result.data.info.title}**` };
      case 'playlist':
        return { tracks: result.data.tracks, replyMsg: `已加入播放清單：**${result.data.info.name}**（${result.data.tracks.length} 首）` };
      case 'search':
        return { tracks: [result.data[0]], replyMsg: `已加入隊列：**${result.data[0].info.title}**` };
      default:
        return { tracks: [], replyMsg: '' };
    }
  }
}

// ─── Pure utilities ────────────────────────────────────────────────────────

function parseTimeToMs(str) {
  str = str.trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10) * 1000;
  const m = str.match(/^(\d+):(\d{2})$/);
  if (m) return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
  return null;
}

function formatMs(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildProgressBar(position, duration, length = PROGRESS_BAR_LENGTH) {
  const ratio  = duration > 0 ? Math.min(position / duration, 1) : 0;
  const filled = Math.round(ratio * length);
  return `${'▬'.repeat(filled)}🔘${'▬'.repeat(length - filled)}\n\`${formatMs(position)} / ${formatMs(duration)}\``;
}

/**
 * Generate select menu options for seeking.
 * Produces up to 23 evenly-spaced timestamps covering the full duration,
 * with the current position marked as default.
 */
function buildSeekOptions(position, duration) {
  if (duration <= 0) {
    return [{ label: '0:00', value: '0', default: true }];
  }

  const COUNT = 23; // max 25 options; leave 2 for safety
  const step  = duration / COUNT;
  let closestIdx = 0;
  let closestDiff = Infinity;

  const options = Array.from({ length: COUNT }, (_, i) => {
    const posMs = Math.round(i * step);
    const pct   = Math.round((i / (COUNT - 1)) * 100);
    const diff  = Math.abs(posMs - position);
    if (diff < closestDiff) { closestDiff = diff; closestIdx = i; }
    return { label: `${formatMs(posMs)}  (${pct}%)`, value: String(posMs), default: false };
  });

  options[closestIdx].default = true;
  return options;
}

module.exports = MusicManager;
