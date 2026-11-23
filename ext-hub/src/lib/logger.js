'use strict';
/** JSON-lines logger to stdout (PM2 / journald collect it). Secrets never reach it: callers log ids, not bodies. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger(level = 'info') {
    const min = LEVELS[level] ?? LEVELS.info;
    const write = (lvl) => (msg, fields = {}) => {
        if (LEVELS[lvl] < min) return;
        const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields });
        (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    };
    return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

module.exports = { createLogger };
