'use strict';
/**
 * Admin settings, stored as JSON per key, with defaults:
 *   allowSignup       users may register themselves (they wait for approval)
 *   minVersion        oldest extension version allowed to sign in / call the API
 *   enabled           kill switch per extension
 *   logRetentionDays  logs, sightings and checks older than this are deleted
 */
const { EXTS, isExt } = require('../lib/util');
const { E } = require('../lib/errors');

const DEFAULTS = Object.freeze({
    allowSignup: false,
    minVersion: { citamate: '0.0.0', relayswitch: '0.0.0' },
    enabled: { citamate: true, relayswitch: true },
    logRetentionDays: 90
});

const VERSION_RE = /^\d+(\.\d+){0,3}$/;

function createSettings({ db, clock }) {
    const getRow = db.prepare('SELECT value_json FROM settings WHERE key = ?');
    const upsert = db.prepare(
        'INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
    );

    function getAll() {
        const out = JSON.parse(JSON.stringify(DEFAULTS));
        for (const key of Object.keys(DEFAULTS)) {
            const row = getRow.get(key);
            if (!row) continue;
            const v = JSON.parse(row.value_json);
            out[key] = typeof DEFAULTS[key] === 'object' && DEFAULTS[key] !== null ? { ...DEFAULTS[key], ...v } : v;
        }
        return out;
    }

    /** Validates and stores a partial update. -> all values */
    function update(patch, actor) {
        if (!patch || typeof patch !== 'object') throw E.badRequest('values must be an object');
        const fields = {};
        const next = {};
        if ('allowSignup' in patch) next.allowSignup = !!patch.allowSignup;
        if ('logRetentionDays' in patch) {
            const n = Number(patch.logRetentionDays);
            if (!Number.isInteger(n) || n < 1 || n > 3650) fields.logRetentionDays = 'Enter a number of days (1–3650).';
            else next.logRetentionDays = n;
        }
        for (const key of ['minVersion', 'enabled']) {
            if (!(key in patch)) continue;
            const v = patch[key];
            if (!v || typeof v !== 'object') {
                fields[key] = 'Must be an object per extension.';
                continue;
            }
            const cur = getAll()[key];
            for (const [ext, val] of Object.entries(v)) {
                if (!isExt(ext)) {
                    fields[`${key}.${ext}`] = 'Unknown extension.';
                } else if (key === 'minVersion') {
                    if (!VERSION_RE.test(String(val))) fields[`${key}.${ext}`] = 'Use a version like 1.6.0.';
                    else cur[ext] = String(val);
                } else {
                    cur[ext] = !!val;
                }
            }
            next[key] = cur;
        }
        if (Object.keys(fields).length) throw E.validation(fields);
        const t = clock.now();
        db.transaction(() => {
            for (const [k, v] of Object.entries(next)) upsert.run(k, JSON.stringify(v), t, actor ? actor.id : null);
        })();
        return getAll();
    }

    return { getAll, update, DEFAULTS, EXTS };
}

module.exports = { createSettings, DEFAULTS };
