'use strict';

/**
 * Connect's pages on connect.openvibe.website. They work without JavaScript: forms are plain POSTs.
 *
 *   /                          the front door; signed in, your shares and the form to make one
 *   POST /shares               make a share → its page, with the key shown once
 *   /shares/:id                one share: connected or not, who may open it, who did, the command
 *   POST /shares/:id/policy    who can open it, the port
 *   POST /shares/:id/key       a new key (shown once); the connected computer is disconnected
 *   POST /shares/:id/node      node=nod_… one of your computers serves it (CON-4); node= (empty) lets it go and shows a
 *                              new key once
 *   POST /shares/:id/hooks     path=&label= a webhook address for it (CON-15)
 *   POST /shares/:id/hooks/:hook/remove
 *   POST /shares/:id/close     close it: the address answers "closed" from then on
 *   /grant?share=&next=        the gate's sign-in step (server/edge/gate.js): signed in and allowed → back to the
 *                              share host with a one-time code
 *   /robots.txt, /llms.txt
 */
const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { send } = require('../render/layout');
const views = require('../views');
const { ShareError } = require('../shares');
const { HookError } = require('../hooks');
const { ApiKeyError } = require('../api-keys');

function createPageRoutes(ctx) {
    const { config, shares, tunnels, gate, proxy, machines, hooks, apiKeys } = ctx;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: '16kb' }));
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => Boolean(req.viewer && req.viewer.kind === 'user' && req.viewer.subject);
    const owner = (req) => ({ subject: req.viewer.subject, username: req.viewer.username, role: req.viewer.role });
    const loginTo = (path) => `/auth/login?next=${encodeURIComponent(path)}`;
    const guard = (req, res) => {
        if (!signedIn(req)) { res.redirect(303, loginTo(req.originalUrl)); return false; }
        if (!sameOrigin(req, config.baseUrl)) {
            page(req, res, { title: 'Not from this site', body: views.message({ title: 'That came from somewhere else', text: 'Changes to your shares must be made on connect.openvibe.website itself.', link: { href: '/', label: 'Your shares' } }) }, 403);
            return false;
        }
        return true;
    };
    const connectedIds = (list) => new Set(list.filter((s) => tunnels.isConnected(s.id)).map((s) => s.id));

    async function homeStats() {
        const t = tunnels.status();
        const open = await ctx.s.db.value("SELECT count(*)::int FROM shares WHERE status = 'active'");
        return { connected: t.connected, shares: open };
    }

    r.get('/', async (req, res) => {
        const list = signedIn(req) ? await shares.list(req.viewer.subject) : [];
        return page(req, res, {
            title: null,
            index: true,
            description: 'OpenVibe Connect: share one port on your computer at its own HTTPS address, behind OpenVibe sign-in. Only the people you pick can open it. One file, Node 22, no router settings.',
            body: views.home({ viewer: req.viewer, shares: list, connectedIds: connectedIds(list), stats: await homeStats(), baseUrl: config.baseUrl }),
        });
    });

    r.post('/shares', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const input = { label: req.body.label, port: req.body.port, mode: req.body.mode, named: req.body.named, expires_in: req.body.expires_in };
        try {
            const { share, key } = await shares.create(owner(req), input);
            return page(req, res, { title: share.host, body: views.sharePage({ share, connected: false, key, baseUrl: config.baseUrl, staff: req.viewer.role === 'admin', notice: 'Your share is made. Run the command below on your computer.' }) }, 201);
        } catch (err) {
            if (!(err instanceof ShareError)) throw err;
            const list = await shares.list(req.viewer.subject);
            const form = { values: input, error: err.message, username: req.viewer.username };
            return page(req, res, { title: 'Make a share', body: views.home({ viewer: req.viewer, shares: list, connectedIds: connectedIds(list), stats: await homeStats(), baseUrl: config.baseUrl, form }) }, err.status || 422);
        }
    });

    async function mine(req, res) {
        if (!signedIn(req)) { res.redirect(303, loginTo(req.originalUrl)); return null; }
        const share = await shares.get(req.params.id);
        if (!share || share.owner_subject !== req.viewer.subject) {
            page(req, res, { title: 'Not found', body: views.notFound() }, 404);
            return null;
        }
        return share;
    }

    async function showShare(req, res, share, extra = {}, status = 200) {
        const tunnel = tunnels.get(share.id);
        const [visits, mine, hookList, keyList] = await Promise.all([
            shares.visits(share.id),
            share.status === 'active' ? machines.list(req.viewer.token) : Promise.resolve({ ok: true, machines: [] }),
            share.status === 'active' ? hooks.list(share.id) : Promise.resolve([]),
            share.status === 'active' && apiKeys ? apiKeys.list(share.id) : Promise.resolve([]),
        ]);
        return page(req, res, { title: share.host, body: views.sharePage({ share, connected: Boolean(tunnel), tunnel, visits, requests: ctx.proxy ? ctx.proxy.inspector.list(share.id) : [], baseUrl: config.baseUrl, staff: req.viewer.role === 'admin', machines: mine.ok ? mine.machines : null, hooks: hookList, apiKeys: keyList, ...extra }) }, status);
    }

    r.get('/shares/:id', async (req, res) => {
        const share = await mine(req, res);
        if (!share) return undefined;
        const notice = req.query.saved ? 'Saved.' : req.query.served ? `${share.node ? share.node.name : 'Your computer'} serves it now. Run the command below on it.` : null;
        return showShare(req, res, share, { notice });
    });

    r.post('/shares/:id/policy', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const share = await mine(req, res);
        if (!share) return undefined;
        try {
            const updated = await shares.setPolicy(owner(req), share.id, { mode: req.body.mode, named: req.body.named, port: req.body.port === undefined || req.body.port === '' ? undefined : Number(req.body.port), expires_in: req.body.expires_in === undefined ? undefined : req.body.expires_in });
            proxy.forget(updated.host);
            return res.redirect(303, `/shares/${encodeURIComponent(share.id)}?saved=1`);
        } catch (err) {
            if (!(err instanceof ShareError)) throw err;
            return showShare(req, res, share, { error: err.message }, err.status || 422);
        }
    });

    r.post('/shares/:id/key', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const share = await mine(req, res);
        if (!share) return undefined;
        try {
            const { share: updated, key } = await shares.rotateKey(owner(req), share.id);
            tunnels.close(share.id, 4003, 'the key was replaced');
            return showShare(req, res, updated, { key, notice: 'A new key is made. The old one no longer works.' });
        } catch (err) {
            if (!(err instanceof ShareError)) throw err;
            return showShare(req, res, share, { error: err.message }, err.status || 422);
        }
    });

    r.post('/shares/:id/node', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const share = await mine(req, res);
        if (!share) return undefined;
        const want = String(req.body.node || '').trim();
        try {
            if (!want) {
                const { share: updated, key } = await shares.bindNode(owner(req), share.id, null);
                tunnels.close(share.id, 4003, 'the computer was let go');
                return showShare(req, res, updated, { key, notice: 'Your computer no longer serves it. Use this key with ov-connect.js, or pick a computer again.' });
            }
            const found = await machines.find(req.viewer.token, want);
            if (!found.ok) return showShare(req, res, share, { error: 'Your computers could not be read from OpenVibe just now. Try again in a moment.' }, 503);
            if (!found.machine) return showShare(req, res, share, { error: 'That is not one of your computers. Pair it with OpenVibe Node first.' }, 404);
            const { share: updated } = await shares.bindNode(owner(req), share.id, found.machine);
            tunnels.close(share.id, 4003, 'now served by one of your computers');
            return res.redirect(303, `/shares/${encodeURIComponent(share.id)}?served=1`);
        } catch (err) {
            if (!(err instanceof ShareError)) throw err;
            return showShare(req, res, share, { error: err.message }, err.status || 422);
        }
    });

    r.post('/shares/:id/hooks', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const share = await mine(req, res);
        if (!share) return undefined;
        try {
            const hook = await hooks.create(owner(req), share, { path: req.body.path, label: req.body.label });
            return showShare(req, res, share, { notice: `Webhook address made. Give ${hook.url} to the service that sends them.` }, 201);
        } catch (err) {
            if (!(err instanceof HookError)) throw err;
            return showShare(req, res, share, { error: err.message }, err.status || 422);
        }
    });

    r.post('/shares/:id/api-keys', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const share = await mine(req, res);
        if (!share) return undefined;
        try {
            const made = await apiKeys.create(owner(req), share, { name: req.body.name, per_minute: req.body.per_minute ? Number(req.body.per_minute) : undefined });
            res.set('Cache-Control', 'no-store');
            return showShare(req, res, share, { notice: 'API key made. Copy it now: it is not shown again.', newApiKey: made }, 201);
        } catch (err) {
            if (!(err instanceof ApiKeyError)) throw err;
            return showShare(req, res, share, { error: err.message }, err.status || 422);
        }
    });

    r.post('/shares/:id/api-keys/:key/revoke', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const share = await mine(req, res);
        if (!share) return undefined;
        try {
            await apiKeys.revoke(owner(req), share, req.params.key);
        } catch (err) {
            if (!(err instanceof ApiKeyError)) throw err;
            return showShare(req, res, share, { error: err.message }, err.status || 404);
        }
        return showShare(req, res, share, { notice: 'Revoked. That key opens nothing from now on.' });
    });

    r.post('/shares/:id/hooks/:hook/remove', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const share = await mine(req, res);
        if (!share) return undefined;
        const hook = await hooks.get(req.params.hook);
        if (!hook || hook.share_id !== share.id) return showShare(req, res, share, { error: 'No such webhook address.' }, 404);
        await hooks.remove(owner(req), hook.id);
        return showShare(req, res, share, { notice: 'Removed. That address answers "not found" from now on.' });
    });

    r.post('/shares/:id/close', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const share = await mine(req, res);
        if (!share) return undefined;
        const closed = await shares.revoke(owner(req), share.id);
        tunnels.close(share.id, 4003, 'share closed');
        proxy.forget(closed.host);
        proxy.inspector.forget(share.id);
        return showShare(req, res, closed, { notice: 'Closed. The address answers "closed" from now on.' });
    });

    // The gate's sign-in step. GET only; nothing changes here but a one-time code in memory.
    r.get('/grant', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const id = typeof req.query.share === 'string' ? req.query.share.slice(0, 64) : '';
        const next = gate.safeNext(typeof req.query.next === 'string' ? req.query.next : '/');
        const share = id ? await shares.get(id) : null;
        if (!share || share.status !== 'active') {
            return page(req, res, { title: 'No such share', body: views.message({ title: 'No such share', text: share ? `${share.host} is closed.` : 'That share does not exist.', link: { href: '/', label: 'OpenVibe Connect' } }) }, share ? 410 : 404);
        }
        if (!signedIn(req)) return res.redirect(303, loginTo(req.originalUrl));
        if (!shares.allows(share, req.viewer)) {
            proxy.denied(share, req.viewer);
            return page(req, res, { title: 'Not for you', body: views.grantDenied({ share, viewer: req.viewer }) }, 403);
        }
        const code = gate.mintCode({ shareId: share.id, subject: req.viewer.subject, username: req.viewer.username });
        res.set('Referrer-Policy', 'no-referrer');
        return res.redirect(303, `${share.url}/__ovc/callback?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`);
    });

    // ── Reports (CON-9 v0): anyone reports a share; staff read them and close a share. ──────────────────────────────
    const { REPORT_REASONS } = require('../shares');
    const reportHits = new Map();   // address → times this hour (in memory only; never stored)
    const overReports = (req) => {
        const key = String(req.ip || ''), cut = Date.now() - 3600_000;
        const hits = (reportHits.get(key) || []).filter((t) => t > cut);
        if (hits.length >= 5) return true;
        hits.push(Date.now());
        reportHits.set(key, hits);
        if (reportHits.size > 10_000) reportHits.delete(reportHits.keys().next().value);
        return false;
    };
    r.get('/report', (req, res) => page(req, res, { title: 'Report a share', body: views.reportForm({ host: String(req.query.host || '').slice(0, 200), reasons: REPORT_REASONS, signedIn: signedIn(req) }) }));
    r.post('/report', async (req, res) => {
        const values = { host: req.body.host, reason: req.body.reason, details: req.body.details };
        const again = (status, error) => page(req, res, { title: 'Report a share', body: views.reportForm({ values, error, reasons: REPORT_REASONS, signedIn: signedIn(req) }) }, status);
        if (!sameOrigin(req, config.baseUrl)) return again(403, 'Send the report from connect.openvibe.website itself.');
        if (overReports(req)) return again(429, 'That is a lot of reports in an hour. Try again later, or write to OpenVibe from the Help site.');
        try {
            await shares.report({ host: values.host, reason: values.reason, details: values.details, reporter: signedIn(req) ? req.viewer.subject : null });
        } catch (err) {
            if (!(err instanceof ShareError)) throw err;
            return again(err.status || 422, err.message);
        }
        return page(req, res, { title: 'Report sent', body: views.message({ title: 'Thank you. The report is in.', text: 'OpenVibe staff read every report. If the share breaks the rules, it is closed and its address says so.', link: { href: '/', label: 'OpenVibe Connect' } }) }, 201);
    });
    const staffOnly = (req, res) => {
        if (!signedIn(req)) { res.redirect(303, loginTo(req.originalUrl)); return false; }
        if (req.viewer.role !== 'admin') { page(req, res, { title: 'Not found', body: views.notFound() }, 404); return false; }
        return true;
    };
    r.get('/admin/reports', async (req, res) => {
        if (!staffOnly(req, res)) return undefined;
        res.set('Cache-Control', 'private, no-store');
        const notice = req.query.done === 'close' ? 'The share is closed.' : req.query.done === 'dismiss' ? 'Dismissed.' : null;
        return page(req, res, { title: 'Reports', body: views.reportsAdmin({ reports: await shares.openReports(), reasons: REPORT_REASONS, notice }) });
    });
    r.post('/admin/reports/:id/:action', async (req, res) => {
        if (!staffOnly(req, res)) return undefined;
        if (!sameOrigin(req, config.baseUrl)) return page(req, res, { title: 'Not from this site', body: views.message({ title: 'That came from somewhere else', text: 'Handle reports on connect.openvibe.website itself.', link: { href: '/admin/reports', label: 'Reports' } }) }, 403);
        try {
            const out = await shares.handleReport(owner(req), req.params.id, req.params.action);
            if (out.action === 'close' && out.share) {
                tunnels.close(out.share.id, 4003, 'the share was closed after a report');
                proxy.forget(out.share.host);
                proxy.inspector.forget(out.share.id);
            }
            return res.redirect(303, `/admin/reports?done=${encodeURIComponent(out.action)}`);
        } catch (err) {
            if (!(err instanceof ShareError)) throw err;
            return page(req, res, { title: 'Reports', body: views.message({ title: 'That did not work', text: err.message, link: { href: '/admin/reports', label: 'Reports' } }) }, err.status || 422);
        }
    });

    r.get('/robots.txt', (req, res) => {
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(`User-agent: *\nAllow: /$\nDisallow: /shares\nDisallow: /grant\nDisallow: /auth\nDisallow: /api\n`);
    });
    r.get('/llms.txt', (req, res) => {
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send([
            '# OpenVibe Connect',
            '',
            '> Share one port on your computer at https://<name>--<username>.openvibe.website, behind OpenVibe sign-in.',
            '',
            '- Client: one file, Node 22+: curl -fsSLO https://connect.openvibe.website/ov-connect.js; node ov-connect.js --key ovc_… --port 8080',
            '- Who can open a share: only the owner, the owner and named OpenVibe usernames, or anyone signed in to OpenVibe. No public shares yet.',
            '- The app behind a share receives X-OpenVibe-User and X-OpenVibe-Subject; Host is localhost:<port>.',
            '- API (a person\'s Network token as a Bearer): GET/POST /api/v1/shares, GET/PATCH/DELETE /api/v1/shares/{id}, POST /api/v1/shares/{id}/key',
            '- Source: https://github.com/OpenVibers/OpenVibe.Connect (AGPL-3.0)',
            '',
        ].join('\n'));
    });

    return r;
}

module.exports = { createPageRoutes };
