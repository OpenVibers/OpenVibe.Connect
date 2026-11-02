'use strict';

/**
 * OpenVibe.Connect: process entry. `node server/index.js`
 * Listens on PORT (5240) behind nginx (deploy/): connect.openvibe.website and every <label>--<user>.openvibe.website.
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
    const extra = [() => { if (subs) subs.stop(); }];
    createLifecycle({ server, ctx, extra });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.Connect] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
