// PM2 进程守护配置：pm2 start ecosystem.config.cjs
// 作用：异常退出自动拉起、内存超阈值自动重启、日志按大小切割、开机自启
module.exports = {
  apps: [{
    name: 'green-island-cup',
    script: 'server.js',
    cwd: '/opt/green-island-cup',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 20,
    min_uptime: '30s',
    restart_delay: 3000,
    max_memory_restart: '300M',
    kill_timeout: 6000,            // 给优雅退出（SIGTERM → WAL checkpoint）留时间
    env: { NODE_ENV: 'production', PORT: 3000 },
    merge_logs: true,
    time: true,
  }],
};
