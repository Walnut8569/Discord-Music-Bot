'use strict';

// 進度條的字元總長度（不含 ● 符號）
const PROGRESS_BAR_LENGTH = 19;

/**
 * 將毫秒數格式化為 m:ss 字串。
 * 例：90000 → "1:30"
 * @param {number} ms
 * @returns {string}
 */
function formatMs(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * 產生音樂播放器風格的進度條字串。
 * 範例輸出：`1:23` ━━━━━━━━━●━━━━━━━━━ `5:54`
 * @param {number} position  目前播放位置（毫秒）
 * @param {number} duration  曲目總長度（毫秒）
 * @param {number} [length]  ━ 字元的總數（不含 ●，預設 19）
 * @returns {string}
 */
function buildProgressBar(position, duration, length = PROGRESS_BAR_LENGTH) {
  // 計算進度比例，最大為 1（避免超過結尾）
  const ratio  = duration > 0 ? Math.min(position / duration, 1) : 0;
  const filled = Math.round(ratio * length);
  // 前段已播 ━，指示點 ●，後段未播 ━
  const bar    = '━'.repeat(filled) + '●' + '━'.repeat(length - filled);
  return `\`${formatMs(position)}\` ${bar} \`${formatMs(duration)}\``;
}

/**
 * 根據 wall-clock 時間計算當前播放位置，精度高於 Shoukaku 的 player.position
 * （後者每 5 秒才更新一次）。
 * @param {import('./GuildQueue')} queue
 * @returns {number} 目前播放位置（毫秒）
 */
function getComputedPosition(queue) {
  if (!queue.effectiveStartUnix) return 0;
  // 暫停中：直接回傳暫停時記錄的位置
  if (queue.paused) return queue.pausedPositionMs ?? 0;
  // 播放中：用現在時間減去「位置為 0 時的 wall-clock」
  return Math.min(
    Date.now() - queue.effectiveStartUnix * 1000,
    queue.current?.info?.length ?? 0,
  );
}

module.exports = { formatMs, buildProgressBar, getComputedPosition };
