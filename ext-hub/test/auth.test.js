'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServices, addUser, extClient, DAY } = require('./helpers');

const codeOf = (fn) => {
    try {
        fn();
    } catch (e) {
        return e.code;
    }
    return 'no error';
};

test('extension login: tokens, user, entitlements, device registered', () => {
    const s = makeServices();
    addUser(s, 'ali', { ents: { citamate: { expiresAt: s.clock.now() + 30 * DAY, maxDevices: 2 } } });
    const out = s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate'), ip: '1.1.1.1' });
    assert.ok(out.accessToken && out.refreshToken);
    assert.equal(out.user.username, 'ali');
    assert.equal(out.user.role, 'user');
    assert.equal(out.entitlements[0].ext, 'citamate');
    assert.equal(out.entitlements[0].active, true);
    assert.equal(out.accessExpiresAt, s.clock.now() + 10 * 60 * 1000);
    const a = s.auth.authenticate(out.accessToken);
    assert.equal(a.user.username, 'ali');
    assert.equal(a.session.kind, 'extension');
    assert.equal(s.devices.list({ ownerId: a.user.id }).length, 1);
    assert.equal(s.audit.list().some((x) => x.action === 'auth.login'), true);
});

test('login: username is case-insensitive; wrong password and unknown user give the same error', () => {
    const s = makeServices();
    addUser(s, 'Ali', { ents: { citamate: {} } });
    assert.ok(s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' } }).accessToken);
    assert.equal(codeOf(() => s.auth.login({ username: 'ali', password: 'nope', client: { kind: 'panel' } })), 'invalid_credentials');
    assert.equal(codeOf(() => s.auth.login({ username: 'ghost', password: 'nope', client: { kind: 'panel' } })), 'invalid_credentials');
    assert.equal(codeOf(() => s.auth.login({ username: 'ali', password: 'x', client: { kind: 'robot' } })), 'validation_error');
    assert.equal(codeOf(() => s.auth.login({ username: 'ali', password: 'x', client: { kind: 'extension', ext: 'other' } })), 'validation_error');
});

test('login: too many failures from one IP are blocked, other IPs are not', () => {
    const s = makeServices({ loginMaxFailures: 3 });
    addUser(s, 'ali');
    for (let i = 0; i < 3; i++) assert.equal(codeOf(() => s.auth.login({ username: 'ali', password: 'bad', client: { kind: 'panel' }, ip: '9.9.9.9' })), 'invalid_credentials');
    assert.equal(codeOf(() => s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' }, ip: '9.9.9.9' })), 'too_many_requests');
    assert.ok(s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' }, ip: '8.8.8.8' }).accessToken);
    s.clock.advance(16 * 60 * 1000);
    assert.ok(s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' }, ip: '9.9.9.9' }).accessToken);
});

test('login: disabled and pending accounts', () => {
    const s = makeServices();
    const u = addUser(s, 'ali');
    s.users.update(u.id, { enabled: false }, null);
    assert.equal(codeOf(() => s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' } })), 'account_disabled');
    s.users.update(u.id, { enabled: true, pending: true }, null);
    assert.equal(codeOf(() => s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' } })), 'account_pending');
});

test('entitlements: none, expired, admin always allowed; panel needs none', () => {
    const s = makeServices();
    addUser(s, 'none');
    addUser(s, 'old', { ents: { relayswitch: { expiresAt: s.clock.now() - 1 } } });
    addUser(s, 'boss', { role: 'admin' });
    assert.equal(codeOf(() => s.auth.login({ username: 'none', password: 'password-123', client: extClient('citamate') })), 'no_entitlement');
    let err;
    try {
        s.auth.login({ username: 'old', password: 'password-123', client: extClient('relayswitch') });
    } catch (e) {
        err = e;
    }
    assert.equal(err.code, 'subscription_expired');
    assert.equal(err.extra.expiresAt, s.clock.now() - 1);
    assert.ok(s.auth.login({ username: 'boss', password: 'password-123', client: extClient('citamate') }).accessToken);
    assert.ok(s.auth.login({ username: 'none', password: 'password-123', client: { kind: 'panel' } }).accessToken);
});

test('expiry hits a signed-in extension on its next call and on refresh', () => {
    const s = makeServices();
    addUser(s, 'ali', { ents: { citamate: { expiresAt: s.clock.now() + DAY } } });
    const out = s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate') });
    const a = s.auth.authenticate(out.accessToken);
    assert.ok(s.auth.requireExtAccess(a, 'citamate', '1.0.0'));
    // The admin shortens the access while the extension is signed in: the next call fails.
    s.users.setEntitlements(a.user.id, [{ ext: 'citamate', expiresAt: s.clock.now() - 1, maxDevices: 1 }], null);
    assert.equal(codeOf(() => s.auth.requireExtAccess(s.auth.authenticate(out.accessToken), 'citamate', '1.0.0')), 'subscription_expired');
    // Extending it again lets the same sign-in continue.
    s.users.setEntitlements(a.user.id, [{ ext: 'citamate', expiresAt: s.clock.now() + DAY, maxDevices: 1 }], null);
    assert.ok(s.auth.requireExtAccess(s.auth.authenticate(out.accessToken), 'citamate', '1.0.0'));
    // Time passes beyond the date: refresh is refused.
    s.clock.advance(DAY + 1);
    assert.equal(codeOf(() => s.auth.refresh({ refreshToken: out.refreshToken, kind: 'extension', deviceId: 'dev-1' })), 'subscription_expired');
});

test('device limit: known device reuses its slot, new device is refused, removing one frees a slot', () => {
    const s = makeServices();
    const u = addUser(s, 'ali', { ents: { citamate: { maxDevices: 1 } } });
    s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate', 'A') });
    s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate', 'A') });
    let err;
    try {
        s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate', 'B') });
    } catch (e) {
        err = e;
    }
    assert.equal(err.code, 'device_limit');
    assert.equal(err.extra.maxDevices, 1);
    // Devices are per extension.
    s.users.setEntitlements(u.id, [{ ext: 'citamate', maxDevices: 1 }, { ext: 'relayswitch', maxDevices: 1 }], null);
    assert.ok(s.auth.login({ username: 'ali', password: 'password-123', client: extClient('relayswitch', 'B') }).accessToken);
    const devA = s.devices.list({ ownerId: u.id }).find((d) => d.deviceId === 'A');
    s.devices.revoke(u, devA.id);
    assert.ok(s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate', 'B') }).accessToken);
    // A is now over the limit again.
    assert.equal(codeOf(() => s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate', 'A') })), 'device_limit');
    assert.equal(codeOf(() => s.auth.login({ username: 'ali', password: 'password-123', client: { ...extClient('citamate'), deviceId: '' } })), 'validation_error');
});

test('removing a device signs it out immediately', () => {
    const s = makeServices();
    const u = addUser(s, 'ali', { ents: { citamate: { maxDevices: 2 } } });
    const out = s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate', 'A') });
    const dev = s.devices.list({ ownerId: u.id })[0];
    s.devices.revoke(u, dev.id);
    assert.equal(codeOf(() => s.auth.authenticate(out.accessToken)), 'session_expired');
    assert.equal(codeOf(() => s.auth.refresh({ refreshToken: out.refreshToken, kind: 'extension' })), 'session_expired');
});

test('min version and kill switch', () => {
    const s = makeServices();
    addUser(s, 'ali', { ents: { citamate: {} } });
    s.settings.update({ minVersion: { citamate: '1.6.0' } }, null);
    let err;
    try {
        s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate', 'A', '1.5.0') });
    } catch (e) {
        err = e;
    }
    assert.equal(err.code, 'update_required');
    assert.equal(err.status, 426);
    assert.equal(err.extra.minVersion, '1.6.0');
    const out = s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate', 'A', '1.6.0') });
    const a = s.auth.authenticate(out.accessToken);
    assert.equal(codeOf(() => s.auth.requireExtAccess(a, 'citamate', '1.5.9')), 'update_required');
    s.settings.update({ enabled: { citamate: false } }, null);
    assert.equal(codeOf(() => s.auth.requireExtAccess(a, 'citamate', '1.6.0')), 'ext_disabled');
    assert.equal(codeOf(() => s.auth.requireExtAccess(a, 'relayswitch', '1.6.0')), 'forbidden');
});

test('refresh: slides expiry, checks device id, rejects revoked / expired / wrong kind', () => {
    const s = makeServices();
    addUser(s, 'ali', { ents: { citamate: {} } });
    const out = s.auth.login({ username: 'ali', password: 'password-123', client: extClient('citamate', 'A') });
    s.clock.advance(20 * DAY);
    const r = s.auth.refresh({ refreshToken: out.refreshToken, kind: 'extension', deviceId: 'A', version: '1.6.0' });
    assert.equal(r.refreshExpiresAt, s.clock.now() + 30 * DAY);
    assert.ok(s.auth.authenticate(r.accessToken));
    assert.equal(codeOf(() => s.auth.refresh({ refreshToken: out.refreshToken, kind: 'extension', deviceId: 'B' })), 'session_expired');
    assert.equal(codeOf(() => s.auth.refresh({ refreshToken: out.refreshToken, kind: 'panel' })), 'session_expired');
    assert.equal(codeOf(() => s.auth.refresh({ refreshToken: 'nope' })), 'session_expired');
    assert.equal(codeOf(() => s.auth.refresh({ refreshToken: null })), 'session_expired');
    s.clock.advance(31 * DAY);
    assert.equal(codeOf(() => s.auth.refresh({ refreshToken: out.refreshToken, kind: 'extension' })), 'session_expired');
});

test('access token: expired, garbage, logout, sign out everywhere', () => {
    const s = makeServices();
    const u = addUser(s, 'ali');
    const out = s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' } });
    assert.equal(codeOf(() => s.auth.authenticate(null)), 'not_signed_in');
    assert.equal(codeOf(() => s.auth.authenticate('x.y.z')), 'not_signed_in');
    s.clock.advance(11 * 60 * 1000);
    assert.equal(codeOf(() => s.auth.authenticate(out.accessToken)), 'access_token_expired');
    const r = s.auth.refresh({ refreshToken: out.refreshToken, kind: 'panel' });
    const a = s.auth.authenticate(r.accessToken);
    s.auth.logout(a.session.id);
    assert.equal(codeOf(() => s.auth.authenticate(r.accessToken)), 'session_expired');

    const two = s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' } });
    s.users.signOutEverywhere(u.id);
    assert.equal(codeOf(() => s.auth.authenticate(two.accessToken)), 'session_expired');
    assert.equal(codeOf(() => s.auth.refresh({ refreshToken: two.refreshToken })), 'session_expired');
});

test('disabling a user kills live tokens; admin password reset too', () => {
    const s = makeServices();
    const u = addUser(s, 'ali');
    const out = s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' } });
    s.users.update(u.id, { password: 'brand-new-pass' }, null);
    assert.equal(codeOf(() => s.auth.authenticate(out.accessToken)), 'session_expired');
    const two = s.auth.login({ username: 'ali', password: 'brand-new-pass', client: { kind: 'panel' } });
    s.users.update(u.id, { enabled: false }, null);
    assert.equal(codeOf(() => s.auth.authenticate(two.accessToken)), 'session_expired');
});

test('own password change keeps this sign-in and ends the others', () => {
    const s = makeServices();
    addUser(s, 'ali');
    const one = s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' } });
    const two = s.auth.login({ username: 'ali', password: 'password-123', client: { kind: 'panel' } });
    const a = s.auth.authenticate(one.accessToken);
    assert.equal(codeOf(() => s.auth.changePassword(a.user, a.session.id, 'wrong', 'new-password-1')), 'validation_error');
    assert.equal(codeOf(() => s.auth.changePassword(a.user, a.session.id, 'password-123', 'short')), 'validation_error');
    s.auth.changePassword(a.user, a.session.id, 'password-123', 'new-password-1');
    assert.ok(s.auth.authenticate(one.accessToken));
    assert.equal(codeOf(() => s.auth.authenticate(two.accessToken)), 'session_expired');
    assert.ok(s.auth.login({ username: 'ali', password: 'new-password-1', client: { kind: 'panel' } }));
});
