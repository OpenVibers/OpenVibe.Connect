'use strict';

/**
 * /api/v1/link: a person's computer, as OpenVibe Link (CON-4, ADR-057 decision 4). Every call carries the computer's
 * Network node token (Authorization: Bearer, subject link:lnk_…, audience openvibe.link); nothing here answers to a
 * person's token or the session.
 *
 *   GET  /shares                       the open shares this computer serves → { shares: [{ id, host, url, local_port, mode }] }
 *   POST /shares/:id/tunnel-token      → { tunnel_token, expires_in: 60, share }   for one hello on /tunnel, within 60 s
 *
 * The tunnel token is in this answer only, and is never logged.
 */
const { http } = require('openvibe-contracts');
const express = require('express');
const { asyncRouter } = require('./router');
const { verify } = require('../party-grants');
const { ShareError } = require('../shares');

function createLinkApi(ctx) {
    const { config, shares, linkAuth, tunnels, proxy } = ctx;
    const host = new URL(config.baseUrl).host;
    const r = asyncRouter();
    r.use(express.json({ limit: '4kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const fail = (res, req, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.use(async (req, res, next) => {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return fail(res, req, 401, 'token.required', 'send this computer\'s Network node token (audience openvibe.link) as a Bearer');
        const v = await linkAuth.verify(header.slice(7).trim());
        if (!v.ok) return fail(res, req, v.status, v.code, v.reason);
        req.node = v.node;
        return next();
    });

    const brief = (s) => ({ id: s.id, host: s.host, url: s.url, local_port: s.local_port, mode: s.mode });

    r.get('/shares', async (req, res) => res.json({ shares: (await shares.byNode(req.node)).map(brief) }));

    r.post('/egress-share', async (req, res) => {
        const identity = await require('../link-egress').createEgressAuth({ config }).identity(req.body?.network_token);
        if (!identity || identity.node_id !== req.node) return fail(res, req, 403, 'egress.owner', 'Network did not confirm this computer');
        const share = await shares.createEgress({ node: req.node, owner: identity.owner, name: identity.name, port: req.body.port });
        proxy.forget(share.host);
        return res.json({ share: brief(share) });
    });

    r.post('/party-shares', async (req, res) => {
        const claim = verify(req.body && req.body.grant, config.partySharedSecret);
        if (!claim || claim.type !== 'create' || claim.node !== req.node)
            return fail(res, req, 403, 'party.invalid_grant', 'Chat did not authorize this party for this machine');
        try {
            const share = await shares.createParty(claim);
            return res.status(201).json({ share: brief(share) });
        } catch (err) {
            if (err instanceof ShareError) return fail(res, req, err.status, err.code, err.message);
            throw err;
        }
    });

    r.put('/shares/:id/party-members', async (req, res) => {
        try {
            const share = await shares.partyMembers(await shares.get(req.params.id), req.node, req.body && req.body.members);
            proxy.forget(share.host);
            return res.json({ share: brief(share) });
        } catch (err) {
            if (err instanceof ShareError) return fail(res, req, err.status, err.code, err.message);
            throw err;
        }
    });

    r.delete('/shares/:id/party', async (req, res) => {
        try {
            const share = await shares.closeParty(await shares.get(req.params.id), req.node);
            tunnels.close(share.id, 4003, 'party ended');
            proxy.forget(share.host);
            return res.json({ share: brief(share) });
        } catch (err) {
            if (err instanceof ShareError) return fail(res, req, err.status, err.code, err.message);
            throw err;
        }
    });

    r.post('/shares/:id/tunnel-token', async (req, res) => {
        const share = await shares.get(req.params.id);
        // Another person's share and a share this computer does not serve look the same: not found.
        if (!share || !share.node || share.node.id !== req.node) return fail(res, req, 404, 'share.not_found', `This computer does not serve that share. Pick it on the share's page on ${host}.`);
        if (share.status !== 'active') return fail(res, req, 410, 'share.revoked', 'That share is closed.');
        const t = linkAuth.mint(share.id, req.node);
        return res.json({ tunnel_token: t.token, expires_in: t.expires_in, share: brief(share) });
    });

    return r;
}

module.exports = { createLinkApi };
