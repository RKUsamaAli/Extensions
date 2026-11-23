'use strict';
/**
 * Data the extensions need to work at all, edited by the admin:
 *   catalogs      versioned reference data (CitaMate: provinces, countries, trámites, offices)
 *   site_configs  per-extension JSON (CitaMate: the page selectors that used to be in content.js)
 * Seeded once from seeds/<ext>-catalog.json and seeds/<ext>-site-config.json.
 */
const fs = require('fs');
const path = require('path');
const { E } = require('../lib/errors');
const { EXTS, isExt, parseJson } = require('../lib/util');

const CATALOG_EXTS = ['citamate'];

function validateCatalog(ext, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw E.badRequest('data must be an object');
    if (ext === 'citamate') {
        const fields = {};
        if (!Array.isArray(data.provinces)) fields.provinces = 'Must be a list.';
        if (!Array.isArray(data.paises)) fields.paises = 'Must be a list.';
        if (!data.tramites || typeof data.tramites !== 'object' || Array.isArray(data.tramites)) fields.tramites = 'Must be an object keyed by province.';
        if (!data.offices || typeof data.offices !== 'object' || Array.isArray(data.offices)) fields.offices = 'Must be an object keyed by province.';
        if (Object.keys(fields).length) throw E.validation(fields, 'The catalog is missing parts.');
    }
}

function createConfigStore({ db, clock, audit }) {
    function getCatalog(ext) {
        const r = db.prepare('SELECT * FROM catalogs WHERE ext = ?').get(ext);
        return r ? { version: r.version, data: parseJson(r.data_json, {}), updatedAt: r.updated_at } : null;
    }
    const catalogVersion = (ext) => db.prepare('SELECT version FROM catalogs WHERE ext = ?').pluck().get(ext) ?? null;

    function putCatalog(ext, data, actor, { ip } = {}) {
        if (!CATALOG_EXTS.includes(ext)) throw E.notFound('This extension has no catalog.');
        validateCatalog(ext, data);
        const t = clock.now();
        const version = (catalogVersion(ext) || 0) + 1;
        db.prepare(
            'INSERT INTO catalogs (ext, version, data_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ext) DO UPDATE SET version = excluded.version, data_json = excluded.data_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
        ).run(ext, version, JSON.stringify(data), t, actor ? actor.id : null);
        audit.record({ actor, action: 'catalog.update', target: ext, detail: { version }, ip });
        return version;
    }

    function getSiteConfig(ext) {
        const r = db.prepare('SELECT * FROM site_configs WHERE ext = ?').get(ext);
        return r ? { config: parseJson(r.config_json, {}), updatedAt: r.updated_at } : { config: {}, updatedAt: null };
    }

    function putSiteConfig(ext, config, actor, { ip } = {}) {
        if (!isExt(ext)) throw E.notFound('Unknown extension.');
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw E.badRequest('config must be a JSON object');
        const t = clock.now();
        db.prepare(
            'INSERT INTO site_configs (ext, config_json, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(ext) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
        ).run(ext, JSON.stringify(config), t, actor ? actor.id : null);
        audit.record({ actor, action: 'site_config.update', target: ext, ip });
        return getSiteConfig(ext);
    }

    /** Inserts seed files for anything not in the database yet. -> list of what was seeded */
    function seed(seedsDir) {
        const done = [];
        if (!seedsDir || !fs.existsSync(seedsDir)) return done;
        for (const ext of EXTS) {
            const catFile = path.join(seedsDir, `${ext}-catalog.json`);
            if (CATALOG_EXTS.includes(ext) && catalogVersion(ext) === null && fs.existsSync(catFile)) {
                const data = JSON.parse(fs.readFileSync(catFile, 'utf8'));
                validateCatalog(ext, data);
                db.prepare('INSERT INTO catalogs (ext, version, data_json, updated_at, updated_by) VALUES (?, 1, ?, ?, NULL)').run(ext, JSON.stringify(data), clock.now());
                done.push(`${ext}-catalog`);
            }
            const cfgFile = path.join(seedsDir, `${ext}-site-config.json`);
            const has = db.prepare('SELECT 1 FROM site_configs WHERE ext = ?').get(ext);
            if (!has && fs.existsSync(cfgFile)) {
                const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
                db.prepare('INSERT INTO site_configs (ext, config_json, updated_at, updated_by) VALUES (?, ?, ?, NULL)').run(ext, JSON.stringify(cfg), clock.now());
                done.push(`${ext}-site-config`);
            }
        }
        return done;
    }

    return { getCatalog, catalogVersion, putCatalog, getSiteConfig, putSiteConfig, seed, CATALOG_EXTS };
}

module.exports = { createConfigStore, validateCatalog };
