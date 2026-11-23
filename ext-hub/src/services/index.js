'use strict';
/**
 * Wires every service around one database. `clock` is injectable so tests can move time
 * (expiry dates, token lifetimes).
 */
const { cipherFor } = require('../lib/crypto');
const { createJwt } = require('../lib/jwt');
const { createAudit } = require('./audit');
const { createSettings } = require('./settings');
const { createUsers } = require('./users');
const { createAuth } = require('./auth');
const { createProfiles } = require('./profiles');
const { createProxies } = require('./proxies');
const { createActivity } = require('./activity');
const { createConfigStore } = require('./config');
const { createAvailability } = require('./availability');
const { createDevices } = require('./devices');

const systemClock = { now: () => Date.now() };

function createServices({ db, config, clock = systemClock, checkProxy }) {
    const cipher = cipherFor(config);
    const jwt = createJwt({ secret: config.appSecret, audience: config.publicUrl });
    const audit = createAudit({ db, clock });
    const settings = createSettings({ db, clock });
    const users = createUsers({ db, clock, audit });
    const auth = createAuth({ db, clock, config, jwt, users, settings, audit });
    const profiles = createProfiles({ db, clock, cipher, users });
    const proxies = createProxies({ db, clock, cipher, users, ...(checkProxy ? { checkProxy } : {}) });
    // CitaMate results move entries along (pending -> in progress -> booked).
    const availability = createAvailability({ db, clock });
    const activity = createActivity({ db, clock, onLog: profiles.noteActivity, onSighting: availability.noteSighting });
    const configStore = createConfigStore({ db, clock, audit });
    const devices = createDevices({ db, clock, audit });

    /** Deletes old logs/checks/sightings and dead sign-in sessions. -> counts */
    function maintenance() {
        const days = settings.getAll().logRetentionDays;
        const cutoff = clock.now() - days * 24 * 3600 * 1000;
        const out = {};
        db.transaction(() => {
            for (const table of ['cm_logs', 'cm_sightings', 'rs_logs', 'proxy_checks', 'cm_alerts']) {
                out[table] = db.prepare(`DELETE FROM ${table} WHERE t < ?`).run(cutoff).changes;
            }
            out.check_claims = db.prepare('DELETE FROM cm_check_claims WHERE until < ?').run(clock.now()).changes;
            const weekAgo = clock.now() - 7 * 24 * 3600 * 1000;
            out.auth_sessions = db.prepare('DELETE FROM auth_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(weekAgo, weekAgo).changes;
        })();
        auth.sweep();
        return out;
    }

    /** Users whose access ends within `days` (for the admin dashboard). */
    function expiringSoon(days = 7) {
        const now = clock.now();
        return db
            .prepare(
                `SELECT e.ext, e.expires_at, u.id, u.username FROM entitlements e JOIN users u ON u.id = e.user_id
                 WHERE e.expires_at IS NOT NULL AND e.expires_at > ? AND e.expires_at <= ? AND u.enabled = 1 ORDER BY e.expires_at`
            )
            .all(now, now + days * 24 * 3600 * 1000)
            .map((r) => ({ userId: r.id, username: r.username, ext: r.ext, expiresAt: r.expires_at }));
    }

    function dashboard(actor, scope) {
        const recent = activity.recentCounts(scope, 7);
        const out = {
            counts: {
                profiles: profiles.count(scope),
                proxies: proxies.count(scope),
                devices: devices.countActive(scope),
                logs7d: recent.logs,
                bookings7d: recent.bookings
            },
            entitlements: users.entitlementsOf(scope.ownerId && scope.ownerId !== actor.id ? users.get(scope.ownerId) || actor : actor)
        };
        if (actor.role === 'admin' && scope.ownerId === null) {
            out.counts.users = users.count();
            out.expiringSoon = expiringSoon(7);
        }
        return out;
    }

    return { db, config, clock, cipher, jwt, audit, settings, users, auth, profiles, proxies, activity, availability, configStore, devices, maintenance, expiringSoon, dashboard };
}

module.exports = { createServices, systemClock };
