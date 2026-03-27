'use strict';

/**
 * 代表單一伺服器（Guild）的音樂播放佇列與狀態。
 * 每個有音樂播放的伺服器會各持有一個 GuildQueue 實例。
 */
class GuildQueue {
  /**
   * @param {string} voiceChannelId  機器人加入的語音頻道 ID
   * @param {string} textChannelId   傳送 NP 訊息的文字頻道 ID
   */
  constructor(voiceChannelId, textChannelId) {
    this.voiceChannelId = voiceChannelId;
    this.textChannelId  = textChannelId;

    /** @type {import('shoukaku').Player|null} Lavalink 播放器實例 */
    this.player  = null;
    /** @type {Array<{encoded:string, info:object}>} 待播曲目陣列 */
    this.tracks  = [];
    /** @type {{encoded:string, info:object}|null} 當前播放中的曲目 */
    this.current = null;

    /** 是否正在播放 */
    this.playing = false;
    /** 是否已暫停 */
    this.paused  = false;

    /**
     * 播放位置為 0 時的 Unix 秒數（wall-clock）。
     * 用於計算當前進度：position = now - effectiveStartUnix * 1000
     */
    this.effectiveStartUnix = null;
    /** 暫停當下記錄的播放位置（毫秒），繼續播放時用來還原時間戳 */
    this.pausedPositionMs   = null;

    /** @type {import('discord.js').Message|null} 目前頻道中的 Now Playing 訊息 */
    this.npMessage        = null;
    /** @type {ReturnType<typeof setInterval>|null} 進度條定期更新的 interval */
    this.progressInterval = null;
    /** @type {ReturnType<typeof setTimeout>|null} 無人使用後自動離開的 timeout */
    this.leaveTimer       = null;

    /** 防止同時發出多個 NP 更新請求（避免 Discord API rate limit） */
    this.npUpdating   = false;
    /** 連續 NP 更新失敗次數，達到上限後暫停更新 */
    this.npErrorCount = 0;

    /** 循環模式：'OFF'（不循環）| 'TRACK'（單曲）| 'QUEUE'（整列） */
    this.loopMode = 'OFF';
    /**
     * 當前曲目是否為主動跳過。
     * true 時 _playNext 不會將剛播完的曲目重新插入佇列（即使循環模式開啟）。
     */
    this.skipping = false;
    /**
     * 防止 _playNext 同時被多個事件觸發（例如 end + exception 同時發生）。
     * true 時新的 _playNext 呼叫會直接 return。
     */
    this.advancing = false;
  }

  /** 清除自動離開計時器 */
  clearLeaveTimer() {
    if (this.leaveTimer) { clearTimeout(this.leaveTimer); this.leaveTimer = null; }
  }

  /** 清除進度條更新 interval */
  clearProgressInterval() {
    if (this.progressInterval) { clearInterval(this.progressInterval); this.progressInterval = null; }
  }
}

module.exports = GuildQueue;
