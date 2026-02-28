module.exports = {
  apps: [{
    name: 'monke-harvester',
    script: 'npx',
    args: 'tsx bot/anchor-harvest-bot.ts',
    cwd: '/root/monke-army',
    env_file: '/root/monke-army/bot/.env',
    max_memory_restart: '512M',
    restart_delay: 5000,
    max_restarts: 50,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    out_file: '/root/.pm2/logs/monke-harvester-out.log',
    error_file: '/root/.pm2/logs/monke-harvester-error.log',
  }]
};
