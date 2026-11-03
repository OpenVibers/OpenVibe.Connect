'use strict';
/**
 * API keys for a share (CON-16 v0): the owner makes a key (shown once), a program sends it as a Bearer token and
 * passes the gate without signing in; the app never sees the key, only X-OpenVibe-Subject key:<id>; a key opens the
 * share's API, never its pages (an HTML answer is refused); a wrong, revoked or other share's key is 401, never a
 * sign-in redirect; each key has its own rate; only the owner manages keys; the page shows a new key once.
 *   node test/api-keys.test.js
 */
const assert = require('assert');
const { boot, startLocalApp } = require('./helpers/boot');
const { check, done } = require('./helpers/check');

(async () => {
    const t = await boot();
    const app = await startLocalApp();
    const alex = t.network.addUser('alex');
    const bob = t.network.addUser('bob');
    const made = await t.makeShare(alex, { label: 'llm', port: app.port });
    const other = await t.makeShare(alex, { label: 'other', port: app.port });
    const c = t.client({ key: made.key, port: app.port });
    await c.ready();
    const api = (path, headers = {}) => t.share(made.share.host, path, { headers: { accept: 'application/json', ...headers } });
    let key, token, otherToken;

    await check('the owner makes a key: named, a rate, the token once; nobody else can', async () => {
        const r = await t.get(`/api/v1/shares/${made.share.id}/api-keys`, { as: alex, json: { name: 'laptop script', per_minute: 3 } });
        assert.strictEqual(r.status, 201, r.text);
        key = r.json().api_key;
        token = r.json().key;
        assert.match(token, /^ovsk_[A-Za-z0-9_-]{43}$/);
        assert.match(key.id, /^sak_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.deepStrictEqual([key.name, key.per_minute, key.prefix], ['laptop script', 3, token.slice(0, 12)]);
        const list = await t.get(`/api/v1/shares/${made.share.id}/api-keys`, { as: alex });
        assert.strictEqual(list.json().api_keys.length, 1);
        assert.ok(!list.text.includes(token), 'a list never shows the token');
        assert.strictEqual((await t.get(`/api/v1/shares/${made.share.id}/api-keys`, { as: bob, json: { name: 'x' } })).status, 404, 'not on another person\'s share');
        assert.strictEqual((await t.get(`/api/v1/shares/${made.share.id}/api-keys`, { as: alex, json: { name: '' } })).status, 422);
        assert.strictEqual((await t.get(`/api/v1/shares/${made.share.id}/api-keys`, { as: alex, json: { name: 'x', per_minute: 9999 } })).status, 422);
        const o = await t.get(`/api/v1/shares/${other.share.id}/api-keys`, { as: alex, json: { name: 'other' } });
        otherToken = o.json().key;
        const row = await t.ctx.s.db.one('SELECT key_hash FROM share_api_keys WHERE id = $1', [key.id]);
        assert.ok(row.key_hash && !row.key_hash.includes(token), 'only the hash is kept');
    });

    await check('a key passes the gate; the app sees who, never the key', async () => {
        const r = await api('/v1/models', { authorization: `Bearer ${token}` });
        assert.strictEqual(r.status, 200, r.text);
        const seen = app.seen[app.seen.length - 1];
        assert.strictEqual(seen.url, '/v1/models');
        assert.strictEqual(seen.headers.authorization, undefined, 'the key is dropped at the edge');
        assert.strictEqual(seen.headers['x-openvibe-subject'], `key:${key.id}`);
        assert.strictEqual(seen.headers['x-openvibe-user'], 'key: laptop script');
        const post = await t.share(made.share.host, '/v1/chat/completions', { method: 'POST', body: '{"model":"x"}', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` } });
        assert.strictEqual(post.status, 200);
        assert.strictEqual(post.json().body, '{"model":"x"}');
    });

    await check('a key opens the API, never a page: an HTML answer is refused (406)', async () => {
        const r = await api('/page', { authorization: `Bearer ${token}` });
        assert.strictEqual(r.status, 406, r.text);
        assert.ok(!r.text.includes('a page'), 'not a byte of the page');
        assert.strictEqual(r.json().error, 'api_only');
    });

    await check('a wrong, another share\'s or a malformed key is 401, never a sign-in redirect', async () => {
        for (const bad of [`ovsk_${'A'.repeat(43)}`, otherToken]) {
            const r = await t.share(made.share.host, '/', { headers: { accept: 'text/html', authorization: `Bearer ${bad}` } });
            assert.strictEqual(r.status, 401, `${bad.slice(0, 12)}: ${r.status}`);
            assert.ok(!r.headers.location, 'no redirect to sign in');
        }
        const plain = await t.share(made.share.host, '/', { headers: { accept: 'text/html', authorization: 'Bearer something-else' } });
        assert.strictEqual(plain.status, 302, 'a token that is not a key leaves the usual gate alone');
    });

    await check('each key has its own rate (3 a minute here): the fourth is 429', async () => {
        const statuses = [];
        for (let i = 0; i < 2; i++) statuses.push((await api('/v1/models', { authorization: `Bearer ${token}` })).status);
        // Two requests were made above (a GET and a POST) plus the page: the rate is already used.
        assert.ok(statuses.includes(429), `over its rate: ${statuses}`);
        const limited = await api('/v1/models', { authorization: `Bearer ${token}` });
        assert.strictEqual(limited.status, 429);
        assert.strictEqual(limited.headers['retry-after'], '60');
    });

    await check('the share page shows a new key once, lists keys by their start, and revokes', async () => {
        const page = await t.get(`/shares/${made.share.id}/api-keys`, { as: alex, form: { name: 'editor', per_minute: '60' } });
        assert.strictEqual(page.status, 201, page.text.slice(0, 300));
        assert.match(page.text, /Your new key<\/b> for editor/);
        assert.match(page.text, /<code id="cn-apikey">ovsk_[A-Za-z0-9_-]{43}<\/code>/);
        const again = await t.get(`/shares/${made.share.id}`, { as: alex });
        assert.ok(!/<code id="cn-apikey">/.test(again.text), 'shown once');
        assert.match(again.text, /API keys for programs/);
        assert.ok(again.text.includes(`${token.slice(0, 12)}…`), 'listed by its start');
        const gone = await t.get(`/shares/${made.share.id}/api-keys/${key.id}/revoke`, { as: alex, method: 'POST', form: {} });
        assert.strictEqual(gone.status, 200);
        assert.strictEqual((await api('/v1/models', { authorization: `Bearer ${token}` })).status, 401, 'a revoked key stops at once');
        assert.strictEqual((await t.get(`/api/v1/shares/${made.share.id}/api-keys/${key.id}`, { as: alex, method: 'DELETE' })).status, 404, 'already revoked');
    });

    c.stop();
    app.close();
    await done(t);
})().catch((e) => { console.error(e); process.exit(1); });
