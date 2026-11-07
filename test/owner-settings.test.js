'use strict';
/**
 * Owner settings (D11) for Connect's outside sign-in apps (server/settings.js, connect.signin_apps):
 *   - six providers, a client id and secret each, with plain titles, 30+ character descriptions,
 *     x-owner-input words, x-required-for and a test hook;
 *   - /internal/config is loopback only and needs connect.config.manage;
 *   - a secret is write-only and its marker never a value; the read path prefers the owner's value
 *     and falls back to the environment;
 *   - the test route answers ok/failed in one line and never echoes or logs a key.
 *   node test/owner-settings.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { boot } = require('./helpers/boot');
const { check, done } = require('./helpers/check');
const { createSettings, PROVIDERS } = require('../server/settings');

const CAP = 'connect.config.manage';
const NS = 'connect.signin_apps';
const USR = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const SECRET = 'connect-owner-secret-sentinel';
const ENV_ID = 'env-google-client-id';

(async () => {
    const t = await boot({ env: { CONNECT_GOOGLE_CLIENT_ID: ENV_ID } });
    const issuer = t.network.issuer();
    const now = Math.floor(Date.now() / 1000);
    const tokenFor = (caps) => t.network.signJwt({ iss: issuer, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.website'], cap: caps, iat: now, exp: now + 300, jti: `tok_${Math.random().toString(36).slice(2)}` });
    const TOKEN = tokenFor([CAP]);

    await check('every provider publishes an ID and a secret with owner words', async () => {
        const r = await t.get(`/internal/config/${NS}`, { bearer: TOKEN });
        assert.strictEqual(r.status, 200, r.text);
        const props = r.json().schema.properties;
        assert.strictEqual(Object.keys(props).length, Object.keys(PROVIDERS).length * 2);
        for (const p of Object.keys(PROVIDERS)) {
            for (const kind of ['id', 'secret']) {
                const key = `${p}_client_${kind}`;
                const f = props[key];
                assert.ok(f, `${key} exists`);
                assert.ok(f.title && f.title.length >= 3, `${key} has a title`);
                assert.ok(f.description && f.description.length >= 30, `${key} has a 30+ character description`);
                assert.strictEqual(f['x-owner-input'].group, 'Sign-in apps', `${key} is in Sign-in apps`);
                assert.ok(f['x-owner-input'].unlocks && f['x-owner-input'].unlocks.length > 20, `${key} says what it unlocks`);
                assert.ok(/^https:\/\//.test(f['x-owner-input'].get_it_at), `${key} says where to get it`);
                assert.ok(f['x-owner-input'].get_it_how, `${key} says how`);
                assert.strictEqual(f['x-owner-input'].test, true, `${key} has a test`);
                assert.ok(f['x-required-for'], `${key} names the feature that waits on it`);
            }
        }
    });

    await check('the config routes are loopback only and need the capability', async () => {
        assert.strictEqual((await t.get(`/internal/config/${NS}`, { bearer: tokenFor(['connect.share.read']) })).status, 403);
        assert.strictEqual((await t.get(`/internal/config/${NS}`)).status, 401);
        assert.strictEqual((await t.get(`/internal/config/${NS}`, { bearer: TOKEN, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 404);
    });

    await check('a secret is write-only and the environment is the fallback', async () => {
        assert.strictEqual(t.ctx.settings.credentials('google').clientId, ENV_ID, 'the env is the fallback');
        const r = await t.get(`/internal/config/${NS}/secrets/twitch_client_secret`, {
            bearer: TOKEN, method: 'PUT', json: { value: SECRET, reason: 'owner test' },
            headers: { 'x-ov-subject': USR, 'x-ov-fresh': '1' },
        });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.json().fingerprint && r.json().hint);
        assert.ok(!r.text.includes(SECRET), 'the answer never carries the value');
        const id = await t.get(`/internal/config/${NS}`, {
            bearer: TOKEN, method: 'POST', json: { values: { twitch_client_id: 'twitch-client-id' }, merge: true, reason: 'owner test' },
            headers: { 'x-ov-subject': USR },
        });
        assert.strictEqual(id.status, 200, id.text);
        const summary = await t.get(`/internal/config/${NS}`, { bearer: TOKEN });
        assert.ok(summary.json().values.twitch_client_secret.redacted, 'the summary shows a marker');
        assert.ok(!summary.text.includes(SECRET), 'no secret value in the summary');
        assert.strictEqual(t.ctx.settings.credentials('twitch').clientSecret, SECRET, 'the code reads the owner value when set');
        assert.strictEqual(t.ctx.settings.credentials('twitch').clientId, 'twitch-client-id');
        assert.strictEqual(t.ctx.settings.credentials('google').clientId, ENV_ID, 'unset keys still fall back');
    });

    await check('the test hook says ok/failed in one line and never echoes or logs a key', async () => {
        const before = t.logs ? t.logs() : '';
        const fake = createSettings({
            db: t.ctx.s.db, env: {},
            probes: { twitch: async (creds) => { throw new Error(`refused ${creds.clientSecret}`); } },
        });
        await fake.ready;
        const app = express();
        app.use(express.json());
        fake.mount(app, { guard: (_req, _res, next) => next(), log: t.log });
        const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            const r = await fetch(`http://127.0.0.1:${server.address().port}/internal/config/${NS}/test/twitch_client_secret`, { method: 'POST' });
            const body = await r.json();
            assert.strictEqual(r.status, 200);
            assert.strictEqual(body.ok, false);
            assert.ok(/^failed — Twitch said: /.test(body.detail), body.detail);
            assert.ok(!body.detail.includes(SECRET), 'the provider answer is redacted');
            assert.ok(!body.detail.includes('\n'), 'one line');
        } finally { server.close(); }
        const lines = t.logs ? t.logs().slice(before.length) : '';
        assert.ok(!lines.includes(SECRET), 'no key in a captured log line');
    });

    await done(t);
})().catch((e) => { console.error(e); process.exit(1); });
