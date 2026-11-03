'use strict';
/**
 * API keys, v1 (CON-16): a key may have a daily quota, counted in UTC days and kept in the database (a restart does not
 * reset it); over it, 429 key_daily_quota until midnight UTC. The owner sees what each key did today: its requests, the
 * MCP tools it called (JSON-RPC tools/call, by name) and the models it asked for (an OpenAI-style "model"), names and
 * counts only.
 *   node test/api-key-quotas.test.js
 */
const assert = require('assert');
const { boot, startLocalApp } = require('./helpers/boot');
const { check, done } = require('./helpers/check');
const { createApiKeys, usageOf } = require('../server/api-keys');

const until = async (fn, ms = 2000) => {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v || Date.now() > end) return v;
        await new Promise((r) => setTimeout(r, 25));
    }
};

(async () => {
    await check('what a body used: tools/call names (a batch counts each), a model on a model path, nothing else', () => {
        assert.deepStrictEqual(usageOf('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_files', arguments: { q: 'secret plans' } } })), ['tool:search_files']);
        assert.deepStrictEqual(usageOf('/mcp', JSON.stringify([{ method: 'tools/call', params: { name: 'a' } }, { method: 'tools/call', params: { name: 'b' } }, { method: 'tools/list' }])), ['tool:a', 'tool:b']);
        assert.deepStrictEqual(usageOf('/v1/chat/completions', '{"model":"llama3.2:3b","messages":[{"role":"user","content":"hi"}]}'), ['model:llama3.2:3b']);
        assert.deepStrictEqual(usageOf('/api/generate?x=1', '{"model":"qwen2.5"}'), ['model:qwen2.5'], 'Ollama\'s own API');
        assert.deepStrictEqual(usageOf('/orders', '{"model":"x"}'), [], 'a "model" field elsewhere is not a model request');
        assert.deepStrictEqual(usageOf('/mcp', '{"method":"initialize"}'), []);
        assert.deepStrictEqual(usageOf('/mcp', 'not json'), []);
        assert.deepStrictEqual(usageOf('/mcp', JSON.stringify({ method: 'tools/call', params: { name: '<b>evil</b> name;rm' } })), ['tool:bevil/bnamerm'], 'names are cleaned');
    });

    const t = await boot();
    const app = await startLocalApp();
    const alex = t.network.addUser('alex');
    const made = await t.makeShare(alex, { label: 'mcp', port: app.port });
    const c = t.client({ key: made.key, port: app.port });
    await c.ready();
    const call = (token, path, { method = 'GET', body } = {}) => t.share(made.share.host, path, { method, body, headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) } });
    let key, token;
    const usage = async (id) => Object.fromEntries((await t.ctx.s.db.many('SELECT what, n FROM share_api_key_usage WHERE key_id = $1', [id])).map((r) => [r.what, Number(r.n)]));

    await check('a key may have a daily quota; a bad one changes nothing', async () => {
        const bad = await t.get(`/api/v1/shares/${made.share.id}/api-keys`, { as: alex, json: { name: 'x', per_day: 0 } });
        assert.strictEqual(bad.status, 422);
        assert.strictEqual(bad.json().code, 'key.invalid_quota', bad.text);
        const r = await t.get(`/api/v1/shares/${made.share.id}/api-keys`, { as: alex, json: { name: 'claude desktop', per_minute: 60, per_day: 3 } });
        assert.strictEqual(r.status, 201, r.text);
        key = r.json().api_key;
        token = r.json().key;
        assert.strictEqual(key.per_day, 3);
    });

    await check('three requests pass; the fourth is 429 key_daily_quota until midnight UTC, and is not counted', async () => {
        assert.strictEqual((await call(token, '/v1/models')).status, 200);
        assert.strictEqual((await call(token, '/v1/chat/completions', { method: 'POST', body: '{"model":"llama3.2:3b","messages":[]}' })).status, 200);
        assert.strictEqual((await call(token, '/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'search_files', arguments: { q: 'x' } } }) })).status, 200);
        const over = await call(token, '/v1/models');
        assert.strictEqual(over.status, 429, over.text);
        assert.strictEqual(over.json().error, 'key_daily_quota');
        assert.strictEqual(over.json().per_day, 3);
        const wait = Number(over.headers['retry-after']);
        assert.ok(wait >= 1 && wait <= 86400, `retry-after ${over.headers['retry-after']}`);
        const u = await until(async () => { const x = await usage(key.id); return x['tool:search_files'] && x; });
        assert.deepStrictEqual(u, { '*': 3, 'model:llama3.2:3b': 1, 'tool:search_files': 1 });
        assert.ok(!JSON.stringify(await t.ctx.s.db.many('SELECT * FROM share_api_key_usage')).includes('"q"'), 'no arguments kept');
    });

    await check('a restart does not reset the quota: a fresh process reads today\'s count', async () => {
        const fresh = createApiKeys(t.ctx.s, { now: t.ctx.s.now });
        assert.strictEqual(await fresh.overDay(key), true);
        const unlimited = { ...key, id: 'sak_01M6FWGEVYZYQTP5ZPZ75CWB7P', per_day: null };
        assert.strictEqual(await fresh.overDay(unlimited), false, 'a key without a quota is never over its day');
    });

    await check('the list and the share page show today\'s use: requests against the quota, tools and models', async () => {
        const list = await t.get(`/api/v1/shares/${made.share.id}/api-keys`, { as: alex });
        const k = list.json().api_keys.find((x) => x.id === key.id);
        assert.strictEqual(k.today, 3);
        assert.deepStrictEqual(k.used.map((u) => u.what).sort(), ['model:llama3.2:3b', 'tool:search_files']);
        const page = await t.get(`/shares/${made.share.id}`, { as: alex });
        assert.match(page.text, /3 a day/);
        assert.match(page.text, /Today: 3 of 3 requests/);
        assert.match(page.text, /<span class="cn-muted">tool<\/span> <code>search_files<\/code> ×1/);
        assert.match(page.text, /<span class="cn-muted">model<\/span> <code>llama3\.2:3b<\/code> ×1/);
        assert.match(page.text, /name="per_day" type="number" min="1" max="1000000"/);
        const form = await t.get(`/shares/${made.share.id}/api-keys`, { as: alex, form: { name: 'nightly job', per_minute: '10', per_day: '500' } });
        assert.strictEqual(form.status, 201);
        assert.match(form.text, /10 a minute · 500 a day/);
    });

    c.stop();
    app.close();
    await done(t);
})().catch((e) => { console.error(e); process.exit(1); });
