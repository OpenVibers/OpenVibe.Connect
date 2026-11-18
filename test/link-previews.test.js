'use strict';
/**
 * Previews (plan §AD.25, migration 0018): a computer, as OpenVibe Link, opens an owner-only share for a folder it
 * serves, after Network confirms whose computer it is; its address is p<6>--<computer>; it lasts 5 minutes to a day (2
 * hours when not said); five at most at once per computer; the expiry sweep closes it; another computer's or person's
 * token is refused.
 */
const assert = require('assert/strict');

(async () => {
    const fetchOriginal = globalThis.fetch;
    let identity = null;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/api/v1/link/self/egress/identity')) return identity ? new Response(JSON.stringify(identity)) : new Response(null, { status: 403 });
        return fetchOriginal(url, options);
    };
    const { boot } = require('./helpers/boot');
    const t = await boot({ env: { CONNECT_SHARE_DOMAIN: 'openvibe.link', CONNECT_SHARE_DOMAINS: 'openvibe.link' } });
    try {
        const owner = t.network.addUser('previewowner');
        const node = t.network.addNode(owner, { name: 'Build box' });
        const other = t.network.addNode(t.network.addUser('someoneelse'), { name: 'Theirs' });
        const ask = (body, n = node) => t.get('/api/v1/link/previews', { method: 'POST', bearer: t.network.linkToken(n), json: { network_token: 'nt', ...body } });

        identity = { node_id: node.id, owner: owner.subject, name: 'Build box' };
        let r = await ask({ port: 41234 });
        assert.equal(r.status, 201, r.text);
        const share = r.json().share;
        assert.match(share.host, new RegExp(`^p[0-9a-f]{6}--${node.id.slice(4).toLowerCase()}\\.openvibe\\.link$`));
        assert.deepEqual([share.mode, share.local_port], ['owner', 41234], 'only its owner, signed in, may open it');
        const ttl = (Date.parse(r.json().expires_at) - Date.now()) / 1000;
        assert.ok(ttl > 7100 && ttl <= 7200, `two hours when not said (${ttl})`);
        const row = await t.ctx.s.db.one('SELECT link_preview, node_id, owner_subject FROM shares WHERE id = $1', [share.id]);
        assert.deepEqual([row.link_preview, row.node_id, row.owner_subject], [true, node.id, owner.subject]);
        const listed = await t.get('/api/v1/link/shares', { bearer: t.network.linkToken(node) });
        assert.ok(listed.json().shares.some((x) => x.id === share.id), 'the computer serves it like its other shares');

        r = await ask({ port: 41235, expires_in: 999999 });
        assert.ok((Date.parse(r.json().expires_at) - Date.now()) / 1000 <= 24 * 3600, 'a day at most');
        r = await ask({ port: 41236, expires_in: 5 });
        assert.ok((Date.parse(r.json().expires_at) - Date.now()) / 1000 >= 290, 'five minutes at least');
        await ask({ port: 41237 });
        await ask({ port: 41238 });
        r = await ask({ port: 41239 });
        assert.deepEqual([r.status, r.json().code], [429, 'preview.too_many'], 'five open at once per computer');

        r = await ask({ port: 0 });
        assert.equal(r.status, 422);
        identity = { node_id: other.id, owner: owner.subject, name: 'x' };
        r = await ask({ port: 41240 });
        assert.deepEqual([r.status, r.json().code], [403, 'preview.owner'], 'Network must confirm this very computer');
        identity = null;
        r = await ask({ port: 41240 });
        assert.equal(r.status, 403);
        r = await t.get('/api/v1/link/previews', { method: 'POST', json: { port: 1 } });
        assert.equal(r.status, 401, 'a computer\'s token, nothing else');

        // The expiry sweep closes a preview whose time is up.
        await t.ctx.s.db.exec("UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1", [share.id]);
        await t.ctx.shares.expireDue();
        const after = await t.ctx.s.db.one('SELECT status FROM shares WHERE id = $1', [share.id]);
        assert.equal(after.status, 'revoked');
    } finally {
        globalThis.fetch = fetchOriginal;
        await t.close();
    }
    console.log('link previews: owner-only, confirmed by Network, 5 minutes to a day, five at most, closed when due');
})().catch((err) => { console.error(err); process.exit(1); });
