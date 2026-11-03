'use strict';
// Many requests per test file: the per-address limits would answer 429 part-way.
process.env.CONNECT_RATE_LIMIT_PER_MIN = process.env.CONNECT_RATE_LIMIT_PER_MIN || '100000';
process.env.CONNECT_API_RATE_LIMIT_PER_MIN = process.env.CONNECT_API_RATE_LIMIT_PER_MIN || '100000';
/**
 * Boots OpenVibe.Connect on a temp database with a mock Network (test/helpers/mocks.js), captures log lines, and
 * returns small HTTP clients. Every test file gets its own.
 *
 *   const t = await boot();
 *   t.get(path, { as: user, bearer, json, form, headers, method, cookie, origin })   connect.openvibe.website
 *   t.share(host, path, { cookie, headers, method, body })                            a share host (Host header set)
 *   t.signIn(user) → cookie header value (connect_at = a Network user token, as after /auth/callback)
 *   t.client({ key, port }) → a started ov-connect client against this server (public/ov-connect.js)
 *   t.logs(), t.dbDump()
 */
const http = require('http');
const { startNetwork } = require('./mocks');

const captured = [];
for (const m of ['log', 'info', 'warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => { captured.push(a.map(String).join(' ')); if (process.env.VERBOSE) orig(...a); };
}

async function boot(opts = {}) {
    const network = await startNetwork(opts.network || {});
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://connect.openvibe.website', TRUST_PROXY: '1',
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url,
        OV_OAUTH_CLIENT_ID: 'connect', OV_OAUTH_CLIENT_SECRET: 'connect-secret', COOKIE_SECURE: 'false',
        CONNECT_DRILL: '1',
        CONNECT_EVENTS_URL: network.url,
        CONNECT_SHARE_SCHEME: 'https',
        CONNECT_SESSION_SECRET: 'test-session-secret-0123456789abcdef0123',
        CONNECT_PING_MS: '60000',
        ...(opts.env || {}),
    };
    for (const [k, v] of Object.entries(opts.env || {})) if (v === null) delete env[k];
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const log = { log: (...a) => captured.push(a.map(String).join(' ')), warn: (...a) => captured.push(a.map(String).join(' ')), error: (...a) => captured.push(a.map(String).join(' ')), info: (...a) => captured.push(a.map(String).join(' ')) };

    const config = configLib.load(env);
    const { createStore } = require('../../server/db');
    const testdb = await require('./db').testDb();
    const store = createStore(testdb.db, { now: opts.now });
    const built = await createApp({ config, store, log, telemetrySink: opts.telemetrySink, accountSend: opts.accountSend, notifier: opts.notifier, probeDelayMs: opts.probeDelayMs != null ? opts.probeDelayMs : 60_000 });
    await built.ctx.keys.ensure();
    const server = await new Promise((resolve) => { const s = http.createServer(built.app); s.on('upgrade', built.ctx.onUpgrade); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const sockets = new Set();
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

    const signIn = (user) => `connect_at=${network.userToken(user)}`;

    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as) headers.cookie = [signIn(o.as), headers.cookie].filter(Boolean).join('; ');
        if (o.cookie) headers.cookie = o.cookie;
        if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        if (o.form) { body = new URLSearchParams({ ...o.form }).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        const method = o.method || (body ? 'POST' : 'GET');
        if (o.as && method !== 'GET' && method !== 'HEAD' && !headers.origin && !headers['sec-fetch-site']) headers.origin = config.baseUrl;
        if (o.origin) headers.origin = o.origin;
        const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.toString('utf8');
        return { status: res.status, headers: res.headers, text, buffer: buf, json() { return JSON.parse(text); } };
    }

    /** A request to a share host (fetch cannot set Host, so this is http.request). */
    function share(host, p = '/', o = {}) {
        return new Promise((resolve, reject) => {
            const headers = { host, accept: 'text/html', ...(o.headers || {}) };
            if (o.cookie) headers.cookie = o.cookie;
            const req = http.request({ host: '127.0.0.1', port, path: p, method: o.method || 'GET', headers }, (res) => {
                const chunks = [];
                if (o.onResponse) o.onResponse(res);
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), buffer: buf, json() { return JSON.parse(buf.toString('utf8')); } });
                });
                res.on('error', reject);
            });
            req.on('error', reject);
            if (o.body) req.write(o.body);
            req.end();
        });
    }

    const clients = [];
    function client({ key, port: localPort, quiet = true, server: serverUrl }) {
        const { createClient } = require('../../public/ov-connect');
        const lines = [];
        const c = createClient({ key, port: localPort, server: serverUrl || `ws://127.0.0.1:${port}/tunnel`, quiet, log: (l) => lines.push(l), localHost: '127.0.0.1' });
        c.lines = lines;
        c.ready = () => new Promise((resolve) => c.onReady(resolve));
        clients.push(c);
        c.start();
        return c;
    }

    /** Make a share as `user` through the API → { share, key }. */
    async function makeShare(user, body) {
        const r = await get('/api/v1/shares', { as: user, json: body });
        if (r.status !== 201) throw new Error(`share not made: ${r.status} ${r.text}`);
        return r.json();
    }

    /** Walk the gate as `user` for a share: grant → callback → the share's own cookie header value. */
    async function enter(user, sh, next = '/') {
        const g = await get(`/grant?share=${encodeURIComponent(sh.id)}&next=${encodeURIComponent(next)}`, { as: user });
        if (g.status !== 303) return { status: g.status, grant: g };
        const loc = new URL(g.headers.get('location'));
        const cb = await share(sh.host, `${loc.pathname}${loc.search}`);
        const setCookie = [].concat(cb.headers['set-cookie'] || [])[0] || '';
        return { status: cb.status, location: cb.headers.location, cookie: setCookie.split(';')[0], setCookie };
    }

    async function dbDump() {
        const db = built.ctx.s.db;
        const tables = (await db.many("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()")).map((r) => r.name);
        return (await Promise.all(tables.map(async (tname) => JSON.stringify(await db.many(`SELECT * FROM "${tname}"`))))).join('\n');
    }

    const t = {
        base, port, network, config, ctx: built.ctx, get, share, signIn, dbDump, client, makeShare, enter,
        logs: () => captured.join('\n'),
        async close() {
            for (const c of clients) c.stop();
            built.ctx.tunnels.closeAll();
            built.ctx.gate.stop();
            await built.ctx.proxy.stop();
            for (const s of sockets) s.destroy();
            await new Promise((r) => server.close(r));
            built.ctx.keys.client.stop();
            await built.ctx.telemetry.stop().catch(() => {});
            await testdb.close();
            await network.close();
        },
    };
    return t;
}

/** A tiny local app for a share to point at: echoes what it got, streams on /sse, upgrades on /ws (raw echo). */
function startLocalApp() {
    return new Promise((resolve) => {
        const seen = [];
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
                if (req.url === '/sse') {
                    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                    let n = 0;
                    const iv = setInterval(() => { n++; res.write(`data: tick ${n}\n\n`); if (n === 3) { clearInterval(iv); res.end(); } }, 20);
                    return;
                }
                if (req.url === '/big') {
                    res.writeHead(200, { 'content-type': 'application/octet-stream' });
                    res.end(Buffer.alloc(3 * 1024 * 1024, 7));
                    return;
                }
                if (req.url === '/cookie') {
                    res.writeHead(200, { 'set-cookie': ['app=1; Domain=.openvibe.website; Path=/', '__Host-ovc=forged; Path=/; Secure'], 'cache-control': 'public, max-age=600' });
                    res.end('ok');
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json', 'x-app': 'yes' });
                res.end(JSON.stringify({ method: req.method, url: req.url, user: req.headers['x-openvibe-user'] || null, host: req.headers.host, cookie: req.headers.cookie || null, body: Buffer.concat(chunks).toString('utf8') }));
            });
        });
        server.on('upgrade', (req, socket) => {
            seen.push({ upgrade: true, url: req.url, headers: req.headers });
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
            socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
        });
        const sockets = new Set();
        server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }) }));
    });
}

module.exports = { boot, startLocalApp };
