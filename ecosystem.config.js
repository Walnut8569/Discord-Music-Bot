/**
 * PM2 設定檔。
 * 使用 `pm2 start ecosystem.config.js` 同時啟動 Lavalink 與 Discord Bot。
 * 使用 `pm2 stop all` / `pm2 restart all` 管理兩個行程。
 */
module.exports = {
  apps: [
    {
      // ── Lavalink 音訊伺服器 ──────────────────────────────────────────
      name: 'lavalink',
      script: 'lavalink/start.sh', // 啟動腳本（執行 java -jar Lavalink.jar）
      interpreter: 'bash',
      cwd: '/home/walnut/文件/Discord-Music-Bot',
      autorestart: true,  // 異常崩潰時自動重啟
      watch: false,       // 不監控檔案變化
    },
    {
      // ── Discord Bot 主程序 ───────────────────────────────────────────
      name: 'bot',
      script: 'index.js',
      cwd: '/home/walnut/文件/Discord-Music-Bot',
      autorestart: true,  // 異常崩潰時自動重啟
      watch: false,       // 不監控檔案變化
      env_file: '.env',   // 從 .env 載入環境變數（TOKEN、API KEY 等）
    },
  ],
}
