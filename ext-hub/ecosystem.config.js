// PM2: pm2 start ecosystem.config.js && pm2 save
// One process: SQLite is written from a single process, which keeps it simple and fast.
//
// On a server set up with deploy/setup-server.sh this file is loaded through the
// `current` symlink; Node resolves it to the real release folder, so:
//   - cwd is that release (a reload after the symlink swap starts the new code)
//   - APP_RELEASE is the release name, reported on /healthz for the deploy health check
//   - logs go to <base>/shared/logs so they survive deploys
const fs = require('fs');
const path = require('path');

const deployed = fs.existsSync(path.join(__dirname, 'REVISION'));
const sharedLogs = path.resolve(__dirname, '..', '..', 'shared', 'logs');
const logs = deployed && fs.existsSync(sharedLogs)
    ? { out_file: path.join(sharedLogs, 'app.out.log'), error_file: path.join(sharedLogs, 'app.err.log'), merge_logs: true }
    : {};

module.exports = {
    apps: [
        {
            name: 'ext-hub',
            script: 'src/server.js',
            cwd: __dirname,
            instances: 1,
            exec_mode: 'fork',
            max_memory_restart: '300M',
            env: { NODE_ENV: 'production', APP_RELEASE: deployed ? path.basename(__dirname) : '' },
            kill_timeout: 10000,
            ...logs
        }
    ]
};
