'use strict';
/**
 * CitaMate activity log and office sightings, sent by the extension in batches.
 * Each item keeps the extension's own id (client_id) so a batch sent twice is stored once.
 */
const { newId } = require('../lib/ids');
const { E } = require('../lib/errors');
const { str, clampInt, parseJson } = require('../lib/util');
const { scopeSql } = require('./ownership');

const MAX_POST = 500;
const MAX_CONTEXT = 32 * 1024;

function createActivity({ db, clock, onLog = null }) {
    /**
     * Page snapshot of a failed step, stored as JSON (max 32 KB). Too big: the long lists
     * (fields, buttons, options) are shortened first, so the summary always survives.
     */
    function contextJson(ctx) {
        if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return null;
        let json = JSON.stringify(ctx);
        if (json.length <= MAX_CONTEXT) return json;
        const slim = { ...ctx, truncated: true };
        for (const key of ['fields', 'buttons', 'forms', 'tried']) {
            if (Array.isArray(slim[key])) slim[key] = slim[key].slice(0, 15).map((f) => (f && typeof f === 'object' && Array.isArray(f.options) ? { ...f, options: f.options.slice(0, 5) } : f));
            json = JSON.stringify(slim);
            if (json.length <= MAX_CONTEXT) return json;
        }
        const keep = {};
        for (const [k, v] of Object.entries(slim)) if (v === null || typeof v !== 'object') keep[k] = typeof v === 'string' ? v.slice(0, 1000) : v;
        return JSON.stringify({ ...keep, truncated: true }).slice(0, MAX_CONTEXT);
    }
    function parseContext(json) {
        try {
            return JSON.parse(json);
        } catch (_) {
            return null;
        }
    }

    function checkItems(items) {
        if (!Array.isArray(items)) throw E.badRequest('items must be an array');
        if (items.length > MAX_POST) throw E.badRequest(`At most ${MAX_POST} items per request.`);
    }
    const time = (v, now) => {
        const t = Number(v);
        return Number.isFinite(t) && t > 0 ? Math.floor(t) : now;
    };

    // --------------------------------------------------------------- logs ----
    function addLogs(actor, items) {
        checkItems(items);
        const ins = db.prepare(
            `INSERT OR IGNORE INTO cm_logs (id, owner_id, client_id, t, page, url, kind, entry, entry_id, action, status, detail, context, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const now = clock.now();
        let saved = 0;
        db.transaction(() => {
            for (const it of items) {
                if (!it || typeof it !== 'object') continue;
                const id = newId();
                saved += ins.run(
                    id,
                    actor.id,
                    str(it.id, 100) || id,
                    time(it.t, now),
                    str(it.page, 100),
                    str(it.url, 1000),
                    it.kind === 'check' ? 'check' : 'booking',
                    str(it.entry, 200),
                    str(it.entryId, 100),
                    str(it.action, 100),
                    str(it.status, 20),
                    str(it.detail, 2000),
                    contextJson(it.context),
                    now
                ).changes;
                if (onLog && it.entryId) onLog(actor.id, str(it.entryId, 100), str(it.status, 20), it.kind === 'check' ? 'check' : 'booking');
            }
        })();
        return saved;
    }

    function listLogs(scope, { entryId, limit, context = false } = {}) {
        const n = clampInt(limit, 1, 5000, 1000);
        const s = scopeSql(scope, 'l');
        let where = s.where;
        const params = [...s.params];
        if (entryId) {
            where += ' AND l.entry_id = ?';
            params.push(String(entryId));
        }
        const rows = db
            .prepare(`SELECT l.*, u.username AS owner_name FROM cm_logs l JOIN users u ON u.id = l.owner_id WHERE ${where} ORDER BY l.t DESC, l.id DESC LIMIT ?`)
            .all(...params, n);
        return rows.reverse().map((r) => ({
            id: r.client_id,
            t: r.t,
            page: r.page,
            url: r.url,
            kind: r.kind,
            entry: r.entry,
            entryId: r.entry_id,
            action: r.action,
            status: r.status,
            detail: r.detail,
            ...(context && r.context ? { context: parseContext(r.context) } : {}),
            ownerId: r.owner_id,
            ownerName: r.owner_name
        }));
    }

    const clearLogs = (actor) => db.prepare('DELETE FROM cm_logs WHERE owner_id = ?').run(actor.id).changes;

    // ---------------------------------------------------------- sightings ----
    function addSightings(actor, items) {
        checkItems(items);
        const ins = db.prepare(
            `INSERT OR IGNORE INTO cm_sightings (id, owner_id, client_id, t, entry, entry_id, province, tramite, kind, offices_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const now = clock.now();
        let saved = 0;
        db.transaction(() => {
            for (const it of items) {
                if (!it || typeof it !== 'object') continue;
                const offices = (Array.isArray(it.offices) ? it.offices : [])
                    .slice(0, 500)
                    .filter((o) => o && typeof o === 'object')
                    .map((o) => ({ value: str(o.value, 100), text: str(o.text, 500) }));
                const id = newId();
                saved += ins.run(
                    id,
                    actor.id,
                    str(it.id, 100) || id,
                    time(it.t, now),
                    str(it.entry, 200),
                    str(it.entryId, 100),
                    str(it.province, 200),
                    str(it.tramite, 500),
                    it.kind === 'check' ? 'check' : 'booking',
                    JSON.stringify(offices),
                    now
                ).changes;
            }
        })();
        return saved;
    }

    function listSightings(scope, { limit } = {}) {
        const n = clampInt(limit, 1, 5000, 2000);
        const s = scopeSql(scope, 's');
        const rows = db
            .prepare(`SELECT s.*, u.username AS owner_name FROM cm_sightings s JOIN users u ON u.id = s.owner_id WHERE ${s.where} ORDER BY s.t DESC, s.id DESC LIMIT ?`)
            .all(...s.params, n);
        return rows.reverse().map((r) => ({
            id: r.client_id,
            t: r.t,
            entry: r.entry,
            entryId: r.entry_id,
            province: r.province,
            tramite: r.tramite,
            kind: r.kind,
            offices: parseJson(r.offices_json, []),
            ownerId: r.owner_id,
            ownerName: r.owner_name
        }));
    }

    const clearSightings = (actor) => db.prepare('DELETE FROM cm_sightings WHERE owner_id = ?').run(actor.id).changes;

    /** Dashboard numbers for the last `days`. */
    function recentCounts(scope, days = 7) {
        const s = scopeSql(scope, 'l');
        const since = clock.now() - days * 24 * 3600 * 1000;
        const r = db
            .prepare(`SELECT COUNT(*) AS logs, SUM(CASE WHEN l.status = 'done' THEN 1 ELSE 0 END) AS bookings FROM cm_logs l WHERE ${s.where} AND l.t >= ?`)
            .get(...s.params, since);
        return { logs: r.logs || 0, bookings: r.bookings || 0 };
    }

    return { addLogs, listLogs, clearLogs, addSightings, listSightings, clearSightings, recentCounts };
}

module.exports = { createActivity };
