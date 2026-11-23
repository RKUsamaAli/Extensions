'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createJwt } = require('../src/lib/jwt');
const { hashPassword, verifyPassword, createCipher, cipherFor, sha256 } = require('../src/lib/crypto');
const { compareVersions, parseClientHeader, str, clampInt } = require('../src/lib/util');
const { createLimiter } = require('../src/lib/rateLimiter');
const { isId, newId } = require('../src/lib/ids');
const { loadConfig } = require('../src/config');

test('jwt: sign and verify, expiry, kind separation, tampering', () => {
    const jwt = createJwt({ secret: 'x'.repeat(40), audience: 'http://a' });
    const now = Date.UTC(2026, 0, 1);
    const { token, claims } = jwt.sign({ sub: 'u1' }, { kind: 'access', ttlSec: 60, now });
    assert.equal(claims.sub, 'u1');
    assert.equal(jwt.verify(token, { kind: 'access', now }).sub, 'u1');
    assert.equal(jwt.inspect(token, { kind: 'access', now: now + 61_000 }).expired, true);
    assert.equal(jwt.verify(token, { kind: 'access', now: now + 61_000 }), null);
    assert.equal(jwt.inspect(token, { kind: 'refresh', now }), null, 'another kind uses another key');
    const [h, p, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'admin' })).toString('base64url');
    assert.equal(jwt.inspect(`${h}.${forged}.${sig}`, { kind: 'access', now }), null);
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    assert.equal(jwt.inspect(`${none}.${p}.`, { kind: 'access', now }), null);
    const other = createJwt({ secret: 'x'.repeat(40), audience: 'http://b' });
    assert.equal(other.inspect(token, { kind: 'access', now }), null, 'audience is checked');
    assert.equal(jwt.inspect('garbage', { kind: 'access' }), null);
});

test('crypto: scrypt passwords', () => {
    const h = hashPassword('correct horse');
    assert.ok(h.startsWith('scrypt$'));
    assert.equal(verifyPassword('correct horse', h), true);
    assert.equal(verifyPassword('wrong', h), false);
    assert.equal(verifyPassword('x', null), false);
    assert.equal(verifyPassword('x', 'md5$abc'), false);
    assert.notEqual(hashPassword('same'), hashPassword('same'), 'salted');
});

test('crypto: AES-GCM round trip, nulls, tamper detection', () => {
    const c = createCipher(crypto.randomBytes(32));
    const enc = c.encrypt('X1234567L');
    assert.ok(enc.startsWith('v1:'));
    assert.ok(!enc.includes('X1234567L'));
    assert.equal(c.decrypt(enc), 'X1234567L');
    assert.notEqual(c.encrypt('a'), c.encrypt('a'), 'random iv');
    assert.equal(c.encrypt(null), null);
    assert.equal(c.decrypt(null), null);
    assert.deepEqual(c.decryptJson(c.encryptJson({ a: 1 })), { a: 1 });
    const raw = Buffer.from(enc.slice(3), 'base64url');
    raw[raw.length - 1] ^= 1;
    assert.throws(() => c.decrypt('v1:' + raw.toString('base64url')));
    assert.throws(() => createCipher(Buffer.alloc(5)));
    const other = createCipher(crypto.randomBytes(32));
    assert.throws(() => other.decrypt(enc), 'wrong key fails');
});

test('crypto: cipherFor uses DATA_KEY when given', () => {
    const base = { appSecret: 'y'.repeat(40) };
    const a = cipherFor({ ...base, dataKey: '' });
    const b = cipherFor({ ...base, dataKey: 'ab'.repeat(32) });
    assert.throws(() => b.decrypt(a.encrypt('x')));
    assert.throws(() => cipherFor({ ...base, dataKey: 'short' }));
    assert.equal(sha256('a').length, 64);
});

test('util: versions, client header, strings, ints', () => {
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('1.6', '1.6.0'), 0);
    assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
    assert.equal(compareVersions(null, '0.0.1'), -1);
    assert.deepEqual(parseClientHeader('citamate/1.6.0'), { ext: 'citamate', version: '1.6.0' });
    assert.equal(parseClientHeader('citamate'), null);
    assert.equal(parseClientHeader(undefined), null);
    assert.equal(str('  ab  '), 'ab');
    assert.equal(str(null), '');
    assert.equal(str('abcdef', 3), 'abc');
    assert.equal(clampInt('50', 1, 10, 5), 10);
    assert.equal(clampInt('x', 1, 10, 5), 5);
});

test('rate limiter: window, blocked, reset, sweep', () => {
    let t = 0;
    const l = createLimiter({ limit: 2, windowMs: 1000, now: () => t });
    assert.equal(l.hit('k').allowed, true);
    assert.equal(l.blocked('k'), false);
    assert.equal(l.hit('k').allowed, true);
    assert.equal(l.blocked('k'), true);
    assert.equal(l.hit('k').allowed, false);
    assert.ok(l.retryAfter('k') >= 1);
    t = 1001;
    assert.equal(l.blocked('k'), false);
    assert.equal(l.hit('k').allowed, true);
    l.reset('k');
    assert.equal(l.blocked('k'), false);
    t = 5000;
    l.sweep();
    assert.equal(l.retryAfter('k'), 0);
});

test('ids: uuid v7 ordered and valid', () => {
    const a = newId();
    const b = newId();
    assert.ok(isId(a) && isId(b));
    assert.ok(a < b);
    assert.equal(isId('nope'), false);
});

test('config: production needs a strong secret, lists parse', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }));
    assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_SECRET: 'short' }));
    const c = loadConfig({ NODE_ENV: 'production', APP_SECRET: 'z'.repeat(40), ALLOWED_EXTENSION_IDS: 'abc, def', PUBLIC_URL: 'https://x.y/' });
    assert.deepEqual(c.allowedExtensionIds, ['abc', 'def']);
    assert.equal(c.publicUrl, 'https://x.y');
    assert.equal(c.trustProxy, 1);
    assert.equal(loadConfig({}).port, 4000);
});
