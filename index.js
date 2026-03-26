'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const MusicManager = require('./MusicManager');

// ─── Validate environment ──────────────────────────────────────────────────

const {
  DISCORD_TOKEN,
  GUILD_ID,
  LAVALINK_HOST = 'localhost',
  LAVALINK_PORT = '2333',
  LAVALINK_PASSWORD = 'youshallnotpass',
  LAVALINK_SECURE = 'false',
  GEMINI_API_KEY,
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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Gemini AI ─────────────────────────────────────────────────────────────

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const geminiModel = genAI ? genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }) : null;

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
    .setName('clear')
    .setDescription('清空待播佇列'),

  new SlashCommandBuilder()
    .setName('lucifer31415926536')
    .setDescription('100%juice is gay'),

  new SlashCommandBuilder()
    .setName('playfav')
    .setDescription('播放最愛歌曲'),

].map((cmd) => cmd.toJSON());

// ─── Register commands on ready ────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  const rest = new REST().setToken(DISCORD_TOKEN);

  // Guild commands update instantly; global commands take up to 1 hour.
  const guildIds = GUILD_ID
    ? GUILD_ID.split(',').map(id => id.trim()).filter(Boolean)
    : [];

  try {
    if (guildIds.length > 0) {
      for (const gid of guildIds) {
        await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: commandDefs });
        console.log(`[Discord] Slash commands registered (guild: ${gid}).`);
      }
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commandDefs });
      console.log('[Discord] Slash commands registered (global).');
    }
  } catch (err) {
    console.error('[Discord] Failed to register slash commands:', err);
  }
});

// ─── Interaction handler ───────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'play':               await client.music.handlePlay(interaction);    break;
        case 'clear':              await client.music.handleClear(interaction);   break;
        case 'lucifer31415926536': await client.music.handleLucifer(interaction);  break;
        case 'playfav':            await client.music.handlePlayFav(interaction); break;
      }
    } else if (interaction.isButton()) {
      await client.music.handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await client.music.handleSelectMenu(interaction);
    }
  } catch (err) {
    // 10062: interaction expired before the bot could respond (expected on restart / network lag)
    // 40060: interaction already acknowledged by a concurrent handler
    if (err.code === 10062 || err.code === 40060) return;
    console.error('[Discord] Interaction error:', err);
  }
});

// ─── Mention → Gemini reply ────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  // Ignore bots and messages that don't mention this bot
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;
  if (!geminiModel) {
    await message.reply('GEMINI_API_KEY 未設定，無法使用 AI 功能。');
    return;
  }

  // Strip the mention from the message content
  const prompt = message.content
    .replace(/<@!?\d+>/g, '')
    .trim();

  if (!prompt) {
    await message.reply('請在 @ 我之後輸入你想問的問題！');
    return;
  }

  try {
    await message.channel.sendTyping();
    const result = await geminiModel.generateContent(prompt);
    const text = result.response.text();

    // Discord messages are limited to 2000 characters
    if (text.length <= 2000) {
      await message.reply(text);
    } else {
      // Split into chunks
      const chunks = text.match(/[\s\S]{1,2000}/g);
      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    }
  } catch (err) {
    console.error('[Gemini] Error:', err);
    await message.reply('AI 回覆時發生錯誤，請稍後再試。');
  }
});

// ─── Guild delete cleanup ──────────────────────────────────────────────────

client.on('guildDelete', (guild) => {
  client.music._destroyQueue(guild.id).catch(console.error);
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
