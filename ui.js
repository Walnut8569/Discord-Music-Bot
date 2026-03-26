'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const { buildProgressBar, getComputedPosition } = require('./utils');

// Button custom ID constants (must match MusicManager.js BTN object)
const BTN = {
  FAV:     'np_fav',
  RESTART: 'np_restart',
  PAUSE:   'np_pause',
  SKIP:    'np_skip',
  LOOP:    'np_loop',
};

/**
 * Build the now-playing embed.
 * @param {import('./GuildQueue')} queue
 * @returns {EmbedBuilder}
 */
function buildNpEmbed(queue) {
  const { info } = queue.current;
  const position = getComputedPosition(queue);
  const duration = info.length;

  const progressBar = buildProgressBar(position, duration);
  const description = info.author
    ? `**${info.author}**\n\n${progressBar}`
    : progressBar;

  const embed = new EmbedBuilder()
    .setAuthor({ name: queue.paused ? 'Paused' : 'Now Playing' })
    .setTitle(info.title)
    .setURL(info.uri)
    .setDescription(description)
    .setFooter({ text: `${queue.tracks.length} in queue${{ OFF: '', TRACK: '  •  🔁 單曲', QUEUE: '  •  🔁 全部' }[queue.loopMode] ?? ''}${queue.current.requester ? `  •  點播：${queue.current.requester.displayName}` : ''}` })
    .setColor(queue.paused ? 0xffa500 : 0x1db954);

  if (info.sourceName === 'youtube' && info.identifier) {
    embed.setImage(`https://img.youtube.com/vi/${info.identifier}/hqdefault.jpg`);
  }

  return embed;
}

/**
 * Build the control buttons row.
 * @param {import('./GuildQueue')} queue
 * @returns {ActionRowBuilder[]}
 */
function buildNpComponents(queue) {
  const isStream = queue.current?.info?.isStream ?? false;

  const loopStyles = { OFF: ButtonStyle.Secondary, TRACK: ButtonStyle.Primary, QUEUE: ButtonStyle.Success };
  const loopLabels = { OFF: '↺', TRACK: '↺¹', QUEUE: '↺∞' };

  // ❤️ ⏮ ⏸/▶ ⏭ 🔁  (max 5 buttons per ActionRow)
  const controlRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN.FAV)
      .setLabel('♡')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN.RESTART)
      .setLabel('⏮')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isStream),
    new ButtonBuilder()
      .setCustomId(BTN.PAUSE)
      .setLabel(queue.paused ? '▶' : '⏸')
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

  if (queue.tracks.length > 0) {
    const options = queue.tracks.slice(0, 25).map((track, i) => ({
      label: track.info.title.length > 100 ? track.info.title.slice(0, 97) + '...' : track.info.title,
      description: track.requester ? `點播：${track.requester.displayName}` : undefined,
      value: String(i),
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
