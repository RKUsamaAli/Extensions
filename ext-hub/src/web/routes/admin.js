'use strict';
/** /api/v1/admin — users, entitlements, settings, catalog, site config, audit. Admins only. */
const express = require('express');
const { E } = require('../../lib/errors');
const { isExt } = require('../../lib/util');

function adminRoutes(services) {
    const r = express.Router();
    const { users, settings, configStore, audit } = services;
    const ctx = (req) => ({ ip: req.ip });

    r.get('/users', (_req, res) => res.json({ items: users.list() }));
    r.post('/users', (req, res) => {
        const u = users.create(req.body || {}, req.actor, ctx(req));
        res.status(201).json({ item: users.adminUser(u) });
    });
    r.put('/users/:id', (req, res) => res.json({ item: users.adminUser(users.update(req.params.id, req.body || {}, req.actor, ctx(req))) }));
    r.delete('/users/:id', (req, res) => {
        users.remove(req.params.id, req.actor, ctx(req));
        res.json({ ok: true });
    });
    r.post('/users/:id/sign-out', (req, res) => {
        if (!users.get(req.params.id)) throw E.notFound('User not found.');
        users.signOutEverywhere(req.params.id);
        audit.record({ actor: req.actor, action: 'user.sign_out_everywhere', target: req.params.id, ip: req.ip });
        res.json({ ok: true });
    });
    r.put('/users/:id/entitlements', (req, res) => res.json({ items: users.setEntitlements(req.params.id, (req.body || {}).items, req.actor, ctx(req)) }));

    r.get('/settings', (_req, res) => res.json({ values: settings.getAll() }));
    r.put('/settings', (req, res) => {
        const body = req.body || {};
        const values = settings.update(body.values || body, req.actor);
        audit.record({ actor: req.actor, action: 'settings.update', detail: body.values || body, ip: req.ip });
        res.json({ values });
    });

    const extParam = (req) => {
        if (!isExt(req.params.ext)) throw E.notFound('Unknown extension.');
        return req.params.ext;
    };
    r.get('/catalog/:ext', (req, res) => {
        const c = configStore.getCatalog(extParam(req));
        if (!c) throw E.notFound('No catalog yet.');
        res.json(c);
    });
    r.put('/catalog/:ext', (req, res) => res.json({ version: configStore.putCatalog(extParam(req), (req.body || {}).data, req.actor, ctx(req)) }));
    r.get('/site-config/:ext', (req, res) => res.json(configStore.getSiteConfig(extParam(req))));
    r.put('/site-config/:ext', (req, res) => res.json(configStore.putSiteConfig(extParam(req), (req.body || {}).config, req.actor, ctx(req))));

    r.get('/audit', (req, res) => res.json({ items: audit.list({ limit: req.query.limit, before: req.query.before }) }));
    r.get('/expiring', (req, res) => res.json({ items: services.expiringSoon(Number(req.query.days) || 7) }));

    return r;
}

module.exports = { adminRoutes };
