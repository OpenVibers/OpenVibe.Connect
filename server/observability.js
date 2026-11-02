'use strict';

/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready): the database is required; the Network signing key,
 * the OAuth client and Valkey are optional. The key store is warmed right after listen, so a service nobody has
 * signed in to yet is not degraded only because the first fetch had not happened.
 */
const { jwksStatus } = require('openvibe-sdk/auth');
const { createReadiness } = require('openvibe-shared/ready');

function createServiceReadiness({ s, config, valkey = null, release = null, tunnels = null }) {
    return createReadiness({
        service: 'connect',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: async () => {
                    const r = await s.db.ready();
                    return r.ok ? { ok: true, detail: r.detail } : r.error;
                },
            },
            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-caller limits count in this process only' }) },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    const statuses = jwksStatus();
                    if (!statuses.length) return 'no JWKS clients (misconfigured)';
                    const first = statuses[0];
                    if (!first.ready) return 'Network signing key not loaded yet: sign-in and the API are unavailable';
                    return { ok: true, detail: { keys: first.keys, failures: first.failures, stale: first.stale, fetched_at: first.fetchedAt } };
                },
            },
            { name: 'oauth_client', required: false, check: () => (config.oauth.clientSecret ? true : 'OV_OAUTH_CLIENT_SECRET unset: sign-in cannot complete') },
            // How many computers are connected right now (never required: zero is a fine state).
            { name: 'tunnels', required: false, check: () => (tunnels ? { ok: true, detail: tunnels.status() } : { skipped: 'no tunnel server' }) },
        ],
    });
}

module.exports = { createServiceReadiness };
