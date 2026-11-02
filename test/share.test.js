'use strict';
/**
 * A share end to end: made through the API, the gate (grant → one-time code → the share's own host-only cookie),
 * the client (public/ov-connect.js) carrying requests to a real local app — bodies, server-sent events, a 3 MB
 * download, a WebSocket-style upgrade — the headers the app gets and the ones it may not set, who may open it, a new
 * key, closing, and the counters.
 */
const assert = require('assert');
const net = require('net');
const { boot, startLocalApp } = require('./helpers/boot');
const { check, done } = require('./helpers/check');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out waiting');
        await sleep(20);
    }
}

(async () => {
    const t = await boot();
    const app = await startLocalApp();
    const alex = t.network.addUser('Alex_Dev');
    const bob = t.network.addUser('bob');
    let made;
    let alexCookie;
    let c;

    await check('a share is made through the API: its address joins the name and the handle with "--"; the key comes once', async () => {
        made = await t.makeShare(alex, { label: 'agents', port: app.port });
        assert.strictEqual(made.share.host, 'agents--alex-dev.openvibe.website');
        assert.strictEqual(made.share.url, 'https://agents--alex-dev.openvibe.website');
        assert.strictEqual(made.share.mode, 'owner');
        assert.match(made.key, /^ovc_[A-Za-z0-9_-]{43}$/);
        const list = await t.get('/api/v1/shares', { as: alex });
        assert.strictEqual(list.json().shares.length, 1);
        assert.ok(!list.text.includes(made.key), 'the key is never shown again');
        assert.ok(!(await t.dbDump()).includes(made.key), 'only the key\'s hash is stored');
    });

    await check('names: public, reserved, malformed and taken names are refused', async () => {
        const pub = await t.get('/api/v1/shares', { as: alex, json: { label: 'open', port: 80, mode: 'public' } });
        assert.strictEqual(pub.status, 422);
        assert.strictEqual(pub.json().code, 'share.public_not_yet');
        assert.strictEqual((await t.get('/api/v1/shares', { as: alex, json: { label: 'connect', port: 80 } })).json().code, 'share.reserved_label');
        assert.strictEqual((await t.get('/api/v1/shares', { as: alex, json: { label: 'a--b', port: 80 } })).json().code, 'share.invalid_label');
        assert.strictEqual((await t.get('/api/v1/shares', { as: alex, json: { label: 'agents', port: 80 } })).json().code, 'share.taken');
        assert.strictEqual((await t.get('/api/v1/shares', { as: alex, json: { label: 'x', port: 70000 } })).json().code, 'share.invalid_port');
        const everyone = await t.get('/api/v1/shares', { as: alex, json: { label: 'open', port: 80, mode: 'signin' } });
        assert.strictEqual(everyone.status, 403, '"anyone signed in" is staff-only until the abuse check');
        assert.strictEqual(everyone.json().code, 'share.signin_not_yet');
        const staff = t.network.addUser('ops', { role: 'admin' });
        const ok = await t.get('/api/v1/shares', { as: staff, json: { label: 'open', port: 80, mode: 'signin' } });
        assert.strictEqual(ok.status, 201, ok.text);
    });

    await check('the gate: a browser goes to the grant, a script gets 401 with where to sign in', async () => {
        const r = await t.share(made.share.host, '/hello?x=1');
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, `https://connect.openvibe.website/grant?share=${made.share.id}&next=${encodeURIComponent('/hello?x=1')}`);
        assert.strictEqual(r.headers['cloudflare-cdn-cache-control'], 'no-store');
        const api = await t.share(made.share.host, '/data.json', { headers: { accept: 'application/json' } });
        assert.strictEqual(api.status, 401);
        assert.strictEqual(api.json().error, 'sign_in_required');
    });

    await check('the grant: signed out → sign in first; the owner gets a one-time code; the callback sets a host-only cookie', async () => {
        const anon = await t.get(`/grant?share=${made.share.id}&next=/hello`);
        assert.strictEqual(anon.status, 303);
        assert.match(anon.headers.get('location'), /^\/auth\/login\?next=/);
        const e = await t.enter(alex, made.share, '/hello');
        assert.strictEqual(e.status, 303);
        assert.strictEqual(e.location, '/hello');
        assert.match(e.setCookie, /^ovc=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/, 'host-only: no Domain attribute');
        alexCookie = e.cookie;
    });

    await check('a code works once, and only on its own share', async () => {
        const g = await t.get(`/grant?share=${made.share.id}&next=/`, { as: alex });
        const loc = new URL(g.headers.get('location'));
        const first = await t.share(made.share.host, `${loc.pathname}${loc.search}`);
        assert.strictEqual(first.status, 303);
        const again = await t.share(made.share.host, `${loc.pathname}${loc.search}`);
        assert.strictEqual(again.status, 400, 'used once');
        const other = await t.makeShare(alex, { label: 'other', port: app.port });
        const g2 = await t.get(`/grant?share=${made.share.id}&next=/`, { as: alex });
        const loc2 = new URL(g2.headers.get('location'));
        assert.strictEqual((await t.share(other.share.host, `${loc2.pathname}${loc2.search}`)).status, 400, 'bound to its share');
        await t.get(`/api/v1/shares/${other.share.id}`, { as: alex, method: 'DELETE' });
    });

    await check('nothing connected: the visitor is told the computer is not connected', async () => {
        const r = await t.share(made.share.host, '/', { cookie: alexCookie });
        assert.strictEqual(r.status, 502);
        assert.match(r.text, /computer is not connected/);
    });

    await check('the client connects with its key and the share answers from the local app', async () => {
        c = t.client({ key: made.key, port: app.port });
        const ready = await c.ready();
        assert.strictEqual(ready.host, made.share.host);
        const r = await t.share(made.share.host, '/hello?x=1', { cookie: `${alexCookie}; theirs=1`, headers: { accept: 'application/json', 'x-openvibe-user': 'mallory', 'x-forwarded-host': 'evil--x.openvibe.website' } });
        assert.strictEqual(r.status, 200, r.text);
        const b = r.json();
        assert.strictEqual(b.url, '/hello?x=1');
        assert.strictEqual(b.user, 'Alex_Dev', 'the app is told who, and a visitor cannot say it');
        assert.strictEqual(b.host, `localhost:${app.port}`);
        assert.strictEqual(b.cookie, 'theirs=1', 'the gate\'s cookie never reaches the app');
        const seen = app.seen[app.seen.length - 1].headers;
        assert.strictEqual(seen['x-forwarded-host'], made.share.host, 'the share\'s host, never the visitor\'s header');
        assert.strictEqual(seen['x-openvibe-subject'], alex.subject);
        assert.strictEqual(r.headers['x-app'], 'yes');
        assert.strictEqual(r.headers['x-robots-tag'], 'noindex, nofollow');
        assert.strictEqual(r.headers['cloudflare-cdn-cache-control'], 'no-store');
        assert.match(r.headers['cache-control'], /private/);
    });

    await check('a request body goes through', async () => {
        const r = await t.share(made.share.host, '/post', { method: 'POST', cookie: alexCookie, headers: { accept: 'application/json', 'content-type': 'text/plain' }, body: 'hello from the phone' });
        assert.strictEqual(r.json().body, 'hello from the phone');
        assert.strictEqual(r.json().method, 'POST');
    });

    await check('server-sent events stream as they come', async () => {
        const times = [];
        const r = await t.share(made.share.host, '/sse', { cookie: alexCookie, headers: { accept: 'text/event-stream' }, onResponse: (res) => res.on('data', () => times.push(Date.now())) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers['content-type'], 'text/event-stream');
        assert.match(r.text, /data: tick 1\n\ndata: tick 2\n\ndata: tick 3/);
        assert.ok(times.length >= 2, 'more than one piece arrived');
    });

    await check('a 3 MB response arrives whole', async () => {
        const r = await t.share(made.share.host, '/big', { cookie: alexCookie, headers: { accept: '*/*' } });
        assert.strictEqual(r.buffer.length, 3 * 1024 * 1024);
        assert.ok(r.buffer.every((x) => x === 7));
    });

    await check('a Set-Cookie loses its Domain, and the app cannot set the gate\'s own cookie', async () => {
        const r = await t.share(made.share.host, '/cookie', { cookie: alexCookie, headers: { accept: '*/*' } });
        const set = [].concat(r.headers['set-cookie'] || []);
        assert.deepStrictEqual(set, ['app=1; Path=/']);
        assert.strictEqual(r.headers['cache-control'], 'private, max-age=600', 'public turned private: nothing past the gate is cached by a CDN');
    });

    await check('a WebSocket-style upgrade is a byte pipe to the local app, after the gate', async () => {
        const reply = await new Promise((resolve, reject) => {
            const s = net.connect(t.port, '127.0.0.1', () => {
                s.write(`GET /ws HTTP/1.1\r\nHost: ${made.share.host}\r\nConnection: Upgrade\r\nUpgrade: echo\r\nCookie: ${alexCookie}\r\n\r\n`);
            });
            let got = '';
            s.on('data', (d) => {
                got += d.toString();
                if (got.includes('\r\n\r\n') && !got.includes('echo:')) s.write('ping');
                if (got.includes('echo:ping')) { s.destroy(); resolve(got); }
            });
            s.on('error', reject);
            setTimeout(() => reject(new Error(`no echo: ${JSON.stringify(got)}`)), 3000);
        });
        assert.match(reply, /^HTTP\/1\.1 101/);
        const up = app.seen.find((x) => x.upgrade);
        assert.strictEqual(up.headers.host, `localhost:${app.port}`);
        assert.ok(!String(up.headers.cookie || '').includes('ovc='));
        const anon = await new Promise((resolve) => {
            const s = net.connect(t.port, '127.0.0.1', () => s.write(`GET /ws HTTP/1.1\r\nHost: ${made.share.host}\r\nConnection: Upgrade\r\nUpgrade: echo\r\nAccept: application/json\r\n\r\n`));
            let got = '';
            s.on('data', (d) => { got += d; });
            s.on('close', () => resolve(got));
        });
        assert.match(anon, /^HTTP\/1\.1 401/, 'no cookie, no pipe');
    });

    await check('who can open it: bob is turned away, then named; changing it signs everyone out of the share', async () => {
        const denied = await t.enter(bob, made.share);
        assert.strictEqual(denied.status, 403);
        assert.match(denied.grant.text, /You can.t open/);
        const patched = await t.get(`/api/v1/shares/${made.share.id}`, { as: alex, method: 'PATCH', json: { mode: 'named', named: ['Bob'] } });
        assert.strictEqual(patched.status, 200, patched.text);
        assert.deepStrictEqual(patched.json().share.named, ['bob']);
        assert.strictEqual(patched.json().share.policy_version, made.share.policy_version + 1);
        const stale = await t.share(made.share.host, '/', { cookie: alexCookie });
        assert.strictEqual(stale.status, 302, 'the old cookie no longer opens it');
        const inBob = await t.enter(bob, made.share);
        assert.strictEqual(inBob.status, 303);
        const r = await t.share(made.share.host, '/', { cookie: inBob.cookie, headers: { accept: 'application/json' } });
        assert.strictEqual(r.json().user, 'bob');
        alexCookie = (await t.enter(alex, made.share)).cookie;
    });

    await check('a cookie that was tampered with or made for another share does not open it', async () => {
        const [data, sig] = alexCookie.slice(4).split('.');
        const claims = JSON.parse(Buffer.from(data, 'base64url').toString());
        claims.u = bob.subject;
        const forged = `ovc=${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
        assert.strictEqual((await t.share(made.share.host, '/', { cookie: forged })).status, 302);
    });

    await check('nothing listening on the port: the visitor is told so', async () => {
        const dead = await t.makeShare(alex, { label: 'dead', port: 9 });
        const cDead = t.client({ key: dead.key, port: 9 });
        await cDead.ready();
        const cookie = (await t.enter(alex, dead.share)).cookie;
        const r = await t.share(dead.share.host, '/', { cookie });
        assert.strictEqual(r.status, 502);
        assert.match(r.text, /nothing answered on port 9/);
        cDead.stop();
    });

    await check('a wrong key is refused and the client stops', async () => {
        const bad = t.client({ key: `ovc_${'A'.repeat(43)}`, port: app.port });
        await until(() => bad.lines.some((l) => /Stopped/.test(l)));
        assert.ok(bad.lines.some((l) => /not one we know/.test(l)));
    });

    await check('a new key disconnects the computer and the old key stops working', async () => {
        const r = await t.get(`/api/v1/shares/${made.share.id}/key`, { as: alex, method: 'POST' });
        assert.strictEqual(r.status, 200);
        const fresh = r.json().key;
        assert.notStrictEqual(fresh, made.key);
        await until(() => c.lines.some((l) => /Stopped/.test(l)));
        assert.strictEqual(t.ctx.tunnels.isConnected(made.share.id), false);
        const old = t.client({ key: made.key, port: app.port });
        await until(() => old.lines.some((l) => /Stopped/.test(l)));
        c = t.client({ key: fresh, port: app.port });
        await c.ready();
        assert.strictEqual(t.ctx.tunnels.isConnected(made.share.id), true);
    });

    await check('a second client for the same share takes over; the first stops', async () => {
        const key = (await t.get(`/api/v1/shares/${made.share.id}/key`, { as: alex, method: 'POST' })).json().key;
        const first = t.client({ key, port: app.port });
        await first.ready();
        const second = t.client({ key, port: app.port });
        await second.ready();
        await until(() => first.lines.some((l) => /took over/.test(l)));
        const r = await t.share(made.share.host, '/', { cookie: alexCookie, headers: { accept: 'application/json' } });
        assert.strictEqual(r.status, 200);
        c = second;
    });

    await check('the counters: requests, bytes and who opened it reach the share page', async () => {
        await t.ctx.proxy.flush();
        const s = (await t.get(`/api/v1/shares/${made.share.id}`, { as: alex })).json().share;
        assert.ok(s.requests >= 6, `requests ${s.requests}`);
        assert.ok(s.bytes_out >= 3 * 1024 * 1024);
        const v = (await t.get(`/api/v1/shares/${made.share.id}/visits`, { as: alex })).json().visits;
        const names = v.map((x) => x.username).sort();
        assert.deepStrictEqual(names, ['Alex_Dev', 'bob']);
        assert.ok(v.find((x) => x.username === 'bob').denied >= 1, 'bob was turned away once');
        assert.strictEqual(s.connected, true);
    });

    await check('another person cannot see, change or close someone else\'s share', async () => {
        assert.strictEqual((await t.get(`/api/v1/shares/${made.share.id}`, { as: bob })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/shares/${made.share.id}`, { as: bob, method: 'DELETE' })).status, 404);
        assert.strictEqual((await t.get(`/shares/${made.share.id}`, { as: bob })).status, 404);
    });

    await check('closing: the computer is disconnected and the address answers 410; nobody else can take it', async () => {
        const r = await t.get(`/api/v1/shares/${made.share.id}`, { as: alex, method: 'DELETE' });
        assert.strictEqual(r.json().share.status, 'revoked');
        await until(() => !t.ctx.tunnels.isConnected(made.share.id));
        const gone = await t.share(made.share.host, '/', { cookie: alexCookie });
        assert.strictEqual(gone.status, 410);
        assert.match(gone.text, /closed/);
        const again = await t.get('/api/v1/shares', { as: alex, json: { label: 'agents', port: app.port } });
        assert.strictEqual(again.status, 201, 'the owner may reuse their own address');
    });

    await check('a host that is not a share\'s, or a share that does not exist, says so', async () => {
        assert.strictEqual((await t.share('nobody--here.openvibe.website', '/')).status, 404);
        const page = await t.get('/', { headers: { host: 'connect.openvibe.website' } });
        assert.strictEqual(page.status, 200);
    });

    await t.close();
    await app.close();
    done();
})();
