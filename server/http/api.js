'use strict';

/**
 * /api/v1: OpenVibe.Connect's JSON API, for a person (the connect session cookie, or a Network user token as a
 * Bearer). A session write must come from connect.openvibe.website itself (403 connect.cross_site).
 *
 *   GET    /shares               your shares (website.share@1 shapes, plus connected)
 *   POST   /shares               { label, port, mode?, named? } → 201 { share, key }   the key is in this answer only
 *   GET    /shares/:id           one of your shares
 *   PATCH  /shares/:id           { mode?, named?, port?, note? }
 *   DELETE /shares/:id           close it (the host answers 410 from then on)
 *   POST   /shares/:id/key       a new key → { share, key }; the connected computer is disconnected
 *   GET    /shares/:id/visits    who opened it in the last 7 days
 *
 * Errors are application/problem+json with a `code`.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { ShareError } = require('../shares');

function createApi(ctx) {
    const { shares, tunnels, principal, proxy } = ctx;
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
            if (err instanceof ShareError) return fail(res, req, err.status, err.code, err.message);
            throw err;
        }
    };

    r.get('/shares', guard(async (req, res) => res.json({ shares: (await shares.list(req.principal.subject)).map(shape) })));

    r.post('/shares', guard(async (req, res) => {
        if (!req.principal.username) return fail(res, req, 403, 'identity.no_username', 'Your account needs a username before it can share.');
        const b = req.body || {};
        const { share, key } = await shares.create(owner(req), { label: b.label, port: b.port, mode: b.mode, named: b.named, note: b.note });
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
        const updated = await shares.setPolicy(owner(req), share.id, { mode: b.mode, named: b.named, port: b.port, note: b.note });
        proxy.forget(updated.host);
        return res.json({ share: shape(updated) });
    }));

    r.delete('/shares/:id', guard(async (req, res) => {
        const share = await mine(req, res);
        if (!share) return undefined;
        const closed = await shares.revoke(owner(req), share.id);
        tunnels.close(share.id, 4003, 'share closed');
        proxy.forget(closed.host);
        return res.json({ share: shape(closed) });
    }));

    r.post('/shares/:id/key', guard(async (req, res) => {
        const share = await mine(req, res);
        if (!share) return undefined;
        const { share: updated, key } = await shares.rotateKey(owner(req), share.id);
        tunnels.close(share.id, 4003, 'the key was replaced');
        return res.json({ share: shape(updated), key });
    }));

    r.get('/shares/:id/visits', guard(async (req, res) => {
        const share = await mine(req, res);
        return share ? res.json({ visits: await shares.visits(share.id) }) : undefined;
    }));

    return r;
}

module.exports = { createApi };
