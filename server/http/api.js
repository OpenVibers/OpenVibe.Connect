'use strict';

/**
 * /api/v1: OpenVibe.Connect's JSON API, for a person (the connect session cookie, or a Network user token as a
 * Bearer). A session write must come from connect.openvibe.website itself (403 connect.cross_site).
 *
 *   GET    /shares               your shares (website.share@1 shapes, plus connected)
 *   POST   /shares               { label, port, mode?, named?, expires_in? } → 201 { share, key }   the key is in this answer only
 *   GET    /shares/:id           one of your shares
 *   PATCH  /shares/:id           { mode?, named?, port?, note?, expires_in? }   expires_in: seconds from now (600 to 30 days),
 *                                or null to stay open until you close it
 *   DELETE /shares/:id           close it (the host answers 410 from then on)
 *   POST   /shares/:id/key       a new key → { share, key }; the connected computer is disconnected
 *   PUT    /shares/:id/node      { node: 'nod_…' } one of your computers serves it, as OpenVibe Node (CON-4): the key
 *                                stops working → { share }; { node: null } lets the computer go → { share, key } (a new key)
 *   GET    /machines             your computers that can serve a share (Network's list of your machines)
 *   GET    /shares/:id/hooks     its webhook addresses (CON-15): each kept webhook waits up to 7 days for the computer
 *   POST   /shares/:id/hooks     { path, label? } → 201 { hook }: https://connect.openvibe.website/h/<id> → that path
 *   DELETE /shares/:id/hooks/:hook  removes it; webhooks still waiting are dropped
 *   GET    /shares/:id/visits    who opened it in the last 7 days
 *   GET    /shares/:id/requests  the last 100 requests through it, newest first (?after=<seq>: only newer ones);
 *                                memory only, query values shown as "…" (edge/inspector.js)
 *
 * Errors are application/problem+json with a `code`.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { ShareError } = require('../shares');
const { HookError } = require('../hooks');

function createApi(ctx) {
    const { shares, tunnels, principal, proxy, machines, hooks } = ctx;
    const r = asyncRouter();
    r.use(express.json({ limit: '16kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);
    r.use(principal.requirePerson);

    const fail = (res, req, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const owner = (req) => ({ subject: req.principal.subject, username: req.principal.username, role: req.principal.role });
    const shape = (s) => ({ ...s, connected: tunnels.isConnected(s.id) });
    const guard = (fn) => async (req, res) => {
        try { return await fn(req, res); } catch (err) {
            if (err instanceof ShareError || err instanceof HookError) return fail(res, req, err.status, err.code, err.message);
            throw err;
        }
    };

    r.get('/shares', guard(async (req, res) => res.json({ shares: (await shares.list(req.principal.subject)).map(shape) })));

    r.post('/shares', guard(async (req, res) => {
        if (!req.principal.username) return fail(res, req, 403, 'identity.no_username', 'Your account needs a username before it can share.');
        const b = req.body || {};
        const { share, key } = await shares.create(owner(req), { label: b.label, port: b.port, mode: b.mode, named: b.named, note: b.note, expires_in: b.expires_in });
        return res.status(201).json({ share: shape(share), key });
    }));

    async function mine(req, res) {
        const share = await shares.get(req.params.id);
        if (!share || share.owner_subject !== req.principal.subject) { fail(res, req, 404, 'share.not_found', 'No such share.'); return null; }
        return share;
    }

    r.get('/shares/:id', guard(async (req, res) => {
        const share = await mine(req, res);
        return share ? res.json({ share: shape(share) }) : undefined;
    }));

    r.patch('/shares/:id', guard(async (req, res) => {
        const share = await mine(req, res);
        if (!share) return undefined;
        const b = req.body || {};
        const updated = await shares.setPolicy(owner(req), share.id, { mode: b.mode, named: b.named, port: b.port, note: b.note, expires_in: b.expires_in });
        proxy.forget(updated.host);
        return res.json({ share: shape(updated) });
    }));

    r.delete('/shares/:id', guard(async (req, res) => {
        const share = await mine(req, res);
        if (!share) return undefined;
        const closed = await shares.revoke(owner(req), share.id);
        tunnels.close(share.id, 4003, 'share closed');
        proxy.forget(closed.host);
        proxy.inspector.forget(share.id);
        return res.json({ share: shape(closed) });
    }));

    r.post('/shares/:id/key', guard(async (req, res) => {
        const share = await mine(req, res);
        if (!share) return undefined;
        const { share: updated, key } = await shares.rotateKey(owner(req), share.id);
        tunnels.close(share.id, 4003, 'the key was replaced');
        return res.json({ share: shape(updated), key });
    }));

    r.get('/machines', guard(async (req, res) => {
        const m = await machines.list(req.principal.token);
        if (!m.ok) return fail(res, req, 503, 'machines.unavailable', 'Your computers could not be read from OpenVibe just now. Try again in a moment.');
        return res.json({ machines: m.machines });
    }));

    r.put('/shares/:id/node', guard(async (req, res) => {
        const share = await mine(req, res);
        if (!share) return undefined;
        const want = (req.body || {}).node;
        if (want === null || want === '') {
            const { share: updated, key } = await shares.bindNode(owner(req), share.id, null);
            tunnels.close(share.id, 4003, 'the computer was let go');
            return res.json({ share: shape(updated), key });
        }
        if (typeof want !== 'string') return fail(res, req, 422, 'share.invalid_node', 'Name one of your computers by its id (nod_…), or null.');
        const found = await machines.find(req.principal.token, want);
        if (!found.ok) return fail(res, req, 503, 'machines.unavailable', 'Your computers could not be read from OpenVibe just now. Try again in a moment.');
        if (!found.machine) return fail(res, req, 404, 'share.unknown_node', 'That is not one of your computers. Pair it with OpenVibe Node first.');
        const { share: updated } = await shares.bindNode(owner(req), share.id, found.machine);
        tunnels.close(share.id, 4003, 'now served by one of your computers');
        return res.json({ share: shape(updated) });
    }));

    r.get('/shares/:id/hooks', guard(async (req, res) => {
        const share = await mine(req, res);
        return share ? res.json({ hooks: await hooks.list(share.id) }) : undefined;
    }));
    r.post('/shares/:id/hooks', guard(async (req, res) => {
        const share = await mine(req, res);
        if (!share) return undefined;
        const b = req.body || {};
        return res.status(201).json({ hook: await hooks.create(owner(req), share, { path: b.path, label: b.label }) });
    }));
    r.delete('/shares/:id/hooks/:hook', guard(async (req, res) => {
        const share = await mine(req, res);
        if (!share) return undefined;
        const hook = await hooks.get(req.params.hook);
        if (!hook || hook.share_id !== share.id) return fail(res, req, 404, 'hook.not_found', 'No such webhook address.');
        return res.json({ hook: await hooks.remove(owner(req), hook.id) });
    }));

    r.get('/shares/:id/requests', guard(async (req, res) => {
        const share = await mine(req, res);
        return share ? res.json({ requests: proxy.inspector.list(share.id, { after: req.query.after }), keep: proxy.inspector.KEEP }) : undefined;
    }));

    r.get('/shares/:id/visits', guard(async (req, res) => {
        const share = await mine(req, res);
        return share ? res.json({ visits: await shares.visits(share.id) }) : undefined;
    }));

    return r;
}

module.exports = { createApi };
