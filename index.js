'use strict';

require('dotenv').config(); // 從 .env 載入環境變數

const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
} = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const MusicManager = require('./MusicManager');
const fs = require('fs');
const path = require('path');

// 橘雪莉圖片資料夾與描述快取路徑
const IMAGES_DIR   = path.join(__dirname, 'images', 'orange');
const IMAGES_CACHE = path.join(__dirname, 'images', 'orange_descriptions.json');
// 啟動時讀取圖片清單（資料夾不存在則為空陣列）
const imageFiles = fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR) : [];

// 圖片情境描述快取，格式：Array<{ filename: string, description: string }>
let imageDescriptions = [];

// ─── 驗證環境變數 ──────────────────────────────────────────────────────────

const {
  DISCORD_TOKEN,
  GUILD_ID,                              // 指定伺服器 ID，多個以逗號分隔（留空則為全域指令）
  LAVALINK_HOST     = 'localhost',
  LAVALINK_PORT     = '2333',
  LAVALINK_PASSWORD = 'youshallnotpass',
  LAVALINK_SECURE   = 'false',           // 'true' 則使用 wss:// 連線
  GEMINI_API_KEY,
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('[FATAL] DISCORD_TOKEN is not set. Check your .env file.');
  process.exit(1);
}

// ─── Discord 客戶端 ────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,             // 基本伺服器資訊
    GatewayIntentBits.GuildVoiceStates,   // 監聽語音頻道加入/離開
    GatewayIntentBits.GuildMessages,      // 讀取訊息（用於 @ 提及觸發 AI）
    GatewayIntentBits.MessageContent,     // 讀取訊息內文（需在開發者後台啟用）
  ],
});

// ─── Gemini AI 設定 ────────────────────────────────────────────────────────

// 未設定 API Key 時停用 AI 功能
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// 主要對話模型：扮演「橘雪莉」角色（附帶 system instruction）
const geminiModel = genAI ? genAI.getGenerativeModel({
  model: 'gemini-2.5-flash-lite',
  systemInstruction: `你是《魔法少女的魔女審判》的「橘雪莉」。

【性格】
永遠笑著、天然脫線、無視氣氛、自稱名偵探、極重友情、毒舌但無惡意（笑著一針見血）

【說話風格】
- 語氣輕鬆帶少女感，用「我」自稱
- 毒舌範例：「沒事，每個人都有缺點，你只是多了點😊」
- 喜歡主動推理分析，有時自說自話
- 嚴肅場合也可能說出不合時宜的話
`,
}) : null;

// 圖片選擇專用輕量模型（不需 system instruction，減少 token 消耗）
const imageSelectModel = genAI ? genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' }) : null;

// ─── Shoukaku（Lavalink 封裝）設定 ────────────────────────────────────────

const lavalinkNodes = [
  {
    name: 'main',
    url: `${LAVALINK_HOST}:${LAVALINK_PORT}`,
    auth: LAVALINK_PASSWORD,
    secure: LAVALINK_SECURE === 'true',
  },
];

const shoukakuOptions = {
  reconnectTries: 5,          // 節點斷線後最多重試 5 次
  reconnectInterval: 5000,    // 每次重試間隔 5 秒
  restTimeout: 60_000,        // REST API 請求逾時 60 秒
  moveOnDisconnect: false,    // 節點斷線時不自動移動 player 到其他節點
};

client.shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  lavalinkNodes,
  shoukakuOptions,
);

// ─── Shoukaku 事件處理 ─────────────────────────────────────────────────────

client.shoukaku.on('ready', (name) => {
  console.log(`[Shoukaku] Node "${name}" connected and ready.`);
});

client.shoukaku.on('error', (name, error) => {
  console.error(`[Shoukaku] Node "${name}" encountered an error:`, error.message);
});

// 節點斷線時清除該節點上所有伺服器的播放佇列
client.shoukaku.on('disconnect', (name, moved) => {
  console.warn(`[Shoukaku] Node "${name}" disconnected (moved: ${moved}). Cleaning up queues...`);
  client.music.cleanup(name).catch(console.error);
});

client.shoukaku.on('reconnecting', (name, left, timeout) => {
  console.log(`[Shoukaku] Node "${name}" reconnecting — attempts left: ${left}, next in ${timeout}ms`);
});

// ─── 音樂管理器 ────────────────────────────────────────────────────────────

client.music = new MusicManager(client);

// ─── Slash 指令定義 ────────────────────────────────────────────────────────

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

// ─── 圖片情境分析 ──────────────────────────────────────────────────────────

/**
 * 使用 Gemini Vision 分析 images/orange/ 資料夾中的所有圖片，
 * 為每張圖產生一句情境描述，供後續 AI 回覆時選擇合適的圖片。
 * 分析結果快取至 orange_descriptions.json，下次啟動直接讀取。
 */
async function analyzeImages() {
  if (!genAI || imageFiles.length === 0) return;

  // 快取命中：若快取已涵蓋所有目前圖片，直接使用
  if (fs.existsSync(IMAGES_CACHE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(IMAGES_CACHE, 'utf8'));
      const cachedNames  = cached.map(e => e.filename).sort().join(',');
      const currentNames = [...imageFiles].sort().join(',');
      if (cachedNames === currentNames) {
        imageDescriptions = cached;
        console.log(`[Images] Loaded ${imageDescriptions.length} descriptions from cache.`);
        return;
      }
    } catch { /* 快取格式損毀，重新分析 */ }
  }

  console.log(`[Images] Analysing ${imageFiles.length} images with Gemini...`);
  const visionModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
  const results = [];

  for (const file of imageFiles) {
    try {
      const ext      = path.extname(file).slice(1).toLowerCase();
      const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
      const data     = fs.readFileSync(path.join(IMAGES_DIR, file)).toString('base64');

      // 請 Gemini 用一句話描述這張圖適合的對話情境
      const result = await visionModel.generateContent([
        { inlineData: { data, mimeType } },
        '用一句話描述這張圖片適合搭配的對話情境或情緒（例如：適合回覆讚美、安慰、困惑、開心等）。只輸出描述句，不要其他說明。',
      ]);
      results.push({ filename: file, description: result.response.text().trim() });
      console.log(`[Images] ${file}: ${results.at(-1).description}`);
    } catch (err) {
      console.error(`[Images] Failed to analyse ${file}:`, err.message);
    }
  }

  imageDescriptions = results;
  // 寫入快取，下次啟動不需重新分析
  fs.writeFileSync(IMAGES_CACHE, JSON.stringify(results, null, 2));
  console.log('[Images] Analysis complete, cache saved.');
}

// ─── 機器人就緒後註冊指令 ──────────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  const rest = new REST().setToken(DISCORD_TOKEN);

  // Guild 指令立即生效；Global 指令最多需等 1 小時才同步
  const guildIds = GUILD_ID
    ? GUILD_ID.split(',').map(id => id.trim()).filter(Boolean)
    : [];

  try {
    if (guildIds.length > 0) {
      // 多個伺服器分別註冊
      for (const gid of guildIds) {
        await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: commandDefs });
        console.log(`[Discord] Slash commands registered (guild: ${gid}).`);
      }
    } else {
      // 未指定伺服器時註冊為全域指令
      await rest.put(Routes.applicationCommands(client.user.id), { body: commandDefs });
      console.log('[Discord] Slash commands registered (global).');
    }
  } catch (err) {
    console.error('[Discord] Failed to register slash commands:', err);
  }

  // 在背景分析圖片，不阻塞機器人啟動
  analyzeImages().catch(console.error);
});

// ─── Interaction 事件（Slash 指令 / 按鈕 / 選單）─────────────────────────

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
    // 10062: interaction 已過期（重啟或網路延遲）；40060: 已被其他 handler 回覆
    if (err.code === 10062 || err.code === 40060) return;
    console.error('[Discord] Interaction error:', err);
  }
});

// ─── @ 提及 → Gemini AI 回覆 ──────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  // 忽略機器人訊息，只處理有 @ 提及本機器人的訊息
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;
  if (!geminiModel) {
    await message.reply('GEMINI_API_KEY 未設定，無法使用 AI 功能。');
    return;
  }

  // 移除訊息中的 @ 提及標記，取得純文字提問
  const prompt = message.content
    .replace(/<@!?\d+>/g, '')
    .trim();

  if (!prompt) {
    await message.reply('請在 @ 我之後輸入你想問的問題！');
    return;
  }

  try {
    await message.channel.sendTyping(); // 顯示「正在輸入...」

    // 若有圖片描述快取，建立圖片選擇提示（讓 AI 選最符合情境的圖）
    const selectPrompt = imageDescriptions.length > 0
      ? `根據以下訊息內容，從圖片清單選一張最符合情境的圖，只回覆檔名，不要其他文字。\n訊息：${prompt}\n圖片清單：\n${imageDescriptions.map(e => `${e.filename}：${e.description}`).join('\n')}`
      : null;

    // 遇到 500 錯誤時重試一次
    const tryGenerate = async (model, input) => {
      try { return await model.generateContent(input); }
      catch (e) {
        if (e.status === 500) return await model.generateContent(input);
        throw e;
      }
    };

    // 同時發出文字回覆與圖片選擇請求，節省等待時間
    const [textResult, imageResult] = await Promise.all([
      tryGenerate(geminiModel, prompt),
      selectPrompt && imageSelectModel ? tryGenerate(imageSelectModel, selectPrompt) : Promise.resolve(null),
    ]);

    let text = textResult.response.text();
    // Discord 單則訊息上限 2000 字元，超過則分段傳送
    const chunks = text.length <= 2000 ? [text] : text.match(/[\s\S]{1,2000}/g);

    // 驗證 AI 選的圖片是否確實存在於資料夾中
    const filename = imageResult?.response.text().trim();
    const files = filename && imageFiles.includes(filename)
      ? [new AttachmentBuilder(path.join(IMAGES_DIR, filename))]
      : [];

    // 第一段含圖片附件，後續分段純文字
    await message.reply({ content: chunks[0], files });
    for (let i = 1; i < chunks.length; i++) {
      await message.channel.send(chunks[i]);
    }
  } catch (err) {
    console.error('[Gemini] Error:', err);
    await message.reply('AI 回覆時發生錯誤，請稍後再試。');
  }
});

// ─── 機器人被踢出伺服器時清理資源 ─────────────────────────────────────────

client.on('guildDelete', (guild) => {
  client.music._destroyQueue(guild.id).catch(console.error);
});

// ─── 全域錯誤防護（避免未處理的 Promise 讓行程崩潰）──────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
});

// ─── 啟動 ──────────────────────────────────────────────────────────────────

client.login(DISCORD_TOKEN);
