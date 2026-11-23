'use strict';
/**
 * Checks a proxy from the server: connects through it to an IP-echo service and returns
 * { ok, ms, ip, error }. Supports http, https (TLS to the proxy), socks5 (with login) and
 * socks4. No dependencies: plain net / tls sockets.
 *
 * The result shows whether the proxy works and how fast it is FROM THIS SERVER. The
 * extension's own checks (from the user's browser) stay the main score source.
 */
const net = require('net');
const tls = require('tls');

const DEFAULT_TARGET = { host: 'api.ipify.org', port: 80, path: '/?format=json' };
const DEFAULT_TIMEOUT_MS = 10000;

/** {session} {country} {city} like RelaySwitch (relayswitch/src/core/username.ts). */
function renderUsername(template, vars) {
    return String(template || '').replace(/\{([a-z]+)\}/g, (_all, name) => {
        if (!['session', 'country', 'city'].includes(name)) throw new Error(`Unknown token {${name}}`);
        const v = vars[name] === null || vars[name] === undefined ? '' : String(vars[name]).trim();
        if (!v) throw new Error(`Token {${name}} has no value`);
        return v;
    });
}

function connectProxy(p, timeoutMs) {
    return new Promise((resolve, reject) => {
        const opts = { host: p.host, port: p.port };
        const sock = p.scheme === 'https' ? tls.connect({ ...opts, servername: net.isIP(p.host) ? undefined : p.host }) : net.connect(opts);
        sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`No answer in ${Math.round(timeoutMs / 1000)} s`)));
        sock.once(p.scheme === 'https' ? 'secureConnect' : 'connect', () => resolve(sock));
        sock.once('error', reject);
    });
}

/** Reads exactly n bytes (SOCKS handshakes). */
function readBytes(sock, n) {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const onData = (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length >= n) {
                cleanup();
                const extra = buf.subarray(n);
                if (extra.length) sock.unshift(extra);
                resolve(buf.subarray(0, n));
            }
        };
        const onEnd = () => { cleanup(); reject(new Error('Proxy closed the connection')); };
        const onErr = (e) => { cleanup(); reject(e); };
        // Pause between reads, so bytes pushed back with unshift wait for the next reader
        // instead of being emitted to nobody. An explicitly paused socket is resumed below.
        const cleanup = () => { sock.off('data', onData); sock.off('end', onEnd); sock.off('error', onErr); sock.pause(); };
        sock.on('data', onData);
        sock.once('end', onEnd);
        sock.once('error', onErr);
        sock.resume();
    });
}

async function socks5(sock, p, target) {
    const auth = !!p.username;
    sock.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
    const [ver, method] = await readBytes(sock, 2);
    if (ver !== 5) throw new Error('Not a SOCKS5 proxy');
    if (method === 0xff) throw new Error('Proxy refused every login method');
    if (method === 2) {
        const u = Buffer.from(p.username), pw = Buffer.from(p.password || '');
        sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
        const [, status] = await readBytes(sock, 2);
        if (status !== 0) throw new Error('Proxy login failed');
    }
    const host = Buffer.from(target.host);
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([target.port >> 8, target.port & 255])]));
    const head = await readBytes(sock, 4);
    if (head[1] !== 0) throw new Error(`Proxy could not connect (SOCKS5 code ${head[1]})`);
    const atyp = head[3];
    const rest = atyp === 1 ? 4 + 2 : atyp === 4 ? 16 + 2 : (await readBytes(sock, 1))[0] + 2;
    await readBytes(sock, rest);
}

async function socks4(sock, p, target) {
    const user = Buffer.from(p.username || '');
    const host = Buffer.from(target.host);
    // SOCKS4a: IP 0.0.0.1 + host name after the user id.
    sock.write(Buffer.concat([Buffer.from([4, 1, target.port >> 8, target.port & 255, 0, 0, 0, 1]), user, Buffer.from([0]), host, Buffer.from([0])]));
    const r = await readBytes(sock, 8);
    if (r[1] !== 0x5a) throw new Error(`Proxy refused the connection (SOCKS4 code ${r[1]})`);
}

/** Decodes a chunked body; null while incomplete. */
function dechunk(raw) {
    let out = '';
    let i = 0;
    for (;;) {
        const nl = raw.indexOf('\r\n', i);
        if (nl < 0) return null;
        const size = parseInt(raw.slice(i, nl), 16);
        if (Number.isNaN(size)) return out;
        if (size === 0) return out;
        if (raw.length < nl + 2 + size + 2) return null;
        out += raw.slice(nl + 2, nl + 2 + size);
        i = nl + 2 + size + 2;
    }
}

/**
 * Sends the request and reads one answer -> { status, body }. Finishes as soon as the body
 * is complete (Content-Length or chunked), so proxies that keep the connection open work.
 */
function httpExchange(sock, request) {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        let settled = false;
        const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
        const tryParse = (closed) => {
            const text = buf.toString('latin1');
            const end = text.indexOf('\r\n\r\n');
            if (end < 0) {
                if (closed) finish(reject, new Error(text ? 'Unexpected answer from the proxy' : 'Proxy closed the connection'));
                return;
            }
            const head = text.slice(0, end);
            const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
            if (!m) return finish(reject, new Error('Unexpected answer from the proxy'));
            const status = Number(m[1]);
            const raw = text.slice(end + 4);
            const len = /\r\ncontent-length:\s*(\d+)/i.exec(head);
            const chunked = /\r\ntransfer-encoding:\s*chunked/i.test(head);
            let body = null;
            if (len) body = raw.length >= Number(len[1]) ? raw.slice(0, Number(len[1])) : null;
            else if (chunked) body = dechunk(raw);
            else if (closed || status === 407 || status === 204) body = raw;
            if (body !== null) finish(resolve, { status, body: Buffer.from(body, 'latin1').toString('utf8') });
            else if (closed) finish(reject, new Error('Answer cut off'));
        };
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length > 64 * 1024) return sock.destroy(new Error('Answer too large'));
            tryParse(false);
        });
        sock.once('error', (e) => finish(reject, e));
        sock.once('close', () => tryParse(true));
        sock.resume();
        sock.write(request);
    });
}

/**
 * p = { scheme, host, port, username, password }
 * -> Promise<{ ok: boolean, ms?: number, ip?: string, error?: string }>  (never rejects)
 */
async function checkProxy(p, { timeoutMs = DEFAULT_TIMEOUT_MS, target = DEFAULT_TARGET } = {}) {
    const started = Date.now();
    let sock;
    const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error(`No answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs).unref());
    const run = async () => {
        sock = await connectProxy(p, timeoutMs);
        const hostHeader = target.port === 80 ? target.host : `${target.host}:${target.port}`;
        let request;
        if (p.scheme === 'socks5' || p.scheme === 'socks4') {
            await (p.scheme === 'socks5' ? socks5 : socks4)(sock, p, target);
            request = `GET ${target.path} HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: ext-hub-check\r\nConnection: close\r\n\r\n`;
        } else {
            const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password || ''}`).toString('base64')}\r\n` : '';
            request = `GET http://${hostHeader}${target.path} HTTP/1.1\r\nHost: ${hostHeader}\r\n${auth}User-Agent: ext-hub-check\r\nConnection: close\r\n\r\n`;
        }
        const res = await httpExchange(sock, request);
        if (res.status === 407) throw new Error('Proxy login failed (407)');
        if (res.status !== 200) throw new Error(`Proxy answered HTTP ${res.status}`);
        let ip = '';
        try {
            ip = String(JSON.parse(res.body).ip || '');
        } catch (_) {
            ip = res.body.trim().slice(0, 64);
        }
        // Only a real address counts: a captive page or an error page is not a working proxy.
        if (!net.isIP(ip)) throw new Error('Unexpected answer (no IP address) – the proxy may be blocking requests');
        return { ok: true, ms: Date.now() - started, ip };
    };
    try {
        return await Promise.race([run(), deadline]);
    } catch (err) {
        return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
    } finally {
        if (sock) sock.destroy();
    }
}

module.exports = { checkProxy, renderUsername, DEFAULT_TARGET };
