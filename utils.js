'use strict';

const PROGRESS_BAR_LENGTH = 19;

/**
 * Format milliseconds to m:ss string.
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
 * Build a music-player-style progress bar.
 * Example: `1:23` ━━━━━━━━━●━━━━━━━━━ `5:54`
 * @param {number} position  Current position in ms
 * @param {number} duration  Total duration in ms
 * @param {number} [length]  Number of ━ chars (excluding ●)
 * @returns {string}
 */
function buildProgressBar(position, duration, length = PROGRESS_BAR_LENGTH) {
  const ratio  = duration > 0 ? Math.min(position / duration, 1) : 0;
  const filled = Math.round(ratio * length);
  const bar    = '━'.repeat(filled) + '●' + '━'.repeat(length - filled);
  return `\`${formatMs(position)}\` ${bar} \`${formatMs(duration)}\``;
}

/**
 * Compute the current playback position from wall-clock timestamps.
 * More accurate than queue.player.position (which only updates every 5 s).
 * @param {import('./GuildQueue')} queue
 * @returns {number} Position in ms
 */
function getComputedPosition(queue) {
  if (!queue.effectiveStartUnix) return 0;
  if (queue.paused) return queue.pausedPositionMs ?? 0;
  return Math.min(
    Date.now() - queue.effectiveStartUnix * 1000,
    queue.current?.info?.length ?? 0,
  );
}

module.exports = { formatMs, buildProgressBar, getComputedPosition };
