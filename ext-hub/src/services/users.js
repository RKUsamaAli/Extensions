'use strict';
/**
 * Users and their entitlements (which extension, until when, how many devices).
 * Admins are always entitled to every extension, without expiry or device limit.
 */
const { newId, isId } = require('../lib/ids');
const { hashPassword } = require('../lib/crypto');
const { E } = require('../lib/errors');
const { EXTS, isExt, str } = require('../lib/util');

const USERNAME_RE = /^[A-Za-z0-9._-]{3,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkUsername(v) {
    return USERNAME_RE.test(String(v || '')) ? null : 'Use 3–40 letters, digits, dot, dash or underscore.';
}
function checkPassword(v) {
    const s = String(v ?? '');
    return s.length >= 8 && s.length <= 200 ? null : 'Use 8–200 characters.';
}
function checkEmail(v) {
    if (v === null || v === undefined || v === '') return null;
    return EMAIL_RE.test(String(v)) && String(v).length <= 200 ? null : 'Enter a valid email address.';
}

function createUsers({ db, clock, audit }) {
    const byId = db.prepare('SELECT * FROM users WHERE id = ?');
    const byName = db.prepare('SELECT * FROM users WHERE username = ?');
    const entRows = db.prepare('SELECT * FROM entitlements WHERE user_id = ? ORDER BY ext');

    const get = (id) => (isId(id) ? byId.get(id) || null : null);
    const getByUsername = (name) => byName.get(String(name || '')) || null;

    const publicUser = (u) => ({ id: u.id, username: u.username, email: u.email || null, role: u.role });

    function entitlementShape(row) {
        const now = clock.now();
        return { ext: row.ext, expiresAt: row.expires_at ?? null, maxDevices: row.max_devices, active: row.expires_at === null || row.expires_at > now };
    }

    /** Effective entitlements: admins get every extension, never expiring, no device limit. */
    function entitlementsOf(user) {
        if (user.role === 'admin') return EXTS.map((ext) => ({ ext, expiresAt: null, maxDevices: null, active: true }));
        return entRows.all(user.id).map(entitlementShape);
    }

    /** -> entitlement for ext, or null when the user has none. */
    function entitlementFor(user, ext) {
        return entitlementsOf(user).find((e) => e.ext === ext) || null;
    }

    function adminUser(u) {
        return {
            ...publicUser(u),
            enabled: !!u.enabled,
            pending: !!u.pending,
            note: u.note || '',
            createdAt: u.created_at,
            updatedAt: u.updated_at,
            lastLoginAt: u.last_login_at ?? null,
            entitlements: entRows.all(u.id).map(entitlementShape)
        };
    }

    function list() {
        return db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(adminUser);
    }

    /** Validates a list of { ext, expiresAt, maxDevices }. -> normalized list */
    function normalizeEntitlements(items) {
        if (!Array.isArray(items)) throw E.badRequest('items must be an array');
        const fields = {};
        const seen = new Set();
        const out = [];
        items.forEach((it, i) => {
            const ext = it && it.ext;
            if (!isExt(ext)) fields[`items.${i}.ext`] = 'Unknown extension.';
            else if (seen.has(ext)) fields[`items.${i}.ext`] = 'Listed twice.';
            seen.add(ext);
            let expiresAt = it ? it.expiresAt : null;
            if (expiresAt === '' || expiresAt === undefined) expiresAt = null;
            if (expiresAt !== null) {
                expiresAt = Number(expiresAt);
                if (!Number.isFinite(expiresAt) || expiresAt < 0) fields[`items.${i}.expiresAt`] = 'Enter a date or leave empty for never.';
            }
            const maxDevices = it && it.maxDevices !== undefined && it.maxDevices !== null && it.maxDevices !== '' ? Number(it.maxDevices) : 1;
            if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 100) fields[`items.${i}.maxDevices`] = 'Enter 1–100.';
            out.push({ ext, expiresAt, maxDevices });
        });
        if (Object.keys(fields).length) throw E.validation(fields);
        return out;
    }

    function writeEntitlements(userId, items, actor) {
        const t = clock.now();
        const by = actor ? actor.id : null;
        db.prepare(`DELETE FROM entitlements WHERE user_id = ? AND ext NOT IN (${items.map(() => '?').join(',') || "''"})`).run(userId, ...items.map((i) => i.ext));
        const up = db.prepare(
            `INSERT INTO entitlements (id, user_id, ext, expires_at, max_devices, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, ext) DO UPDATE SET expires_at = excluded.expires_at, max_devices = excluded.max_devices,
                 updated_at = excluded.updated_at, updated_by = excluded.updated_by`
        );
        for (const it of items) up.run(newId(), userId, it.ext, it.expiresAt, it.maxDevices, t, by, t, by);
    }

    function create(input, actor, { ip } = {}) {
        const fields = {};
        const username = str(input.username, 40);
        const e1 = checkUsername(username);
        if (e1) fields.username = e1;
        const e2 = checkPassword(input.password);
        if (e2) fields.password = e2;
        const email = str(input.email, 200) || null;
        const e3 = checkEmail(email);
        if (e3) fields.email = e3;
        const role = input.role === undefined ? 'user' : input.role;
        if (!['admin', 'user'].includes(role)) fields.role = 'Choose admin or user.';
        if (Object.keys(fields).length) throw E.validation(fields);
        if (getByUsername(username)) throw E.conflict('This username is taken.');
        const ents = input.entitlements ? normalizeEntitlements(input.entitlements) : [];
        const t = clock.now();
        const id = newId();
        const by = actor ? actor.id : null;
        db.transaction(() => {
            db.prepare(
                `INSERT INTO users (id, username, email, password_hash, role, enabled, pending, note, created_at, created_by, updated_at, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(id, username, email, hashPassword(input.password), role, input.enabled === false ? 0 : 1, input.pending ? 1 : 0, str(input.note, 1000) || null, t, by, t, by);
            if (ents.length) writeEntitlements(id, ents, actor);
        })();
        audit.record({ actor, action: input.pending ? 'user.register' : 'user.create', target: id, detail: { username, role }, ip });
        return get(id);
    }

    /** Admin edit. Disabling, role change or a new password signs the user out everywhere. */
    function update(id, patch, actor, { ip } = {}) {
        const u = get(id);
        if (!u) throw E.notFound('User not found.');
        const fields = {};
        const set = {};
        let bump = false;
        if ('username' in patch) {
            const username = str(patch.username, 40);
            const e = checkUsername(username);
            if (e) fields.username = e;
            else {
                const other = getByUsername(username);
                if (other && other.id !== id) throw E.conflict('This username is taken.');
                set.username = username;
            }
        }
        if ('email' in patch) {
            const email = str(patch.email, 200) || null;
            const e = checkEmail(email);
            if (e) fields.email = e;
            else set.email = email;
        }
        if ('role' in patch) {
            if (!['admin', 'user'].includes(patch.role)) fields.role = 'Choose admin or user.';
            else if (patch.role !== u.role) {
                if (actor && actor.id === id) fields.role = 'You cannot change your own role.';
                else {
                    set.role = patch.role;
                    bump = true;
                }
            }
        }
        if ('enabled' in patch) {
            const en = patch.enabled ? 1 : 0;
            if (!en && actor && actor.id === id) fields.enabled = 'You cannot disable yourself.';
            else if (en !== u.enabled) {
                set.enabled = en;
                if (!en) bump = true;
            }
        }
        if ('pending' in patch) set.pending = patch.pending ? 1 : 0;
        if ('note' in patch) set.note = str(patch.note, 1000) || null;
        if ('password' in patch && patch.password !== '' && patch.password !== null && patch.password !== undefined) {
            const e = checkPassword(patch.password);
            if (e) fields.password = e;
            else {
                set.password_hash = hashPassword(patch.password);
                bump = true;
            }
        }
        if (Object.keys(fields).length) throw E.validation(fields);
        const keys = Object.keys(set);
        if (keys.length || bump) {
            const t = clock.now();
            db.transaction(() => {
                if (keys.length) {
                    db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`).run(
                        ...keys.map((k) => set[k]),
                        t,
                        actor ? actor.id : null,
                        id
                    );
                }
                if (bump) signOutEverywhere(id, t);
            })();
            audit.record({ actor, action: 'user.update', target: id, detail: { changed: keys.filter((k) => k !== 'password_hash').concat('password_hash' in set ? ['password'] : []) }, ip });
        }
        return get(id);
    }

    /** Kills every token of the user: bumps token_version and revokes all sign-in sessions. */
    function signOutEverywhere(id, t = clock.now()) {
        db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id);
        db.prepare('UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(t, t, id);
    }

    function remove(id, actor, { ip } = {}) {
        const u = get(id);
        if (!u) throw E.notFound('User not found.');
        if (actor && actor.id === id) throw E.forbidden('You cannot delete yourself.');
        db.prepare('DELETE FROM users WHERE id = ?').run(id); // ON DELETE CASCADE removes their data
        audit.record({ actor, action: 'user.delete', target: id, detail: { username: u.username }, ip });
    }

    function setEntitlements(id, items, actor, { ip } = {}) {
        const u = get(id);
        if (!u) throw E.notFound('User not found.');
        const norm = normalizeEntitlements(items);
        db.transaction(() => writeEntitlements(id, norm, actor))();
        audit.record({ actor, action: 'user.entitlements', target: id, detail: norm, ip });
        return entRows.all(id).map(entitlementShape);
    }

    const touchLogin = (id) => db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(clock.now(), id);

    const count = () => db.prepare('SELECT COUNT(*) FROM users').pluck().get();

    return {
        get,
        getByUsername,
        publicUser,
        adminUser,
        list,
        create,
        update,
        remove,
        setEntitlements,
        entitlementsOf,
        entitlementFor,
        signOutEverywhere,
        touchLogin,
        count,
        checkPassword,
        checkUsername
    };
}

module.exports = { createUsers };
