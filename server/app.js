'use strict';

/**
 * OpenVibe.Connect: the Express app factory; server/index.js listens, tests build their own instance with a temp
 * database and a mock Network.
 *
 *   <label>--<user>.openvibe.link/*      a share: the gate, then the tunnel (edge/proxy.js), before anything else
 *   /, /shares/*, /grant                  the pages (http/pages.js)
 *   /api/v1/node/*                        a person's computer as OpenVibe Link (http/node-api.js, CON-4)
 *   /api/v1/*                             the API (http/api.js)
 *   /ov-connect.js                        the client, served as it is in public/
 *   /auth/*                               Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics   (loopback only)
 *   /internal/events                      account export/deletion (loopback only)
 *   WebSocket /tunnel                     a computer connecting a share (edge/tunnels.js); ctx.onUpgrade routes it
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createPrincipal } = require('./http/principal');
const settingsLib = require('./settings');
const { createApi } = require('./http/api');
const { createNodeApi } = require('./http/node-api');
const { createNodeAuth } = require('./auth/node-auth');
const { createMachines } = require('./machines');
const { createHooks } = require('./hooks');
const { createApiKeys } = require('./api-keys');
const { createOAuth } = require('./oauth');
const { createOAuthRoutes } = require('./http/oauth-routes');
const { createProbe } = require('./probe');
const { createHookRoutes } = require('./http/hooks');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createPageRoutes } = require('./http/pages');
const { createServiceReadiness } = require('./observability');
const { assetVersion, setRelease } = require('./render/layout');
const { createShares } = require('./shares');
const { createTunnels } = require('./edge/tunnels');
const { createGate } = require('./edge/gate');
const { createProxy, rawResponder } = require('./edge/proxy');

const accountDataLib = require('./identity/account-data');
const { createNetworkSender } = require('openvibe-sdk/account-data');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const { createHttpTelemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink } = require('openvibe-sdk/telemetry');

/**
 * opts: config, store, now (clock), fetchImpl (Network), log, valkey, accountSend (a stand-in for Network's internal
 * routes; tests only), telemetrySink.
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const s = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl, log });
    const sso = createSso({ config, keys, fetchImpl, now: s.now, log });
    const principal = createPrincipal({ config, keys });
    // D11 owner settings (connect.signin_apps): created before the app mounts /internal/config. A failure leaves
    // Connect serving (the sign-in apps fall back to the environment) and says why in the log.
    let settings = opts.settings || null;
    if (!settings) {
        try {
            const made = settingsLib.createSettings({ db: s.db, env: opts.env || process.env, log });
            await made.ready;
            settings = settingsLib.activate(made);
        } catch (err) {
            log.warn('[OpenVibe.Connect] owner settings unavailable, sign-in apps fall back to the environment:', err && err.message);
        }
    }
    const shares = createShares(s, { config });
    // "Tell me when it's back" (CON-17): when a share's computer connects, everyone waiting on it gets one notification.
    const notifier = opts.notifier || require('./notify').createNotifier({ config, fetchImpl, log });
    // A person's computer as OpenVibe Node (CON-4): its node token and a single-use tunnel token; its owner's machines.
    const nodeAuth = createNodeAuth({ config, keys, now: s.now });
    const machines = opts.machines || createMachines({ config, fetchImpl, log, now: s.now });
    const tunnels = createTunnels({ shares, config, log, nodeAuth, now: s.now, onConnect: async (share) => {
        // Webhooks that waited for this computer (CON-15) go at once, oldest first; Events' later retry finds them
        // settled. One that fails waits for that retry.
        ctx.deliverWaiting(share).catch((err) => log.warn('[OpenVibe.Connect] waiting webhooks not handed over:', err.message));
        // The signed probe (CON-9): once a day per share, a little after its computer connects (the app may still be
        // starting), its front page is read for the signs of a credential trap; a likely one goes to staff review.
        const probeTimer = setTimeout(() => { ctx.probe.run(share).catch(() => {}); }, ctx.probeDelayMs);
        if (probeTimer.unref) probeTimer.unref();
        const waiting = await shares.takeWaiters(share.id);
        for (const subject of waiting) await notifier.shareBack(subject, share);
        if (waiting.length) log.log(`[OpenVibe.Connect] told ${waiting.length} person(s) ${share.host} is back`);
    } });
    const gate = createGate({ config, now: s.now });
    // API keys for a share (CON-16 v0): a program passes the gate with one; it opens the share's API, never its pages.
    const apiKeys = createApiKeys(s, { now: s.now });
    const oauth = createOAuth(s, { shares, scheme: config.shares.scheme, now: s.now });
    const proxy = createProxy({ config, shares, tunnels, gate, apiKeys, oauth, log, now: s.now });

    const accountData = accountDataLib.create({ db: s.db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Connect cannot answer account events'); });

    // Hooks that wait for your computer (CON-15): a webhook and its pointer commit together; the relay (started in
    // index.js, never in drill mode) publishes the pointer to OpenVibe.Events with Connect's own token.
    const outbox = opts.outbox !== undefined ? opts.outbox : createServiceOutbox({
        db: s.db, source: 'connect', eventsUrl: config.events.url, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl, log, now: s.now,
        table: 'service_outbox', eventTypes: ['connect.hook.received'],
        validate: (env) => contracts.validate('events.event-envelope@1', env),
    });
    const hooks = createHooks(s, { config, outbox, now: s.now, log });

    const ctx = { config, s, keys, sso, principal, settings, shares, tunnels, gate, proxy, apiKeys, oauth, notifier, nodeAuth, machines, hooks, outbox, accountData, accountSend, log };
    ctx.probe = createProbe({ shares, proxy, config, log, now: s.now });
    ctx.probeDelayMs = opts.probeDelayMs != null ? opts.probeDelayMs : 10_000;

    /** A share's computer is connected: its waiting webhooks go to its app, one at a time, oldest first. → delivered count */
    ctx.deliverWaiting = async (share) => {
        let n = 0;
        for (const ref of await hooks.pending(share.id)) {
            const q = await hooks.request(ref);
            if (!q) continue;
            const out = await proxy.deliverHook(share, { method: q.method, path: q.path, headers: q.headers, body: q.body, hookId: q.hookId, eventId: q.eventId || q.ref, receivedAt: q.receivedAt });
            if (out.offline) break;
            if (!out.status || out.status >= 500) {
                await hooks.fail(q.ref, out.status || null, out.error || `the app answered ${out.status}`);
                continue;
            }
            if (await hooks.settle(q.ref, out.status)) n++;
        }
        if (n) log.log(`[OpenVibe.Connect] ${n} waiting webhook(s) handed to ${share.host}`);
        return n;
    };

    /** Shares whose time is up close themselves (CON-6): their computers are disconnected and their lists forgotten. */
    ctx.expireSweep = async () => {
        let due = [];
        try { due = await shares.expireDue(); } catch (err) { log.warn('[OpenVibe.Connect] expiry sweep failed:', err.message); return []; }
        due.forEach((r) => { tunnels.close(r.id, 4003, 'the share ended'); proxy.forget(r.host); proxy.inspector.forget(r.id); });
        if (due.length) log.log(`[OpenVibe.Connect] ${due.length} share(s) ended on time`);
        // Webhooks and delivery-log rows past their 72 hours go, delivered or not (CON-15).
        try { const gone = await hooks.sweep(); if (gone) log.log(`[OpenVibe.Connect] ${gone} webhook(s) past 72 hours removed`); } catch (err) { log.warn('[OpenVibe.Connect] webhook sweep failed:', err.message); }
        return due;
    };
    if (opts.expirySweep !== false) {
        ctx.expiryTimer = setInterval(() => { ctx.expireSweep(); }, 30_000);
        ctx.expiryTimer.unref();
    }

    /** A WebSocket upgrade: a share host goes through the gate; /tunnel on Connect's own host is a computer. */
    ctx.onUpgrade = (req, socket, head) => {
        if (proxy.isShareHost(req.headers.host)) { proxy.upgrade(req, socket, head).catch(() => socket.destroy()); return; }
        if (String(req.url || '').split('?')[0] === '/tunnel') { tunnels.handleUpgrade(req, socket, head); return; }
        socket.on('error', () => {});
        const r = rawResponder(socket);
        r.writeHead(404, { 'content-type': 'text/plain' });
        r.end('No WebSocket here.');
    };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);

    // ── Shares first: a share host's every request belongs to the share (the gate, then the tunnel). Nothing else of
    //    Connect (its pages, its API, its sign-in) answers on a share's address. ──
    app.use((req, res, next) => {
        if (!proxy.isShareHost(req.headers.host)) return next();
        return proxy.handle(req, res).catch((err) => {
            log.error('[OpenVibe.Connect] share request failed:', err && err.message);
            if (!res.headersSent) { res.statusCode = 502; res.end('Something went wrong on our side.'); } else res.destroy();
        });
    });
    // /.well-known/agent.json (openvibe-shared/agent-layer, SEO-2): what this site serves, for agents.
    // After the share hosts: a share's own /.well-known/agent.json belongs to the share.
    require('openvibe-shared/agent-layer').mount(app, { descriptor: require('./agent-descriptor') });

    const release = require('openvibe-shared/release').createRelease({ service: 'connect', root: path.join(__dirname, '..') });
    setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'connect', release: release.release });
    app.locals.metrics = metrics.registry;
    ctx.telemetry = createHttpTelemetry({ service: 'connect', sink: opts.telemetrySink || createPgTelemetrySink({ db: s.db, log }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    app.use(ctx.telemetry.middleware());
    app.locals.ctx = ctx;

    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://openvibe.chat', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                // The grant sends the browser on to a share's own address.
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use((req, res, next) => {
        const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
        const canonical = new URL(config.baseUrl).hostname;
        if (['connect.openvibe.link', 'connect.openvibe.website'].includes(host) && host !== canonical) {
            return res.redirect(302, `${config.baseUrl}${req.originalUrl}`);
        }
        return next();
    });
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-connect', name: 'OpenVibe Connect', version: VERSION, tunnels: tunnels.status() }));
    release.mount(app, { registry: metrics.registry });
    const readiness = createServiceReadiness({ s, config, release: release.release, valkey, tunnels });
    app.get('/api/ready', readiness.handler);

    // ── Who is asking (verified offline; refreshed when expired) ──
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'connect', service: 'connect', host: 'connect.openvibe.link', name: 'OpenVibe Connect', profile: 'ugc' })); }

    // ── Webhooks to a share's hooks, and Events' deliveries of them back (CON-15; /internal/ is loopback only) ──
    app.use(createHookRoutes(ctx));

    // ── D11 owner settings (openvibe-shared/config): Network's admin proxy, acting for the owner, reads and
    // writes connect.signin_apps (the outside OAuth apps). Loopback only, guarded by connect.config.manage; a
    // secret change needs X-OV-Fresh: 1, and the test route makes one cheap authenticated read per provider.
    if (settings) {
        const internalOnly = (req, res, next) => {
            if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) {
                return contracts.http.sendProblem(res, 404, 'connect.not_found', { detail: 'no such route', ctx: req.ov });
            }
            return next();
        };
        const configCapability = (req, res, next) => {
            const p = req.principal;
            if (!p || p.kind !== 'app') return contracts.http.sendProblem(res, 401, 'token.required', { detail: 'a Network service token with connect.config.manage is required', ctx: req.ov });
            const decision = contracts.capabilities.check(p.claims, 'connect.config.manage');
            const granted = decision.allowed || contracts.capabilities.grants(p.claims.cap, 'connect.config.manage');
            if (!granted) return contracts.http.sendProblem(res, 403, decision.code || 'capability.denied', { detail: decision.reason || 'connect.config.manage not granted', ctx: req.ov });
            return next();
        };
        app.use('/internal/config', express.json({ limit: '64kb' }));
        settings.mount(app, { guard: [internalOnly, principal.middleware, configCapability], log });
    }

    // ── OpenVibe.Events → this service (loopback only; nginx answers 404 for /internal/) ──
    app.use('/internal/events', accountData.consumer({
        secrets: config.events.secrets,
        send: accountSend,
        now: s.now,
        onEvent: async (ev) => `ignored:${ev.event_type}`,
    }));

    // ── Static assets (content-hashed ?v= → immutable); the client is a plain download ──
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.get('/ov-connect.js', (req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'ov-connect.js'));
    });
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: Number(process.env.CONNECT_API_RATE_LIMIT_PER_MIN) || 240, standardHeaders: true, legacyHeaders: false, handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }) }));
    app.use('/api/v1/node', createNodeApi(ctx));
    app.use('/api/v1', createApi(ctx));
    // GET /openapi.json (SEO-3): the API as OpenAPI 3.1. It is not in openvibe-contracts, so the document is read from
    // the routes this app mounts under /api/, with the summaries the API files' header comments give them
    // (server/http/openapi-routes.js).
    {
        const d = require('./agent-descriptor');
        const site = String(config.baseUrl).replace(/\/+$/, '');
        app.get('/openapi.json', require('./http/openapi-routes').openapiRoute(app, {
            title: `${d.name} API`, description: d.purpose, version: require('../package.json').version, baseUrl: site,
            docs: `${site}/llms-full.txt`,
            files: ['http/api.js', 'http/node-api.js'].map((f) => require('path').join(__dirname, f)),
        }));
    }
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.CONNECT_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));
    app.use(createOAuthRoutes(ctx));
    const pageRoutes = createPageRoutes(ctx);
    // The Markdown twins of the public pages, and the head link and Link: header that name them (SEO-1,
    // server/agent-twins.js): a twin is the page rendered signed out.
    require('./agent-twins').mountTwins(app, { router: pageRoutes, descriptor: require('./agent-descriptor'), baseUrl: ctx.config.baseUrl });
    app.use(pageRoutes);
    app.use((req, res) => sendNotFound(req, res, ctx));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[OpenVibe.Connect]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return req.path.startsWith('/api/') ? contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov }) : res.status(413).type('text/plain').send('That request was too large.');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

function sendNotFound(req, res, ctx) {
    const views = require('./views');
    const { send } = require('./render/layout');
    return send(res, 404, {
        viewer: req.viewer, config: ctx.config, path: req.originalUrl, title: 'Not found',
        body: views.notFound(), active: '/',
    });
}

module.exports = { createApp };
