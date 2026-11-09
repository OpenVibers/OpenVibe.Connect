'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { boot } = require('./helpers/boot');
const { check, done } = require('./helpers/check');

const SECRET = 'party-test-shared-secret-01234567890123456789';
const sign = (body) => {
    const payload = Buffer.from(JSON.stringify({ ...body, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    return `${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
};

(async () => {
    const t = await boot({ env: { CONNECT_PARTY_SHARED_SECRET: SECRET, CONNECT_SHARE_DOMAIN: 'openvibe.link', CONNECT_SHARE_DOMAINS: 'openvibe.link', COOKIE_SECURE: 'true' } });
    const alex = t.network.addUser('alex');
    const bob = t.network.addUser('bob');
    const desk = t.network.addNode(alex, { name: 'Desk PC' });
    const slug = 'party-0123abcd';
    let share;

    await check('only Chat-granted Link machine creates the named party share', async () => {
        const claim = sign({ type: 'create', party: slug, owner: alex.subject, username: 'alex', node: desk.id, port: 18180 });
        const noToken = await t.get('/api/v1/link/party-shares', { method: 'POST', json: { grant: claim } });
        assert.strictEqual(noToken.status, 401);
        const bad = await t.get('/api/v1/link/party-shares', { method: 'POST', bearer: t.network.linkToken(desk), json: { grant: claim + 'x' } });
        assert.strictEqual(bad.status, 403);
        const made = await t.get('/api/v1/link/party-shares', { method: 'POST', bearer: t.network.linkToken(desk), json: { grant: claim } });
        assert.strictEqual(made.status, 201, made.text);
        share = made.json().share;
        assert.strictEqual(share.host, `${slug}--alex.openvibe.link`);
        const stored = await t.ctx.shares.get(share.id);
        assert.strictEqual(stored.mode, 'named');
        assert.strictEqual(stored.party_slug, slug);
        assert.strictEqual(stored.node.id, desk.id);
        assert.strictEqual((await t.get(`/api/v1/shares/${share.id}`, { as: alex })).json().share.key_prefix, null);
    });

    await check('a member ticket enters the embedded share; an outsider cannot', async () => {
        const landing = await t.share(share.host, '/__ovc/party');
        assert.strictEqual(landing.status, 200, landing.text);
        assert.match(landing.text, /location\.hash/);
        assert.match(landing.headers['content-security-policy'], /frame-ancestors https:\/\/openvibe\.party/);
        const asBob = sign({ type: 'access', share: share.id, subject: bob.subject, username: 'bob' });
        const opts = { method: 'POST', headers: { origin: `https://${share.host}`, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: asBob }) };
        assert.strictEqual((await t.share(share.host, '/__ovc/party', opts)).status, 403);
        const synced = await t.get(`/api/v1/link/shares/${share.id}/party-members`, { method: 'PUT', bearer: t.network.linkToken(desk), json: { members: ['alex', 'bob'] } });
        assert.strictEqual(synced.status, 200, synced.text);
        const entered = await t.share(share.host, '/__ovc/party', opts);
        assert.strictEqual(entered.status, 200, entered.text);
        assert.strictEqual(entered.json().username, 'bob');
        assert.match(String(entered.headers['set-cookie']), /SameSite=None.*Partitioned/);
        const stored = await t.ctx.shares.get(share.id);
        assert.ok(t.ctx.gate.verify(String(entered.headers['set-cookie']).split(';')[0].split('=')[1], stored));
    });

    await check('the party machine closes its share', async () => {
        const closed = await t.get(`/api/v1/link/shares/${share.id}/party`, { method: 'DELETE', bearer: t.network.linkToken(desk) });
        assert.strictEqual(closed.status, 200, closed.text);
        assert.strictEqual((await t.ctx.shares.get(share.id)).status, 'revoked');
        assert.strictEqual((await t.share(share.host, '/__ovc/party')).status, 410);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
