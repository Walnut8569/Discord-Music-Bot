# Discord Music Bot

高效能 Discord 音樂機器人，基於 **discord.js v14** + **Shoukaku** + **Lavalink** 建構。

## 功能

- `/play <URL 或關鍵字>` — 播放 YouTube 音樂或關鍵字搜尋
- `/seek <時間>` — 跳至指定時間點（支援秒數如 `90`，或 `mm:ss` 格式如 `1:30`）
- `/nowplaying` — 顯示目前播放進度
- 播放控制按鈕：重播、後退 30 秒、暫停/繼續、前進 30 秒、跳過、停止
- 拖拉跳轉選單（最多 23 個時間點）
- 進度條每 2 秒自動更新，剩餘時間透過 Discord 時間戳即時倒數
- 隊列播完後 30 秒自動離開語音頻道

## 前置需求

- **Node.js** >= 18
- **Lavalink** 伺服器（含 [youtube-source](https://github.com/lavalink-devtools/youtube-source) 插件）

## 安裝

```bash
npm install
```

建立 `.env` 檔案：

```env
DISCORD_TOKEN=你的_Bot_Token
GUILD_ID=你的_伺服器_ID          # 省略此行則註冊為全域指令（更新需等最多 1 小時）
LAVALINK_HOST=localhost
LAVALINK_PORT=2333
LAVALINK_PASSWORD=youshallnotpass
LAVALINK_SECURE=false             # 若 Lavalink 使用 HTTPS/WSS 則設為 true
```

## Lavalink 設定

專案內附 `application.yml` 可直接用於啟動 Lavalink。

啟動前請先下載 [youtube-source 插件](https://github.com/lavalink-devtools/youtube-source/releases)，放至 Lavalink 的 `plugins/` 資料夾。

```bash
java -jar Lavalink.jar
```

> 若要修改密碼，請同步更新 `application.yml` 中的 `password` 與 `.env` 中的 `LAVALINK_PASSWORD`。

## 啟動

```bash
npm start
```

## 技術架構

| 元件 | 用途 |
|------|------|
| [discord.js v14](https://discord.js.org/) | Discord API 互動 |
| [Shoukaku](https://github.com/shipgirlproject/Shoukaku) | Lavalink WebSocket 客戶端 |
| [Lavalink](https://github.com/lavalink-devtools/lavalink) | 音訊串流引擎 |

## 支援音源

YouTube（透過 youtube-source 插件）、SoundCloud、Bandcamp、Twitch、Vimeo、HTTP 直連
