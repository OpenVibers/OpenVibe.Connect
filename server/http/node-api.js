'use strict';

/**
 * /api/v1/node: a person's computer, as OpenVibe Link (CON-4, ADR-057 decision 4). Every call carries the computer's
 * Network node token (Authorization: Bearer, subject node:nod_…, audience openvibe.website); nothing here answers to a
 * person's token or the session.
 *
 *   GET  /shares                       the open shares this computer serves → { shares: [{ id, host, url, local_port, mode }] }
 *   POST /shares/:id/tunnel-token      → { tunnel_token, expires_in: 60, share }   for one hello on /tunnel, within 60 s
 *
 * The tunnel token is in this answer only, and is never logged.
 */
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');

function createNodeApi(ctx) {
    const { shares, nodeAuth } = ctx;
    const r = asyncRouter();
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const fail = (res, req, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.use(async (req, res, next) => {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return fail(res, req, 401, 'token.required', 'send this computer\'s Network node token (audience openvibe.website) as a Bearer');
        const v = await nodeAuth.verify(header.slice(7).trim());
        if (!v.ok) return fail(res, req, v.status, v.code, v.reason);
        req.node = v.node;
        return next();
    });

    const brief = (s) => ({ id: s.id, host: s.host, url: s.url, local_port: s.local_port, mode: s.mode });

    r.get('/shares', async (req, res) => res.json({ shares: (await shares.byNode(req.node)).map(brief) }));

    r.post('/shares/:id/tunnel-token', async (req, res) => {
        const share = await shares.get(req.params.id);
        // Another person's share and a share this computer does not serve look the same: not found.
        if (!share || !share.node || share.node.id !== req.node) return fail(res, req, 404, 'share.not_found', 'This computer does not serve that share. Pick it on the share\'s page on connect.openvibe.website.');
        if (share.status !== 'active') return fail(res, req, 410, 'share.revoked', 'That share is closed.');
        const t = nodeAuth.mint(share.id, req.node);
        return res.json({ tunnel_token: t.token, expires_in: t.expires_in, share: brief(share) });
    });

    return r;
}

module.exports = { createNodeApi };
