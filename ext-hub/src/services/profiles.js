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

function createProfiles({ db, clock, cipher, users }) {
    const byId = db.prepare('SELECT * FROM profiles WHERE id = ?');

    function shape(row, ownerName) {
        const data = cipher.decryptJson(row.data_enc) || {};
        const out = { id: row.id, label: row.label };
        for (const f of DATA_FIELDS) out[f] = data[f] ?? '';
        out.ownerId = row.owner_id;
        out.ownerName = ownerName ?? row.owner_name ?? null;
        out.createdBy = row.created_by ?? null;
        out.createdByName = row.created_by_name ?? null;
        out.createdAt = row.created_at;
        out.updatedAt = row.updated_at;
        return out;
    }

    const SEL = 'SELECT p.*, u.username AS owner_name, cb.username AS created_by_name FROM profiles p JOIN users u ON u.id = p.owner_id LEFT JOIN users cb ON cb.id = p.created_by';

    function list(scope) {
        const s = scopeSql(scope, 'p');
        const c = createdSql(scope, 'p');
        return db
            .prepare(`${SEL} WHERE ${s.where}${c.where} ORDER BY p.label COLLATE NOCASE, p.id`)
            .all(...s.params, ...c.params)
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

    function insert(ownerId, v, actor) {
        const t = clock.now();
        const id = newId();
        db.prepare('INSERT INTO profiles (id, owner_id, label, data_enc, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
            id,
            ownerId,
            v.label,
            encode(v),
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
        return shape(get(insert(ownerId, value, actor)));
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
        const t = clock.now();
        db.prepare('UPDATE profiles SET label = ?, data_enc = ?, owner_id = COALESCE(?, owner_id), updated_at = ?, updated_by = ? WHERE id = ?').run(value.label, encode(value), newOwner, t, actor.id, id);
        return shape(get(id));
    }

    function remove(actor, id) {
        const row = get(id);
        assertCanTouch(actor, row, 'Entry');
        db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    }

    function count(scope) {
        const s = scopeSql(scope, 'p');
        return db.prepare(`SELECT COUNT(*) FROM profiles p WHERE ${s.where}`).pluck().get(...s.params);
    }

    return { list, get: (id) => byId.get(id), create, bulkCreate, update, remove, count };
}

module.exports = { createProfiles, normalizeProfile, DATA_FIELDS };
