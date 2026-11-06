'use strict';
/**
 * Hooks that wait for your computer (CON-15): a webhook address on a share, a provider's webhook kept with only the
 * provider's headers and its pointer in the outbox (one transaction), Events' signed delivery handed to the computer
 * once it is connected (503 while it is not, so Events retries), once only, and the sweep after 72 hours.
 *   node test/hooks.test.js
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { keepHeaders } = require('../server/hooks');
const { boot, startLocalApp } = require('./helpers/boot');
const { check, done } = require('./helpers/check');

const SECRET = 'hook-delivery-secret-0123456789abcdef';

(async () => {
    const t = await boot({ env: { CONNECT_EVENTS_SECRET: SECRET } });
    const app = await startLocalApp();
    const alex = t.network.addUser('alex');
    const bob = t.network.addUser('bob');
    const made = await t.makeShare(alex, { label: 'bot', port: app.port });
    let hook;
    let envelope;

    const settled = async (ref) => {
        for (let i = 0; i < 200; i++) {
            const row = await t.ctx.s.db.maybe('SELECT delivered_at FROM hook_requests WHERE id = $1', [ref]);
            if (!row || row.delivered_at) return true;
            await new Promise((r) => setTimeout(r, 10));
        }
        return false;
    };

    const deliver = async (env, secret = SECRET) => {
        const raw = Buffer.from(JSON.stringify({ event: env }));
        const headers = { 'content-type': 'application/json', ...signDeliveryHeaders(raw, secret), 'x-openvibe-subscription-id': 'sub_x', 'x-openvibe-delivery-attempt': '1' };
        return t.get('/internal/hook-deliveries', { method: 'POST', body: raw, headers });
    };

    await check('the owner makes a webhook address: a path on the app, at most ten, never on another person\'s share', async () => {
        const r = await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex, json: { path: '/webhooks/github', label: 'GitHub pushes' } });
        assert.strictEqual(r.status, 201, r.text);
        hook = r.json().hook;
        assert.match(hook.url, /^https:\/\/connect\.openvibe\.website\/h\/hk_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(hook.local_path, '/webhooks/github');
        assert.strictEqual((await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex, json: { path: 'no-slash' } })).status, 422);
        assert.strictEqual((await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex, json: { path: '/a b' } })).status, 422);
        assert.strictEqual((await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: bob, json: { path: '/x' } })).status, 404);
        const list = await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex });
        assert.deepStrictEqual(list.json().hooks.map((h) => h.id), [hook.id]);
        const page = await t.get(`/shares/${made.share.id}`, { as: alex });
        assert.match(page.text, /Webhooks that wait for your computer/);
        assert.ok(page.text.includes(hook.url));
    });

    await check('a provider\'s webhook: 202, sealed, kept with its headers minus hop-by-hop and credentials, its pointer in the outbox', async () => {
        const body = JSON.stringify({ ref: 'refs/heads/main', commits: 3 });
        const r = await t.get(`/h/${hook.id}`, { method: 'POST', body, headers: {
            'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=abc',
            cookie: 'session=secret', 'x-forwarded-for': '203.0.113.9', authorization: 'Bearer nope', 'x-openvibe-user': 'mallory',
        } });
        assert.strictEqual(r.status, 202, r.text);
        const ref = r.json().id;
        assert.match(ref, /^hb_/);
        const row = await t.ctx.s.db.one('SELECT method, headers, body, received_at, expires_at FROM hook_requests WHERE id = $1', [ref]);
        assert.strictEqual(row.method, 'POST');
        const kept = t.ctx.hooks.request(ref);
        assert.strictEqual((await kept).body.toString(), body, 'the body is there for the computer, not for the database');
        assert.ok(!Buffer.from(row.body).toString().includes('refs/heads/main'), 'the body is sealed at rest');
        assert.match(Buffer.from(row.body).subarray(0, 4).toString(), /^OVC1$/);
        const names = row.headers.map(([k]) => k);
        assert.ok(names.includes('x-github-event') && names.includes('x-hub-signature-256') && names.includes('content-type'), names.join(','));
        for (const gone of ['cookie', 'x-forwarded-for', 'authorization', 'x-openvibe-user']) {
            assert.ok(!names.includes(gone), `${gone} must not be kept: ${names.join(',')}`);
        }
        const hop = keepHeaders({ connection: 'keep-alive', te: 'trailers', 'proxy-authorization': 'Basic nope', upgrade: 'h2c', 'transfer-encoding': 'chunked', 'x-github-event': 'push' }).map(([k]) => k);
        assert.deepStrictEqual(hop, ['x-github-event'], 'hop-by-hop headers are dropped');
        const lifetime = await t.ctx.s.db.one('SELECT extract(epoch FROM expires_at - received_at)::int AS s FROM hook_requests WHERE id = $1', [ref]);
        assert.strictEqual(lifetime.s, 72 * 3600, 'kept for 72 hours');
        const out = await t.ctx.s.db.many("SELECT envelope FROM service_outbox WHERE envelope->>'event_type' = 'connect.hook.received'");
        assert.strictEqual(out.length, 1);
        envelope = out[0].envelope;
        assert.deepStrictEqual(Object.keys(envelope.payload).sort(), ['body_ref', 'content_type', 'hook_id', 'method', 'received_at', 'share_id', 'size']);
        assert.strictEqual(envelope.payload.body_ref, ref);
        assert.ok(!JSON.stringify(envelope).includes('refs/heads/main'), 'no body in the event');
        const v = contracts.validate('events.event-envelope@1', envelope);
        assert.ok(v.valid !== false, JSON.stringify(v.errors || v));
    });

    await check('the address takes POST, PUT and PATCH only; an unknown address is 404; more than 1 MB is refused', async () => {
        assert.strictEqual((await t.get(`/h/${hook.id}`)).status, 405);
        assert.strictEqual((await t.get('/h/hk_01K9ZZZZZZZZZZZZZZZZZZZZZZ', { method: 'POST', body: '{}' })).status, 404);
        const big = await t.get(`/h/${hook.id}`, { method: 'POST', body: Buffer.alloc(1024 * 1024 + 10, 97), headers: { 'content-type': 'application/octet-stream' } });
        assert.strictEqual(big.status, 413);
    });

    await check('Events\' delivery is 503 while the computer is offline; connecting hands it to the app at the hook\'s path, once', async () => {
        const off = await deliver(envelope);
        assert.strictEqual(off.status, 503, off.text);
        const before = app.seen.length;
        const c = t.client({ key: made.key, port: app.port });
        await c.ready();
        for (let i = 0; i < 100 && !app.seen.slice(before).some((x) => x.url === '/webhooks/github'); i++) await new Promise((r) => setTimeout(r, 20));
        const got = app.seen.slice(before).find((x) => x.url === '/webhooks/github');
        assert.ok(got, 'the app got it');
        assert.strictEqual(got.method, 'POST');
        assert.strictEqual(got.body, JSON.stringify({ ref: 'refs/heads/main', commits: 3 }));
        assert.strictEqual(got.headers['x-github-event'], 'push');
        assert.strictEqual(got.headers['x-hub-signature-256'], 'sha256=abc');
        assert.strictEqual(got.headers['x-openvibe-hook'], hook.id);
        assert.strictEqual(got.headers['x-openvibe-event-id'], envelope.event_id, 'the event\'s own id, whichever way it came');
        assert.strictEqual(got.headers['x-openvibe-received-at'], envelope.payload.received_at, 'the original arrival time');
        assert.strictEqual(got.headers.cookie, undefined);
        assert.ok(await settled(envelope.payload.body_ref), 'the delivery settles');
        const again = await deliver(envelope);
        assert.strictEqual(again.status, 200);
        assert.deepStrictEqual(again.json(), { gone: true }, 'delivered once');
        assert.strictEqual(app.seen.filter((x) => x.url === '/webhooks/github').length, 1);
        const kept = await t.ctx.s.db.one('SELECT length(body)::int AS n, status FROM hook_requests WHERE id = $1', [envelope.payload.body_ref]);
        assert.deepStrictEqual([kept.n, kept.status], [0, 200], 'its body is dropped once delivered');
        const h = (await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex })).json().hooks[0];
        assert.deepStrictEqual([h.received, h.delivered, h.last_status], [1, 1, 200]);
        assert.strictEqual(h.deliveries[0].status, 200, 'the owner sees the delivery');
        assert.strictEqual(h.deliveries[0].method, 'POST');
        assert.strictEqual(h.deliveries[0].path, '/webhooks/github');
        const log = await t.get(`/api/v1/shares/${made.share.id}/hooks/${hook.id}/deliveries`, { as: alex });
        assert.strictEqual(log.status, 200, log.text);
        assert.strictEqual(log.json().deliveries[0].status, 200);
        assert.strictEqual(log.json().deliveries[0].event_id, envelope.event_id);
        const page = await t.get(`/shares/${made.share.id}`, { as: alex });
        assert.match(page.text, /Delivery log/);
        c.stop();
    });

    await check('a delivery must be signed, from this machine; another event type is acknowledged and ignored', async () => {
        assert.strictEqual((await deliver(envelope, 'not-the-secret-0123456789abcdefgh')).status, 401);
        const other = await deliver({ ...envelope, event_type: 'connect.something.else' });
        assert.deepStrictEqual(other.json(), { ignored: true });
    });

    await check('removing the address: it answers 404 and its waiting webhooks are dropped', async () => {
        const w = await t.get(`/h/${hook.id}`, { method: 'POST', body: '{"n":2}', headers: { 'content-type': 'application/json' } });
        assert.strictEqual(w.status, 202);
        const r = await t.get(`/api/v1/shares/${made.share.id}/hooks/${hook.id}`, { as: alex, method: 'DELETE' });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual((await t.get(`/h/${hook.id}`, { method: 'POST', body: '{}' })).status, 404);
        const left = await t.ctx.s.db.one('SELECT count(*)::int AS n FROM hook_requests WHERE hook_id = $1 AND delivered_at IS NULL', [hook.id]);
        assert.strictEqual(left.n, 0);
    });

    await check('the sweep removes webhooks past their 72 hours', async () => {
        const h2 = (await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex, json: { path: '/x' } })).json().hook;
        const ref = (await t.get(`/h/${h2.id}`, { method: 'POST', body: 'old' })).json().id;
        await t.ctx.s.db.exec("UPDATE hook_requests SET expires_at = now() - interval '1 minute' WHERE id = $1", [ref]);
        await t.ctx.expireSweep();
        assert.strictEqual((await t.ctx.s.db.maybe('SELECT id FROM hook_requests WHERE id = $1', [ref])), null);
    });

    await check('a body written before sealing is sealed by the sweep and still reaches the app', async () => {
        const h2 = (await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex, json: { path: '/x/legacy' } })).json().hook;
        const ref = 'hb_legacy0123456789ab';
        await t.ctx.s.db.exec(`INSERT INTO hook_requests (id, hook_id, method, headers, body, received_at, expires_at)
                               VALUES ($1, $2, 'POST', '[]'::jsonb, $3::bytea, now(), now() + interval '72 hours')`, [ref, h2.id, Buffer.from('plain at rest')]);
        await t.ctx.hooks.sweep();
        const row = await t.ctx.s.db.one('SELECT body FROM hook_requests WHERE id = $1', [ref]);
        assert.ok(!Buffer.from(row.body).toString().includes('plain at rest'), 'the sweep sealed it');
        assert.strictEqual((await t.ctx.hooks.request(ref)).body.toString(), 'plain at rest');
        await t.get(`/api/v1/shares/${made.share.id}/hooks/${h2.id}`, { as: alex, method: 'DELETE' });
    });

    await check('a share holds at most 1,000 waiting webhooks', async () => {
        const h2 = (await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex, json: { path: '/x/full' } })).json().hook;
        await t.ctx.s.db.exec(`INSERT INTO hook_requests (id, hook_id, method, headers, body, received_at, expires_at, event_id)
                               SELECT 'hb_q' || g, $1, 'POST', '[]'::jsonb, ''::bytea, now(), now() + interval '72 hours', 'evt_q' || g
                               FROM generate_series(1, 1000) g`, [h2.id]);
        const r = await t.get(`/h/${h2.id}`, { method: 'POST', body: '{}' });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.json().error, 'hook.queue_full');
        await t.get(`/api/v1/shares/${made.share.id}/hooks/${h2.id}`, { as: alex, method: 'DELETE' });
    });

    await check('a webhook that waited goes to the app as soon as its computer connects; Events\' retry then finds it settled', async () => {
        const h3 = (await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex, json: { path: '/webhooks/waited' } })).json().hook;
        const w = await t.get(`/h/${h3.id}`, { method: 'POST', body: '{"waited":true}', headers: { 'content-type': 'application/json' } });
        assert.strictEqual(w.status, 202);
        const env = (await t.ctx.s.db.one("SELECT envelope FROM service_outbox WHERE envelope->'payload'->>'body_ref' = $1", [w.json().id])).envelope;
        const before = app.seen.length;
        const c = t.client({ key: made.key, port: app.port });
        await c.ready();
        for (let i = 0; i < 100 && !app.seen.slice(before).some((x) => x.url === '/webhooks/waited'); i++) await new Promise((r) => setTimeout(r, 20));
        const got = app.seen.slice(before).find((x) => x.url === '/webhooks/waited');
        assert.ok(got, 'handed over on connect');
        assert.strictEqual(got.body, '{"waited":true}');
        assert.strictEqual(got.headers['x-openvibe-event-id'], env.event_id, 'the event\'s own id');
        assert.ok(await settled(w.json().id), 'the handover settles');
        const late = await deliver(env);
        assert.deepStrictEqual(late.json(), { gone: true }, 'Events\' delivery finds it settled');
        assert.strictEqual(app.seen.filter((x) => x.url === '/webhooks/waited').length, 1, 'once');
        c.stop();
    });

    await check('with the computer connected, Events\' delivery hands the webhook over itself', async () => {
        const h4 = (await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex, json: { path: '/webhooks/live' } })).json().hook;
        const c = t.client({ key: made.key, port: app.port });
        await c.ready();
        const w = await t.get(`/h/${h4.id}`, { method: 'POST', body: '{"live":1}', headers: { 'content-type': 'application/json' } });
        const env = (await t.ctx.s.db.one("SELECT envelope FROM service_outbox WHERE envelope->'payload'->>'body_ref' = $1", [w.json().id])).envelope;
        const r = await deliver(env);
        assert.deepStrictEqual(r.json(), { delivered: true, status: 200 });
        const got = app.seen.filter((x) => x.url === '/webhooks/live');
        assert.strictEqual(got.length, 1);
        assert.strictEqual(got[0].headers['x-openvibe-event-id'], env.event_id);
        c.stop();
    });

    await check('every waiting webhook replays in order when its computer connects, past one batch', async () => {
        const h = (await t.get(`/api/v1/shares/${made.share.id}/hooks`, { as: alex, json: { path: '/webhooks/order' } })).json().hook;
        for (let i = 0; i < 105; i++) {
            const r = await t.get(`/h/${h.id}`, { method: 'POST', body: JSON.stringify({ i }), headers: { 'content-type': 'application/json' } });
            assert.strictEqual(r.status, 202, r.text);
        }
        const before = app.seen.length;
        const c = t.client({ key: made.key, port: app.port });
        await c.ready();
        const got = () => app.seen.slice(before).filter((x) => x.url === '/webhooks/order');
        for (let i = 0; i < 500 && got().length < 105; i++) await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(got().length, 105, 'every waiting webhook is handed over');
        assert.deepStrictEqual(got().map((x) => JSON.parse(x.body).i), Array.from({ length: 105 }, (_, i) => i), 'oldest first');
        c.stop();
    });

    await check('the page: make one with a plain form', async () => {
        const r = await t.get(`/shares/${made.share.id}/hooks`, { as: alex, method: 'POST', form: { path: '/hooks/stripe', label: 'Stripe' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.match(r.text, /Webhook address made/);
        assert.match(r.text, /localhost:\d+\/hooks\/stripe · Stripe/);
    });

    await t.close();
    await app.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
