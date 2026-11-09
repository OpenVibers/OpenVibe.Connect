'use strict';
const assert = require('assert/strict');
const { createEgressAuth } = require('../server/link-egress');
(async () => {
    const seen = [];
    let allowed = true;
    const gate = createEgressAuth({ config: { networkInternalUrl: 'http://network' }, fetchImpl: async (url, options) => {
        seen.push({ url, options });
        const b = JSON.parse(options.body);
        return { ok: allowed, json: async () => ({ node_id: b.node_id, session_id: b.session_id }) };
    } });
    const share = { node: { id: 'lnk_mine' } };
    const req = { method: 'GET', url: '/__ov_egress', headers: { upgrade: 'websocket', 'x-ov-session': 'ses_mine', 'x-ov-egress': 'a'.repeat(43) } };
    assert.equal(await gate.open(share, req), true);
    allowed = false;
    assert.equal(await gate.open(share, req), false, 'successful ownership checks are never cached');
    assert.equal(seen.length, 2);
    assert.equal(JSON.parse(seen[0].options.body).node_id, 'lnk_mine');
    assert.equal(await gate.open(share, { ...req, headers: { cookie: 'owner-session' } }), false, 'owner cookie is insufficient');
    assert.equal(await gate.open(share, { ...req, url: '/' }), false);
    assert.equal(await gate.open(share, { ...req, url: '/__ov_egress?credential=secret' }), false);
    assert.equal(await gate.open(share, { ...req, method: 'CONNECT' }), false);
    const offline = createEgressAuth({ config: { networkInternalUrl: 'http://network' }, fetchImpl: async () => { throw Error(); } });
    assert.equal(await offline.open(share, req), false, 'Network unavailable fails closed');
    console.log('Link egress gate: every-open authorization and fail-closed checks passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
