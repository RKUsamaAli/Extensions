'use strict';
/** Express middleware: security headers, extension CORS, auth, rate limit, errors. */
const { HttpError, E } = require('../lib/errors');
const { createLimiter } = require('../lib/rateLimiter');
const { parseClientHeader } = require('../lib/util');
const { scopeFor } = require('../services/ownership');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function securityHeaders(config) {
    return (req, res, next) => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        if (config.publicUrl.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
        next();
    };
}

const EXT_ORIGIN_RE = /^(chrome-extension|moz-extension|safari-web-extension):\/\/([A-Za-z0-9-]+)$/;

/**
 * CORS only for extension origins (the panel is same-origin). In production only the
 * listed extension ids are answered; with an empty list any extension may call (dev).
 */
function extensionCors(config) {
    return (req, res, next) => {
        const origin = req.headers.origin;
        const m = origin && EXT_ORIGIN_RE.exec(origin);
        if (m && (config.allowedExtensionIds.length === 0 || config.allowedExtensionIds.includes(m[2]))) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Expose-Headers', 'Retry-After, RateLimit-Remaining');
            if (req.method === 'OPTIONS') {
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Client, X-Device-Id');
                res.setHeader('Access-Control-Max-Age', '600');
                return res.status(204).end();
            }
        } else if (req.method === 'OPTIONS') {
            return res.status(204).end();
        }
        next();
    };
}

const bearer = (req) => {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

/** -> req.auth = { user, session, claims }, req.actor = user row, req.client = { ext, version } | null */
function requireAuth(services) {
    return (req, _res, next) => {
        req.auth = services.auth.authenticate(bearer(req));
        req.actor = req.auth.user;
        next();
    };
}

function requireAdmin(req, _res, next) {
    if (!req.actor || req.actor.role !== 'admin') throw E.forbidden('Admins only.');
    next();
}

/** Extension tokens must pass the extension checks on every data call. */
function requireExt(services, ext) {
    return (req, _res, next) => {
        const client = parseClientHeader(req.headers['x-client']);
        services.auth.requireExtAccess(req.auth, ext, client && client.ext === ext ? client.version : null);
        next();
    };
}

/**
 * Proxies and CitaMate entries are managed only in the web panel. Extension sessions may
 * read them (and still send logs, checks and sightings), but every change is refused here,
 * on the server, so a modified extension can't add or edit data either.
 */
function panelOnly(config, what) {
    return (req, _res, next) => {
        if (req.auth && req.auth.session && req.auth.session.kind === 'extension') {
            throw E.panelOnly(`${what} are managed in the web panel. Open ${config.publicUrl}/app to add or change them.`, { panelUrl: config.publicUrl + '/app' });
        }
        next();
    };
}

/** Per-user API limit (writes count 3x). Mounted after requireAuth. */
function userRateLimit(config) {
    const limiter = createLimiter({ limit: config.apiRateLimitRpm, windowMs: 60 * 1000 });
    const mw = (req, res, next) => {
        const key = req.actor ? 'u:' + req.actor.id : 'ip:' + req.ip;
        const r = limiter.hit(key, req.method === 'GET' ? 1 : 3);
        res.setHeader('RateLimit-Remaining', String(r.remaining));
        if (!r.allowed) {
            res.setHeader('Retry-After', String(r.retryAfterSec));
            throw E.tooMany(r.retryAfterSec);
        }
        next();
    };
    mw.limiter = limiter;
    return mw;
}

/** ?owner= -> scope (see services/ownership.js). */
const scopeOf = (req) => scopeFor(req.actor, req.query.owner === undefined ? undefined : String(req.query.owner));

function notFoundApi(_req, _res, next) {
    next(E.notFound('No such API endpoint.'));
}

function errorHandler(logger) {
    // eslint-disable-next-line no-unused-vars
    return (err, req, res, _next) => {
        let e = err;
        if (!(e instanceof HttpError)) {
            if (err && err.type === 'entity.parse.failed') e = E.badRequest('The request body is not valid JSON.');
            else if (err && err.type === 'entity.too.large') e = new HttpError(413, 'too_large', 'The request is too large.');
            else {
                logger.error('unhandled error', { path: req.path, method: req.method, err: err && err.stack ? err.stack : String(err) });
                e = new HttpError(500, 'server_error', 'Something went wrong on the server.');
            }
        }
        if (e.status === 429 && e.extra.retryAfter) res.setHeader('Retry-After', String(e.extra.retryAfter));
        res.status(e.status).json({ code: e.code, message: e.message, ...e.extra });
    };
}

module.exports = {
    panelOnly, securityHeaders, extensionCors, requireAuth, requireAdmin, requireExt, userRateLimit, scopeOf, notFoundApi, errorHandler, bearer, CSP };
