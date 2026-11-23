'use strict';
/**
 * RelaySwitch proxies, their check history (scores) and RelaySwitch logs.
 * Proxy passwords are encrypted at rest and returned in clear only to owner / admin.
 */
const { newId, isId } = require('../lib/ids');
const { E } = require('../lib/errors');
const { str, clampInt } = require('../lib/util');
const { scopeSql, assertCanTouch, ownerForCreate } = require('./ownership');

const SCHEMES = ['http', 'https', 'socks4', 'socks5'];
const MAX_BULK = 1000;
const MAX_POST = 500;
const CHECKS_PER_PROXY = 50;
const HOST_RE = /^[A-Za-z0-9.\-:[\]_]+$/;

/** -> { value, fields }. `password` undefined = keep the stored one (on update). */
function normalizeProxy(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const fields = {};
    const v = {
        name: str(src.name, 200),
        scheme: str(src.scheme || 'http', 10).toLowerCase(),
        host: str(src.host, 255),
        port: Number(src.port),
        usernameTemplate: str(src.usernameTemplate, 500),
        password: src.password === undefined ? undefined : str(src.password, 500),
        country: str(src.country, 60),
        city: str(src.city, 100),
        sessionStart: src.sessionStart === undefined || src.sessionStart === '' ? 1 : Number(src.sessionStart),
        sessionEnd: src.sessionEnd === undefined || src.sessionEnd === '' ? 1000 : Number(src.sessionEnd)
    };
    if (!SCHEMES.includes(v.scheme)) fields.scheme = 'Choose http, https, socks4 or socks5.';
    if (!v.host) fields.host = 'Enter the server address.';
    else if (!HOST_RE.test(v.host)) fields.host = 'Use only the host name or IP address.';
    if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) fields.port = 'Enter a port between 1 and 65535.';
    if (!Number.isInteger(v.sessionStart) || v.sessionStart < 0) fields.sessionStart = 'Enter a whole number.';
    if (!Number.isInteger(v.sessionEnd) || v.sessionEnd < 0) fields.sessionEnd = 'Enter a whole number.';
    else if (Number.isInteger(v.sessionStart) && v.sessionEnd < v.sessionStart) fields.sessionEnd = 'Must be at least the start.';
    return { value: v, fields };
}

function createProxies({ db, clock, cipher, users }) {
    const sel = 'SELECT x.*, u.username AS owner_name FROM proxies x JOIN users u ON u.id = x.owner_id';

    function shape(r) {
        return {
            id: r.id,
            name: r.name,
            scheme: r.scheme,
            host: r.host,
            port: r.port,
            usernameTemplate: r.username_template,
            password: cipher.decrypt(r.password_enc) ?? '',
            country: r.country,
            city: r.city,
            sessionStart: r.session_start,
            sessionEnd: r.session_end,
            ownerId: r.owner_id,
            ownerName: r.owner_name ?? null,
            createdAt: r.created_at,
            updatedAt: r.updated_at
        };
    }

    const get = (id) => (isId(id) ? db.prepare(`${sel} WHERE x.id = ?`).get(id) || null : null);

    function list(scope) {
        const s = scopeSql(scope, 'x');
        return db.prepare(`${sel} WHERE ${s.where} ORDER BY x.name COLLATE NOCASE, x.host, x.id`).all(...s.params).map(shape);
    }

    function insert(ownerId, v, actor) {
        const t = clock.now();
        const id = newId();
        db.prepare(
            `INSERT INTO proxies (id, owner_id, name, scheme, host, port, username_template, password_enc, country, city, session_start, session_end, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, ownerId, v.name, v.scheme, v.host, v.port, v.usernameTemplate, cipher.encrypt(v.password ?? ''), v.country, v.city, v.sessionStart, v.sessionEnd, t, actor.id, t, actor.id);
        return id;
    }

    function create(actor, body) {
        const ownerId = ownerForCreate(actor, body && body.ownerId, users);
        const { value, fields } = normalizeProxy(body);
        if (Object.keys(fields).length) throw E.validation(fields);
        return shape(get(insert(ownerId, value, actor)));
    }

    function bulkCreate(actor, items, ownerIdInput) {
        if (!Array.isArray(items)) throw E.badRequest('items must be an array');
        if (items.length > MAX_BULK) throw E.badRequest(`At most ${MAX_BULK} items per request.`);
        const ownerId = ownerForCreate(actor, ownerIdInput, users);
        const fields = {};
        const values = items.map((it, i) => {
            const r = normalizeProxy(it);
            for (const [k, m] of Object.entries(r.fields)) fields[`items.${i}.${k}`] = m;
            return r.value;
        });
        if (Object.keys(fields).length) throw E.validation(fields);
        const ids = db.transaction(() => values.map((v) => insert(ownerId, v, actor)))();
        return ids.map((id) => shape(get(id)));
    }

    function update(actor, id, body) {
        const row = get(id);
        assertCanTouch(actor, row, 'Proxy');
        const { value: v, fields } = normalizeProxy(body);
        if (Object.keys(fields).length) throw E.validation(fields);
        const t = clock.now();
        const pw = v.password === undefined ? row.password_enc : cipher.encrypt(v.password);
        db.prepare(
            `UPDATE proxies SET name = ?, scheme = ?, host = ?, port = ?, username_template = ?, password_enc = ?, country = ?, city = ?,
                 session_start = ?, session_end = ?, updated_at = ?, updated_by = ? WHERE id = ?`
        ).run(v.name, v.scheme, v.host, v.port, v.usernameTemplate, pw, v.country, v.city, v.sessionStart, v.sessionEnd, t, actor.id, id);
        return shape(get(id));
    }

    function remove(actor, id) {
        const row = get(id);
        assertCanTouch(actor, row, 'Proxy');
        db.prepare('DELETE FROM proxies WHERE id = ?').run(id); // checks cascade
    }

    function count(scope) {
        const s = scopeSql(scope, 'x');
        return db.prepare(`SELECT COUNT(*) FROM proxies x WHERE ${s.where}`).pluck().get(...s.params);
    }

    // ------------------------------------------------------------- checks ----
    /** Stores check results; proxies the caller may not touch are skipped. */
    function addChecks(actor, items) {
        if (!Array.isArray(items)) throw E.badRequest('items must be an array');
        if (items.length > MAX_POST) throw E.badRequest(`At most ${MAX_POST} items per request.`);
        const owners = new Map();
        const ownerOf = (pid) => {
            if (!owners.has(pid)) {
                const r = isId(pid) ? db.prepare('SELECT owner_id FROM proxies WHERE id = ?').get(pid) : null;
                owners.set(pid, r && (r.owner_id === actor.id || actor.role === 'admin') ? r.owner_id : null);
            }
            return owners.get(pid);
        };
        const ins = db.prepare('INSERT OR IGNORE INTO proxy_checks (id, owner_id, proxy_id, client_id, t, ok, ms, ip, error, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const now = clock.now();
        let saved = 0;
        db.transaction(() => {
            for (const it of items) {
                if (!it || typeof it !== 'object') continue;
                const owner = ownerOf(it.proxyId);
                if (!owner) continue;
                const t = Number(it.t);
                saved += ins.run(
                    newId(),
                    owner,
                    it.proxyId,
                    str(it.id, 100) || null,
                    Number.isFinite(t) && t > 0 ? Math.floor(t) : now,
                    it.ok ? 1 : 0,
                    Number.isFinite(Number(it.ms)) && it.ms !== null && it.ms !== undefined ? Math.max(0, Math.round(Number(it.ms))) : null,
                    str(it.ip, 64) || null,
                    str(it.error, 500) || null,
                    it.source === 'use' ? 'use' : 'test',
                    now
                ).changes;
            }
        })();
        return saved;
    }

    /** -> { [proxyId]: { results: [...] } }, last 50 per proxy, oldest -> newest. */
    function stats(scope) {
        const s = scopeSql(scope, 'c');
        const rows = db
            .prepare(
                `SELECT * FROM (
                     SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.proxy_id ORDER BY c.t DESC, c.id DESC) AS rn
                     FROM proxy_checks c WHERE ${s.where}
                 ) WHERE rn <= ${CHECKS_PER_PROXY} ORDER BY proxy_id, t, id`
            )
            .all(...s.params);
        const out = {};
        for (const r of rows) {
            const res = { t: r.t, ok: !!r.ok, source: r.source };
            if (r.ms !== null) res.ms = r.ms;
            if (r.ip) res.ip = r.ip;
            if (r.error) res.error = r.error;
            (out[r.proxy_id] ||= { results: [] }).results.push(res);
        }
        return out;
    }

    // --------------------------------------------------------------- logs ----
    function addLogs(actor, items) {
        if (!Array.isArray(items)) throw E.badRequest('items must be an array');
        if (items.length > MAX_POST) throw E.badRequest(`At most ${MAX_POST} items per request.`);
        const ins = db.prepare('INSERT OR IGNORE INTO rs_logs (id, owner_id, client_id, t, level, event, profile, profile_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const now = clock.now();
        let saved = 0;
        db.transaction(() => {
            for (const it of items) {
                if (!it || typeof it !== 'object') continue;
                const event = str(it.event, 200);
                if (!event) continue;
                const t = Number(it.t);
                saved += ins.run(
                    newId(),
                    actor.id,
                    str(it.id, 100) || null,
                    Number.isFinite(t) && t > 0 ? Math.floor(t) : now,
                    ['info', 'warn', 'error'].includes(it.level) ? it.level : 'info',
                    event,
                    str(it.profile, 200) || null,
                    str(it.profileId, 100) || null,
                    str(it.detail, 2000) || null,
                    now
                ).changes;
            }
        })();
        return saved;
    }

    function listLogs(scope, { limit } = {}) {
        const n = clampInt(limit, 1, 5000, 2000);
        const s = scopeSql(scope, 'l');
        const rows = db
            .prepare(`SELECT l.*, u.username AS owner_name FROM rs_logs l JOIN users u ON u.id = l.owner_id WHERE ${s.where} ORDER BY l.t DESC, l.id DESC LIMIT ?`)
            .all(...s.params, n);
        return rows.reverse().map((r) => {
            const o = { t: r.t, level: r.level, event: r.event };
            if (r.profile) o.profile = r.profile;
            if (r.profile_id) o.profileId = r.profile_id;
            if (r.detail) o.detail = r.detail;
            o.ownerId = r.owner_id;
            o.ownerName = r.owner_name;
            return o;
        });
    }

    function clearLogs(actor) {
        return db.prepare('DELETE FROM rs_logs WHERE owner_id = ?').run(actor.id).changes;
    }

    return { list, get, create, bulkCreate, update, remove, count, addChecks, stats, addLogs, listLogs, clearLogs };
}

module.exports = { createProxies, normalizeProxy, SCHEMES };
