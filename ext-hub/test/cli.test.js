'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, parseDate } = require('../src/cli');

function env() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-hub-cli-'));
    return { dir, env: { NODE_ENV: 'test', APP_SECRET: 'c'.repeat(40), DB_FILE: path.join(dir, 'x.db'), SEEDS_DIR: path.join(__dirname, 'fixtures') } };
}

test('cli: migrate, create-admin, grant, users, reset-password, maintenance', () => {
    const { dir, env: e } = env();
    const lines = [];
    const out = (l) => lines.push(l);
    try {
        assert.equal(run(['migrate'], { out, env: e }), 0);
        assert.match(lines.pop(), /seeded citamate-catalog, citamate-site-config/);
        assert.equal(run(['create-admin', 'root'], { out, env: e }), 0);
        assert.match(lines.pop(), /Password: \S{8,}/);
        assert.equal(run(['create-admin', 'ali', 'password-123'], { out, env: e }), 0);
        assert.equal(run(['grant', 'ali', 'citamate', '2026-12-31', '2'], { out, env: e }), 0);
        assert.equal(run(['grant', 'ali', 'relayswitch'], { out, env: e }), 0);
        assert.equal(run(['users'], { out, env: e }), 0);
        const aliLine = lines.find((l) => l.startsWith('ali '));
        assert.match(aliLine, /citamate:2026-12-31/);
        assert.match(aliLine, /relayswitch:never/);
        assert.equal(run(['reset-password', 'ali', 'another-pass-1'], { out, env: e }), 0);
        assert.equal(run(['maintenance'], { out, env: e }), 0);
        assert.throws(() => run(['grant', 'ghost', 'citamate'], { out, env: e }), /No user/);
        assert.throws(() => run(['grant', 'ali', 'nope'], { out, env: e }), /ext must be/);
        assert.equal(run(['bogus'], { out, env: e }), 1);
        assert.equal(run([], { out, env: e }), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('cli: parseDate is end of day UTC, never = null', () => {
    assert.equal(parseDate('2026-12-31'), Date.UTC(2026, 11, 31, 23, 59, 59));
    assert.equal(parseDate('never'), null);
    assert.equal(parseDate(undefined), null);
    assert.throws(() => parseDate('31/12/2026'));
});
