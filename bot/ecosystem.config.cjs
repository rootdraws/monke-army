module.exports = {
  apps: [{
    name: 'monke-harvester',
    script: 'npx',
    args: 'tsx bot/anchor-harvest-bot.ts',
    cwd: process.env.HOME + '/monke-army',
    env_file: 'bot/.env',
    max_memory_restart: '512M',
    restart_delay: 5000,
    max_restarts: 50,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
