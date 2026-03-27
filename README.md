# Discord Music Bot

discord.js v14 + Shoukaku + Lavalink 寫的音樂 bot，附帶橘雪莉 AI 對話功能。

## 指令

| 指令 | 說明 |
|---|---|
| `/play <URL 或關鍵字>` | 播放 YouTube 音樂，支援單曲、播放清單、關鍵字搜尋 |
| `/clear` | 清空待播佇列（不中斷目前曲目） |
| `/playfav` | 將你的最愛歌單打亂後全部加入佇列 |

## Now Playing

播放中會出現一則 Now Playing 訊息，包含進度條、封面圖和控制按鈕：

| 按鈕 | 功能 |
|---|---|
| `♡` | 將目前歌曲加入你的最愛歌單 |
| `⏮` | 跳回歌曲開頭 |
| `⏸` / `▶` | 暫停 / 繼續 |
| `⏭` | 跳過目前曲目 |
| `↺` / `↺¹` / `↺∞` | 循環模式：關閉 / 單曲循環 / 全部循環 |

有待播清單的話會附上選單，可以直接跳播任意一首。佇列空了之後 30 秒自動離開。

## 最愛歌單

每位用戶都有自己的最愛歌單，儲存在 `favorites.json`。

- 播放中按 `♡` 將目前歌曲加入歌單（重複加會提示已存在）
- `/playfav` 將整個歌單隨機打亂後加入目前佇列

## 橘雪莉 AI（@ 提及）

設定 `GEMINI_API_KEY` 後，@ 提及機器人即可與橘雪莉對話。

- 使用 **Gemini 2.5 Flash Lite** 模型
- 角色設定為《魔法少女的魔女審判》的橘雪莉：天然脫線、毒舌但無惡意、自稱名偵探
- 若 `images/orange/` 資料夾中有圖片，bot 啟動時會用 Gemini Vision 自動分析每張圖的情境，回覆時自動附上最符合當下對話氣氛的圖片
- 圖片分析結果快取於 `images/orange_descriptions.json`，重啟時若圖片未變動則直接讀取快取

## 跑起來

需要先有 Java 21 和一個跑著的 Lavalink。

```bash
# 安裝依賴
npm install

# 複製 .env 並填入設定
cp .env.example .env

# 啟動 Lavalink + bot（用 PM2 管理，推薦）
# ecosystem.config.js 不納入版控，請參考下方「檔案結構」自行建立
pm2 start ecosystem.config.js

# 或手動分別啟動
./lavalink/start.sh   # 需先把 Lavalink.jar 和 youtube-source 插件放進 lavalink/
npm start
```

`.env` 裡需要填的東西：

```env
DISCORD_TOKEN=
GUILD_ID=              # 填了是伺服器指令（即時生效），不填是全域指令（最慢 1 小時）
                       # 可用逗號分隔多個伺服器 ID，例如：123456789,987654321
LAVALINK_HOST=localhost
LAVALINK_PORT=2333
LAVALINK_PASSWORD=youshallnotpass
LAVALINK_SECURE=false
GEMINI_API_KEY=        # 選填，填了可以 @ bot 與橘雪莉對話（Gemini 2.5 Flash Lite）
```

密碼要跟 `application.yml` 裡的 `password` 一致。

## Lavalink 設定（application.yml）

Lavalink 的設定檔已包含在 `application.yml`，主要項目：

| 項目 | 預設值 | 說明 |
|---|---|---|
| `server.port` | `2333` | 監聽埠，需與 `LAVALINK_PORT` 一致 |
| `server.address` | `0.0.0.0` | 監聽位址 |
| `lavalink.server.password` | `youshallnotpass` | 需與 `LAVALINK_PASSWORD` 一致 |
| `lavalink.server.sources.youtube` | `false` | 由 youtube-source 插件接管，保持 false |
| `opusEncodingQuality` | `10` | 音質（0–10），越高 CPU 用量越大 |
| `resamplingQuality` | `HIGH` | 重採樣品質（LOW / MEDIUM / HIGH） |
| `bufferDurationMs` | `400` | 緩衝時間，網路較差可調高 |
| `frameBufferDurationMs` | `5000` | 幀緩衝，出現卡頓可調高 |

### YouTube 插件

youtube-source 插件需手動下載放進 `lavalink/plugins/`：

```
https://github.com/lavalink-devtools/youtube-source/releases
```

下載 `youtube-plugin-x.x.x.jar` 放入後重啟 Lavalink 即可。

## 檔案結構

```
index.js          # 入口：Discord client、Shoukaku 初始化、指令路由、AI 對話
MusicManager.js   # 播放邏輯、佇列管理、按鈕處理、最愛功能
GuildQueue.js     # 每個伺服器的播放狀態資料結構
ui.js             # Now Playing embed 和控制按鈕
utils.js          # 進度條、時間格式化
favorites.js      # 最愛歌單讀寫
application.yml   # Lavalink 設定
```

以下檔案不納入版控（已加入 `.gitignore`），需自行建立：

```
.env                            # 環境變數（Token、API Key 等）
ecosystem.config.js             # PM2 設定（含機器路徑，各環境不同）
favorites.json                  # 最愛歌單資料（執行時自動產生）
images/orange/                  # 橘雪莉回覆用圖片（選填，自行放入）
images/orange_descriptions.json # 圖片情境描述快取（啟動時自動產生）
```
