'use strict';

class GuildQueue {
  /**
   * @param {string} voiceChannelId
   * @param {string} textChannelId
   */
  constructor(voiceChannelId, textChannelId) {
    this.voiceChannelId = voiceChannelId;
    this.textChannelId  = textChannelId;
    /** @type {import('shoukaku').Player|null} */
    this.player  = null;
    /** @type {Array<{encoded:string, info:object}>} */
    this.tracks  = [];
    /** @type {{encoded:string, info:object}|null} */
    this.current = null;
    this.playing = false;
    this.paused  = false;
    /** Wall-clock Unix second when playback position was 0 */
    this.effectiveStartUnix = null;
    /** Playback position (ms) recorded at the moment of pause */
    this.pausedPositionMs   = null;
    /** @type {import('discord.js').Message|null} */
    this.npMessage        = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.progressInterval = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.leaveTimer       = null;
    /** Prevent concurrent NP update requests from piling up */
    this.npUpdating       = false;
    /** Consecutive NP update failures; progress updater stops after MAX_NP_ERRORS */
    this.npErrorCount     = 0;
  }

  clearLeaveTimer() {
    if (this.leaveTimer) { clearTimeout(this.leaveTimer); this.leaveTimer = null; }
  }

  clearProgressInterval() {
    if (this.progressInterval) { clearInterval(this.progressInterval); this.progressInterval = null; }
  }
}

module.exports = GuildQueue;
