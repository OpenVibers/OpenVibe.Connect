'use strict';

/**
 * OpenVibe.Connect: process entry. `node server/index.js`
 * Listens on PORT (5240) behind nginx (deploy/): connect.openvibe.link and every <label>--<user>.openvibe.link.
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startTelemetryRetention } = require('openvibe-sdk/telemetry');
const { startSubscriptions } = require('openvibe-sdk/account-data');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then the tunnels close (their computers reconnect to
 * the next process), the counters are written, the JWKS refresher stops, the store closes and the Events
 * subscriptions stop. Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'OpenVibe.Connect', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [
            () => { for (const t of timers) clearInterval(t); },
            () => ctx.tunnels.closeAll(),
            () => ctx.proxy.stop(),
            () => clearInterval(ctx.expiryTimer),
            () => ctx.gate.stop(),
            () => ctx.keys.client.stop(),
            async () => { clearInterval(ctx.telemetryTick); if (ctx.retention) await ctx.retention.stop(); if (ctx.telemetry) await ctx.telemetry.stop(); },
            () => ctx.s.close(),
            ...extra,
        ],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.Connect] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl}, shares at *--*.${config.shares.domain} (db ${ctx.s.db.store})`);
        ctx.keys.ensure().catch(() => {});
    });
    server.keepAliveTimeout = 65_000;
    // A share's request may stream for as long as its app streams (server-sent events): no overall request timeout.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.on('upgrade', ctx.onUpgrade);
    ctx.retention = startTelemetryRetention({ db: ctx.s.db, log: ctx.log || console, olderThanDays: 14 });
    ctx.telemetryTick = setInterval(() => { ctx.telemetry.flush().catch(() => {}); }, 60_000);
    ctx.telemetryTick.unref();
    ctx.keys.client.start();

    // The two account topics (export_requested, deleted) at OpenVibe.Events: idempotent; off without the URL, the
    // delivery secret and the client secret.
    const subs = config.drill ? null : startSubscriptions({
        eventsUrl: config.events.url,
        endpoint: config.events.endpoint || `http://127.0.0.1:${config.port}/internal/events`,
        secret: config.events.secrets[0] || '',
        networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        log: ctx.log || console,
    });
    // Hooks (CON-15): the outbox relay publishes webhook pointers, and Connect's own subscription brings them back to
    // /internal/hook-deliveries, retried for about 72 hours while a computer is offline. Off in drill mode and
    // without the events URL, the delivery secret and the client secret.
    const hookSubs = config.drill ? null : ensureHookSubscription({ config, log: ctx.log || console });
    if (!config.drill && ctx.outbox) ctx.outbox.start();
    const extra = [() => { if (subs) subs.stop(); }, () => { if (hookSubs) hookSubs.stop(); }, () => { if (ctx.outbox) ctx.outbox.stop(); }];
    createLifecycle({ server, ctx, extra });
    return { server, ctx };
}

// About 72 hours of retries (Events allows 20 attempts): 5 s, 30 s, 2 min, 10 min, 30 min, 1, 2, 3, 4, 6, 8 hours,
// four of 4 hours, three of 6 hours and two of 8 hours.
const HOOK_BACKOFF_MS = [5e3, 30e3, 120e3, 600e3, 1800e3, 3600e3, 7200e3, 10800e3, 14400e3, 21600e3, 28800e3,
    14400e3, 14400e3, 14400e3, 14400e3, 21600e3, 21600e3, 21600e3, 28800e3, 28800e3];

/** Connect's subscription to its own connect.hook.received, made once (409 means it is there); tried again every 10 minutes until it is. */
function ensureHookSubscription({ config, log = console, fetchImpl = globalThis.fetch }) {
    const secret = config.events.secrets[0] || '';
    if (!config.events.url || !secret || !config.oauth.clientSecret) { log.warn('[OpenVibe.Connect] webhook deliveries off: CONNECT_EVENTS_URL, CONNECT_EVENTS_SECRET or the client secret is unset'); return null; }
    const { serviceAuth } = require('openvibe-contracts');
    const tokens = serviceAuth.createTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.events', scope: 'events.subscription.manage', fetchImpl });
    let timer = null;
    let stopped = false;
    async function once() {
        try {
            const res = await fetchImpl(`${config.events.url}/api/v1/subscriptions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) },
                body: JSON.stringify({ topic_pattern: 'connect.hook.received', endpoint: `http://127.0.0.1:${config.port}/internal/hook-deliveries`, secret, retry_policy: { max_attempts: 20, backoff_ms: HOOK_BACKOFF_MS } }),
                signal: AbortSignal.timeout(10_000),
            });
            if (res.status === 201 || res.status === 409) { log.log(`[OpenVibe.Connect] webhook deliveries subscribed (${res.status})`); return; }
            log.warn(`[OpenVibe.Connect] webhook subscription not made: HTTP ${res.status}`);
        } catch (err) { log.warn(`[OpenVibe.Connect] webhook subscription not made: ${err.message}`); }
        if (!stopped) { timer = setTimeout(once, 600_000); timer.unref(); }
    }
    once();
    return { stop() { stopped = true; clearTimeout(timer); } };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.Connect] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle, ensureHookSubscription, HOOK_BACKOFF_MS };
