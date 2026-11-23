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
    app.get('/login', page('login.html'));
    app.get('/register', page('register.html'));
    app.get('/app', page('app.html'));
    app.use(express.static(config.publicDir, { index: false, maxAge: config.production ? '1h' : 0, extensions: false }));
    app.use((_req, res) => res.status(404).type('text').send('Not found'));

    app.use(mw.errorHandler(logger));
    return app;
}

module.exports = { createApp };
