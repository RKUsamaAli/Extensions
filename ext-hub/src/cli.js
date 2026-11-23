'use strict';
/**
 * Admin command line:
 *   npm run migrate                                   apply migrations + seeds
 *   npm run cli -- create-admin <username> [password] create an admin (prompts / generates a password)
 *   npm run cli -- reset-password <username> [password]
 *   npm run cli -- grant <username> <ext> [YYYY-MM-DD|never] [maxDevices]
 *   npm run cli -- users                              list users and entitlements
 *   npm run cli -- maintenance                        delete old logs now
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createServices } = require('./services');
const { isExt } = require('./lib/util');

function generatePassword() {
    return crypto.randomBytes(12).toString('base64url');
}

/** "2026-12-31" -> end of that day UTC (ms); "never"/empty -> null */
function parseDate(v) {
    if (!v || v === 'never') return null;
    const t = Date.parse(v + 'T23:59:59Z');
    if (!Number.isFinite(t)) throw new Error(`Bad date "${v}", use YYYY-MM-DD or never`);
    return t;
}

function run(argv, { out = console.log, env = process.env } = {}) {
    const [cmd, ...args] = argv;
    const config = loadConfig(env);
    const db = openDb(config.dbFile);
    const s = createServices({ db, config });
    try {
        switch (cmd) {
            case 'migrate': {
                const seeded = s.configStore.seed(config.seedsDir);
                out(`Database ready at ${config.dbFile}${seeded.length ? `; seeded ${seeded.join(', ')}` : ''}`);
                return 0;
            }
            case 'create-admin': {
                const [username, given] = args;
                if (!username) throw new Error('usage: create-admin <username> [password]');
                const password = given || generatePassword();
                s.users.create({ username, password, role: 'admin' }, null);
                out(`Admin "${username}" created.${given ? '' : ` Password: ${password}`}`);
                return 0;
            }
            case 'reset-password': {
                const [username, given] = args;
                const u = s.users.getByUsername(username);
                if (!u) throw new Error(`No user "${username}"`);
                const password = given || generatePassword();
                s.users.update(u.id, { password }, null);
                out(`Password of "${username}" changed and all sign-ins ended.${given ? '' : ` New password: ${password}`}`);
                return 0;
            }
            case 'grant': {
                const [username, ext, until, max] = args;
                const u = s.users.getByUsername(username);
                if (!u) throw new Error(`No user "${username}"`);
                if (!isExt(ext)) throw new Error('ext must be citamate or relayswitch');
                const current = s.users.adminUser(u).entitlements.filter((e) => e.ext !== ext);
                const items = current.map((e) => ({ ext: e.ext, expiresAt: e.expiresAt, maxDevices: e.maxDevices }));
                items.push({ ext, expiresAt: parseDate(until), maxDevices: max ? Number(max) : 1 });
                s.users.setEntitlements(u.id, items, null);
                out(`${username}: ${ext} until ${until || 'never'}, ${max || 1} device(s).`);
                return 0;
            }
            case 'users': {
                for (const u of s.users.list()) {
                    const ents = u.entitlements.map((e) => `${e.ext}:${e.expiresAt ? new Date(e.expiresAt).toISOString().slice(0, 10) : 'never'}${e.active ? '' : '(expired)'}`).join(' ');
                    out(`${u.username.padEnd(20)} ${u.role.padEnd(6)} ${u.enabled ? 'enabled ' : 'disabled'} ${u.pending ? 'pending ' : ''}${ents}`);
                }
                return 0;
            }
            case 'maintenance':
                out(JSON.stringify(s.maintenance()));
                return 0;
            default:
                out('commands: migrate | create-admin <user> [pw] | reset-password <user> [pw] | grant <user> <ext> [YYYY-MM-DD|never] [maxDevices] | users | maintenance');
                return cmd ? 1 : 0;
        }
    } finally {
        db.close();
    }
}

if (require.main === module) {
    try {
        process.exitCode = run(process.argv.slice(2));
    } catch (err) {
        console.error(err.code === 'validation_error' ? `${err.message} ${JSON.stringify(err.extra.fields)}` : err.message);
        process.exitCode = 1;
    }
}

module.exports = { run, parseDate };
