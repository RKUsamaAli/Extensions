'use strict';
/** Test helpers: in-memory database, movable clock, running app on a random port. */
const path = require('path');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/web/app');

const DAY = 24 * 3600 * 1000;

function testConfig(overrides = {}) {
    return {
        ...loadConfig({ NODE_ENV: 'test', APP_SECRET: 'test-secret-test-secret-test-secret-1234', PUBLIC_URL: 'http://hub.test', LOG_LEVEL: 'silent' }),
        dbFile: ':memory:',
        seedsDir: path.join(__dirname, 'fixtures'),
        ...overrides
    };
}

function makeClock(start = Date.UTC(2026, 0, 1)) {
    let t = start;
    return {
        now: () => t,
        advance: (ms) => {
            t += ms;
        },
        set: (v) => {
            t = v;
        }
    };
}

function makeServices(overrides = {}) {
    const config = testConfig(overrides);
    const clock = overrides.clock || makeClock();
    const db = openDb(':memory:');
    const s = createServices({ db, config, clock });
    return { ...s, clock };
}

/** Creates a user; `ents` = { citamate: { expiresAt, maxDevices } }. */
function addUser(s, username, { role = 'user', password = 'password-123', ents = {} } = {}) {
    const entitlements = Object.entries(ents).map(([ext, e]) => ({ ext, expiresAt: e.expiresAt ?? null, maxDevices: e.maxDevices ?? 1 }));
    return s.users.create({ username, password, role, entitlements }, null);
}

const extClient = (ext, deviceId = 'dev-1', version = '9.9.9') => ({ kind: 'extension', ext, deviceId, deviceName: 'Test browser', version });

/** Starts the app; returns { base, close, call(method, path, { token, body, headers }) }. */
async function startApp(services) {
    const app = createApp(services);
    const server = await new Promise((resolve) => {
        const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function call(method, p, { token, body, headers = {} } = {}) {
        const h = { ...headers };
        if (token) h.authorization = 'Bearer ' + token;
        if (body !== undefined) h['content-type'] = 'application/json';
        const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (_) {
            /* not json */
        }
        return { status: res.status, headers: res.headers, json, text };
    }
    return { base, call, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { DAY, testConfig, makeClock, makeServices, addUser, extClient, startApp };
