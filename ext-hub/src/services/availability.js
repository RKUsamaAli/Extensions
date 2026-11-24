'use strict';
/**
 * Office availability, shared across all users.
 *
 * Every time CitaMate reaches the office page it sends a sighting (province, trámite, the
 * offices listed). Here we:
 *   - work out since when the offices are open (a streak of sightings with offices, less
 *     than STREAK_GAP_MS apart) and since when each office is listed;
 *   - create at most one alert per province + trámite per clock minute while offices are
 *     open, and push it live to the users watching that pair;
 *   - build the "Offices to check" queue from the active entries (one row per province +
 *     trámite, whatever office each entry wants) with short claims so two people don't check
 *     the same pair at once;
 *   - summarise the history for the availability page.
 * Nothing here exposes which client or user made a check.
 */
const { newId } = require('../lib/ids');
const { E } = require('../lib/errors');
const { str, clampInt } = require('../lib/util');

const STREAK_GAP_MS = 30 * 60 * 1000; // sightings further apart start a new "open since"
const FRESH_MS = 15 * 60 * 1000; // a result is "current" this long
const ALERT_MAX_AGE_MS = 10 * 60 * 1000; // old sightings uploaded late don't alert
const CLAIM_MS = 3 * 60 * 1000; // "being checked" lasts this long
const HISTORY_DAYS = 30;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const pairKey = (province, tramite) => norm(province) + '\u0000' + norm(tramite);
const short = (s) => String(s || '').split(',')[0].trim();
const parse = (json, def) => {
    try {
        return json ? JSON.parse(json) : def;
    } catch (_) {
        return def;
    }
};
/** Sightings from the real office page (or older clients that don't say) count as availability. */
const isOfficePage = (page) => !page || page === 'Office';

function createAvailability({ db, clock }) {
    const listeners = new Map(); // userId -> Set(fn)

    // ------------------------------------------------------------ sightings ----
    /**
     * Called for each new sighting. Stores open_since / since_json on it and creates the
     * alert of this minute when offices are open. -> alert or null
     */
    function noteSighting({ id, t, province, tramite, page, offices }) {
        if (!province || !tramite) return null;
        const prev = db
            .prepare(
                `SELECT * FROM cm_sightings WHERE province = ? AND tramite = ? AND id <> ? AND t <= ? AND (page IS NULL OR page = 'Office')
                 ORDER BY t DESC LIMIT 1`
            )
            .get(province, tramite, id, t);
        const list = Array.isArray(offices) ? offices : [];
        let openSince = null;
        const since = {};
        if (list.length && isOfficePage(page)) {
            const prevOffices = prev ? parse(prev.offices_json, []) : [];
            const streak = prev && prevOffices.length && t - prev.t <= STREAK_GAP_MS;
            const prevSince = streak ? parse(prev.since_json, {}) : {};
            openSince = streak ? prev.open_since || prev.t : t;
            for (const o of list) since[o.value || o.text] = prevSince[o.value || o.text] || t;
        }
        db.prepare('UPDATE cm_sightings SET open_since = ?, since_json = ? WHERE id = ?').run(openSince, JSON.stringify(since), id);
        if (!list.length || !isOfficePage(page) || t < clock.now() - ALERT_MAX_AGE_MS) {
            if (isOfficePage(page)) releaseClaim(province, tramite);
            return null;
        }
        releaseClaim(province, tramite);
        const withSince = list.map((o) => ({ value: o.value, text: o.text, since: since[o.value || o.text] }));
        const fresh = withSince.filter((o) => o.since === t);
        const alert = {
            id: newId(),
            t,
            minute: Math.floor(t / 60000),
            province,
            tramite,
            offices: withSince,
            newOffices: fresh,
            openSince,
            stillOpen: openSince < t // false = just opened in this check
        };
        const r = db
            .prepare(
                `INSERT OR IGNORE INTO cm_alerts (id, t, minute, province, tramite, offices_json, new_json, open_since, sighting_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(alert.id, t, alert.minute, province, tramite, JSON.stringify(withSince), JSON.stringify(fresh), openSince, id, clock.now());
        if (!r.changes) return null; // already alerted this minute
        emit(alert);
        return alert;
    }

    // -------------------------------------------------------------- current ----
    /** Latest office-page sighting per pair (last HISTORY_DAYS). -> Map key -> state */
    function latestByPair() {
        const rows = db
            .prepare(
                `SELECT * FROM (
                     SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.province, s.tramite ORDER BY s.t DESC, s.id DESC) AS rn
                     FROM cm_sightings s WHERE s.t >= ? AND (s.page IS NULL OR s.page = 'Office') AND s.province <> '' AND s.tramite <> ''
                 ) WHERE rn = 1`
            )
            .all(clock.now() - HISTORY_DAYS * 86400000);
        const out = new Map();
        const countSince = db.prepare(
            `SELECT COUNT(*) FROM cm_sightings WHERE province = ? AND tramite = ? AND t >= ? AND (page IS NULL OR page = 'Office') AND offices_json <> '[]'`
        );
        const lastOpen = db.prepare(
            `SELECT t, open_since FROM cm_sightings WHERE province = ? AND tramite = ? AND t < ? AND (page IS NULL OR page = 'Office') AND offices_json <> '[]' ORDER BY t DESC LIMIT 1`
        );
        const firstClosed = db.prepare(
            `SELECT MIN(t) FROM cm_sightings WHERE province = ? AND tramite = ? AND t > ? AND (page IS NULL OR page = 'Office') AND offices_json = '[]'`
        );
        for (const r of rows) {
            const offices = parse(r.offices_json, []);
            const since = parse(r.since_json, {});
            const open = offices.length > 0;
            const fresh = clock.now() - r.t <= FRESH_MS;
            const state = {
                province: r.province,
                tramite: r.tramite,
                lastChecked: r.t,
                status: !fresh ? 'stale' : open ? 'open' : 'closed',
                open,
                openSince: open ? r.open_since || r.t : null,
                // Open: "still open" as of the latest check, confirmed by this many checks.
                stillOpenAt: open ? r.t : null,
                confirmations: open ? countSince.pluck().get(r.province, r.tramite, r.open_since || r.t) : 0,
                // Closed: since when, and the last time it was open (from – to).
                closedSince: null,
                lastOpen: null,
                offices: offices.map((o) => ({ value: o.value, text: o.text, since: since[o.value || o.text] || r.t, stillListedAt: r.t }))
            };
            if (!open) {
                const lo = lastOpen.get(r.province, r.tramite, r.t);
                if (lo) {
                    state.lastOpen = { from: lo.open_since || lo.t, to: lo.t };
                    state.closedSince = firstClosed.pluck().get(r.province, r.tramite, lo.t) || r.t;
                }
            }
            out.set(pairKey(r.province, r.tramite), state);
        }
        return out;
    }

    /**
     * "Office open" marker for an entry: its province + trámite was seen open in the last
     * FRESH_MS and its office is listed (any office when the entry has none).
     * -> { since, offices: [names] } or null
     */
    function entryOpenState(entry, latest = latestByPair()) {
        const s = latest.get(pairKey(entry.provinceText, entry.tramiteText));
        if (!s || s.status !== 'open') return null;
        const wanted = entry.office ? s.offices.filter((o) => o.value === entry.office || norm(o.text) === norm(entry.officeText)) : s.offices;
        if (!wanted.length) return null;
        return { since: entry.office ? Math.min(...wanted.map((o) => o.since)) : s.openSince, stillOpenAt: s.stillOpenAt, offices: wanted.map((o) => short(o.text)), checked: s.lastChecked };
    }

    // ---------------------------------------------------------------- queue ----
    /**
     * "Offices to check": one row per province + trámite of the active entries of all users,
     * stalest first. `mine` = the actor's own entries for that pair (a check needs one: the
     * site asks for a real NIE and name) – the least recently used one is suggested.
     */
    function queue(actor, activeEntries) {
        const latest = latestByPair();
        const watched = new Set(watches(actor).map((w) => pairKey(w.province, w.tramite)));
        const claims = new Map(
            db.prepare('SELECT c.*, u.username FROM cm_check_claims c JOIN users u ON u.id = c.user_id WHERE c.until > ?').all(clock.now()).map((c) => [pairKey(c.province, c.tramite), c])
        );
        const lastUse = new Map(
            db.prepare("SELECT entry_id, MAX(t) AS t FROM cm_sightings WHERE kind = 'check' AND entry_id <> '' GROUP BY entry_id").all().map((r) => [r.entry_id, r.t])
        );
        const rows = new Map();
        for (const e of activeEntries) {
            if (!e.provinceText || !e.tramiteText) continue;
            const key = pairKey(e.provinceText, e.tramiteText);
            if (!rows.has(key)) rows.set(key, { key, province: e.provinceText, tramite: e.tramiteText, entries: 0, wanted: new Set(), mine: [] });
            const row = rows.get(key);
            row.entries++;
            row.wanted.add(e.office ? short(e.officeText) || e.office : 'Any office');
            if (e.ownerId === actor.id) row.mine.push(e);
        }
        return [...rows.values()]
            .map((r) => {
                const s = latest.get(r.key) || null;
                const claim = claims.get(r.key);
                const pick = r.mine.slice().sort((a, b) => (lastUse.get(a.id) || 0) - (lastUse.get(b.id) || 0))[0] || null;
                return {
                    province: r.province,
                    tramite: r.tramite,
                    entries: r.entries,
                    wanted: [...r.wanted],
                    lastChecked: s ? s.lastChecked : null,
                    status: s ? s.status : 'never',
                    openSince: s ? s.openSince : null,
                    stillOpenAt: s ? s.stillOpenAt : null,
                    confirmations: s ? s.confirmations : 0,
                    closedSince: s ? s.closedSince : null,
                    lastOpen: s ? s.lastOpen : null,
                    offices: s ? s.offices : [],
                    watched: watched.has(r.key),
                    claim: claim ? { by: claim.username, mine: claim.user_id === actor.id, until: claim.until } : null,
                    checkEntryId: pick ? pick.id : null
                };
            })
            .sort((a, b) => (a.lastChecked || 0) - (b.lastChecked || 0) || a.province.localeCompare(b.province));
    }

    /** Marks a pair as being checked for CLAIM_MS. Someone else's live claim is refused. */
    function claim(actor, province, tramite, entryId) {
        province = str(province, 200);
        tramite = str(tramite, 500);
        if (!province || !tramite) throw E.validation({ province: 'Required.' });
        const cur = db.prepare('SELECT c.*, u.username FROM cm_check_claims c JOIN users u ON u.id = c.user_id WHERE province = ? AND tramite = ?').get(province, tramite);
        if (cur && cur.until > clock.now() && cur.user_id !== actor.id) {
            throw E.conflict(`${cur.username} is checking this right now.`);
        }
        const until = clock.now() + CLAIM_MS;
        db.prepare('INSERT OR REPLACE INTO cm_check_claims (province, tramite, user_id, entry_id, until) VALUES (?, ?, ?, ?, ?)').run(province, tramite, actor.id, str(entryId, 100) || null, until);
        return { until };
    }
    function releaseClaim(province, tramite) {
        db.prepare('DELETE FROM cm_check_claims WHERE province = ? AND tramite = ?').run(province, tramite);
    }

    // ------------------------------------------------------------- overview ----
    /** Availability page: every pair seen in the last `days`, with history for the heatmap. */
    function overview({ days } = {}) {
        const d = clampInt(days, 1, 90, HISTORY_DAYS);
        const from = clock.now() - d * 86400000;
        const latest = latestByPair();
        const rows = db
            .prepare(
                `SELECT province, tramite, t, offices_json, open_since FROM cm_sightings
                 WHERE t >= ? AND (page IS NULL OR page = 'Office') AND province <> '' AND tramite <> '' ORDER BY t`
            )
            .all(from);
        const pairs = new Map();
        for (const r of rows) {
            const key = pairKey(r.province, r.tramite);
            if (!pairs.has(key)) pairs.set(key, { province: r.province, tramite: r.tramite, history: [], lastSeenOpen: null, checks24h: 0, open24h: 0 });
            const p = pairs.get(key);
            const n = parse(r.offices_json, []).length;
            p.history.push([r.t, n]); // [time, offices listed] – the page draws the heatmap in local time
            if (n) p.lastSeenOpen = r.t;
            if (r.t >= clock.now() - 86400000) {
                p.checks24h++;
                if (n) p.open24h++;
            }
        }
        return {
            days: d,
            freshMinutes: FRESH_MS / 60000,
            pairs: [...pairs.entries()]
                .map(([key, p]) => ({ ...p, ...(latest.get(key) || { status: 'stale', offices: [], openSince: null, lastChecked: p.history.at(-1)[0] }), history: p.history.slice(-2000) }))
                .sort((a, b) => (b.status === 'open') - (a.status === 'open') || b.lastChecked - a.lastChecked)
        };
    }

    // -------------------------------------------------------- alerts/watch ----
    function watches(actor) {
        return db.prepare('SELECT province, tramite, created_at AS createdAt FROM cm_watches WHERE user_id = ? ORDER BY province, tramite').all(actor.id);
    }
    function setWatch(actor, province, tramite, on) {
        province = str(province, 200);
        tramite = str(tramite, 500);
        if (!province || !tramite) throw E.validation({ province: 'Required.' });
        if (on) db.prepare('INSERT OR IGNORE INTO cm_watches (user_id, province, tramite, created_at) VALUES (?, ?, ?, ?)').run(actor.id, province, tramite, clock.now());
        else db.prepare('DELETE FROM cm_watches WHERE user_id = ? AND province = ? AND tramite = ?').run(actor.id, province, tramite);
        return { watched: !!on };
    }
    const watchSql = 'EXISTS (SELECT 1 FROM cm_watches w WHERE w.user_id = ? AND w.province = a.province AND w.tramite = a.tramite)';
    function shapeAlert(r) {
        return { id: r.id, t: r.t, province: r.province, tramite: r.tramite, offices: parse(r.offices_json, []), newOffices: parse(r.new_json, []), openSince: r.open_since, stillOpen: !!r.open_since && r.open_since < r.t };
    }
    /** Alerts for the actor's watches, newest first; unread = after alerts_seen_at. */
    function alerts(actor, { since, limit } = {}) {
        const n = clampInt(limit, 1, 200, 50);
        const after = Number(since) > 0 ? Number(since) : 0;
        const items = db.prepare(`SELECT a.* FROM cm_alerts a WHERE ${watchSql} AND a.t > ? ORDER BY a.t DESC LIMIT ?`).all(actor.id, after, n).map(shapeAlert);
        const seen = db.prepare('SELECT alerts_seen_at FROM users WHERE id = ?').pluck().get(actor.id) || 0;
        const unread = db.prepare(`SELECT COUNT(*) FROM cm_alerts a WHERE ${watchSql} AND a.t > ?`).pluck().get(actor.id, seen);
        return { items, unread, seenAt: seen };
    }
    function markSeen(actor) {
        db.prepare('UPDATE users SET alerts_seen_at = ? WHERE id = ?').run(clock.now(), actor.id);
        return { ok: true };
    }

    // ------------------------------------------------------------ live push ----
    /** fn(alert) is called for each new alert on a pair the user watches. -> unsubscribe */
    function subscribe(userId, fn) {
        if (!listeners.has(userId)) listeners.set(userId, new Set());
        listeners.get(userId).add(fn);
        return () => {
            const set = listeners.get(userId);
            if (!set) return;
            set.delete(fn);
            if (!set.size) listeners.delete(userId);
        };
    }
    function emit(alert) {
        if (!listeners.size) return;
        const users = db.prepare('SELECT user_id FROM cm_watches WHERE province = ? AND tramite = ?').pluck().all(alert.province, alert.tramite);
        for (const u of users) for (const fn of listeners.get(u) || []) {
            try {
                fn(alert);
            } catch (_) {
                /* a broken connection must not stop the others */
            }
        }
    }

    return { noteSighting, latestByPair, entryOpenState, queue, claim, overview, watches, setWatch, alerts, markSeen, subscribe, pairKey };
}

module.exports = { createAvailability, pairKey, STREAK_GAP_MS, FRESH_MS };
