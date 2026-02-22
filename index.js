'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const MusicManager = require('./MusicManager');

// ─── Validate environment ──────────────────────────────────────────────────

const {
  DISCORD_TOKEN,
  GUILD_ID,
  LAVALINK_HOST = 'localhost',
  LAVALINK_PORT = '2333',
  LAVALINK_PASSWORD = 'youshallnotpass',
  LAVALINK_SECURE = 'false',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('[FATAL] DISCORD_TOKEN is not set. Check your .env file.');
  process.exit(1);
}

// ─── Discord client ────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ─── Shoukaku (Lavalink wrapper) ───────────────────────────────────────────

const lavalinkNodes = [
  {
    name: 'main',
    url: `${LAVALINK_HOST}:${LAVALINK_PORT}`,
    auth: LAVALINK_PASSWORD,
    secure: LAVALINK_SECURE === 'true',
  },
];

const shoukakuOptions = {
  /** Reconnect up to 5 times before giving up on a node */
  reconnectTries: 5,
  /** Wait 5 s between reconnect attempts */
  reconnectInterval: 5000,
  /** REST request timeout in ms */
  restTimeout: 60_000,
  /** Move players to another node when the current one disconnects */
  moveOnDisconnect: false,
};

client.shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  lavalinkNodes,
  shoukakuOptions,
);

// ─── Shoukaku event handlers ───────────────────────────────────────────────

client.shoukaku.on('ready', (name) => {
  console.log(`[Shoukaku] Node "${name}" connected and ready.`);
});

client.shoukaku.on('error', (name, error) => {
  console.error(`[Shoukaku] Node "${name}" encountered an error:`, error.message);
});

client.shoukaku.on('disconnect', (name, moved) => {
  console.warn(`[Shoukaku] Node "${name}" disconnected (moved: ${moved}). Cleaning up queues...`);
  client.music.cleanup(name).catch(console.error);
});

client.shoukaku.on('reconnecting', (name, left, timeout) => {
  console.log(`[Shoukaku] Node "${name}" reconnecting — attempts left: ${left}, next in ${timeout}ms`);
});

// ─── Music manager ─────────────────────────────────────────────────────────

client.music = new MusicManager(client);

// ─── Slash command definitions ─────────────────────────────────────────────

const commandDefs = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('播放 YouTube 音樂')
    .addStringOption((opt) =>
      opt
        .setName('url')
        .setDescription('YouTube URL 或搜尋關鍵字')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('seek')
    .setDescription('跳至指定時間點')
    .addStringOption((opt) =>
      opt
        .setName('time')
        .setDescription('秒數（如 90）或 mm:ss（如 1:30）')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('顯示目前播放進度'),
].map((cmd) => cmd.toJSON());

// ─── Register commands on ready ────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  const rest = new REST().setToken(DISCORD_TOKEN);

  // Guild commands update instantly; global commands take up to 1 hour.
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(client.user.id, GUILD_ID)
    : Routes.applicationCommands(client.user.id);

  try {
    await rest.put(route, { body: commandDefs });
    console.log(`[Discord] Slash commands registered (${GUILD_ID ? `guild: ${GUILD_ID}` : 'global'}).`);
  } catch (err) {
    console.error('[Discord] Failed to register slash commands:', err);
  }
});

// ─── Interaction handler ───────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'play':       await client.music.handlePlay(interaction);       break;
        case 'seek':       await client.music.handleSeek(interaction);       break;
        case 'nowplaying': await client.music.handleNowPlaying(interaction); break;
      }
    } else if (interaction.isButton()) {
      await client.music.handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await client.music.handleSelectMenu(interaction);
    }
  } catch (err) {
    console.error('[Discord] Interaction error:', err);
  }
});

// ─── Global error guards (prevent crashes from unhandled rejections) ───────

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
});

// ─── Start ─────────────────────────────────────────────────────────────────

client.login(DISCORD_TOKEN);
