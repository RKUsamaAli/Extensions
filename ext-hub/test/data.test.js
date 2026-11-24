'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServices, addUser, DAY } = require('./helpers');
const { normalizeProfile } = require('../src/services/profiles');
const { normalizeProxy } = require('../src/services/proxies');
const { scopeFor } = require('../src/services/ownership');

const codeOf = (fn) => {
    try {
        fn();
    } catch (e) {
        return e.code;
    }
    return 'no error';
};

const entry = (label, extra = {}) => ({ label, docType: 'nie', docNumber: 'x 123 4567 l', fullName: 'Ali Khan', birthYear: '19-90', province: 'p8', provinceText: 'Barcelona', ...extra });

function setup() {
    const s = makeServices();
    const admin = addUser(s, 'boss', { role: 'admin' });
    const ali = addUser(s, 'ali');
    const sara = addUser(s, 'sara');
    return { s, admin, ali, sara };
}

test('profile normalization matches the extension', () => {
    const { value, fields } = normalizeProfile(entry('A'));
    assert.deepEqual(fields, {});
    assert.equal(value.docType, 'NIE');
    assert.equal(value.docNumber, 'X1234567L');
    assert.equal(value.fullName, 'ALI KHAN');
    assert.equal(value.birthYear, '1990');
    assert.equal(normalizeProfile({ ...entry('A'), docType: 'weird' }).value.docType, 'NIE');
    assert.deepEqual(Object.keys(normalizeProfile({}).fields).sort(), ['docNumber', 'fullName', 'label']);
});

test('profiles: personal data is encrypted at rest', () => {
    const { s, ali } = setup();
    const item = s.profiles.create(ali, entry('Ali – TIE', { phone: '600111222', email: 'a@b.c' }));
    assert.equal(item.docNumber, 'X1234567L');
    assert.equal(item.ownerName, 'ali');
    const raw = s.db.prepare('SELECT * FROM profiles WHERE id = ?').get(item.id);
    const dump = JSON.stringify(raw);
    for (const secret of ['X1234567L', 'ALI KHAN', '600111222', 'a@b.c']) assert.ok(!dump.includes(secret), `${secret} must not be stored in clear`);
    assert.equal(raw.label, 'Ali – TIE');
});

test('profiles: each user sees only their own; admin sees own by default, all with owner=all', () => {
    const { s, admin, ali, sara } = setup();
    s.profiles.create(ali, entry('a1'));
    s.profiles.create(ali, entry('a2'));
    s.profiles.create(sara, entry('s1'));
    s.profiles.create(admin, entry('b1'));
    assert.deepEqual(s.profiles.list(scopeFor(ali)).map((p) => p.label), ['a1', 'a2']);
    assert.deepEqual(s.profiles.list(scopeFor(sara)).map((p) => p.label), ['s1']);
    assert.deepEqual(s.profiles.list(scopeFor(admin)).map((p) => p.label), ['b1']);
    assert.equal(s.profiles.list(scopeFor(admin, 'all')).length, 4);
    assert.deepEqual(s.profiles.list(scopeFor(admin, ali.id)).map((p) => p.label), ['a1', 'a2']);
    assert.equal(codeOf(() => scopeFor(ali, sara.id)), 'forbidden');
    assert.equal(codeOf(() => scopeFor(ali, 'all')), 'forbidden');
    assert.equal(codeOf(() => scopeFor(admin, 'not-an-id')), 'validation_error');
});

test('profiles: update/delete only own rows (others get 404); admin may change anyone', () => {
    const { s, admin, ali, sara } = setup();
    const p = s.profiles.create(ali, entry('a1'));
    assert.equal(codeOf(() => s.profiles.update(sara, p.id, entry('hacked'))), 'not_found');
    assert.equal(codeOf(() => s.profiles.remove(sara, p.id)), 'not_found');
    assert.equal(s.profiles.update(ali, p.id, entry('a1b')).label, 'a1b');
    assert.equal(s.profiles.update(admin, p.id, entry('by admin')).label, 'by admin');
    assert.equal(codeOf(() => s.profiles.update(ali, p.id, { label: '' })), 'validation_error');
    assert.equal(codeOf(() => s.profiles.update(ali, 'missing', entry('x'))), 'not_found');
    s.profiles.remove(admin, p.id);
    assert.equal(s.profiles.list(scopeFor(ali)).length, 0);
});

test('profiles: admin can create for another user; users cannot', () => {
    const { s, admin, ali, sara } = setup();
    const p = s.profiles.create(admin, { ...entry('for ali'), ownerId: ali.id });
    assert.equal(p.ownerId, ali.id);
    assert.equal(codeOf(() => s.profiles.create(ali, { ...entry('x'), ownerId: sara.id })), 'forbidden');
    assert.equal(codeOf(() => s.profiles.create(admin, { ...entry('x'), ownerId: '01a207b7-0000-7000-8000-000000000000' })), 'validation_error');
});

test('profiles: bulk create is all-or-nothing with indexed errors', () => {
    const { s, ali } = setup();
    let err;
    try {
        s.profiles.bulkCreate(ali, [entry('ok'), { label: 'bad' }]);
    } catch (e) {
        err = e;
    }
    assert.equal(err.code, 'validation_error');
    assert.ok(err.extra.fields['items.1.docNumber']);
    assert.equal(s.profiles.list(scopeFor(ali)).length, 0);
    assert.equal(s.profiles.bulkCreate(ali, [entry('a'), entry('b')]).length, 2);
    assert.equal(codeOf(() => s.profiles.bulkCreate(ali, 'x')), 'validation_error');
    assert.equal(codeOf(() => s.profiles.bulkCreate(ali, new Array(1001).fill(entry('a')))), 'validation_error');
});

test('proxy normalization', () => {
    assert.deepEqual(normalizeProxy({ host: 'h.example', port: 80 }).fields, {});
    const f = normalizeProxy({ scheme: 'ftp', host: 'bad host!', port: 70000, sessionStart: 5, sessionEnd: 2 }).fields;
    assert.deepEqual(Object.keys(f).sort(), ['host', 'port', 'scheme', 'sessionEnd']);
    assert.equal(normalizeProxy({ scheme: 'SOCKS5', host: 'h', port: '1080' }).value.scheme, 'socks5');
    assert.equal(normalizeProxy({ host: 'h', port: 1 }).value.password, undefined);
});

test('proxies: password encrypted, kept when omitted on update, owner rules', () => {
    const { s, admin, ali, sara } = setup();
    const p = s.proxies.create(ali, { name: 'DE', scheme: 'socks5', host: '1.2.3.4', port: 1080, usernameTemplate: 'u-{session}', password: 'pw-secret' });
    assert.equal(p.password, 'pw-secret');
    assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM proxies').all()).includes('pw-secret'));
    const u = s.proxies.update(ali, p.id, { name: 'DE2', scheme: 'socks5', host: '1.2.3.4', port: 1080 });
    assert.equal(u.password, 'pw-secret');
    assert.equal(u.name, 'DE2');
    assert.equal(s.proxies.update(ali, p.id, { host: '1.2.3.4', port: 1080, password: '' }).password, '');
    assert.equal(codeOf(() => s.proxies.update(sara, p.id, { host: 'x', port: 1 })), 'not_found');
    assert.equal(s.proxies.list(scopeFor(sara)).length, 0);
    assert.equal(s.proxies.list(scopeFor(admin, 'all')).length, 1);
    assert.equal(s.proxies.bulkCreate(ali, [{ host: 'a', port: 1 }, { host: 'b', port: 2 }]).length, 2);
    s.proxies.remove(admin, p.id);
    assert.equal(s.proxies.count(scopeFor(ali)), 2);
});

test('proxy checks: own proxies only, last 50 per proxy, de-duplicated by client id, cascade on delete', () => {
    const { s, ali, sara } = setup();
    const p = s.proxies.create(ali, { host: 'h', port: 1 });
    const theirs = s.proxies.create(sara, { host: 'h', port: 2 });
    const base = s.clock.now();
    const items = Array.from({ length: 60 }, (_, i) => ({ proxyId: p.id, t: base + i, ok: i % 2 === 0, ms: 100 + i, source: 'test' }));
    assert.equal(s.proxies.addChecks(ali, items), 60);
    assert.equal(s.proxies.addChecks(ali, [{ proxyId: theirs.id, t: base, ok: true }, { proxyId: 'junk', ok: true }, null]), 0);
    const st = s.proxies.stats(scopeFor(ali));
    assert.equal(st[p.id].results.length, 50);
    assert.equal(st[p.id].results[0].t, base + 10, 'oldest kept first');
    assert.equal(st[p.id].results[49].ms, 159);
    assert.equal(st[theirs.id], undefined);
    assert.equal(s.proxies.addChecks(ali, [{ id: 'c1', proxyId: p.id, ok: true }, { id: 'c1', proxyId: p.id, ok: true }]), 1);
    s.proxies.remove(ali, p.id);
    assert.equal(s.db.prepare('SELECT COUNT(*) FROM proxy_checks').pluck().get(), 0);
});

test('relayswitch logs: levels, owner, limit, clear own only', () => {
    const { s, admin, ali, sara } = setup();
    s.proxies.addLogs(ali, [{ t: 1, level: 'warn', event: 'Auth failed', profile: 'DE', profileId: 'x' }, { t: 2, level: 'bogus', event: 'b' }, { event: '' }]);
    s.proxies.addLogs(sara, [{ t: 3, event: 'c' }]);
    const mine = s.proxies.listLogs(scopeFor(ali));
    assert.deepEqual(mine.map((l) => l.event), ['Auth failed', 'b']);
    assert.equal(mine[1].level, 'info');
    assert.equal(s.proxies.listLogs(scopeFor(admin, 'all')).length, 3);
    assert.deepEqual(s.proxies.listLogs(scopeFor(ali), { limit: 1 }).map((l) => l.event), ['b'], 'limit keeps the newest');
    assert.equal(s.proxies.clearLogs(ali), 2);
    assert.equal(s.proxies.listLogs(scopeFor(admin, 'all')).length, 1);
    assert.equal(s.proxies.addLogs(ali, [{ id: 'l1', event: 'x' }, { id: 'l1', event: 'x' }]), 1);
});

test('citamate logs and sightings: de-duplicated, filtered, ordered, cleared', () => {
    const { s, admin, ali } = setup();
    const logs = [
        { id: 'a', t: 10, page: 'Form', kind: 'booking', entry: 'E1', entryId: 'e1', action: 'Fill & Next', status: 'ok', detail: 'd' },
        { id: 'b', t: 20, page: 'Booked', kind: 'booking', entry: 'E2', entryId: 'e2', action: 'Result', status: 'done' },
        { id: 'a', t: 10, page: 'dup' }
    ];
    assert.equal(s.activity.addLogs(ali, logs), 2);
    assert.equal(s.activity.addLogs(ali, logs), 0, 'resending a batch stores nothing new');
    assert.deepEqual(s.activity.listLogs(scopeFor(ali)).map((l) => l.id), ['a', 'b']);
    assert.deepEqual(s.activity.listLogs(scopeFor(ali), { entryId: 'e2' }).map((l) => l.id), ['b']);
    assert.equal(s.activity.listLogs(scopeFor(admin)).length, 0);
    const counts = s.activity.recentCounts(scopeFor(ali), 100000);
    assert.equal(counts.bookings, 1);

    assert.equal(s.activity.addSightings(ali, [{ id: 's1', t: 5, province: 'Barcelona', offices: [{ value: '16', text: 'CNP' }, 'junk'] }]), 1);
    const sg = s.activity.listSightings(scopeFor(ali));
    assert.deepEqual(sg[0].offices, [{ value: '16', text: 'CNP' }]);
    assert.equal(s.activity.clearSightings(ali), 1);
    assert.equal(s.activity.clearLogs(ali), 2);
    assert.equal(codeOf(() => s.activity.addLogs(ali, new Array(501).fill({}))), 'validation_error');
});

test('maintenance deletes old logs, checks, sightings and dead sessions', () => {
    const { s, ali } = setup();
    const p = s.proxies.create(ali, { host: 'h', port: 1 });
    const old = s.clock.now() - 100 * DAY;
    s.activity.addLogs(ali, [{ id: 'old', t: old }, { id: 'new', t: s.clock.now() }]);
    s.activity.addSightings(ali, [{ id: 'old', t: old }]);
    s.proxies.addLogs(ali, [{ t: old, event: 'x' }]);
    s.proxies.addChecks(ali, [{ proxyId: p.id, t: old, ok: true }]);
    const out = s.maintenance();
    assert.deepEqual(out, { cm_logs: 1, cm_sightings: 1, rs_logs: 1, proxy_checks: 1, cm_alerts: 0, check_claims: 0, auth_sessions: 0 });
    assert.deepEqual(s.activity.listLogs(scopeFor(ali)).map((l) => l.id), ['new']);
});

test('users: validation, conflicts, self-protection, entitlements', () => {
    const { s, admin, ali } = setup();
    assert.equal(codeOf(() => s.users.create({ username: 'a', password: 'password-123' }, admin)), 'validation_error');
    assert.equal(codeOf(() => s.users.create({ username: 'ALI', password: 'password-123' }, admin)), 'conflict');
    assert.equal(codeOf(() => s.users.create({ username: 'zed', password: 'password-123', email: 'nope' }, admin)), 'validation_error');
    assert.equal(codeOf(() => s.users.update(admin.id, { enabled: false }, admin)), 'validation_error');
    assert.equal(codeOf(() => s.users.update(admin.id, { role: 'user' }, admin)), 'validation_error');
    assert.equal(codeOf(() => s.users.remove(admin.id, admin)), 'forbidden');
    assert.equal(codeOf(() => s.users.update(ali.id, { username: 'boss' }, admin)), 'conflict');
    const ents = s.users.setEntitlements(ali.id, [{ ext: 'citamate', expiresAt: s.clock.now() + DAY, maxDevices: 2 }, { ext: 'relayswitch', expiresAt: '' }], admin);
    assert.equal(ents.length, 2);
    assert.equal(ents.find((e) => e.ext === 'relayswitch').expiresAt, null);
    assert.equal(s.users.setEntitlements(ali.id, [{ ext: 'citamate' }], admin).length, 1, 'set replaces');
    assert.equal(codeOf(() => s.users.setEntitlements(ali.id, [{ ext: 'x' }], admin)), 'validation_error');
    assert.equal(codeOf(() => s.users.setEntitlements(ali.id, [{ ext: 'citamate' }, { ext: 'citamate' }], admin)), 'validation_error');
    assert.equal(codeOf(() => s.users.setEntitlements(ali.id, [{ ext: 'citamate', maxDevices: 0 }], admin)), 'validation_error');
    assert.equal(s.users.entitlementsOf(admin).length, 2, 'admins are entitled to everything');
    assert.equal(s.expiringSoon(7).length, 0);
    s.users.setEntitlements(ali.id, [{ ext: 'citamate', expiresAt: s.clock.now() + 3 * DAY }], admin);
    assert.equal(s.expiringSoon(7)[0].username, 'ali');
});

test('deleting a user deletes their data', () => {
    const { s, admin, ali } = setup();
    s.profiles.create(ali, entry('a'));
    s.proxies.create(ali, { host: 'h', port: 1 });
    s.users.remove(ali.id, admin);
    assert.equal(s.profiles.list(scopeFor(admin, 'all')).length, 0);
    assert.equal(s.proxies.list(scopeFor(admin, 'all')).length, 0);
});

test('settings: defaults, partial updates, validation', () => {
    const { s } = setup();
    const d = s.settings.getAll();
    assert.equal(d.allowSignup, false);
    assert.equal(d.enabled.citamate, true);
    const v = s.settings.update({ minVersion: { relayswitch: '0.2.0' }, logRetentionDays: 30 }, null);
    assert.equal(v.minVersion.relayswitch, '0.2.0');
    assert.equal(v.minVersion.citamate, '0.0.0');
    assert.equal(v.logRetentionDays, 30);
    assert.equal(codeOf(() => s.settings.update({ minVersion: { citamate: 'abc' } }, null)), 'validation_error');
    assert.equal(codeOf(() => s.settings.update({ enabled: { nope: true } }, null)), 'validation_error');
    assert.equal(codeOf(() => s.settings.update({ logRetentionDays: 'x' }, null)), 'validation_error');
});

test('catalog and site config: seed once, versioned updates, validation', () => {
    const { s, admin } = setup();
    assert.deepEqual(s.configStore.seed(s.config.seedsDir), ['citamate-catalog', 'citamate-site-config']);
    assert.deepEqual(s.configStore.seed(s.config.seedsDir), [], 'seeding twice changes nothing');
    assert.equal(s.configStore.catalogVersion('citamate'), 1);
    const cat = s.configStore.getCatalog('citamate');
    assert.equal(cat.data.provinces[0].text, 'Barcelona');
    assert.equal(s.configStore.putCatalog('citamate', cat.data, admin), 2);
    assert.equal(codeOf(() => s.configStore.putCatalog('citamate', { provinces: [] }, admin)), 'validation_error');
    assert.equal(codeOf(() => s.configStore.putCatalog('relayswitch', {}, admin)), 'not_found');
    assert.deepEqual(s.configStore.getSiteConfig('citamate').config.phone, ['#txtTelefonoCitado']);
    assert.deepEqual(s.configStore.getSiteConfig('relayswitch').config, {});
    s.configStore.putSiteConfig('relayswitch', { a: 1 }, admin);
    assert.equal(s.configStore.getSiteConfig('relayswitch').config.a, 1);
    assert.equal(codeOf(() => s.configStore.putSiteConfig('relayswitch', [], admin)), 'validation_error');
});

test('dashboard counts are scoped', () => {
    const { s, admin, ali } = setup();
    s.profiles.create(ali, entry('a'));
    s.proxies.create(admin, { host: 'h', port: 1 });
    assert.equal(s.dashboard(ali, scopeFor(ali)).counts.profiles, 1);
    assert.equal(s.dashboard(ali, scopeFor(ali)).counts.proxies, 0);
    const all = s.dashboard(admin, scopeFor(admin, 'all'));
    assert.equal(all.counts.profiles, 1);
    assert.equal(all.counts.proxies, 1);
    assert.equal(all.counts.users, 3);
    assert.equal(s.dashboard(admin, scopeFor(admin, ali.id)).entitlements.length, 0, 'entitlements of the selected owner');
});

test('proxies page: server-side score, filter, sort, paging and a summary of all proxies', () => {
    const { s, ali, sara } = setup();
    const mk = (name) => s.proxies.create(ali, { name, host: 'h', port: 80 });
    const fast = mk('fast'), slow = mk('slow'), broken = mk('broken'), never = mk('never');
    s.proxies.create(sara, { name: 'not mine', host: 'h', port: 1 });
    const t = s.clock.now();
    const checks = [];
    for (let i = 0; i < 20; i++) {
        checks.push({ proxyId: fast.id, t: t + i, ok: true, ms: 200, ip: '1.1.1.1' });
        checks.push({ proxyId: slow.id, t: t + i, ok: i % 4 !== 0, ms: 2000 });
        checks.push({ proxyId: broken.id, t: t + i, ok: i < 10, ms: 300, error: i < 10 ? null : 'timeout' });
    }
    s.proxies.addChecks(ali, checks);
    const scope = scopeFor(ali);

    const all = s.proxies.page(scope, { limit: 2 });
    assert.deepEqual(all.items.map((p) => p.name), ['fast', 'slow'], 'best score first');
    assert.equal(all.items[0].score.value, 100);
    assert.equal(all.items[0].score.lastIp, '1.1.1.1');
    assert.equal(all.items[0].recent.length, 20);
    assert.equal(all.total, 4);
    assert.equal(all.nextOffset, 2);
    assert.deepEqual(
        { ...all.summary, lastChecked: undefined },
        { total: 4, disabled: 0, checked: 3, neverChecked: 1, good: 1, fair: 2, poor: 0, none: 1, failing: 1, successRatio: (20 + 15 + 10) / 60, medianMs: 300, lastChecked: undefined }
    );
    const rest = s.proxies.page(scope, { limit: 2, offset: 2 });
    assert.deepEqual(rest.items.map((p) => p.name), ['broken', 'never'], 'never-checked last');
    assert.equal(rest.nextOffset, null);

    const failing = s.proxies.page(scope, { limit: 50, filter: 'failing' });
    assert.deepEqual(failing.items.map((p) => p.name), ['broken']);
    assert.equal(failing.summary.total, 4, 'summary always covers every proxy');
    assert.deepEqual(s.proxies.page(scope, { limit: 50, filter: 'none' }).items.map((p) => p.name), ['never']);
    assert.deepEqual(s.proxies.page(scope, { limit: 50, q: '1.1.1' }).items.map((p) => p.name), ['fast'], 'search includes exit IP');
    assert.deepEqual(s.proxies.page(scope, { limit: 50, sort: 'name' }).items.map((p) => p.name), ['broken', 'fast', 'never', 'slow']);
    assert.deepEqual(s.proxies.page(scope, { limit: 50, sort: 'speed' }).items.map((p) => p.name), ['fast', 'broken', 'slow', 'never']);
    assert.equal(s.proxies.page(scopeFor(sara), { limit: 50 }).total, 1);
    assert.equal(s.proxies.stats(scope, { proxyId: fast.id })[slow.id], undefined, 'checks?proxyId= returns one proxy');
});

test('score formula matches RelaySwitch', () => {
    const { scoreOf } = require('../src/lib/score');
    assert.equal(scoreOf([]).value, null);
    assert.equal(scoreOf([{ t: 1, ok: true, ms: 250, ip: 'a' }, { t: 2, ok: false }]).value, 50);
    assert.equal(scoreOf([{ t: 1, ok: true, ms: 3000 }]).value, 70);
    assert.equal(scoreOf(Array.from({ length: 30 }, (_, i) => ({ t: i, ok: i >= 10, ms: 300 }))).value, 100, 'only the last 20 count');
});

test('citamate logs keep the page snapshot of a failed step (opt-in on read, size-capped)', () => {
    const { s, ali } = setup();
    const ctx = { page: 'Personal data', url: '/icpplus/acEntrada', missing: ['Name'], tried: [{ field: 'Name', selectors: ['#txtDesCitado'] }], fields: [{ tag: 'input', id: 'txtNombre' }] };
    s.activity.addLogs(ali, [
        { id: 'a', t: 1, status: 'fail', detail: 'Not found: Name', context: ctx },
        { id: 'b', t: 2, status: 'ok', detail: 'fine', context: 'not an object' },
        { id: 'c', t: 3, status: 'fail', context: { page: 'x', fields: Array.from({ length: 400 }, (_, i) => ({ tag: 'select', id: 'f' + i, options: Array.from({ length: 40 }, (_, j) => 'option text ' + j) })) } }
    ]);
    const scope = scopeFor(ali);
    assert.equal(s.activity.listLogs(scope)[0].context, undefined, 'left out unless asked for');
    const [a, b, c] = s.activity.listLogs(scope, { context: true });
    assert.deepEqual(a.context, ctx);
    assert.equal(b.context, undefined);
    assert.equal(c.context.truncated, true, 'big snapshots are shortened, not dropped');
    assert.equal(c.context.page, 'x');
    assert.ok(JSON.stringify(c.context).length <= 32 * 1024);
});

test('admin creates entries and proxies for a user, sees what they created, and can reassign them', () => {
    const s = makeServices();
    const boss = addUser(s, 'boss', { role: 'admin' });
    const ali = addUser(s, 'ali');
    const sara = addUser(s, 'sara');
    const e = s.profiles.create(boss, { ...entry('For Ali'), ownerId: ali.id });
    assert.equal(e.ownerName, 'ali');
    assert.equal(e.createdByName, 'boss', 'the creator is kept');
    assert.deepEqual(s.profiles.list(scopeFor(ali)).map((x) => x.label), ['For Ali'], 'the user sees it when they sign in');
    s.profiles.create(ali, entry('Ali own'));
    assert.deepEqual(s.profiles.list(scopeFor(boss, 'created')).map((x) => x.label), ['For Ali'], '"created" = what the admin added, for anyone');

    const p = s.proxies.create(boss, { host: 'h', port: 80, ownerId: ali.id });
    s.proxies.addChecks(boss, [{ proxyId: p.id, ok: true, ms: 100 }]);
    assert.equal(s.proxies.stats(scopeFor(ali))[p.id].results.length, 1);
    const moved = s.proxies.update(boss, p.id, { host: 'h', port: 80, ownerId: sara.id });
    assert.equal(moved.ownerName, 'sara');
    assert.equal(s.proxies.list(scopeFor(ali)).length, 0);
    assert.equal(s.proxies.stats(scopeFor(sara))[p.id].results.length, 1, 'check history moves with the proxy');
    assert.equal(s.proxies.page(scopeFor(boss, 'created'), { limit: 10 }).total, 1);

    assert.equal(s.profiles.update(boss, e.id, { ...entry('For Sara'), ownerId: sara.id }).ownerName, 'sara');
    assert.throws(() => s.profiles.update(sara, e.id, { ...entry('x'), ownerId: ali.id }), /admin/);
    assert.throws(() => s.profiles.update(boss, e.id, { ...entry('x'), ownerId: 'nobody' }), (err) => err.code === 'validation_error');
});

test('proxies: switch off/on and delete in bulk; the extension list hides switched-off ones', () => {
    const { s, ali, sara } = setup();
    const a = s.proxies.create(ali, { name: 'a', host: 'h', port: 1 });
    const b = s.proxies.create(ali, { name: 'b', host: 'h', port: 2 });
    const theirs = s.proxies.create(sara, { name: 'x', host: 'h', port: 3 });
    assert.equal(a.enabled, true);
    assert.deepEqual(s.proxies.bulkAction(ali, [a.id, theirs.id, 'junk'], 'disable'), { changed: 1 }, 'only own rows change');
    assert.deepEqual(s.proxies.list(scopeFor(ali), { enabledOnly: true }).map((p) => p.name), ['b']);
    assert.equal(s.proxies.list(scopeFor(ali)).length, 2, 'the panel still lists it');
    const pg = s.proxies.page(scopeFor(ali), { limit: 10, filter: 'disabled' });
    assert.deepEqual(pg.items.map((p) => p.name), ['a']);
    assert.equal(pg.summary.disabled, 1);
    s.proxies.bulkAction(ali, [a.id], 'enable');
    assert.equal(s.proxies.list(scopeFor(ali), { enabledOnly: true }).length, 2);
    assert.deepEqual(s.proxies.bulkAction(ali, [a.id, b.id], 'delete'), { changed: 2 });
    assert.equal(s.proxies.list(scopeFor(sara)).length, 1);
    assert.throws(() => s.proxies.bulkAction(ali, [], 'explode'), (e) => e.code === 'validation_error');
});

test('proxies: server check renders the username, runs the checker and stores "server" checks', async () => {
    const seen = [];
    const s = makeServices({ checkProxy: async (p) => { seen.push(p); return p.host === 'good' ? { ok: true, ms: 120, ip: '198.51.100.9' } : { ok: false, error: 'No answer in 10 s' }; } });
    const ali = addUser(s, 'ali');
    const good = s.proxies.create(ali, { name: 'g', host: 'good', port: 80, usernameTemplate: 'u-{country}-s-{session}', country: 'es', password: 'pw', sessionStart: 5, sessionEnd: 5 });
    const bad = s.proxies.create(ali, { name: 'b', host: 'bad', port: 80 });
    const res = await s.proxies.serverCheck(ali, [good.id, bad.id]);
    assert.deepEqual(res.map((r) => [r.name, r.ok, r.ip || r.error]), [['g', true, '198.51.100.9'], ['b', false, 'No answer in 10 s']]);
    assert.deepEqual(seen[0], { scheme: 'http', host: 'good', port: 80, username: 'u-es-s-5', password: 'pw' });
    const st = s.proxies.stats(scopeFor(ali));
    assert.equal(st[good.id].results[0].source, 'server');
    assert.equal(st[good.id].results[0].ms, 120);
    assert.equal(s.proxies.page(scopeFor(ali), { limit: 5 }).items[0].name, 'g', 'the working one scores first');
    s.proxies.addChecks(ali, [{ proxyId: good.id, ok: true, source: 'server' }]);
    assert.equal(s.proxies.stats(scopeFor(ali))[good.id].results[1].source, 'test', 'clients cannot claim "server"');
});

test('entries: appointment status, bulk change, CitaMate sees active ones, results move them along', () => {
    const { s, ali, sara } = setup();
    const a = s.profiles.create(ali, entry('A'));
    const b = s.profiles.create(ali, entry('B', { status: 'on_hold' }));
    const c = s.profiles.create(ali, entry('C'));
    const theirs = s.profiles.create(sara, entry('X'));
    assert.equal(a.status, 'pending');
    assert.equal(b.status, 'on_hold');
    assert.ok(a.statusAt);
    assert.deepEqual(s.profiles.list(scopeFor(ali), { activeOnly: true }).map((e) => e.label), ['A', 'C'], 'on hold is not offered in CitaMate');
    assert.deepEqual(s.profiles.statusCounts(scopeFor(ali)), { pending: 2, in_progress: 0, on_hold: 1, booked: 0, done: 0, cancelled: 0 });
    assert.deepEqual(s.profiles.bulkAction(ali, [c.id, theirs.id], 'status', 'cancelled'), { changed: 1 }, 'own rows only');
    assert.throws(() => s.profiles.bulkAction(ali, [a.id], 'status', 'lost'), (e) => e.code === 'validation_error');
    assert.equal(s.profiles.update(ali, b.id, { ...entry('B'), status: 'pending' }).status, 'pending');

    // CitaMate results: first booking step -> in progress; confirmation -> booked. Office checks don't count.
    s.activity.addLogs(ali, [{ id: 'k1', entryId: a.id, status: 'ok', kind: 'check' }]);
    assert.equal(s.profiles.list(scopeFor(ali)).find((e) => e.label === 'A').status, 'pending');
    s.activity.addLogs(ali, [{ id: 'l1', entryId: a.id, status: 'ok' }]);
    assert.equal(s.profiles.list(scopeFor(ali)).find((e) => e.label === 'A').status, 'in_progress');
    s.activity.addLogs(ali, [{ id: 'l2', entryId: a.id, status: 'done' }]);
    assert.equal(s.profiles.list(scopeFor(ali)).find((e) => e.label === 'A').status, 'booked');
    s.activity.addLogs(ali, [{ id: 'l3', entryId: c.id, status: 'done' }]);
    assert.equal(s.profiles.list(scopeFor(ali)).find((e) => e.label === 'C').status, 'cancelled', 'never overrides a status the user set');
    s.activity.addLogs(sara, [{ id: 'l4', entryId: a.id, status: 'ok' }]);
    assert.deepEqual(s.profiles.bulkAction(ali, [a.id, b.id], 'delete'), { changed: 2 });
});

test('office availability: open since, one alert per clock minute, watches, live push, shared, entry marker', () => {
    const { s, admin, ali, sara } = setup();
    const MIN = 60000;
    const base = Math.floor(s.clock.now() / MIN) * MIN + 5000; // 5 s into a clock minute
    s.clock.set(base);
    const sight = (actor, id, dt, offices, page = 'Office') => {
        s.clock.set(base + dt);
        s.activity.addSightings(actor, [{ id, t: base + dt, province: 'Albacete', tramite: 'Toma de huellas', page, offices }]);
    };
    const A = { value: '1', text: 'CNP Albacete, Avda. España' };
    const H = { value: '2', text: 'CNP Hellín, Calle Mayor' };
    s.availability.setWatch(sara, 'Albacete', 'Toma de huellas', true);
    const pushed = [];
    const off = s.availability.subscribe(sara.id, (a) => pushed.push(a));

    sight(ali, 's1', 0, []); // closed
    sight(ali, 's2', 10000, [A]); // opens -> alert
    assert.equal(pushed.length, 1, 'watchers get it live');
    assert.equal(pushed[0].openSince, base + 10000);
    assert.deepEqual(pushed[0].newOffices.map((o) => o.value), ['1']);
    sight(sara, 's3', 30000, [A, H]); // same clock minute -> no second alert, Hellín is new
    assert.equal(pushed.length, 1, 'at most one alert per clock minute');
    sight(ali, 's4', MIN, [A, H]); // next minute, still open -> alert again
    assert.equal(pushed.length, 2);
    assert.equal(pushed[1].openSince, base + 10000, 'open since the first open sighting of the streak');
    assert.deepEqual(pushed[1].offices.map((o) => [o.value, o.since - base]), [['1', 10000], ['2', 30000]]);
    sight(ali, 's5', MIN + 1000, [A], 'Trámite'); // not the office page: no alert, not availability
    assert.equal(pushed.length, 2);
    off();

    // Shared state + entry marker (any office / a specific office)
    const latest = s.availability.latestByPair();
    const st = latest.get(s.availability.pairKey('albacete', 'toma de huellas'));
    assert.equal(st.status, 'open');
    assert.equal(st.openSince, base + 10000);
    const anyEntry = { provinceText: 'Albacete', tramiteText: 'Toma de huellas', office: '' };
    assert.deepEqual(s.availability.entryOpenState(anyEntry, latest).offices, ['CNP Albacete', 'CNP Hellín']);
    assert.equal(s.availability.entryOpenState({ ...anyEntry, office: '2', officeText: 'CNP Hellín, Calle Mayor' }, latest).since, base + 30000);
    assert.equal(s.availability.entryOpenState({ ...anyEntry, office: '9', officeText: 'Elsewhere' }, latest), null);

    // Alerts list: only watched pairs; unread until seen
    const al = s.availability.alerts(sara);
    assert.equal(al.items.length, 2);
    assert.equal(al.unread, 2);
    s.availability.markSeen(sara);
    assert.equal(s.availability.alerts(sara).unread, 0);
    assert.equal(s.availability.alerts(ali).items.length, 0, 'ali watches nothing');

    // Closed again -> status closed, no open since
    sight(ali, 's6', 2 * MIN, []);
    assert.equal(s.availability.latestByPair().get(s.availability.pairKey('Albacete', 'Toma de huellas')).status, 'closed');

    // Queue: one row per pair from everyone's active entries; claims; a check needs your own entry
    s.profiles.create(ali, entry('E1', { province: '/icpplus/citar?p=2&locale=es', provinceText: 'Albacete', tramiteText: 'Toma de huellas', office: '1', officeText: 'CNP Albacete' }));
    s.profiles.create(sara, entry('E2', { provinceText: 'Albacete', tramiteText: 'Toma de huellas' }));
    s.profiles.create(sara, entry('E3', { provinceText: 'Madrid', tramiteText: 'Recogida', status: 'booked' }));
    const q = s.availability.queue(admin, s.profiles.list({ ownerId: null }, { activeOnly: true }));
    assert.equal(q.length, 1, 'booked entries are not checked; same pair counted once');
    assert.equal(q[0].entries, 2);
    assert.deepEqual(q[0].wanted.sort(), ['Any office', 'CNP Albacete']);
    assert.equal(q[0].checkEntryId, null, 'admin has no entry for it');
    assert.ok(s.availability.queue(ali, s.profiles.list({ ownerId: null }, { activeOnly: true }))[0].checkEntryId);
    assert.equal(s.availability.queue(ali, s.profiles.list({ ownerId: null }, { activeOnly: true }))[0].checkPath, '/icpplus/citar?p=2&locale=es', 'direct link to the province');
    s.availability.claim(ali, 'Albacete', 'Toma de huellas');
    assert.throws(() => s.availability.claim(sara, 'Albacete', 'Toma de huellas'), (e) => e.code === 'conflict');
    assert.equal(s.availability.queue(sara, s.profiles.list({ ownerId: null }, { activeOnly: true }))[0].claim.by, 'ali');
    sight(ali, 's7', 3 * MIN, []); // the check result releases the claim
    assert.equal(s.availability.queue(sara, s.profiles.list({ ownerId: null }, { activeOnly: true }))[0].claim, null);

    const ov = s.availability.overview({ days: 7 });
    assert.equal(ov.pairs.length, 1);
    assert.equal(ov.pairs[0].history.length, 6, 'office-page sightings only');
});

test('office availability: still open (confirmations), closed since and the last open window', () => {
    const { s, ali } = setup();
    const MIN = 60000;
    const base = Math.floor(s.clock.now() / MIN) * MIN;
    const sight = (id, dt, offices) => {
        s.clock.set(base + dt);
        s.activity.addSightings(ali, [{ id, t: base + dt, province: 'Barcelona', tramite: 'TIE', page: 'Office', offices }]);
    };
    const key = s.availability.pairKey('Barcelona', 'TIE');
    const O = [{ value: '1', text: 'CNP Igualada' }];
    sight('a', 0, O);
    sight('b', 2 * MIN, O);
    sight('c', 4 * MIN, O);
    let st = s.availability.latestByPair().get(key);
    assert.equal(st.openSince, base);
    assert.equal(st.stillOpenAt, base + 4 * MIN, 'still open as of the latest check');
    assert.equal(st.confirmations, 3);
    assert.equal(st.offices[0].stillListedAt, base + 4 * MIN);
    sight('d', 6 * MIN, []);
    sight('e', 8 * MIN, []);
    st = s.availability.latestByPair().get(key);
    assert.equal(st.status, 'closed');
    assert.equal(st.closedSince, base + 6 * MIN, 'closed since the first check that found none');
    assert.deepEqual(st.lastOpen, { from: base, to: base + 4 * MIN });
    const alerts = s.availability.alerts(ali);
    assert.equal(alerts.items.length, 0, 'ali watches nothing');
});
