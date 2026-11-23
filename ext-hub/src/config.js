'use strict';
/**
 * Configuration from environment variables (.env is loaded by server.js / cli.js).
 * loadConfig(env) is pure so tests can build a config without touching process.env.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function int(v, def) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
}
function list(v) {
    return String(v || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function loadConfig(env = process.env) {
    const production = env.NODE_ENV === 'production';
    const appSecret = env.APP_SECRET || (production ? '' : 'dev-only-secret-change-me-dev-only-secret');
    if (!appSecret || appSecret.length < 32) {
        throw new Error('APP_SECRET must be set to at least 32 random characters (openssl rand -hex 32)');
    }
    return {
        production,
        port: int(env.PORT, 4000),
        host: env.HOST || '127.0.0.1',
        /** Public URL of this server, used as JWT audience and for cookie "Secure". */
        publicUrl: (env.PUBLIC_URL || 'http://localhost:4000').replace(/\/+$/, ''),
        appSecret,
        /** Separate key for encrypting personal data and proxy passwords at rest. Defaults to one derived from APP_SECRET. */
        dataKey: env.DATA_KEY || '',
        dbFile: env.DB_FILE || path.join(ROOT, 'data', 'ext-hub.db'),
        seedsDir: env.SEEDS_DIR || path.join(ROOT, 'seeds'),
        publicDir: path.join(ROOT, 'public'),
        /** Extension zips built by deploy/deploy.sh (served by nginx at /downloads/). */
        downloadsDir: env.DOWNLOADS_DIR || path.join(ROOT, 'downloads'),
        trustProxy: int(env.TRUST_PROXY, production ? 1 : 0),
        accessTtlMin: int(env.ACCESS_TOKEN_TTL_MINUTES, 10),
        refreshTtlDaysExtension: int(env.REFRESH_TTL_DAYS_EXTENSION, 30),
        refreshTtlDaysPanel: int(env.REFRESH_TTL_DAYS_PANEL, 7),
        /** Empty = any extension origin (development). Production should list the store ids. */
        allowedExtensionIds: list(env.ALLOWED_EXTENSION_IDS),
        loginMaxFailures: int(env.LOGIN_MAX_FAILURES, 10),
        loginWindowMin: int(env.LOGIN_WINDOW_MINUTES, 15),
        apiRateLimitRpm: int(env.API_RATE_LIMIT_RPM, 600),
        logLevel: env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : 'info'),
        /** Release folder name, set by ecosystem.config.js on a server deployed with deploy/deploy.sh. */
        release: env.APP_RELEASE || ''
    };
}

module.exports = { loadConfig, ROOT };
