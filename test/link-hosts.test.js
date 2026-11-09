'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { boot, startLocalApp } = require('./helpers/boot');
const { check, done } = require('./helpers/check');

function upgrade(t, host, cookie) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(t.port, '127.0.0.1');
        let data = '';
        socket.setTimeout(3000, () => socket.destroy(new Error('upgrade timed out')));
        socket.on('error', reject);
        socket.on('connect', () => socket.write(`GET /ws?keep=1 HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: echo\r\nCookie: ${cookie}\r\n\r\n`));
        socket.on('data', (chunk) => { data += chunk.toString(); if (data.includes('\r\n\r\n')) { socket.destroy(); resolve(data); } });
    });
}

(async () => {
    const t = await boot({ env: { CONNECT_SHARE_DOMAIN: null, COOKIE_SECURE: 'true' } });
    const app = await startLocalApp();
    const alex = t.network.addUser('alex');
    let made, old, cookies = {};
    try {
        await check('new shares advertise Link; pre-existing Website rows keep their ID, key and both names', async () => {
            made = await t.makeShare(alex, { label: 'portal', port: app.port });
            assert.equal(made.share.host, 'portal--alex.openvibe.link');
            old = made.share.host.replace('.link', '.website');
            await t.ctx.s.db.exec('UPDATE shares SET host = $1 WHERE id = $2', [old, made.share.id]);
            for (const host of [old, made.share.host]) assert.equal((await t.ctx.shares.byHost(host)).id, made.share.id);
            assert.equal((await t.ctx.shares.byKey(made.key)).url, made.share.url);
            assert.equal((await t.get('/api/v1/shares', { as: alex })).json().shares[0].host, made.share.host);
            const duplicate = await t.get('/api/v1/shares', { as: alex, json: { label: 'portal', port: app.port } });
            assert.equal(duplicate.status, 409);
            const c = t.client({ key: made.key, port: app.port });
            await c.ready();
        });
        await check('each alias uses Network sign-in and receives a Secure host-only cookie, bound to that host', async () => {
            for (const host of [made.share.host, old]) {
                const gate = await t.share(host, '/deep/path?q=1');
                assert.equal(gate.status, 302);
                const g = new URL(gate.headers.location);
                const grant = await t.get(g.pathname + g.search, { as: alex });
                const cb = new URL(grant.headers.get('location'));
                assert.equal(cb.hostname, host);
                const entered = await t.share(host, cb.pathname + cb.search);
                assert.equal(entered.status, 303);
                assert.equal(entered.headers.location, '/deep/path?q=1');
                const cookie = entered.headers['set-cookie'][0];
                assert.match(cookie, /^__Host-ovc=/); assert.match(cookie, /; Secure/); assert.doesNotMatch(cookie, /domain=/i);
                cookies[host] = cookie.split(';')[0];
                assert.equal((await t.share(host, '/hello', { cookie: cookies[host] })).status, 200);
            }
            assert.equal((await t.share(old, '/', { cookie: cookies[made.share.host] })).status, 302);
            assert.equal((await t.share(made.share.host, '/', { cookie: cookies[old] })).status, 302);
            const other = await t.makeShare(alex, { label: 'other', port: app.port });
            assert.equal((await t.share(other.share.host, '/', { cookie: cookies[made.share.host] })).status, 302);
        });
        await check('grant codes cannot cross aliases and arbitrary return hosts are refused', async () => {
            const grant = await t.get(`/grant?share=${made.share.id}`, { as: alex });
            const cb = new URL(grant.headers.get('location'));
            assert.equal((await t.share(old, cb.pathname + cb.search)).status, 400);
            assert.equal((await t.share(made.share.host, cb.pathname + cb.search)).status, 400, 'attempt spends code');
            assert.equal((await t.get(`/grant?share=${made.share.id}&host=evil.example`, { as: alex })).status, 400);
        });
        await check('HTTP, SSE and WebSocket upgrades use the same tunnel on both hosts', async () => {
            for (const host of [made.share.host, old]) {
                const cookie = cookies[host];
                const post = await t.share(host, '/echo?x=1', { cookie, method: 'POST', body: 'hello' });
                assert.equal(post.json().body, 'hello');
                assert.equal(app.seen.at(-1).headers['x-forwarded-host'], host);
                assert.match((await t.share(host, '/sse', { cookie })).text, /tick 3/);
                assert.match(await upgrade(t, host, cookie), /^HTTP\/1.1 101/);
                const response = await t.share(host, '/cookie', { cookie });
                assert.doesNotMatch(response.headers['set-cookie'].join(';'), /domain=|__Host-ovc=/i);
                assert.equal(response.headers['cloudflare-cdn-cache-control'], 'no-store');
                assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
                assert.equal(response.headers['x-frame-options'], 'DENY');
            }
        });
        await check('MCP metadata and bearer-token audience stay on the requesting share host', async () => {
            const oauth = t.ctx.oauth;
            const client = await oauth.register({ client_name: 'test', redirect_uris: ['http://localhost/callback'] });
            const verifier = 'a'.repeat(43);
            const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
            const share = await oauth.shareFor(`https://${old}`);
            const c = await oauth.client(client.client_id);
            const code = oauth.issueCode({ client: c, share, viewer: alex, redirectUri: 'http://localhost/callback', challenge });
            const token = await oauth.token({ grant_type: 'authorization_code', code, client_id: c.id, redirect_uri: 'http://localhost/callback', code_verifier: verifier });
            assert.ok(await oauth.check({ ...made.share, host: old }, token.access_token));
            assert.equal(await oauth.check(made.share, token.access_token), null);
            assert.equal(await oauth.shareFor(`https://${old}:8443/`), null);
            assert.equal(await oauth.shareFor(`https://person@${old}/`), null);
            await assert.rejects(() => oauth.token({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: c.id, resource: made.share.url }), /resource/);
            for (const host of [old, made.share.host]) assert.equal((await t.share(host, '/.well-known/oauth-protected-resource')).json().resource, `https://${host}`);
        });
        await check('both node audiences work; unrelated audiences do not', async () => {
            const node = t.network.addNode(alex);
            for (const aud of ['openvibe.website', 'openvibe.link']) assert.equal((await t.ctx.linkAuth.verify(t.network.linkToken(node, { aud }))).ok, true);
            assert.equal((await t.ctx.linkAuth.verify(t.network.linkToken(node, { aud: 'openvibe.network' }))).ok, false);
        });
        await check('redirects are opt-in, preserve the path/query, and cover upgrades without forwarding cookies', async () => {
            assert.equal(t.config.shares.redirectLegacy, false);
            t.config.shares.redirectLegacy = true;
            const r = await t.share(old, '/a%20b?x=1&y=2', { cookie: cookies[old] });
            assert.equal(r.status, 302); assert.equal(r.headers.location, `${made.share.url}/a%20b?x=1&y=2`);
            assert.equal(r.headers['set-cookie'], undefined);
            assert.match(await upgrade(t, old, cookies[old]), /^HTTP\/1.1 302/);
            assert.equal((await t.share(made.share.host, '/', { cookie: cookies[made.share.host] })).status, 200);
        });
        await check('revocation invalidates both aliases immediately', async () => {
            t.config.shares.redirectLegacy = false;
            assert.equal((await t.get(`/api/v1/shares/${made.share.id}`, { as: alex, method: 'DELETE' })).status, 200);
            for (const host of [old, made.share.host]) assert.equal((await t.share(host, '/', { cookie: cookies[host] })).status, 410);
        });
    } finally { await t.close(); await app.close(); }
    await check('new control origin uses its exact callback and host-only SSO; old control pages redirect', async () => {
        const n = await boot({ env: { BASE_URL: 'https://connect.openvibe.link', CONNECT_SHARE_DOMAIN: null, COOKIE_SECURE: 'true' } });
        try {
            const user = n.network.addUser('kim');
            const old = await n.share('connect.openvibe.website', '/auth/login?next=%2Fshares');
            assert.equal(old.status, 302);
            assert.equal(old.headers.location, 'https://connect.openvibe.link/auth/login?next=%2Fshares');
            // Machines are not redirected: a webhook, an API call and agent discovery answer on the old name.
            for (const [method, path] of [['POST', '/h/hk_missing'], ['GET', '/api/v1/shares'], ['GET', '/.well-known/agent.json'], ['POST', '/oauth/token']]) {
                const r = await n.share('connect.openvibe.website', path, { method });
                assert.notEqual(r.status, 302, `${method} ${path} on the old control host must not redirect`);
            }
            const login = await n.share('connect.openvibe.link', '/auth/login?next=%2Fshares');
            const authorize = new URL(login.headers.location);
            assert.equal(authorize.searchParams.get('redirect_uri'), 'https://connect.openvibe.link/auth/callback');
            const code = n.network.issueCode(user, authorize.searchParams.get('code_challenge'));
            const cookie = login.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
            const callback = await n.share('connect.openvibe.link', `/auth/callback?code=${code}&state=${authorize.searchParams.get('state')}`, { cookie });
            assert.equal(callback.status, 302);
            assert.equal(callback.headers.location, '/shares');
            assert.ok(callback.headers['set-cookie'].some(c => c.startsWith('ov_token=')));
            for (const c of callback.headers['set-cookie']) assert.doesNotMatch(c, /domain=/i);
            const share = await n.makeShare(user, { label: 'tunnel', port: 9000 });
            for (const host of ['connect.openvibe.website', 'connect.openvibe.link']) {
                const WebSocket = require('ws');
                const ws = new WebSocket(`ws://127.0.0.1:${n.port}/tunnel`, { headers: { Host: host } });
                try {
                    const ready = await new Promise((resolve, reject) => {
                        ws.on('error', reject);
                        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, key: share.key, port: 9000 })));
                        ws.on('message', d => resolve(JSON.parse(String(d))));
                    });
                    assert.equal(ready.t, 'ready');
                    assert.equal(ready.share.host, share.share.host);
                } finally { ws.terminate(); }
            }
        } finally { await n.close(); }
    });
    done();
})();
