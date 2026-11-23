'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServices, addUser, extClient, startApp, DAY } = require('./helpers');

const PW = 'password-123';

async function withApp(fn, overrides) {
    const s = makeServices(overrides);
    s.configStore.seed(s.config.seedsDir);
    const admin = addUser(s, 'boss', { role: 'admin' });
    const ali = addUser(s, 'ali', { ents: { citamate: { expiresAt: s.clock.now() + 30 * DAY, maxDevices: 2 }, relayswitch: {} } });
    const app = await startApp(s);
    try {
        await fn({ s, app, admin, ali, call: app.call });
    } finally {
        await app.close();
    }
}

async function extLogin(call, username, ext, deviceId = 'dev-1') {
    const r = await call('POST', '/api/v1/auth/login', { body: { username, password: PW, client: extClient(ext, deviceId) } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
}
async function panelLogin(call, username) {
    const r = await call('POST', '/api/v1/auth/login', { body: { username, password: PW, client: { kind: 'panel' } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const cookie = r.headers.get('set-cookie');
    return { ...r.json, cookie: cookie.split(';')[0] };
}

test('extension journey: login, bootstrap, CRUD, logs, refresh, logout', () =>
    withApp(async ({ call }) => {
        const L = await extLogin(call, 'ali', 'citamate');
        assert.ok(L.refreshToken, 'extensions get the refresh token in the body');
        const H = { 'x-client': 'citamate/1.6.0', 'x-device-id': 'dev-1' };
        const boot = await call('GET', '/api/v1/bootstrap?ext=citamate', { token: L.accessToken, headers: H });
        assert.equal(boot.status, 200);
        assert.equal(boot.json.catalogVersion, 1);
        assert.deepEqual(boot.json.siteConfig.phone, ['#txtTelefonoCitado']);
        assert.equal(boot.json.entitlement.maxDevices, 2);
        assert.equal(boot.headers.get('cache-control'), 'no-store');

        const cat = await call('GET', '/api/v1/citamate/catalog', { token: L.accessToken, headers: H });
        assert.equal(cat.json.version, 1);
        assert.equal(cat.json.data.paises[0].text, 'PAKISTAN');

        const c = await call('POST', '/api/v1/citamate/profiles', { token: L.accessToken, headers: H, body: { label: 'Ali', docNumber: 'x1', fullName: 'ali' } });
        assert.equal(c.status, 201);
        const id = c.json.item.id;
        const bad = await call('POST', '/api/v1/citamate/profiles', { token: L.accessToken, headers: H, body: { label: '' } });
        assert.equal(bad.status, 400);
        assert.equal(bad.json.code, 'validation_error');
        assert.ok(bad.json.fields.label);
        const up = await call('PUT', `/api/v1/citamate/profiles/${id}`, { token: L.accessToken, headers: H, body: { label: 'Ali 2', docNumber: 'x1', fullName: 'ali' } });
        assert.equal(up.json.item.label, 'Ali 2');
        const bulk = await call('POST', '/api/v1/citamate/profiles/bulk', { token: L.accessToken, headers: H, body: { items: [{ label: 'B', docNumber: '1', fullName: 'b' }] } });
        assert.equal(bulk.status, 201);
        const list = await call('GET', '/api/v1/citamate/profiles', { token: L.accessToken, headers: H });
        assert.deepEqual(list.json.items.map((p) => p.label), ['Ali 2', 'B']);

        const lg = await call('POST', '/api/v1/citamate/logs', { token: L.accessToken, headers: H, body: { items: [{ id: 'l1', t: 1, status: 'ok', entryId: id }] } });
        assert.equal(lg.json.saved, 1);
        assert.equal((await call('GET', '/api/v1/citamate/logs', { token: L.accessToken, headers: H })).json.items.length, 1);
        const sg = await call('POST', '/api/v1/citamate/office-sightings', { token: L.accessToken, headers: H, body: { items: [{ id: 's1', offices: [{ value: '1', text: 'A' }] }] } });
        assert.equal(sg.json.saved, 1);
        assert.equal((await call('DELETE', '/api/v1/citamate/logs', { token: L.accessToken, headers: H })).json.removed, 1);
        assert.equal((await call('DELETE', `/api/v1/citamate/profiles/${id}`, { token: L.accessToken, headers: H })).json.ok, true);

        const R = await call('POST', '/api/v1/auth/refresh', { headers: H, body: { refreshToken: L.refreshToken } });
        assert.equal(R.status, 200);
        assert.ok(R.json.accessToken);
        const wrongDev = await call('POST', '/api/v1/auth/refresh', { headers: { ...H, 'x-device-id': 'other' }, body: { refreshToken: L.refreshToken } });
        assert.equal(wrongDev.json.code, 'session_expired');

        const me = await call('GET', '/api/v1/auth/me', { token: R.json.accessToken });
        assert.equal(me.json.session.ext, 'citamate');
        assert.equal((await call('POST', '/api/v1/auth/logout', { token: R.json.accessToken, body: {} })).json.ok, true);
        assert.equal((await call('GET', '/api/v1/citamate/profiles', { token: R.json.accessToken, headers: H })).json.code, 'session_expired');
        assert.equal((await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: L.refreshToken } })).status, 401);
    }));

test('relayswitch over HTTP: proxies, checks, logs; a citamate token cannot use it', () =>
    withApp(async ({ call }) => {
        const L = await extLogin(call, 'ali', 'relayswitch');
        const p = await call('POST', '/api/v1/relayswitch/proxies', { token: L.accessToken, body: { name: 'DE', host: '1.2.3.4', port: 8080, password: 'pw' } });
        assert.equal(p.status, 201);
        const pid = p.json.item.id;
        assert.equal((await call('POST', '/api/v1/relayswitch/proxies/bulk', { token: L.accessToken, body: { items: [{ host: 'b', port: 1 }] } })).json.items.length, 1);
        assert.equal((await call('PUT', `/api/v1/relayswitch/proxies/${pid}`, { token: L.accessToken, body: { name: 'DE2', host: '1.2.3.4', port: 8080 } })).json.item.password, 'pw');
        assert.equal((await call('POST', '/api/v1/relayswitch/checks', { token: L.accessToken, body: { items: [{ proxyId: pid, ok: true, ms: 50 }] } })).json.saved, 1);
        const st = await call('GET', '/api/v1/relayswitch/checks', { token: L.accessToken });
        assert.equal(st.json.stats[pid].results[0].ms, 50);
        assert.equal((await call('POST', '/api/v1/relayswitch/logs', { token: L.accessToken, body: { items: [{ event: 'Connected' }] } })).json.saved, 1);
        assert.equal((await call('GET', '/api/v1/relayswitch/logs', { token: L.accessToken })).json.items[0].event, 'Connected');
        assert.equal((await call('DELETE', '/api/v1/relayswitch/logs', { token: L.accessToken })).json.removed, 1);
        assert.equal((await call('DELETE', `/api/v1/relayswitch/proxies/${pid}`, { token: L.accessToken })).json.ok, true);
        const cross = await call('GET', '/api/v1/citamate/profiles', { token: L.accessToken });
        assert.equal(cross.status, 403);
        const bootWrong = await call('GET', '/api/v1/bootstrap?ext=citamate', { token: L.accessToken });
        assert.equal(bootWrong.status, 403);
        assert.equal((await call('GET', '/api/v1/bootstrap?ext=nope', { token: L.accessToken })).status, 400);
    }));

test('extension error codes over HTTP: expired, device limit, update required, disabled', () =>
    withApp(async ({ s, call, ali }) => {
        await extLogin(call, 'ali', 'citamate', 'A');
        await extLogin(call, 'ali', 'citamate', 'B');
        const third = await call('POST', '/api/v1/auth/login', { body: { username: 'ali', password: PW, client: extClient('citamate', 'C') } });
        assert.equal(third.status, 403);
        assert.equal(third.json.code, 'device_limit');
        assert.equal(third.json.maxDevices, 2);

        const L = await extLogin(call, 'ali', 'citamate', 'A');
        s.settings.update({ minVersion: { citamate: '2.0.0' } }, null);
        const old = await call('GET', '/api/v1/citamate/profiles', { token: L.accessToken, headers: { 'x-client': 'citamate/1.6.0' } });
        assert.equal(old.status, 426);
        assert.equal(old.json.minVersion, '2.0.0');
        s.settings.update({ minVersion: { citamate: '0.0.0' }, enabled: { citamate: false } }, null);
        const off = await call('GET', '/api/v1/citamate/profiles', { token: L.accessToken });
        assert.equal(off.status, 503);
        assert.equal(off.json.code, 'ext_disabled');
        s.settings.update({ enabled: { citamate: true } }, null);

        s.users.setEntitlements(ali.id, [{ ext: 'citamate', expiresAt: s.clock.now() - 1, maxDevices: 2 }], null);
        const exp = await call('GET', '/api/v1/citamate/profiles', { token: L.accessToken });
        assert.equal(exp.status, 403);
        assert.equal(exp.json.code, 'subscription_expired');
        assert.equal(exp.json.expiresAt, s.clock.now() - 1);
        assert.match(exp.json.message, /expired on/);

        s.clock.advance(11 * 60 * 1000);
        const stale = await call('GET', '/api/v1/auth/me', { token: L.accessToken });
        assert.equal(stale.json.code, 'access_token_expired');
        assert.equal((await call('GET', '/api/v1/auth/me')).json.code, 'not_signed_in');
    }));

test('panel: cookie sign-in, refresh by cookie, cross-site refused, logout clears cookie', () =>
    withApp(async ({ call }) => {
        const P = await panelLogin(call, 'ali');
        assert.equal(P.refreshToken, undefined, 'the panel never sees the refresh token');
        assert.match(P.cookie, /^eh_rt=/);
        const loginRes = await call('POST', '/api/v1/auth/login', { body: { username: 'ali', password: PW, client: { kind: 'panel' } } });
        const sc = loginRes.headers.get('set-cookie');
        assert.match(sc, /HttpOnly/);
        assert.match(sc, /SameSite=Strict/);
        assert.match(sc, /Path=\/api\/v1\/auth/);

        const r = await call('POST', '/api/v1/auth/refresh', { headers: { cookie: P.cookie }, body: {} });
        assert.equal(r.status, 200);
        assert.ok(r.json.accessToken);
        const cross = await call('POST', '/api/v1/auth/refresh', { headers: { cookie: P.cookie, origin: 'https://evil.example' }, body: {} });
        assert.equal(cross.status, 403);
        assert.equal((await call('POST', '/api/v1/auth/refresh', { body: {} })).json.code, 'session_expired');

        // Panel tokens manage data without an extension check.
        assert.equal((await call('GET', '/api/v1/citamate/profiles', { token: r.json.accessToken })).status, 200);
        assert.equal((await call('GET', '/api/v1/dashboard', { token: r.json.accessToken })).json.counts.profiles, 0);

        const out = await call('POST', '/api/v1/auth/logout', { headers: { cookie: P.cookie }, body: {} });
        assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
        assert.equal((await call('POST', '/api/v1/auth/refresh', { headers: { cookie: P.cookie }, body: {} })).status, 401);
    }));

test('password change over HTTP', () =>
    withApp(async ({ call }) => {
        const P = await panelLogin(call, 'ali');
        const bad = await call('POST', '/api/v1/auth/password', { token: P.accessToken, body: { current: 'x', next: 'new-password-1' } });
        assert.equal(bad.json.fields.current, 'Current password is wrong.');
        assert.equal((await call('POST', '/api/v1/auth/password', { token: P.accessToken, body: { current: PW, next: 'new-password-1' } })).json.ok, true);
        const again = await call('POST', '/api/v1/auth/login', { body: { username: 'ali', password: 'new-password-1', client: { kind: 'panel' } } });
        assert.equal(again.status, 200);
    }));

test('ownership over HTTP: users see own, admin uses ?owner=', () =>
    withApp(async ({ call, ali }) => {
        const A = await panelLogin(call, 'ali');
        const B = await panelLogin(call, 'boss');
        await call('POST', '/api/v1/citamate/profiles', { token: A.accessToken, body: { label: 'mine', docNumber: '1', fullName: 'a' } });
        assert.equal((await call('GET', '/api/v1/citamate/profiles', { token: B.accessToken })).json.items.length, 0);
        const all = await call('GET', '/api/v1/citamate/profiles?owner=all', { token: B.accessToken });
        assert.equal(all.json.items[0].ownerName, 'ali');
        assert.equal((await call('GET', `/api/v1/citamate/profiles?owner=${ali.id}`, { token: B.accessToken })).json.items.length, 1);
        assert.equal((await call('GET', '/api/v1/citamate/profiles?owner=all', { token: A.accessToken })).status, 403);
        const pid = all.json.items[0].id;
        const forOther = await call('POST', '/api/v1/relayswitch/proxies', { token: B.accessToken, body: { host: 'h', port: 1, ownerId: ali.id } });
        assert.equal(forOther.json.item.ownerName, 'ali');
        // ali cannot touch a row of boss (404), boss can touch ali's.
        const bossRow = await call('POST', '/api/v1/citamate/profiles', { token: B.accessToken, body: { label: 'boss', docNumber: '1', fullName: 'b' } });
        assert.equal((await call('DELETE', `/api/v1/citamate/profiles/${bossRow.json.item.id}`, { token: A.accessToken })).status, 404);
        assert.equal((await call('DELETE', `/api/v1/citamate/profiles/${pid}`, { token: B.accessToken })).status, 200);
        const dash = await call('GET', '/api/v1/dashboard?owner=all', { token: B.accessToken });
        assert.equal(dash.json.counts.users, 2);
    }));

test('devices over HTTP: list own, revoke signs the extension out', () =>
    withApp(async ({ call }) => {
        const L = await extLogin(call, 'ali', 'citamate', 'A');
        const P = await panelLogin(call, 'ali');
        const d = await call('GET', '/api/v1/devices', { token: P.accessToken });
        assert.equal(d.json.items.length, 1);
        assert.equal(d.json.items[0].deviceId, 'A');
        const B = await panelLogin(call, 'boss');
        assert.equal((await call('GET', '/api/v1/devices', { token: B.accessToken })).json.items.length, 0);
        assert.equal((await call('GET', '/api/v1/devices?owner=all', { token: B.accessToken })).json.items.length, 1);
        assert.equal((await call('DELETE', `/api/v1/devices/${d.json.items[0].id}`, { token: P.accessToken })).json.ok, true);
        assert.equal((await call('GET', '/api/v1/citamate/profiles', { token: L.accessToken })).json.code, 'session_expired');
    }));

test('admin API: users, entitlements, sign-out, settings, catalog, site config, audit; users are refused', () =>
    withApp(async ({ call, ali }) => {
        const A = await panelLogin(call, 'ali');
        assert.equal((await call('GET', '/api/v1/admin/users', { token: A.accessToken })).status, 403);
        const B = await panelLogin(call, 'boss');
        const T = B.accessToken;
        const users = await call('GET', '/api/v1/admin/users', { token: T });
        assert.deepEqual(users.json.items.map((u) => u.username), ['ali', 'boss']);
        assert.equal(users.json.items[0].entitlements.length, 2);

        const created = await call('POST', '/api/v1/admin/users', {
            token: T,
            body: { username: 'zed', password: 'password-123', email: 'z@z.z', entitlements: [{ ext: 'relayswitch', expiresAt: null, maxDevices: 3 }] }
        });
        assert.equal(created.status, 201);
        assert.equal(created.json.item.entitlements[0].maxDevices, 3);
        assert.equal((await call('POST', '/api/v1/admin/users', { token: T, body: { username: 'zed', password: 'password-123' } })).status, 409);
        const zid = created.json.item.id;
        const ed = await call('PUT', `/api/v1/admin/users/${zid}`, { token: T, body: { enabled: true, pending: false, note: 'vip' } });
        assert.equal(ed.json.item.note, 'vip');
        const ents = await call('PUT', `/api/v1/admin/users/${ali.id}/entitlements`, { token: T, body: { items: [{ ext: 'citamate', expiresAt: 1, maxDevices: 1 }] } });
        assert.equal(ents.json.items[0].active, false);
        assert.equal((await call('POST', `/api/v1/admin/users/${ali.id}/sign-out`, { token: T })).json.ok, true);
        assert.equal((await call('GET', '/api/v1/auth/me', { token: A.accessToken })).json.code, 'session_expired');
        assert.equal((await call('DELETE', `/api/v1/admin/users/${zid}`, { token: T })).json.ok, true);
        assert.equal((await call('PUT', '/api/v1/admin/users/nope', { token: T, body: {} })).status, 404);

        const st = await call('PUT', '/api/v1/admin/settings', { token: T, body: { values: { allowSignup: true, minVersion: { citamate: '1.6.0' } } } });
        assert.equal(st.json.values.allowSignup, true);
        assert.equal((await call('GET', '/api/v1/admin/settings', { token: T })).json.values.minVersion.citamate, '1.6.0');
        assert.equal((await call('PUT', '/api/v1/admin/settings', { token: T, body: { values: { logRetentionDays: -5 } } })).status, 400);

        const cat = await call('GET', '/api/v1/admin/catalog/citamate', { token: T });
        assert.equal(cat.json.version, 1);
        assert.equal((await call('PUT', '/api/v1/admin/catalog/citamate', { token: T, body: { data: cat.json.data } })).json.version, 2);
        assert.equal((await call('PUT', '/api/v1/admin/catalog/citamate', { token: T, body: { data: [] } })).status, 400);
        assert.equal((await call('GET', '/api/v1/admin/catalog/nope', { token: T })).status, 404);
        const sc = await call('PUT', '/api/v1/admin/site-config/citamate', { token: T, body: { config: { phone: ['#x'] } } });
        assert.deepEqual(sc.json.config.phone, ['#x']);
        assert.deepEqual((await call('GET', '/api/v1/admin/site-config/citamate', { token: T })).json.config.phone, ['#x']);

        const audit = await call('GET', '/api/v1/admin/audit?limit=3', { token: T });
        assert.equal(audit.json.items.length, 3);
        const page2 = await call('GET', `/api/v1/admin/audit?limit=3&before=${audit.json.items[2].id}`, { token: T });
        assert.ok(page2.json.items.every((x) => x.id < audit.json.items[2].id));
        assert.ok((await call('GET', '/api/v1/admin/expiring', { token: T })).json.items);
    }));

test('register: closed by default, open after the admin allows it, user waits for approval', () =>
    withApp(async ({ s, call }) => {
        const closed = await call('POST', '/api/v1/auth/register', { body: { username: 'newbie', password: 'password-123' } });
        assert.equal(closed.status, 403);
        s.settings.update({ allowSignup: true }, null);
        const open = await call('POST', '/api/v1/auth/register', { body: { username: 'newbie', password: 'password-123', role: 'admin' } });
        assert.equal(open.status, 201);
        assert.equal(open.json.pending, true);
        const u = s.users.getByUsername('newbie');
        assert.equal(u.role, 'user', 'cannot register as admin');
        const login = await call('POST', '/api/v1/auth/login', { body: { username: 'newbie', password: 'password-123', client: { kind: 'panel' } } });
        assert.equal(login.json.code, 'account_pending');
    }));

test('CORS: extension origins allowed (or only listed ids), web origins not', async () => {
    await withApp(async ({ call }) => {
        const pre = await call('OPTIONS', '/api/v1/auth/login', { headers: { origin: 'chrome-extension://abc', 'access-control-request-method': 'POST' } });
        assert.equal(pre.status, 204);
        assert.equal(pre.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
        assert.match(pre.headers.get('access-control-allow-headers'), /X-Device-Id/);
        const web = await call('OPTIONS', '/api/v1/auth/login', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
        assert.equal(web.headers.get('access-control-allow-origin'), null);
    });
    await withApp(
        async ({ call }) => {
            const ok = await call('POST', '/api/v1/auth/login', { headers: { origin: 'chrome-extension://good' }, body: {} });
            assert.equal(ok.headers.get('access-control-allow-origin'), 'chrome-extension://good');
            const no = await call('POST', '/api/v1/auth/login', { headers: { origin: 'chrome-extension://other' }, body: {} });
            assert.equal(no.headers.get('access-control-allow-origin'), null);
        },
        { allowedExtensionIds: ['good'] }
    );
});

test('errors, limits, headers, pages', () =>
    withApp(async ({ call, app }) => {
        const badJson = await call('POST', '/api/v1/auth/login', { body: '{nope' });
        assert.equal(badJson.status, 400);
        assert.equal(badJson.json.code, 'validation_error');
        assert.equal((await call('GET', '/api/v1/nothing-here')).status, 401, 'unknown paths behind auth ask for sign-in first');
        assert.equal((await call('GET', '/api/nothing')).json.code, 'not_found');
        const P = await panelLogin(call, 'ali');
        assert.equal((await call('GET', '/api/v1/nothing-here', { token: P.accessToken })).json.code, 'not_found');

        const health = await call('GET', '/healthz');
        assert.equal(health.json.ok, true);
        const root = await call('GET', '/');
        assert.equal(root.status, 302);
        assert.equal(root.headers.get('location'), '/app');
        for (const p of ['/login', '/app']) {
            const r = await call('GET', p);
            assert.equal(r.status, 200, p);
            assert.match(r.headers.get('content-type'), /text\/html/);
            assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
            assert.equal(r.headers.get('x-frame-options'), 'DENY');
        }
        assert.equal((await call('GET', '/nope.html')).status, 404);
        assert.ok(app.base);
    }));

test('per-user API rate limit returns 429 with Retry-After', () =>
    withApp(
        async ({ call }) => {
            const P = await panelLogin(call, 'ali');
            let last;
            for (let i = 0; i < 6; i++) last = await call('GET', '/api/v1/dashboard', { token: P.accessToken });
            assert.equal(last.status, 429);
            assert.equal(last.json.code, 'too_many_requests');
            assert.ok(Number(last.headers.get('retry-after')) >= 1);
        },
        { apiRateLimitRpm: 5 }
    ));
