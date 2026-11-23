'use strict';
/** Entry point: node src/server.js (PM2: ecosystem.config.js). */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createServices } = require('./services');
const { createApp } = require('./web/app');
const { createLogger } = require('./lib/logger');

function start() {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const db = openDb(config.dbFile);
    const services = createServices({ db, config });
    const seeded = services.configStore.seed(config.seedsDir);
    if (seeded.length) logger.info('seeded', { items: seeded });
    if (services.users.count() === 0) logger.warn('no users yet: create the first admin with `npm run cli -- create-admin <username>`');

    const app = createApp(services, { logger });
    const server = app.listen(config.port, config.host, () => logger.info('ext-hub listening', { host: config.host, port: config.port, url: config.publicUrl }));
    server.keepAliveTimeout = 65 * 1000; // above nginx's 60 s

    const runMaintenance = () => {
        try {
            logger.info('maintenance', services.maintenance());
        } catch (err) {
            logger.error('maintenance failed', { err: String(err && err.stack) });
        }
    };
    setTimeout(runMaintenance, 30 * 1000).unref();
    setInterval(runMaintenance, 60 * 60 * 1000).unref();
    setInterval(() => db.pragma('optimize'), 6 * 60 * 60 * 1000).unref();

    const stop = (sig) => {
        logger.info('shutting down', { sig });
        server.close(() => {
            db.close();
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10 * 1000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return server;
}

if (require.main === module) start();
module.exports = { start };
