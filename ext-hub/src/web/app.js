'use strict';
/**
 * createApp(services) -> Express app (no listen), so tests can start it on a random port.
 *
 *   /api/v1/auth/*        sign-in (public)
 *   /api/v1/admin/*       admins only
 *   /api/v1/*             signed-in data API
 *   /login /register /app panel pages; everything else in public/ is static
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const mw = require('./middleware');
const { authRoutes } = require('./routes/auth');
const { dataRoutes } = require('./routes/data');
const { adminRoutes } = require('./routes/admin');
const { createLogger } = require('../lib/logger');
const { createLimiter } = require('../lib/rateLimiter');
const { E } = require('../lib/errors');

function createApp(services, { logger = createLogger(services.config.logLevel) } = {}) {
    const { config } = services;
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    app.set('etag', false);

    app.use(mw.securityHeaders(config));

    app.get('/healthz', (_req, res) => {
        services.db.prepare('SELECT 1').get();
        // `release` lets deploy/deploy.sh confirm the NEW release is the one answering.
        res.json({ ok: true, time: services.clock.now(), ...(config.release ? { release: config.release } : {}) });
    });

    // ------------------------------------------------------------------ API ----
    const api = express.Router();
    api.use(mw.extensionCors(config));
    api.use(express.json({ limit: '5mb' }));
    api.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    // Signed-out endpoints get a per-IP limit (login failures have their own, stricter one).
    const anon = createLimiter({ limit: 120, windowMs: 60 * 1000 });
    const anonLimit = (req, res, next) => {
        const r = anon.hit('ip:' + req.ip);
        if (!r.allowed) throw E.tooMany(r.retryAfterSec);
        next();
    };
    api.use('/auth', anonLimit, authRoutes(services));

    const limit = mw.userRateLimit(config);
    // Extension packages of this release (any signed-in user; the zips themselves are public).
    api.get('/downloads', mw.requireAuth(services), limit, (_req, res) => {
        res.json({ publicUrl: config.publicUrl, items: listDownloads(config.downloadsDir) });
    });
    api.use('/admin', mw.requireAuth(services), limit, mw.requireAdmin, adminRoutes(services));
    api.use(mw.requireAuth(services), limit, dataRoutes(services));
    api.use(mw.notFoundApi);
    app.use('/api/v1', api);
    app.use('/api', mw.notFoundApi);

    // ---------------------------------------------------------------- panel ----
    const page = (file) => (_req, res, next) => {
        const p = path.join(config.publicDir, file);
        if (!fs.existsSync(p)) return next();
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(p);
    };
    app.get('/', (_req, res) => res.redirect(302, '/app'));
    // People type /downloads or /download: send them to the folder nginx serves (with the slash).
    app.get(['/downloads', '/download', '/download/'], (_req, res) => res.redirect(301, '/downloads/'));
    app.use('/downloads', express.static(config.downloadsDir, { index: false, maxAge: 0 }));
    app.get('/login', page('login.html'));
    app.get('/register', page('register.html'));
    app.get('/app', page('app.html'));
    app.use(express.static(config.publicDir, { index: false, maxAge: config.production ? '1h' : 0, extensions: false }));
    app.use((_req, res) => res.status(404).type('text').send('Not found'));

    app.use(mw.errorHandler(logger));
    return app;
}

/** Zips named <ext>-<version>.zip in dir -> [{ ext, version, file, size, builtAt }], newest version first. */
function listDownloads(dir) {
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch (_) {
        return [];
    }
    const items = [];
    for (const file of names) {
        const m = /^(citamate|relayswitch)-(\d+(?:\.\d+)*)\.zip$/.exec(file);
        if (!m) continue;
        const st = fs.statSync(path.join(dir, file));
        items.push({ ext: m[1], version: m[2], file, url: '/downloads/' + file, size: st.size, builtAt: st.mtimeMs });
    }
    const num = (v) => v.split('.').map(Number);
    const cmp = (a, b) => {
        const x = num(a), y = num(b);
        for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
        return 0;
    };
    return items.sort((a, b) => a.ext.localeCompare(b.ext) || cmp(a.version, b.version));
}

module.exports = { createApp, listDownloads };
