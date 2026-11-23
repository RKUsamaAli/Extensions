// PM2: pm2 start ecosystem.config.js && pm2 save
// One process: SQLite is written from a single process, which keeps it simple and fast.
module.exports = {
    apps: [
        {
            name: 'ext-hub',
            script: 'src/server.js',
            cwd: __dirname,
            instances: 1,
            exec_mode: 'fork',
            max_memory_restart: '300M',
            env: { NODE_ENV: 'production' },
            kill_timeout: 10000
        }
    ]
};
