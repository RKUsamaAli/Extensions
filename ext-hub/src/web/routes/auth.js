'use strict';
/**
 * /api/v1/auth — login, refresh, logout, me, password, register.
 * Extensions get the refresh token in the body; the panel gets it in the HttpOnly
 * SameSite=Strict cookie `eh_rt` (path /api/v1/auth) and never sees it.
 */
const express = require('express');
const { E } = require('../../lib/errors');
const { parseClientHeader } = require('../../lib/util');
const { bearer } = require('../middleware');

const COOKIE = 'eh_rt';
const COOKIE_PATH = '/api/v1/auth';

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 1) continue;
        const k = part.slice(0, i).trim();
        if (!(k in out)) {
            try {
                out[k] = decodeURIComponent(part.slice(i + 1).trim());
            } catch (_) {
                out[k] = part.slice(i + 1).trim();
            }
        }
    }
    return out;
}

function authRoutes(services) {
    const { config } = services;
    const r = express.Router();
    const secure = config.publicUrl.startsWith('https://');

    const setCookie = (res, token, expiresAt) => {
        const maxAge = Math.max(0, Math.floor((expiresAt - services.clock.now()) / 1000));
        res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
    };
    const clearCookie = (res) => res.append('Set-Cookie', `${COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);

    /** Cookie-based calls must come from our own pages (defence in depth next to SameSite). */
    const sameOrigin = (req) => !req.headers.origin || req.headers.origin === config.publicUrl;

    r.post('/login', (req, res) => {
        const b = req.body || {};
        const client = b.client && typeof b.client === 'object' ? b.client : {};
        const out = services.auth.login({ username: b.username, password: b.password, client, ip: req.ip, userAgent: req.headers['user-agent'] });
        if (client.kind === 'panel') {
            setCookie(res, out.refreshToken, out.refreshExpiresAt);
            delete out.refreshToken;
        }
        res.json(out);
    });

    r.post('/refresh', (req, res) => {
        const b = req.body || {};
        if (b.refreshToken) {
            const client = parseClientHeader(req.headers['x-client']);
            return res.json(services.auth.refresh({ refreshToken: b.refreshToken, kind: 'extension', deviceId: req.headers['x-device-id'], version: client ? client.version : null }));
        }
        const token = parseCookies(req.headers.cookie)[COOKIE];
        if (!token) throw E.sessionExpired();
        if (!sameOrigin(req)) throw E.forbidden('Cross-site request refused.');
        try {
            const out = services.auth.refresh({ refreshToken: token, kind: 'panel' });
            setCookie(res, token, out.refreshExpiresAt);
            res.json(out);
        } catch (err) {
            if (err && err.status === 401) clearCookie(res);
            throw err;
        }
    });

    r.post('/logout', (req, res) => {
        const token = bearer(req);
        let done = false;
        if (token) {
            try {
                const a = services.auth.authenticate(token);
                services.auth.logout(a.session.id);
                done = true;
            } catch (_) {
                /* fall through to the refresh token */
            }
        }
        if (!done && req.body && req.body.refreshToken) services.auth.logoutByRefresh(req.body.refreshToken);
        const cookie = parseCookies(req.headers.cookie)[COOKIE];
        if (cookie && sameOrigin(req)) services.auth.logoutByRefresh(cookie);
        clearCookie(res);
        res.json({ ok: true });
    });

    r.get('/me', (req, res) => {
        const a = services.auth.authenticate(bearer(req));
        res.json({ user: services.users.publicUser(a.user), entitlements: services.users.entitlementsOf(a.user), session: { kind: a.session.kind, ext: a.session.ext } });
    });

    r.post('/password', (req, res) => {
        const a = services.auth.authenticate(bearer(req));
        const b = req.body || {};
        services.auth.changePassword(a.user, a.session.id, b.current, b.next, { ip: req.ip });
        res.json({ ok: true });
    });

    r.post('/register', (req, res) => {
        if (!services.settings.getAll().allowSignup) throw E.forbidden('Sign-ups are closed. Ask the admin for an account.');
        const b = req.body || {};
        services.users.create({ username: b.username, password: b.password, email: b.email, role: 'user', pending: true }, null, { ip: req.ip });
        res.status(201).json({ ok: true, pending: true });
    });

    return r;
}

module.exports = { authRoutes, parseCookies, COOKIE };
