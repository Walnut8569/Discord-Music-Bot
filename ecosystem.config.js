module.exports = {
  apps: [
    {
      name: 'lavalink',
      script: 'lavalink/start.sh',
      interpreter: 'bash',
      cwd: '/home/walnut/文件/Discord-Music-Bot',
      autorestart: true,
      watch: false,
    },
    {
      name: 'bot',
      script: 'index.js',
      cwd: '/home/walnut/文件/Discord-Music-Bot',
      autorestart: true,
      watch: false,
      env_file: '.env',
    },
  ],
}
