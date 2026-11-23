'use strict';
/**
 * Security primitives on Node's crypto module (no extra deps).
 *  - hashPassword / verifyPassword : scrypt
 *  - randomToken / sha256          : refresh tokens (only the hash is stored)
 *  - deriveKey                     : per-purpose keys from APP_SECRET
 *  - createCipher(key)             : AES-256-GCM for personal data and proxy passwords at rest
 */
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
    if (!stored || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Same cost as a real check, so unknown usernames take as long as wrong passwords. */
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const keyCache = new Map();
function deriveKey(secret, purpose) {
    const k = purpose + '|' + secret;
    if (!keyCache.has(k)) keyCache.set(k, crypto.createHmac('sha256', secret).update('ext-hub-key:' + purpose).digest());
    return keyCache.get(k);
}

/**
 * AES-256-GCM. Stored format: "v1:" + base64url(iv[12] | tag[16] | ciphertext).
 * encrypt(null|undefined) -> null so optional columns stay NULL.
 */
function createCipher(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('cipher key must be 32 bytes');
    return {
        encrypt(plain) {
            if (plain === null || plain === undefined) return null;
            const iv = crypto.randomBytes(12);
            const c = crypto.createCipheriv('aes-256-gcm', key, iv);
            const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
            return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
        },
        decrypt(stored) {
            if (stored === null || stored === undefined) return null;
            const s = String(stored);
            if (!s.startsWith('v1:')) throw new Error('unknown cipher format');
            const raw = Buffer.from(s.slice(3), 'base64url');
            const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
            d.setAuthTag(raw.subarray(12, 28));
            return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
        },
        encryptJson(obj) {
            return this.encrypt(JSON.stringify(obj));
        },
        decryptJson(stored) {
            const s = this.decrypt(stored);
            return s === null ? null : JSON.parse(s);
        }
    };
}

/** Cipher for this config: DATA_KEY (hex/base64, 32 bytes) or a key derived from APP_SECRET. */
function cipherFor(config) {
    let key;
    if (config.dataKey) {
        key = /^[0-9a-f]{64}$/i.test(config.dataKey) ? Buffer.from(config.dataKey, 'hex') : Buffer.from(config.dataKey, 'base64');
        if (key.length !== 32) throw new Error('DATA_KEY must be 32 bytes (64 hex chars)');
    } else {
        key = deriveKey(config.appSecret, 'data-at-rest');
    }
    return createCipher(key);
}

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, randomToken, sha256, deriveKey, createCipher, cipherFor };
