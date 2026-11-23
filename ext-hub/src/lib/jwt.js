'use strict';
/**
 * JSON Web Tokens (RFC 7519), HS256, no dependencies.
 * Each token kind gets its own key derived from APP_SECRET, so one kind can never be
 * replayed as another. Only our exact header is accepted (no alg=none tricks).
 *
 *   const jwt = createJwt({ secret, audience });
 *   const { token, claims } = jwt.sign({ sub }, { kind: 'access', ttlSec: 600 });
 *   jwt.inspect(token, { kind: 'access' })  -> { claims, expired } | null
 */
const crypto = require('crypto');
const { deriveKey } = require('./crypto');
const { newId } = require('./ids');

const ISSUER = 'ext-hub';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const HEADER = b64({ alg: 'HS256', typ: 'JWT' });
const CLOCK_SKEW_SEC = 30;

function createJwt({ secret, audience }) {
    const keyFor = (kind) => deriveKey(secret, 'jwt:' + kind);

    function sign(claims, { kind, ttlSec, now = Date.now() }) {
        const iat = Math.floor(now / 1000);
        const full = { iss: ISSUER, aud: audience, typ: kind, iat, nbf: iat - CLOCK_SKEW_SEC, exp: iat + Math.floor(ttlSec), jti: newId(), ...claims };
        const body = `${HEADER}.${b64(full)}`;
        const sig = crypto.createHmac('sha256', keyFor(kind)).update(body).digest('base64url');
        return { token: `${body}.${sig}`, claims: full };
    }

    function inspect(token, { kind, now = Date.now() }) {
        if (!token || typeof token !== 'string' || token.length > 4096) return null;
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== HEADER) return null;
        const expected = crypto.createHmac('sha256', keyFor(kind)).update(`${parts[0]}.${parts[1]}`).digest();
        const given = Buffer.from(parts[2], 'base64url');
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
        let claims;
        try {
            claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        } catch (_) {
            return null;
        }
        if (!claims || claims.iss !== ISSUER || claims.typ !== kind || claims.aud !== audience) return null;
        const sec = Math.floor(now / 1000);
        if (typeof claims.nbf === 'number' && claims.nbf > sec + CLOCK_SKEW_SEC) return null;
        return { claims, expired: typeof claims.exp !== 'number' || claims.exp <= sec };
    }

    const verify = (token, opts) => {
        const r = inspect(token, opts);
        return r && !r.expired ? r.claims : null;
    };

    return { sign, inspect, verify };
}

module.exports = { createJwt, ISSUER };
