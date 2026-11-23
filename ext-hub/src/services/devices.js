'use strict';
/** Extension installs. Removing one signs it out and frees a device slot. */
const { isId } = require('../lib/ids');
const { scopeSql, assertCanTouch } = require('./ownership');

function createDevices({ db, clock, audit }) {
    const shape = (r) => ({
        id: r.id,
        deviceId: r.device_id,
        ext: r.ext,
        name: r.name || '',
        version: r.version || '',
        lastSeenAt: r.last_seen_at ?? null,
        createdAt: r.created_at,
        revoked: !!r.revoked,
        ownerId: r.user_id,
        ownerName: r.owner_name ?? null
    });

    function list(scope) {
        // devices.user_id is the owner; reuse scopeSql by aliasing.
        const s = scopeSql(scope, 'd');
        const where = s.where.replace('d.owner_id', 'd.user_id');
        return db
            .prepare(`SELECT d.*, u.username AS owner_name FROM devices d JOIN users u ON u.id = d.user_id WHERE ${where} ORDER BY d.revoked, d.last_seen_at DESC, d.id DESC`)
            .all(...s.params)
            .map(shape);
    }

    function revoke(actor, id, { ip } = {}) {
        const row = isId(id) ? db.prepare('SELECT * FROM devices WHERE id = ?').get(id) : null;
        assertCanTouch(actor, row && { ...row, owner_id: row.user_id }, 'Device');
        const t = clock.now();
        db.transaction(() => {
            db.prepare('UPDATE devices SET revoked = 1, updated_at = ?, updated_by = ? WHERE id = ?').run(t, actor.id, id);
            db.prepare('UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE device_row_id = ? AND revoked_at IS NULL').run(t, t, id);
        })();
        audit.record({ actor, action: 'device.revoke', target: id, detail: { ext: row.ext, name: row.name }, ip });
    }

    function countActive(scope) {
        const s = scopeSql(scope, 'd');
        return db.prepare(`SELECT COUNT(*) FROM devices d WHERE ${s.where.replace('d.owner_id', 'd.user_id')} AND d.revoked = 0`).pluck().get(...s.params);
    }

    return { list, revoke, countActive };
}

module.exports = { createDevices };
