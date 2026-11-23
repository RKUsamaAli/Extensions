'use strict';
/** Signed-in data API: bootstrap, CitaMate, RelaySwitch, devices, dashboard. */
const express = require('express');
const { E } = require('../../lib/errors');
const { isExt, parseClientHeader } = require('../../lib/util');
const { requireExt, scopeOf, panelOnly } = require('../middleware');

function dataRoutes(services) {
    const r = express.Router();
    const { users, profiles, proxies, activity, configStore, devices, settings } = services;
    const items = (req) => (req.body && req.body.items) || null;
    const entriesPanelOnly = panelOnly(services.config, 'CitaMate entries');
    const proxiesPanelOnly = panelOnly(services.config, 'Proxies');

    // ------------------------------------------------------------ bootstrap ----
    r.get('/bootstrap', (req, res) => {
        const ext = String(req.query.ext || '');
        if (!isExt(ext)) throw E.validation({ ext: 'Unknown extension.' });
        const client = parseClientHeader(req.headers['x-client']);
        services.auth.requireExtAccess(req.auth, ext, client && client.ext === ext ? client.version : null);
        const s = settings.getAll();
        const ent = users.entitlementFor(req.actor, ext);
        res.json({
            user: users.publicUser(req.actor),
            entitlement: ent,
            minVersion: s.minVersion[ext],
            enabled: s.enabled[ext],
            catalogVersion: configStore.CATALOG_EXTS.includes(ext) ? configStore.catalogVersion(ext) : null,
            siteConfig: configStore.getSiteConfig(ext).config,
            serverTime: services.clock.now()
        });
    });

    // ------------------------------------------------------------- citamate ----
    const cm = express.Router();
    cm.use(requireExt(services, 'citamate'));
    cm.get('/profiles', (req, res) => res.json({ items: profiles.list(scopeOf(req)) }));
    cm.post('/profiles', entriesPanelOnly, (req, res) => res.status(201).json({ item: profiles.create(req.actor, req.body || {}) }));
    cm.post('/profiles/bulk', entriesPanelOnly, (req, res) => res.status(201).json({ items: profiles.bulkCreate(req.actor, items(req), req.body && req.body.ownerId) }));
    cm.put('/profiles/:id', entriesPanelOnly, (req, res) => res.json({ item: profiles.update(req.actor, req.params.id, req.body || {}) }));
    cm.delete('/profiles/:id', entriesPanelOnly, (req, res) => {
        profiles.remove(req.actor, req.params.id);
        res.json({ ok: true });
    });
    // ?context=1 adds the page snapshots of failed steps (panel); the extension leaves them out.
    cm.get('/logs', (req, res) => res.json({ items: activity.listLogs(scopeOf(req), { entryId: req.query.entryId, limit: req.query.limit, context: req.query.context === '1' }) }));
    cm.post('/logs', (req, res) => res.json({ saved: activity.addLogs(req.actor, items(req)) }));
    cm.delete('/logs', (req, res) => res.json({ removed: activity.clearLogs(req.actor) }));
    cm.get('/office-sightings', (req, res) => res.json({ items: activity.listSightings(scopeOf(req), { limit: req.query.limit }) }));
    cm.post('/office-sightings', (req, res) => res.json({ saved: activity.addSightings(req.actor, items(req)) }));
    cm.delete('/office-sightings', (req, res) => res.json({ removed: activity.clearSightings(req.actor) }));
    cm.get('/catalog', (req, res) => {
        const c = configStore.getCatalog('citamate');
        if (!c) throw E.notFound('The catalog has not been uploaded yet.');
        res.setHeader('Cache-Control', 'private, max-age=0');
        res.json({ version: c.version, data: c.data });
    });
    r.use('/citamate', cm);

    // ---------------------------------------------------------- relayswitch ----
    const rs = express.Router();
    rs.use(requireExt(services, 'relayswitch'));
    rs.get('/proxies', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        // With `limit`: one scored, filtered, sorted page + summary of all (panel). Without: everything (extension).
        if (req.query.limit !== undefined) {
            const { q, filter, sort, limit, offset, ids } = req.query;
            return res.json(proxies.page(scopeOf(req), { q, filter, sort, limit, offset, idsOnly: ids === '1' }));
        }
        // The extension gets only switched-on proxies.
        res.json({ items: proxies.list(scopeOf(req), { enabledOnly: req.auth.session.kind === 'extension' }) });
    });
    rs.post('/proxies/actions', proxiesPanelOnly, (req, res) => {
        const b = req.body || {};
        res.json(proxies.bulkAction(req.actor, b.ids, b.action));
    });
    rs.post('/proxies/server-check', proxiesPanelOnly, async (req, res) => {
        res.json({ results: await proxies.serverCheck(req.actor, (req.body || {}).ids) });
    });
    rs.post('/proxies', proxiesPanelOnly, (req, res) => res.status(201).json({ item: proxies.create(req.actor, req.body || {}) }));
    rs.post('/proxies/bulk', proxiesPanelOnly, (req, res) => res.status(201).json({ items: proxies.bulkCreate(req.actor, items(req), req.body && req.body.ownerId) }));
    rs.put('/proxies/:id', proxiesPanelOnly, (req, res) => res.json({ item: proxies.update(req.actor, req.params.id, req.body || {}) }));
    rs.delete('/proxies/:id', proxiesPanelOnly, (req, res) => {
        proxies.remove(req.actor, req.params.id);
        res.json({ ok: true });
    });
    rs.get('/checks', (req, res) => res.json({ stats: proxies.stats(scopeOf(req), { proxyId: req.query.proxyId }) }));
    rs.post('/checks', (req, res) => res.json({ saved: proxies.addChecks(req.actor, items(req)) }));
    rs.get('/logs', (req, res) => res.json({ items: proxies.listLogs(scopeOf(req), { limit: req.query.limit }) }));
    rs.post('/logs', (req, res) => res.json({ saved: proxies.addLogs(req.actor, items(req)) }));
    rs.delete('/logs', (req, res) => res.json({ removed: proxies.clearLogs(req.actor) }));
    r.use('/relayswitch', rs);

    // -------------------------------------------------------------- devices ----
    r.get('/devices', (req, res) => res.json({ items: devices.list(scopeOf(req)) }));
    r.delete('/devices/:id', (req, res) => {
        devices.revoke(req.actor, req.params.id, { ip: req.ip });
        res.json({ ok: true });
    });

    // ------------------------------------------------------------ dashboard ----
    r.get('/dashboard', (req, res) => res.json(services.dashboard(req.actor, scopeOf(req))));

    return r;
}

module.exports = { dataRoutes };
