'use strict';

/**
 * Hooks that wait for your computer (CON-15): the address providers send to, and Events' deliveries back.
 *
 *   POST|PUT|PATCH /h/:id              a provider's webhook (1 MB): sealed, kept 72 hours, its pointer published → 202
 *   POST /internal/hook-deliveries     Events, signed v2, loopback only (nginx answers 404 for /internal/): the
 *                                      webhook goes to the share's computer. 200 once its app answered (any status
 *                                      below 500) or when the webhook is gone; 503 while the computer is offline or
 *                                      its app fails, so Events tries again (up to 72 hours, server/index.js).
 */
const express = require('express');
const { parseDelivery } = require('openvibe-sdk/events');
const { HookError, METHODS, MAX_BODY } = require('../hooks');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PER_HOOK_MINUTE = 120;

function createHookRoutes(ctx) {
    const { config, hooks, shares, proxy, log } = ctx;
    const r = express.Router();
    const counts = new Map();   // hook id → { minute, n }

    const tooMany = (id) => {
        const minute = Math.floor(Date.now() / 60_000);
        const c = counts.get(id);
        if (!c || c.minute !== minute) { counts.set(id, { minute, n: 1 }); if (counts.size > 5000) counts.delete(counts.keys().next().value); return false; }
        c.n += 1;
        return c.n > PER_HOOK_MINUTE;
    };
    const answer = (res, status, body) => res.status(status).set('Cache-Control', 'no-store').json(body);

    r.all('/h/:id', express.raw({ type: () => true, limit: MAX_BODY }), async (req, res) => {
        if (!METHODS.includes(req.method)) return answer(res.set('Allow', METHODS.join(', ')), 405, { error: 'method', detail: 'A webhook address takes POST, PUT or PATCH.' });
        const hook = await hooks.get(req.params.id);
        if (!hook || hook.status !== 'active') return answer(res, 404, { error: 'not_found', detail: 'No webhook address here.' });
        const share = await shares.get(hook.share_id);
        if (!share || share.status !== 'active') return answer(res, 410, { error: 'gone', detail: 'The share this address served is closed.' });
        if (tooMany(hook.id)) return answer(res.set('Retry-After', '60'), 429, { error: 'rate_limited', detail: `At most ${PER_HOOK_MINUTE} webhooks a minute to one address.` });
        try {
            const { ref } = await hooks.receive(hook, { method: req.method, headers: req.headers, body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) });
            return answer(res, 202, { received: true, id: ref, delivered_when: 'the computer is connected (kept up to 72 hours)' });
        } catch (err) {
            if (err instanceof HookError) {
                if (err.code === 'hook.queue_full') res.set('Retry-After', '300');
                return answer(res, err.status, { error: err.code, detail: err.message });
            }
            log.warn('[OpenVibe.Connect] webhook not kept:', err && err.message);
            return answer(res.set('Retry-After', '30'), 503, { error: 'unavailable', detail: 'Try again shortly.' });
        }
    });

    r.post('/internal/hook-deliveries', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
        if (!LOOPBACK.has(String(req.socket.remoteAddress || ''))) return res.status(404).end();
        let d = null;
        for (const secret of config.events.secrets || []) {
            if (secret) d = parseDelivery(req.body, req.headers, secret);
            if (d) break;
        }
        if (!d) return res.status(401).json({ error: 'bad_signature' });
        const e = d.event || {};
        if (e.event_type !== 'connect.hook.received' || !e.payload) return res.status(200).json({ ignored: true });
        const stored = await hooks.request(e.payload.body_ref);
        if (!stored) return res.status(200).json({ gone: true });
        const share = await shares.get(stored.shareId);
        if (!share || share.status !== 'active') return res.status(200).json({ gone: true });
        const out = await proxy.deliverHook(share, { method: stored.method, path: stored.path, headers: stored.headers, body: stored.body, hookId: stored.hookId, eventId: e.event_id, receivedAt: stored.receivedAt });
        if (out.offline) return res.status(503).set('Retry-After', '300').json({ waiting: 'the computer is not connected' });
        if (!out.status || out.status >= 500) {
            await hooks.fail(stored.ref, out.status || null, out.error || `the app answered ${out.status}`);
            return res.status(503).json({ retry: out.error || `the app answered ${out.status}` });
        }
        await hooks.settle(stored.ref, out.status);
        return res.status(200).json({ delivered: true, status: out.status });
    });

    return r;
}

module.exports = { createHookRoutes };
