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
    // The download page is public (the zips are too): list the packages of this release.
    api.get('/public/downloads', anonLimit, (_req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.json({ publicUrl: config.publicUrl, items: listDownloads(config.downloadsDir) });
    });

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
    // Assets are served under /v/<version>/… (version = release, or the start time in dev)
    // and cached for a year: a new deploy changes the URL, so browsers never mix old and
    // new files and repeat visits load nothing. Each page also preloads all the modules
    // it imports, so the browser fetches them in one parallel wave instead of one level
    // of imports at a time.
    const assetVersion = (config.release || 'dev' + Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, '');
    const pages = new Map();
    const page = (file) => (_req, res, next) => {
        let html = pages.get(file);
        if (html === undefined) {
            html = renderPage(config.publicDir, file, assetVersion);
            if (config.production) pages.set(file, html);
        }
        if (html === null) return next();
        res.setHeader('Cache-Control', 'no-cache');
        res.type('html').send(html);
    };
    app.get('/', (_req, res) => res.redirect(302, '/app'));
    // People type /downloads or /download: send them to the folder nginx serves (with the slash).
    // Express matches /downloads and /downloads/ alike, so look at the real path (no redirect loop).
    app.get(['/downloads', '/download', '/download/'], (req, res, next) => {
        if (req.originalUrl.split('?')[0] === '/downloads/') return page('downloads.html')(req, res, next);
        res.redirect(301, '/downloads/');
    });
    app.use('/downloads', express.static(config.downloadsDir, { index: false, maxAge: 0 }));
    app.get('/login', page('login.html'));
    app.get('/register', page('register.html'));
    app.get('/app', page('app.html'));
    app.use('/v/:ver', (req, res, next) => {
        const current = req.params.ver === assetVersion;
        express.static(config.publicDir, {
            index: false,
            extensions: false,
            // An old version (a page loaded before a deploy) gets today's file, never cached.
            setHeaders: (r) => r.setHeader('Cache-Control', current ? 'public, max-age=31536000, immutable' : 'no-cache')
        })(req, res, next);
    });
    // Un-versioned paths still work (old bookmarks, extensions' links): always revalidated.
    app.use(express.static(config.publicDir, { index: false, extensions: false, setHeaders: (r) => r.setHeader('Cache-Control', 'no-cache') }));
    app.use((_req, res) => res.status(404).type('text').send('Not found'));

    app.use(mw.errorHandler(logger));
    return app;
}

/** Module file -> its static `import … from "./x.js"` targets (resolved), recursively. */
function moduleGraph(publicDir, entry, seen = new Set()) {
    if (seen.has(entry)) return seen;
    const file = path.join(publicDir, entry);
    if (!file.startsWith(publicDir) || !fs.existsSync(file)) return seen;
    seen.add(entry);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|[;\s])(?:import|export)\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        moduleGraph(publicDir, path.posix.normalize(path.posix.join(path.posix.dirname(entry), m[1])), seen);
    }
    return seen;
}

/** HTML page with versioned asset URLs and modulepreload links (null when missing). */
function renderPage(publicDir, file, version) {
    const p = path.join(publicDir, file);
    if (!fs.existsSync(p)) return null;
    let html = fs.readFileSync(p, 'utf8');
    const prefix = `/v/${version}/`;
    const entries = [...html.matchAll(/<script type="module" src="\/([^"]+)"/g)].map((m) => m[1]);
    const preload = new Set();
    for (const e of entries) for (const dep of moduleGraph(publicDir, e)) if (dep !== e) preload.add(dep);
    html = html.replace(/(src|href)="\/(js|css)\//g, `$1="${prefix}$2/`);
    const links = [...preload].sort().map((d) => `  <link rel="modulepreload" href="${prefix}${d}">`).join('\n');
    return links ? html.replace('</head>', `${links}\n</head>`) : html;
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

module.exports = { createApp, listDownloads, renderPage };
