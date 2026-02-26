# Discord Music Bot

discord.js v14 + Shoukaku + Lavalink 寫的音樂 bot。

## 使用

| 指令 | 說明 |
|---|---|
| `/play <URL 或關鍵字>` | 播放 YouTube 音樂，支援單曲、播放清單、關鍵字搜尋 |
| `/clear` | 清空待播佇列（不中斷目前曲目） |

播放中會有一則 Now Playing 訊息，上面有進度條和控制按鈕（重播、後退 10 秒、暫停、前進 10 秒、跳過）。有待播清單的話會附上選單可以直接跳播。隊列空了之後 30 秒自動離開。

## 跑起來

需要先有 Java 21 和一個跑著的 Lavalink。

```bash
# 啟動 Lavalink（需先把 Lavalink.jar 和 youtube-source 插件放進 lavalink/）
./lavalink/start.sh

# 安裝依賴
npm install

# 複製 .env 並填入設定
cp .env.example .env

# 啟動 bot
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

下載 `youtube-plugin-x.x.x.jar` 放入後重啟 Lavalink 即可。插件版本在 `application.yml` 的 `lavalink.plugins` 區段設定，目前使用 `1.17.0`。

## 檔案結構

```
index.js          # 入口，Discord client + Shoukaku 初始化、指令路由
MusicManager.js   # 播放邏輯、隊列管理
GuildQueue.js     # 每個伺服器的播放狀態
ui.js             # Now Playing embed 和按鈕
utils.js          # 進度條、時間格式化
application.yml   # Lavalink 設定
```
