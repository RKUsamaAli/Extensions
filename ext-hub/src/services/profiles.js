'use strict';
/**
 * CitaMate entries ("profiles"). Same field names as the extension uses.
 * Only `label` is stored readable; the rest (names, document numbers, phone, email)
 * is one AES-GCM encrypted JSON blob.
 */
const { newId, isId } = require('../lib/ids');
const { E } = require('../lib/errors');
const { str } = require('../lib/util');
const { scopeSql, createdSql, assertCanTouch, ownerForCreate, ownerForUpdate } = require('./ownership');

const TEXT_FIELDS = ['docType', 'docNumber', 'fullName', 'birthYear', 'phone', 'email', 'notes'];
const SELECT_FIELDS = ['nationality', 'province', 'tramite', 'office'];
const DATA_FIELDS = TEXT_FIELDS.concat(SELECT_FIELDS.flatMap((f) => [f, f + 'Text']));
const DOC_TYPES = ['NIE', 'DNI', 'PASAPORTE'];
const MAX_BULK = 1000;

/** Normalizes like the extension's clean(): -> { value, fields } (fields = errors). */
function normalizeProfile(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const v = { label: str(src.label, 200) };
    for (const f of DATA_FIELDS) v[f] = str(src[f], f === 'notes' ? 2000 : 500);
    const dt = v.docType.toUpperCase();
    v.docType = DOC_TYPES.includes(dt) ? dt : 'NIE';
    v.docNumber = v.docNumber.toUpperCase().replace(/\s+/g, '');
    v.fullName = v.fullName.toUpperCase();
    v.birthYear = v.birthYear.replace(/\D/g, '').slice(0, 4);
    const fields = {};
    if (!v.label) fields.label = 'Enter a label.';
    if (!v.docNumber) fields.docNumber = 'Enter the document number.';
    if (!v.fullName) fields.fullName = 'Enter the full name.';
    return { value: v, fields };
}

/** Appointment statuses. Only ACTIVE ones are sent to CitaMate. */
const STATUSES = ['pending', 'in_progress', 'on_hold', 'booked', 'done', 'cancelled'];
const ACTIVE_STATUSES = ['pending', 'in_progress'];

function createProfiles({ db, clock, cipher, users }) {
    const byId = db.prepare('SELECT * FROM profiles WHERE id = ?');

    function shape(row, ownerName) {
        const data = cipher.decryptJson(row.data_enc) || {};
        const out = { id: row.id, label: row.label };
        for (const f of DATA_FIELDS) out[f] = data[f] ?? '';
        out.ownerId = row.owner_id;
        out.ownerName = ownerName ?? row.owner_name ?? null;
        out.status = row.status || 'pending';
        out.statusAt = row.status_at ?? null;
        out.createdBy = row.created_by ?? null;
        out.createdByName = row.created_by_name ?? null;
        out.createdAt = row.created_at;
        out.updatedAt = row.updated_at;
        return out;
    }

    const SEL = 'SELECT p.*, u.username AS owner_name, cb.username AS created_by_name FROM profiles p JOIN users u ON u.id = p.owner_id LEFT JOIN users cb ON cb.id = p.created_by';

    /** activeOnly: what CitaMate gets (pending / in progress); the panel lists every status. */
    function list(scope, { activeOnly = false } = {}) {
        const s = scopeSql(scope, 'p');
        const c = createdSql(scope, 'p');
        const act = activeOnly ? ` AND p.status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})` : '';
        return db
            .prepare(`${SEL} WHERE ${s.where}${c.where}${act} ORDER BY p.label COLLATE NOCASE, p.id`)
            .all(...s.params, ...c.params, ...(activeOnly ? ACTIVE_STATUSES : []))
            .map((r) => shape(r));
    }

    function get(id) {
        if (!isId(id)) return null;
        return db.prepare(`${SEL} WHERE p.id = ?`).get(id) || null;
    }

    function encode(v) {
        const data = {};
        for (const f of DATA_FIELDS) data[f] = v[f];
        return cipher.encryptJson(data);
    }

    function statusOf(raw, fallback) {
        if (raw === undefined || raw === null || raw === '') return fallback;
        const v = String(raw);
        if (!STATUSES.includes(v)) throw E.validation({ status: 'Unknown status.' });
        return v;
    }

    function insert(ownerId, v, actor, status = 'pending') {
        const t = clock.now();
        const id = newId();
        db.prepare('INSERT INTO profiles (id, owner_id, label, data_enc, status, status_at, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
            id,
            ownerId,
            v.label,
            encode(v),
            status,
            t,
            t,
            actor.id,
            t,
            actor.id
        );
        return id;
    }

    function create(actor, body) {
        const ownerId = ownerForCreate(actor, body && body.ownerId, users);
        const { value, fields } = normalizeProfile(body);
        if (Object.keys(fields).length) throw E.validation(fields);
        return shape(get(insert(ownerId, value, actor, statusOf(body && body.status, 'pending'))));
    }

    function bulkCreate(actor, items, ownerIdInput) {
        if (!Array.isArray(items)) throw E.badRequest('items must be an array');
        if (items.length > MAX_BULK) throw E.badRequest(`At most ${MAX_BULK} items per request.`);
        const ownerId = ownerForCreate(actor, ownerIdInput, users);
        const fields = {};
        const values = items.map((it, i) => {
            const r = normalizeProfile(it);
            for (const [k, m] of Object.entries(r.fields)) fields[`items.${i}.${k}`] = m;
            return r.value;
        });
        if (Object.keys(fields).length) throw E.validation(fields);
        const ids = db.transaction(() => values.map((v) => insert(ownerId, v, actor)))();
        return ids.map((id) => shape(get(id)));
    }

    function update(actor, id, body) {
        const row = get(id);
        assertCanTouch(actor, row, 'Entry');
        const { value, fields } = normalizeProfile(body);
        if (Object.keys(fields).length) throw E.validation(fields);
        const newOwner = ownerForUpdate(actor, row, body && body.ownerId, users);
        const status = statusOf(body && body.status, row.status || 'pending');
        const t = clock.now();
        db.prepare(
            'UPDATE profiles SET label = ?, data_enc = ?, owner_id = COALESCE(?, owner_id), status = ?, status_at = CASE WHEN status = ? THEN status_at ELSE ? END, updated_at = ?, updated_by = ? WHERE id = ?'
        ).run(value.label, encode(value), newOwner, status, status, t, t, actor.id, id);
        return shape(get(id));
    }

    function remove(actor, id) {
        const row = get(id);
        assertCanTouch(actor, row, 'Entry');
        db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    }

    /** Bulk: { action: 'status', status } or { action: 'delete' } on the rows the actor may change. -> { changed } */
    function bulkAction(actor, ids, action, status) {
        if (!Array.isArray(ids)) throw E.badRequest('ids must be an array');
        if (ids.length > MAX_BULK) throw E.badRequest(`At most ${MAX_BULK} entries at once.`);
        if (action !== 'status' && action !== 'delete') throw E.validation({ action: 'Use status or delete.' });
        const next = action === 'status' ? statusOf(status, null) : null;
        if (action === 'status' && !next) throw E.validation({ status: 'Pick a status.' });
        const t = clock.now();
        let changed = 0;
        db.transaction(() => {
            for (const id of new Set(ids.map(String))) {
                const r = isId(id) ? db.prepare('SELECT owner_id, status FROM profiles WHERE id = ?').get(id) : null;
                if (!r || (r.owner_id !== actor.id && actor.role !== 'admin')) continue;
                if (action === 'delete') changed += db.prepare('DELETE FROM profiles WHERE id = ?').run(id).changes;
                else if (r.status !== next) changed += db.prepare('UPDATE profiles SET status = ?, status_at = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(next, t, t, actor.id, id).changes;
            }
        })();
        return { changed };
    }

    /**
     * CitaMate results move an entry along on their own: the first booking step makes a
     * pending entry "in progress", a confirmation page makes it "booked". Never moves an
     * entry the user set to on hold / done / cancelled.
     */
    function noteActivity(ownerId, entryId, logStatus, kind) {
        if (!entryId || kind === 'check') return;
        const row = isId(entryId) ? db.prepare('SELECT owner_id, status FROM profiles WHERE id = ?').get(entryId) : null;
        if (!row || row.owner_id !== ownerId) return;
        const next = logStatus === 'done' && ACTIVE_STATUSES.includes(row.status) ? 'booked' : row.status === 'pending' && logStatus ? 'in_progress' : null;
        if (next) db.prepare('UPDATE profiles SET status = ?, status_at = ? WHERE id = ?').run(next, clock.now(), entryId);
    }

    /** Count per status for the panel tiles (whole list, not the filtered rows). */
    function statusCounts(scope) {
        const s = scopeSql(scope, 'p');
        const c = createdSql(scope, 'p');
        const out = Object.fromEntries(STATUSES.map((x) => [x, 0]));
        for (const r of db.prepare(`SELECT p.status, COUNT(*) AS n FROM profiles p WHERE ${s.where}${c.where} GROUP BY p.status`).all(...s.params, ...c.params)) out[r.status] = r.n;
        return out;
    }

    function count(scope) {
        const s = scopeSql(scope, 'p');
        return db.prepare(`SELECT COUNT(*) FROM profiles p WHERE ${s.where}`).pluck().get(...s.params);
    }

    return { list, get: (id) => byId.get(id), create, bulkCreate, update, remove, count, bulkAction, noteActivity, statusCounts };
}

module.exports = { createProfiles, normalizeProfile, DATA_FIELDS, STATUSES, ACTIVE_STATUSES };
