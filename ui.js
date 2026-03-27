'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const { buildProgressBar, getComputedPosition } = require('./utils');

// NP 訊息上各按鈕的 custom ID 常數（必須與 MusicManager.js 的 BTN 物件一致）
const BTN = {
  FAV:     'np_fav',     // 加入最愛
  RESTART: 'np_restart', // 從頭播放
  PAUSE:   'np_pause',   // 暫停 / 繼續
  SKIP:    'np_skip',    // 跳過
  LOOP:    'np_loop',    // 切換循環模式
};

/**
 * 建立 Now Playing embed 訊息。
 * 包含曲名、作者、進度條、縮圖、頁尾（佇列數、循環模式、點播者）。
 * @param {import('./GuildQueue')} queue
 * @returns {EmbedBuilder}
 */
function buildNpEmbed(queue) {
  const { info } = queue.current;
  const position = getComputedPosition(queue); // 當前播放位置（毫秒）
  const duration = info.length;                // 曲目總長度（毫秒）

  const progressBar = buildProgressBar(position, duration);
  // 有作者名稱時顯示於進度條上方，否則只顯示進度條
  const description = info.author
    ? `**${info.author}**\n\n${progressBar}`
    : progressBar;

  const embed = new EmbedBuilder()
    .setAuthor({ name: queue.paused ? 'Paused' : 'Now Playing' })
    .setTitle(info.title)
    .setURL(info.uri)
    .setDescription(description)
    // 頁尾：佇列數量 + 循環模式圖示 + 點播者
    .setFooter({ text: `${queue.tracks.length} in queue${{ OFF: '', TRACK: '  •  🔁 單曲', QUEUE: '  •  🔁 全部' }[queue.loopMode] ?? ''}${queue.current.requester ? `  •  點播：${queue.current.requester.displayName}` : ''}` })
    // 暫停中顯示橘色，播放中顯示 Spotify 綠
    .setColor(queue.paused ? 0xffa500 : 0x1db954);

  // 僅 YouTube 來源才有縮圖 URL
  if (info.sourceName === 'youtube' && info.identifier) {
    embed.setImage(`https://img.youtube.com/vi/${info.identifier}/hqdefault.jpg`);
  }

  return embed;
}

/**
 * 建立 NP 訊息的控制元件（按鈕列 + 佇列選單）。
 * Discord 每個 ActionRow 最多 5 個按鈕，最多 5 個 ActionRow。
 * @param {import('./GuildQueue')} queue
 * @returns {ActionRowBuilder[]}
 */
function buildNpComponents(queue) {
  const isStream = queue.current?.info?.isStream ?? false;

  // 循環模式對應的按鈕樣式與標籤
  const loopStyles = { OFF: ButtonStyle.Secondary, TRACK: ButtonStyle.Primary, QUEUE: ButtonStyle.Success };
  const loopLabels = { OFF: '↺', TRACK: '↺¹', QUEUE: '↺∞' };

  // 第一列：♡（最愛） ⏮（重頭） ⏸/▶（暫停/繼續） ⏭（跳過） ↺（循環）
  const controlRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN.FAV)
      .setLabel('♡')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN.RESTART)
      .setLabel('⏮')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isStream), // 直播不可 seek，禁用重頭按鈕
    new ButtonBuilder()
      .setCustomId(BTN.PAUSE)
      .setLabel(queue.paused ? '▶' : '⏸')   // 根據狀態切換圖示
      .setStyle(queue.paused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(BTN.SKIP)
      .setLabel('⏭')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN.LOOP)
      .setLabel(loopLabels[queue.loopMode] ?? '🔁')
      .setStyle(loopStyles[queue.loopMode] ?? ButtonStyle.Secondary),
  );

  const components = [controlRow];

  // 有待播曲目時才顯示佇列下拉選單（最多顯示 25 首，Discord 限制）
  if (queue.tracks.length > 0) {
    const options = queue.tracks.slice(0, 25).map((track, i) => ({
      // 標題超過 100 字元時截斷（Discord 選項 label 上限）
      label: track.info.title.length > 100 ? track.info.title.slice(0, 97) + '...' : track.info.title,
      description: track.requester ? `點播：${track.requester.displayName}` : undefined,
      value: String(i), // value 用於 handleSelectMenu 識別選取的索引
    }));

    const queueMenu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('np_queue_select')
        .setPlaceholder(`Queue（${queue.tracks.length} 首）— 選歌直接跳播`)
        .addOptions(options),
    );

    components.push(queueMenu);
  }

  return components;
}

module.exports = { buildNpEmbed, buildNpComponents };
