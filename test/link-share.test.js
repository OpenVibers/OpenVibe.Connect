'use strict';
/**
 * A share served by one of its owner's computers, as OpenVibe Link (CON-4, ADR-057 decision 4): the owner picks the
 * computer from their machines on Network; the computer asks for a tunnel token with its node token and says hello with
 * both; a visitor's request reaches it; it sends a fresh node token before the old one runs out, and a tunnel whose token
 * ran out is closed. Every refusal: another person's computer, a token for another audience, a spent or late tunnel
 * token, a share it does not serve, the key once a computer serves it.
 *   node test/link-share.test.js
 */
const assert = require('assert');
const WebSocket = require('ws');
const { boot } = require('./helpers/boot');
const { check, done } = require('./helpers/check');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A computer's tunnel: hello with its two credentials, and an answer to every request ("from node <path>"). */
function linkTunnel(t, hello) {
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/tunnel`);
    const frames = [];
    const waiters = [];
    let closed = null;
    ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(String(data));
        frames.push(m);
        if (m.t === 'req') {
            ws.send(JSON.stringify({ t: 'res', id: m.id, status: 200, headers: [['content-type', 'text/plain']] }));
            const head = Buffer.alloc(5); head[0] = 1; head.writeUInt32BE(m.id, 1);
            ws.send(Buffer.concat([head, Buffer.from(`from node ${m.path}`)]));
            const end = Buffer.alloc(5); end[0] = 2; end.writeUInt32BE(m.id, 1);
            ws.send(end);
        }
        waiters.splice(0).forEach((w) => w());
    });
    const closedP = new Promise((resolve) => ws.on('close', (code, reason) => { closed = { code, reason: String(reason) }; resolve(closed); waiters.splice(0).forEach((w) => w()); }));
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, client: 'openvibe-link/test', port: 1234, ...hello })));
    async function next(type, ms = 3000) {
        const end = Date.now() + ms;
        for (;;) {
            const f = frames.find((x) => x.t === type);
            if (f) { frames.splice(frames.indexOf(f), 1); return f; }
            if (closed) return null;
            if (Date.now() > end) throw new Error(`no ${type} frame`);
            await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
        }
    }
    return { ws, next, closed: () => closedP, frames };
}

(async () => {
    const t = await boot();
    const alex = t.network.addUser('alex');
    const bob = t.network.addUser('bob');
    const desk = t.network.addNode(alex, { name: 'Desk PC' });
    const gone = t.network.addNode(alex, { name: 'Old laptop', status: 'revoked' });
    const bobs = t.network.addNode(bob, { name: 'Bob box' });
    let made;
    let ticket;

    await check('the owner sees their active computers, and only theirs', async () => {
        made = await t.makeShare(alex, { label: 'portal', port: 8790 });
        const r = await t.get('/api/v1/machines', { as: alex });
        assert.strictEqual(r.status, 200, r.text);
        const m = r.json().machines;
        assert.deepStrictEqual(m.map((x) => [x.id, x.name]), [[desk.id, 'Desk PC']], 'a revoked machine and Bob\'s are left out');
        const page = await t.get(`/shares/${made.share.id}`, { as: alex });
        assert.match(page.text, /Serve it from this computer/);
        assert.match(page.text, /Desk PC/);
        assert.doesNotMatch(page.text, /Old laptop|Bob box/);
    });

    await check('binding: only one of the owner\'s active computers; the key stops working at once', async () => {
        for (const bad of [bobs.id, gone.id, 'lnk_01M6FCPA3HCE14MFEM40HQ7VDJ']) {
            const r = await t.get(`/api/v1/shares/${made.share.id}/node`, { as: alex, method: 'PUT', json: { node: bad } });
            assert.strictEqual(r.status, 404, `${bad}: ${r.text}`);
        }
        const other = await t.get(`/api/v1/shares/${made.share.id}/node`, { as: bob, method: 'PUT', json: { node: bobs.id } });
        assert.strictEqual(other.status, 404, 'not Bob\'s share');
        const c = t.client({ key: made.key, port: 8790 });
        await c.ready();
        const r = await t.get(`/api/v1/shares/${made.share.id}/node`, { as: alex, method: 'PUT', json: { node: desk.id } });
        assert.strictEqual(r.status, 200, r.text);
        const s = r.json().share;
        assert.deepStrictEqual(s.node, { id: desk.id, name: 'Desk PC' });
        assert.strictEqual(s.key_prefix, null, 'no key to show');
        await sleep(100);
        assert.strictEqual(t.ctx.tunnels.isConnected(made.share.id), false, 'the key\'s computer was disconnected');
        c.stop();
        const k = linkTunnel(t, { key: made.key });
        const closed = await k.closed();
        assert.strictEqual(closed.code, 4002, 'the key no longer opens it');
    });

    await check('the computer: its shares and a tunnel token, only with its own node token for openvibe.website', async () => {
        const list = await t.get('/api/v1/link/shares', { bearer: t.network.linkToken(desk) });
        assert.strictEqual(list.status, 200, list.text);
        assert.deepStrictEqual(list.json().shares.map((x) => [x.id, x.local_port]), [[made.share.id, 8790]]);
        assert.strictEqual((await t.get('/api/v1/link/shares')).status, 401, 'no token');
        assert.strictEqual((await t.get('/api/v1/link/shares', { bearer: t.network.userToken(alex) })).status, 401, 'a person\'s token is not a computer\'s');
        assert.strictEqual((await t.get('/api/v1/link/shares', { bearer: t.network.linkToken(desk, { aud: 'openvibe.bot' }) })).status, 401, 'another audience');
        assert.strictEqual((await t.get('/api/v1/link/shares', { bearer: t.network.linkToken(desk, { iat: Math.floor(Date.now() / 1000) - 1000 }) })).status, 401, 'expired');
        assert.strictEqual((await t.get('/api/v1/link/shares', { bearer: t.network.linkToken(desk, { sub: 'svc:bot' }) })).status, 401, 'a service is not a computer');
        const bobList = await t.get('/api/v1/link/shares', { bearer: t.network.linkToken(bobs) });
        assert.deepStrictEqual(bobList.json().shares, [], 'Bob\'s computer serves nothing of Alex\'s');
        const no = await t.get(`/api/v1/link/shares/${made.share.id}/tunnel-token`, { method: 'POST', bearer: t.network.linkToken(bobs) });
        assert.strictEqual(no.status, 404, 'another computer gets no tunnel token');
        const r = await t.get(`/api/v1/link/shares/${made.share.id}/tunnel-token`, { method: 'POST', bearer: t.network.linkToken(desk) });
        assert.strictEqual(r.status, 200, r.text);
        ticket = r.json();
        assert.match(ticket.tunnel_token, /^ovt_[A-Za-z0-9_-]{43}$/);
        assert.strictEqual(ticket.expires_in, 60);
        assert.ok(!t.logs().includes(ticket.tunnel_token), 'never logged');
    });

    await check('hello with both: ready, and a visitor\'s request reaches the computer', async () => {
        const n = linkTunnel(t, { share: made.share.id, link_token: t.network.linkToken(desk), tunnel: ticket.tunnel_token });
        const ready = await n.next('ready');
        assert.ok(ready, 'ready');
        assert.strictEqual(ready.node, true);
        assert.strictEqual(ready.share.local_port, 8790);
        assert.ok(t.ctx.tunnels.isConnected(made.share.id));
        const visitor = await t.enter(alex, made.share);
        const page = await t.share(made.share.host, '/hello', { cookie: visitor.cookie });
        assert.strictEqual(page.status, 200, page.text);
        assert.strictEqual(page.text, 'from node /hello');
        const html = await t.get(`/shares/${made.share.id}`, { as: alex });
        assert.match(html.text, /Your computer serves it/);
        assert.match(html.text, /openvibe-link share --share shr_/);
        n.ws.close();
        await n.closed();
    });

    await check('a tunnel token is spent by any try, and is for one share and one computer', async () => {
        const fresh = async (node) => (await t.get(`/api/v1/link/shares/${made.share.id}/tunnel-token`, { method: 'POST', bearer: t.network.linkToken(node) })).json().tunnel_token;
        const again = linkTunnel(t, { share: made.share.id, link_token: t.network.linkToken(desk), tunnel: ticket.tunnel_token });
        assert.strictEqual((await again.closed()).code, 4000, 'spent: ask again');
        const tok = await fresh(desk);
        const wrong = linkTunnel(t, { share: made.share.id, link_token: t.network.linkToken(bobs), tunnel: tok });
        assert.strictEqual((await wrong.closed()).code, 4003, 'Bob\'s computer does not serve it');
        const after = linkTunnel(t, { share: made.share.id, link_token: t.network.linkToken(desk), tunnel: tok });
        assert.strictEqual((await after.closed()).code, 4000, 'and the try spent it');
        const bad = linkTunnel(t, { share: made.share.id, link_token: t.network.linkToken(desk, { aud: 'openvibe.network' }), tunnel: await fresh(desk) });
        assert.strictEqual((await bad.closed()).code, 4002, 'a node token for Network is refused: the computer stops');
        assert.strictEqual(t.ctx.linkAuth.pending(), 1, 'the unused one waits; nothing else is kept');
    });

    await check('reauth: a fresh token keeps it open; another computer\'s token closes it; a token that ran out closes it', async () => {
        const tok = (await t.get(`/api/v1/link/shares/${made.share.id}/tunnel-token`, { method: 'POST', bearer: t.network.linkToken(desk) })).json().tunnel_token;
        const n = linkTunnel(t, { share: made.share.id, link_token: t.network.linkToken(desk, { ttl: 2 }), tunnel: tok });
        await n.next('ready');
        n.ws.send(JSON.stringify({ t: 'reauth', link_token: t.network.linkToken(desk) }));
        const ok = await n.next('reauthed');
        assert.ok(ok && Date.parse(ok.until) > Date.now() + 200_000, 'until moves on');
        n.ws.send(JSON.stringify({ t: 'reauth', link_token: t.network.linkToken(bobs) }));
        assert.strictEqual((await n.closed()).code, 4002);

        const tok2 = (await t.get(`/api/v1/link/shares/${made.share.id}/tunnel-token`, { method: 'POST', bearer: t.network.linkToken(desk) })).json().tunnel_token;
        const m = linkTunnel(t, { share: made.share.id, link_token: t.network.linkToken(desk), tunnel: tok2 });
        await m.next('ready');
        const live = t.ctx.tunnels.get(made.share.id);
        live.authUntil = Date.now() - 60_000;   // its token ran out a minute ago and no reauth came
        t.ctx.tunnels.sweep();
        assert.strictEqual((await m.closed()).code, 4000, 'closed; the computer reconnects with a fresh token');
    });

    await check('letting the computer go: a new key (shown once) serves it again; the computer no longer can', async () => {
        const page = await t.get(`/shares/${made.share.id}/node`, { as: alex, form: { node: '' }, method: 'POST' });
        assert.strictEqual(page.status, 200, page.text);
        const key = /<code id="cn-key-v">(ovc_[A-Za-z0-9_-]{43})<\/code>/.exec(page.text);
        assert.ok(key, 'the new key is shown once');
        const s = (await t.get(`/api/v1/shares/${made.share.id}`, { as: alex })).json().share;
        assert.strictEqual(s.node, null);
        const r = await t.get(`/api/v1/link/shares/${made.share.id}/tunnel-token`, { method: 'POST', bearer: t.network.linkToken(desk) });
        assert.strictEqual(r.status, 404);
        const c = t.client({ key: key[1], port: 8790 });
        await c.ready();
        assert.ok(t.ctx.tunnels.isConnected(made.share.id), 'the key works again');
        c.stop();
    });

    await check('binding from the page: a plain form, then the commands for that computer', async () => {
        const r = await t.get(`/shares/${made.share.id}/node`, { as: alex, form: { node: desk.id }, method: 'POST' });
        assert.strictEqual(r.status, 303, r.text);
        const page = await t.get(r.headers.get('location'), { as: alex });
        assert.match(page.text, /Desk PC serves it now/);
        assert.match(page.text, /sudo openvibe-link share add --share/);
        const cross = await t.get(`/shares/${made.share.id}/node`, { as: alex, form: { node: desk.id }, method: 'POST', origin: 'https://evil.example' });
        assert.strictEqual(cross.status, 403, 'another site cannot bind it');
    });

    await check('a computer that Network cannot list for its owner just now: the page says so, nothing changes', async () => {
        t.network.setDown(true);
        try {
            const page = await t.get(`/shares/${made.share.id}/node`, { as: alex, form: { node: desk.id }, method: 'POST' });
            assert.strictEqual(page.status, 503);
            assert.match(page.text, /could not be read from OpenVibe just now/);
        } finally { t.network.setDown(false); }
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
