'use strict';
/** Audit trail: sign-ins, admin changes, device removals. Never stores secrets. */
const { newId } = require('../lib/ids');
const { clampInt } = require('../lib/util');

function createAudit({ db, clock }) {
    const ins = db.prepare('INSERT INTO audit (id, t, actor_id, actor_name, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    function record({ actor = null, action, target = null, detail = null, ip = null }) {
        ins.run(
            newId(),
            clock.now(),
            actor ? actor.id : null,
            actor ? actor.username : null,
            action,
            target,
            detail === null || detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
            ip
        );
    }

    /** Newest first. `before` = id of the last row of the previous page. */
    function list({ limit, before } = {}) {
        const n = clampInt(limit, 1, 500, 100);
        const rows = before
            ? db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(String(before), n)
            : db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(n);
        return rows.map((r) => ({ id: r.id, t: r.t, actorId: r.actor_id, actorName: r.actor_name, action: r.action, target: r.target, detail: r.detail, ip: r.ip }));
    }

    return { record, list };
}

module.exports = { createAudit };
