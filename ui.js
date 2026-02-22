'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { buildProgressBar, getComputedPosition } = require('./utils');

// Button custom ID constants (must match MusicManager.js BTN object)
const BTN = {
  RESTART:  'np_restart',
  BACK:     'np_back',
  PAUSE:    'np_pause',
  FORWARD:  'np_forward',
  SKIP:     'np_skip',
  STOP:     'np_stop',
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
    .setAuthor({ name: queue.paused ? '⏸  Paused' : '▶  Now Playing' })
    .setTitle(info.title)
    .setURL(info.uri)
    .setDescription(description)
    .setFooter({ text: `♫  ${queue.tracks.length} in queue` })
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

  const controlRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN.RESTART)
      .setLabel('⏮')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isStream),
    new ButtonBuilder()
      .setCustomId(BTN.BACK)
      .setLabel('↺')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isStream),
    new ButtonBuilder()
      .setCustomId(BTN.PAUSE)
      .setLabel(queue.paused ? '▶' : '⏸')
      .setStyle(queue.paused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(BTN.FORWARD)
      .setLabel('↻')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isStream),
    new ButtonBuilder()
      .setCustomId(BTN.SKIP)
      .setLabel('⏭')
      .setStyle(ButtonStyle.Danger),
  );

  return [controlRow];
}

module.exports = { buildNpEmbed, buildNpComponents };
