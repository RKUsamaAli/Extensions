'use strict';
/**
 * Sign-in for extensions and the panel.
 *
 *   refresh token  random 32 bytes, only its SHA-256 is stored (auth_sessions.token_hash).
 *                  Extensions keep it in chrome.storage.local, the panel in an HttpOnly cookie.
 *                  Expiry slides on every refresh (30 days extension / 7 days panel).
 *   access token   JWT, 10 minutes: { sub, role, sid, kind, ext, tv }.
 *
 * Every authenticated request re-reads the user and the session row, so disabling a
 * user, removing a device or signing out takes effect immediately.
 *
 * Extension checks (login, refresh and every extension API call):
 *   extension switched on -> client version >= minVersion -> entitlement exists and not
 *   expired (admins always pass) -> device known or a free device slot -> device not revoked.
 */
const { newId, isId } = require('../lib/ids');
const { verifyPassword, hashPassword, DUMMY_HASH, randomToken, sha256 } = require('../lib/crypto');
const { E } = require('../lib/errors');
const { isExt, compareVersions, str } = require('../lib/util');
const { createLimiter } = require('../lib/rateLimiter');

const DEVICE_TOUCH_MS = 60 * 1000;

function createAuth({ db, clock, config, jwt, users, settings, audit }) {
    const loginLimiter = createLimiter({ limit: config.loginMaxFailures, windowMs: config.loginWindowMin * 60 * 1000, now: () => clock.now() });

    const sessionById = db.prepare('SELECT * FROM auth_sessions WHERE id = ?');
    const sessionByHash = db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?');
    const deviceById = db.prepare('SELECT * FROM devices WHERE id = ?');

    // ------------------------------------------------------------ checks ----
    function checkUserUsable(user) {
        if (!user.enabled) throw E.disabled();
        if (user.pending) throw E.pending();
    }

    /** Extension on, version new enough, entitlement active. */
    function checkExtension(user, ext, version) {
        const s = settings.getAll();
        if (!s.enabled[ext]) throw E.extDisabled(ext);
        const min = s.minVersion[ext];
        if (min && min !== '0.0.0' && compareVersions(version || '0', min) < 0) throw E.updateRequired(min);
        const ent = users.entitlementFor(user, ext);
        if (!ent) throw E.noEntitlement(ext);
        if (!ent.active) throw E.expired(ext, ent.expiresAt);
        return ent;
    }

    /** Finds or registers the device, enforcing the device limit. -> devices row */
    function claimDevice(user, ext, ent, { deviceId, deviceName, version }) {
        const id = str(deviceId, 100);
        if (!id) throw E.validation({ 'client.deviceId': 'Missing device id.' });
        const t = clock.now();
        const existing = db.prepare('SELECT * FROM devices WHERE user_id = ? AND ext = ? AND device_id = ?').get(user.id, ext, id);
        if (existing && !existing.revoked) {
            db.prepare('UPDATE devices SET name = ?, version = ?, last_seen_at = ?, updated_at = ? WHERE id = ?').run(
                str(deviceName, 100) || existing.name,
                str(version, 40) || existing.version,
                t,
                t,
                existing.id
            );
            return deviceById.get(existing.id);
        }
        if (ent.maxDevices !== null) {
            const used = db.prepare('SELECT COUNT(*) FROM devices WHERE user_id = ? AND ext = ? AND revoked = 0').pluck().get(user.id, ext);
            if (used >= ent.maxDevices) throw E.deviceLimit(ent.maxDevices);
        }
        if (existing) {
            // A removed device signs in again and takes a free slot.
            db.prepare('UPDATE devices SET revoked = 0, name = ?, version = ?, last_seen_at = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(
                str(deviceName, 100) || existing.name,
                str(version, 40) || existing.version,
                t,
                t,
                user.id,
                existing.id
            );
            return deviceById.get(existing.id);
        }
        const rowId = newId();
        db.prepare(
            `INSERT INTO devices (id, user_id, ext, device_id, name, version, last_seen_at, revoked, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
        ).run(rowId, user.id, ext, id, str(deviceName, 100) || null, str(version, 40) || null, t, t, user.id, t, user.id);
        return deviceById.get(rowId);
    }

    // ------------------------------------------------------------ tokens ----
    function issueAccess(user, session) {
        const { token, claims } = jwt.sign(
            { sub: user.id, role: user.role, sid: session.id, kind: session.kind, ext: session.ext || null, tv: user.token_version },
            { kind: 'access', ttlSec: config.accessTtlMin * 60, now: clock.now() }
        );
        return { accessToken: token, accessExpiresAt: claims.exp * 1000 };
    }

    const refreshTtlMs = (kind) => (kind === 'panel' ? config.refreshTtlDaysPanel : config.refreshTtlDaysExtension) * 24 * 3600 * 1000;

    // ------------------------------------------------------------- login ----
    /**
     * @param {object} p { username, password, client: { kind, ext, deviceId, deviceName, version }, ip, userAgent }
     * -> { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, user, entitlements }
     */
    function login({ username, password, client, ip, userAgent }) {
        const limitKey = 'ip:' + (ip || '?');
        if (loginLimiter.blocked(limitKey)) throw E.tooMany(loginLimiter.retryAfter(limitKey));
        const c = client && typeof client === 'object' ? client : {};
        const kind = c.kind === 'panel' ? 'panel' : c.kind === 'extension' ? 'extension' : null;
        const fields = {};
        if (!kind) fields['client.kind'] = 'Use "extension" or "panel".';
        if (kind === 'extension' && !isExt(c.ext)) fields['client.ext'] = 'Unknown extension.';
        if (!username) fields.username = 'Enter your username.';
        if (!password) fields.password = 'Enter your password.';
        if (Object.keys(fields).length) throw E.validation(fields);

        const user = users.getByUsername(String(username).trim());
        const ok = verifyPassword(String(password), user ? user.password_hash : DUMMY_HASH);
        if (!user || !ok) {
            loginLimiter.hit(limitKey);
            audit.record({ action: 'auth.login_failed', target: user ? user.id : null, detail: { username: str(username, 60), kind, ext: c.ext || null }, ip });
            throw E.invalidCredentials();
        }
        checkUserUsable(user);

        let device = null;
        let ext = null;
        if (kind === 'extension') {
            ext = c.ext;
            const ent = checkExtension(user, ext, c.version);
            device = claimDevice(user, ext, ent, c);
        }

        const refreshToken = randomToken();
        const t = clock.now();
        const session = {
            id: newId(),
            kind,
            ext,
            expiresAt: t + refreshTtlMs(kind)
        };
        db.prepare(
            `INSERT INTO auth_sessions (id, user_id, kind, ext, device_row_id, token_hash, expires_at, last_used_at, ip, user_agent, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(session.id, user.id, kind, ext, device ? device.id : null, sha256(refreshToken), session.expiresAt, t, str(ip, 64) || null, str(userAgent, 300) || null, t, user.id, t, user.id);
        users.touchLogin(user.id);
        loginLimiter.reset(limitKey);
        audit.record({ actor: user, action: 'auth.login', target: session.id, detail: { kind, ext, device: device ? device.name || device.device_id : null }, ip });

        return {
            ...issueAccess(user, session),
            refreshToken,
            refreshExpiresAt: session.expiresAt,
            user: users.publicUser(user),
            entitlements: users.entitlementsOf(user)
        };
    }

    // ----------------------------------------------------------- refresh ----
    /**
     * @param {object} p { refreshToken, kind ('extension'|'panel'), deviceId, version }
     * -> { accessToken, accessExpiresAt, refreshExpiresAt }
     */
    function refresh({ refreshToken, kind, deviceId, version }) {
        if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.length > 200) throw E.sessionExpired();
        const s = sessionByHash.get(sha256(refreshToken));
        const t = clock.now();
        if (!s || s.revoked_at || s.expires_at <= t || (kind && s.kind !== kind)) throw E.sessionExpired();
        const user = users.get(s.user_id);
        if (!user) throw E.sessionExpired();
        checkUserUsable(user);
        if (s.kind === 'extension') {
            const device = s.device_row_id ? deviceById.get(s.device_row_id) : null;
            if (!device || device.revoked) throw E.deviceRevoked();
            if (deviceId && deviceId !== device.device_id) throw E.sessionExpired();
            checkExtension(user, s.ext, version);
            db.prepare('UPDATE devices SET last_seen_at = ?, version = COALESCE(?, version) WHERE id = ?').run(t, str(version, 40) || null, device.id);
        }
        const expiresAt = t + refreshTtlMs(s.kind);
        db.prepare('UPDATE auth_sessions SET expires_at = ?, last_used_at = ?, updated_at = ? WHERE id = ?').run(expiresAt, t, t, s.id);
        return { ...issueAccess(user, { id: s.id, kind: s.kind, ext: s.ext }), refreshExpiresAt: expiresAt };
    }

    // ------------------------------------------------------ authenticate ----
    /** Bearer token -> { user, session, claims }. Throws the documented 401/403 errors. */
    function authenticate(token) {
        if (!token) throw E.notSignedIn();
        const r = jwt.inspect(token, { kind: 'access', now: clock.now() });
        if (!r) throw E.notSignedIn();
        if (r.expired) throw E.accessExpired();
        const c = r.claims;
        const user = isId(c.sub) ? users.get(c.sub) : null;
        if (!user || user.token_version !== c.tv) throw E.sessionExpired();
        checkUserUsable(user);
        const session = isId(c.sid) ? sessionById.get(c.sid) : null;
        if (!session || session.revoked_at || session.expires_at <= clock.now() || session.user_id !== user.id) throw E.sessionExpired();
        if (session.kind === 'extension') {
            const device = session.device_row_id ? deviceById.get(session.device_row_id) : null;
            if (!device || device.revoked) throw E.deviceRevoked();
            session.device = device;
        }
        return { user, session, claims: c };
    }

    /**
     * Called on every /citamate/* and /relayswitch/* request.
     * Panel tokens may always manage data; extension tokens must belong to this ext
     * and pass the extension checks.
     */
    function requireExtAccess(auth, ext, clientVersion) {
        if (auth.session.kind !== 'extension') return null;
        if (auth.session.ext !== ext) throw E.forbidden(`This sign-in is for ${auth.session.ext}, not ${ext}.`);
        const ent = checkExtension(auth.user, ext, clientVersion);
        const d = auth.session.device;
        const t = clock.now();
        if (d && (!d.last_seen_at || t - d.last_seen_at > DEVICE_TOUCH_MS)) {
            db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(t, d.id);
        }
        return ent;
    }

    function logout(sessionId) {
        const t = clock.now();
        db.prepare('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?').run(t, t, sessionId);
    }

    /** Logout by refresh token (panel cookie without a valid access token). */
    function logoutByRefresh(refreshToken) {
        if (!refreshToken) return;
        const s = sessionByHash.get(sha256(refreshToken));
        if (s) logout(s.id);
    }

    /** Own password change: other sign-ins of the user end, this one continues. */
    function changePassword(user, sessionId, current, next, { ip } = {}) {
        if (!verifyPassword(String(current ?? ''), user.password_hash)) throw E.validation({ current: 'Current password is wrong.' });
        const e = users.checkPassword(next);
        if (e) throw E.validation({ next: e });
        const t = clock.now();
        db.transaction(() => {
            db.prepare('UPDATE users SET password_hash = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(hashPassword(next), t, user.id, user.id);
            db.prepare('UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').run(t, t, user.id, sessionId);
        })();
        audit.record({ actor: user, action: 'auth.password_changed', target: user.id, ip });
    }

    function sweep() {
        loginLimiter.sweep();
    }

    return { login, refresh, authenticate, requireExtAccess, logout, logoutByRefresh, changePassword, checkExtension, sweep };
}

module.exports = { createAuth };
