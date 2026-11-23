'use strict';
/**
 * RelaySwitch proxies, their check history (scores) and RelaySwitch logs.
 * Proxy passwords are encrypted at rest and returned in clear only to owner / admin.
 */
const { newId, isId } = require('../lib/ids');
const { E } = require('../lib/errors');
const { str, clampInt } = require('../lib/util');
const { scopeSql, createdSql, assertCanTouch, ownerForCreate, ownerForUpdate } = require('./ownership');
const { scoreOf, scoreBand, SCORE_WINDOW } = require('../lib/score');
const { checkProxy: defaultCheckProxy, renderUsername } = require('../lib/proxyCheck');

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

function createProxies({ db, clock, cipher, users, checkProxy = defaultCheckProxy }) {
    const sel = 'SELECT x.*, u.username AS owner_name, cb.username AS created_by_name FROM proxies x JOIN users u ON u.id = x.owner_id LEFT JOIN users cb ON cb.id = x.created_by';

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
            enabled: r.enabled === undefined || r.enabled === null ? true : !!r.enabled,
            createdBy: r.created_by ?? null,
            createdByName: r.created_by_name ?? null,
            createdAt: r.created_at,
            updatedAt: r.updated_at
        };
    }

    const get = (id) => (isId(id) ? db.prepare(`${sel} WHERE x.id = ?`).get(id) || null : null);

    /** enabledOnly: what RelaySwitch gets – switched-off proxies stay in the panel only. */
    function list(scope, { enabledOnly = false } = {}) {
        const s = scopeSql(scope, 'x');
        const c = createdSql(scope, 'x');
        const on = enabledOnly ? ' AND x.enabled = 1' : '';
        return db.prepare(`${sel} WHERE ${s.where}${c.where}${on} ORDER BY x.name COLLATE NOCASE, x.host, x.id`).all(...s.params, ...c.params).map(shape);
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
        const newOwner = ownerForUpdate(actor, row, body && body.ownerId, users);
        const t = clock.now();
        const pw = v.password === undefined ? row.password_enc : cipher.encrypt(v.password);
        db.transaction(() => {
            db.prepare(
                `UPDATE proxies SET name = ?, scheme = ?, host = ?, port = ?, username_template = ?, password_enc = ?, country = ?, city = ?,
                     session_start = ?, session_end = ?, owner_id = COALESCE(?, owner_id), updated_at = ?, updated_by = ? WHERE id = ?`
            ).run(v.name, v.scheme, v.host, v.port, v.usernameTemplate, pw, v.country, v.city, v.sessionStart, v.sessionEnd, newOwner, t, actor.id, id);
            // The check history follows the proxy to its new owner.
            if (newOwner) db.prepare('UPDATE proxy_checks SET owner_id = ? WHERE proxy_id = ?').run(newOwner, id);
        })();
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
    function addChecks(actor, items, { fromServer = false } = {}) {
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
                    fromServer ? 'server' : it.source === 'use' ? 'use' : 'test',
                    now
                ).changes;
            }
        })();
        return saved;
    }

    /** -> { [proxyId]: { results: [...] } }, last `perProxy` per proxy (default 50), oldest -> newest. */
    function stats(scope, { proxyId, perProxy = CHECKS_PER_PROXY } = {}) {
        const s = scopeSql(scope, 'c');
        if (proxyId) {
            s.where += ' AND c.proxy_id = ?';
            s.params = [...s.params, String(proxyId)];
        }
        const rows = db
            .prepare(
                `SELECT * FROM (
                     SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.proxy_id ORDER BY c.t DESC, c.id DESC) AS rn
                     FROM proxy_checks c WHERE ${s.where}
                 ) WHERE rn <= ${clampInt(perProxy, 1, CHECKS_PER_PROXY, CHECKS_PER_PROXY)} ORDER BY proxy_id, t, id`
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

    /**
     * One page of proxies for the panel, scored, filtered and sorted on the server, plus a
     * summary over ALL proxies in scope (not only the page).
     *   q       search in name, host, username, country, city, owner, exit IP
     *   filter  good | fair | poor | none | failing
     *   sort    score (default) | speed | recent | name
     * -> { items: [proxy + { score, recent }], total, offset, nextOffset, summary }
     */
    function page(scope, { q = '', filter = '', sort = 'score', limit, offset, idsOnly = false } = {}) {
        const n = clampInt(limit, 1, 200, 50);
        const start = clampInt(offset, 0, 1e9, 0);
        const s = scopeSql(scope, 'x');
        const c = createdSql(scope, 'x');
        const rows = db.prepare(`${sel} WHERE ${s.where}${c.where} ORDER BY x.name COLLATE NOCASE, x.host, x.id`).all(...s.params, ...c.params);
        const checks = stats(scope, { perProxy: SCORE_WINDOW });
        const all = rows.map((r) => {
            const recent = (checks[r.id] && checks[r.id].results) || [];
            return { r, recent, sc: scoreOf(recent) };
        });

        const checked = all.filter((x) => x.sc.samples);
        const okSum = checked.reduce((a, x) => a + x.sc.okCount, 0);
        const sampleSum = checked.reduce((a, x) => a + x.sc.samples, 0);
        const speeds = checked.map((x) => x.sc.medianMs).filter((v) => v !== null).sort((a, b) => a - b);
        const bands = { good: 0, fair: 0, poor: 0, none: 0 };
        for (const x of all) bands[scoreBand(x.sc.value)]++;
        const summary = {
            total: all.length,
            disabled: all.filter((x) => !x.r.enabled).length,
            checked: checked.length,
            neverChecked: all.length - checked.length,
            ...bands,
            failing: checked.filter((x) => x.sc.lastOk === false).length,
            successRatio: sampleSum ? okSum / sampleSum : null,
            medianMs: speeds.length ? speeds[Math.floor(speeds.length / 2)] : null,
            lastChecked: checked.reduce((m, x) => Math.max(m, x.sc.lastChecked || 0), 0) || null
        };

        const term = str(q, 200).toLowerCase();
        let list = all.filter(({ r, sc }) => {
            if (term && ![r.name, r.host, r.username_template, r.country, r.city, r.owner_name, sc.lastIp].some((v) => String(v || '').toLowerCase().includes(term))) return false;
            if (!filter) return true;
            if (filter === 'disabled') return !r.enabled;
            if (filter === 'enabled') return !!r.enabled;
            if (filter === 'failing') return sc.lastOk === false;
            return scoreBand(sc.value) === filter;
        });
        const byName = (a, b) => String(a.r.name).localeCompare(String(b.r.name), undefined, { numeric: true, sensitivity: 'base' }) || (a.r.id < b.r.id ? -1 : 1);
        const nullsLast = (x, y, fn) => (x === null) - (y === null) || (x === null ? 0 : fn(x, y));
        const sorters = {
            name: byName,
            speed: (a, b) => nullsLast(a.sc.medianMs, b.sc.medianMs, (x, y) => x - y) || byName(a, b),
            recent: (a, b) => nullsLast(a.sc.lastChecked, b.sc.lastChecked, (x, y) => y - x) || byName(a, b),
            score: (a, b) => nullsLast(a.sc.value, b.sc.value, (x, y) => y - x) || byName(a, b)
        };
        list = list.sort(sorters[sort] || sorters.score);
        // "Select all N" in the panel: every matching id, no rows.
        if (idsOnly) return { ids: list.map((x) => x.r.id), total: list.length };
        const slice = list.slice(start, start + n);
        return {
            // `recent` feeds the small bars only: time, result, speed (full rows: GET /checks?proxyId=).
            items: slice.map(({ r, recent, sc }) => ({ ...shape(r), score: sc, recent: recent.map((c) => (c.ms === undefined ? { t: c.t, ok: c.ok } : { t: c.t, ok: c.ok, ms: c.ms })) })),
            total: list.length,
            offset: start,
            nextOffset: start + slice.length < list.length ? start + slice.length : null,
            summary
        };
    }

    /** Rows the actor may change, by id (others are skipped, like unknown ids). */
    function touchable(actor, ids) {
        if (!Array.isArray(ids)) throw E.badRequest('ids must be an array');
        if (ids.length > MAX_BULK) throw E.badRequest(`At most ${MAX_BULK} proxies at once.`);
        const rows = [];
        for (const id of new Set(ids.map(String))) {
            const r = isId(id) ? db.prepare('SELECT * FROM proxies WHERE id = ?').get(id) : null;
            if (r && (r.owner_id === actor.id || actor.role === 'admin')) rows.push(r);
        }
        return rows;
    }

    /** Bulk on / off / delete -> { changed } */
    function bulkAction(actor, ids, action) {
        if (!['enable', 'disable', 'delete'].includes(action)) throw E.validation({ action: 'Use enable, disable or delete.' });
        const rows = touchable(actor, ids);
        const t = clock.now();
        const upd = db.prepare('UPDATE proxies SET enabled = ?, updated_at = ?, updated_by = ? WHERE id = ?');
        const del = db.prepare('DELETE FROM proxies WHERE id = ?');
        let changed = 0;
        db.transaction(() => {
            for (const r of rows) changed += action === 'delete' ? del.run(r.id).changes : upd.run(action === 'enable' ? 1 : 0, t, actor.id, r.id).changes;
        })();
        return { changed };
    }

    /**
     * Checks proxies from the server (8 at a time) and stores the results as checks with
     * source "server". -> [{ id, name, ok, ms, ip, error }]
     */
    async function serverCheck(actor, ids, { concurrency = 8 } = {}) {
        const rows = touchable(actor, ids);
        if (rows.length > 100) throw E.badRequest('At most 100 proxies per check.');
        const results = new Array(rows.length);
        let next = 0;
        const worker = async () => {
            while (next < rows.length) {
                const i = next++;
                const r = rows[i];
                let res;
                try {
                    const lo = Math.min(r.session_start, r.session_end), hi = Math.max(r.session_start, r.session_end);
                    const session = lo + Math.floor(Math.random() * (hi - lo + 1));
                    const username = r.username_template ? renderUsername(r.username_template, { session, country: r.country, city: r.city }) : '';
                    res = await checkProxy({ scheme: r.scheme, host: r.host, port: r.port, username, password: cipher.decrypt(r.password_enc) ?? '' });
                } catch (err) {
                    res = { ok: false, error: String((err && err.message) || err) };
                }
                results[i] = { id: r.id, name: r.name, t: clock.now(), ...res };
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
        addChecks(actor, results.map((x) => ({ proxyId: x.id, t: x.t, ok: x.ok, ms: x.ms, ip: x.ip, error: x.error })), { fromServer: true });
        return results;
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

    return { list, page, get, create, bulkCreate, update, remove, count, addChecks, stats, bulkAction, serverCheck, addLogs, listLogs, clearLogs };
}

module.exports = { createProxies, normalizeProxy, SCHEMES };
