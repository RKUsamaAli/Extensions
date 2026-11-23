'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const { checkProxy, renderUsername } = require('../src/lib/proxyCheck');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

/** IP-echo service standing in for api.ipify.org. */
async function echo() {
    const srv = http.createServer((_req, res) => res.end(JSON.stringify({ ip: '203.0.113.7' })));
    return { srv, port: await listen(srv) };
}

/** HTTP proxy that needs user:pass and forwards absolute-URI GETs. */
async function httpProxy() {
    const srv = http.createServer((req, res) => {
        const want = 'Basic ' + Buffer.from('user-es-session-5:pw').toString('base64');
        if (req.headers['proxy-authorization'] !== want) { res.writeHead(407); return res.end(); }
        http.get(req.url, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    });
    return { srv, port: await listen(srv) };
}

/** SOCKS5 proxy with username/password login (RFC 1928 / 1929, domain addresses). */
async function socks5Proxy(target) {
    const srv = net.createServer((c) => {
        let stage = 0;
        let buf = Buffer.alloc(0);
        c.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (stage === 0 && buf.length >= 2 + buf[1]) { buf = buf.subarray(2 + buf[1]); c.write(Buffer.from([5, 2])); stage = 1; }
            if (stage === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
                const u = buf.subarray(2, 2 + buf[1]).toString(); const pl = buf[2 + buf[1]]; const p = buf.subarray(3 + buf[1], 3 + buf[1] + pl).toString();
                buf = buf.subarray(3 + buf[1] + pl); const ok = u === 'su' && p === 'sp'; c.write(Buffer.from([1, ok ? 0 : 1])); if (!ok) return c.end(); stage = 2;
            }
            if (stage === 2 && buf.length >= 5 && buf.length >= 7 + buf[4]) {
                buf = buf.subarray(7 + buf[4]); stage = 3;
                const up = net.connect({ port: target, host: '127.0.0.1' }, () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (buf.length) up.write(buf); c.pipe(up); up.pipe(c); });
            }
        });
    });
    return { srv, port: await listen(srv) };
}

test('proxy check: http with login, socks5 with login, bad login, dead proxy', async () => {
    const e = await echo();
    const target = { host: '127.0.0.1', port: e.port, path: '/?format=json' };
    const hp = await httpProxy();
    const sp = await socks5Proxy(e.port);
    try {
        const ok = await checkProxy({ scheme: 'http', host: '127.0.0.1', port: hp.port, username: renderUsername('user-{country}-session-{session}', { country: 'es', session: 5 }), password: 'pw' }, { target });
        assert.equal(ok.ok, true, JSON.stringify(ok));
        assert.equal(ok.ip, '203.0.113.7');
        assert.ok(ok.ms >= 0);
        const bad = await checkProxy({ scheme: 'http', host: '127.0.0.1', port: hp.port, username: 'x', password: 'y' }, { target });
        assert.deepEqual(bad, { ok: false, error: 'Proxy login failed (407)' });
        const s5 = await checkProxy({ scheme: 'socks5', host: '127.0.0.1', port: sp.port, username: 'su', password: 'sp' }, { target });
        assert.equal(s5.ok, true, JSON.stringify(s5));
        assert.equal(s5.ip, '203.0.113.7');
        const s5bad = await checkProxy({ scheme: 'socks5', host: '127.0.0.1', port: sp.port, username: 'su', password: 'no' }, { target });
        assert.equal(s5bad.ok, false);
        assert.match(s5bad.error, /login failed/);
        const dead = await checkProxy({ scheme: 'http', host: '127.0.0.1', port: 1 }, { target, timeoutMs: 2000 });
        assert.equal(dead.ok, false);
        assert.match(dead.error, /ECONNREFUSED|No answer/);
    } finally {
        for (const s of [e.srv, hp.srv, sp.srv]) s.close();
    }
    assert.throws(() => renderUsername('u-{session}', {}), /no value/);
});
