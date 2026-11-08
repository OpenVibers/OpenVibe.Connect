'use strict';

/**
 * OpenVibe.Connect configuration (connect.openvibe.link). Every value comes from the environment (production:
 * /etc/openvibe/connect.env, see .env.example). Only environment variable NAMES appear in code and docs; secrets are
 * never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const bool = (v, def = false) => (v == null ? def : v === '1' || v === 'true' || v === 'yes');

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5240);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://connect.openvibe.link' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'connect',
        room: 'website',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        drill: bool(env.CONNECT_DRILL),

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used.
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.CONNECT_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:connect:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        // The registered service/admin audience stays Website; node audiences are independent.
        audience: env.CONNECT_AUDIENCE || 'openvibe.website',
        // Old binaries still request the Website audience during the transition.
        nodeAudiences: [...new Set([env.CONNECT_AUDIENCE || 'openvibe.link', 'openvibe.link', 'openvibe.website'])],
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'connect',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Events → this service's account export/deletion route (comma-separated for rotation).
        events: {
            secrets: String(env.CONNECT_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
            url: trim(env.CONNECT_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.CONNECT_EVENTS_ENDPOINT || '',
        },

        // The shares. A share answers at https://<label>--<user>.<shareDomain>. The session secret signs the
        // visitor's host-only cookie on a share host and is required in production (32+ characters).
        shares: {
            domain: String(env.CONNECT_SHARE_DOMAIN || 'openvibe.link').toLowerCase(),
            domains: [...new Set([env.CONNECT_SHARE_DOMAIN || 'openvibe.link', ...(env.CONNECT_SHARE_DOMAINS || 'openvibe.link,openvibe.website').split(',')].map((s) => s.trim().toLowerCase()).filter(Boolean))],
            // Enable only after DNS, wildcard TLS and the new vhost have been proved.
            redirectLegacy: bool(env.CONNECT_REDIRECT_LEGACY),
            scheme: env.CONNECT_SHARE_SCHEME || (isProduction ? 'https' : 'http'),
            sessionSecret: env.CONNECT_SESSION_SECRET || (isProduction ? '' : 'development-only-session-secret-0123456789'),
            sessionHours: Math.max(1, Math.min(72, int(env.CONNECT_SESSION_HOURS, 12))),
            perPerson: Math.max(1, Math.min(50, int(env.CONNECT_SHARES_PER_PERSON, 5))),
            // Per share: requests at once, a request body's size, and how long a request may take end to end.
            maxStreams: Math.max(1, Math.min(1000, int(env.CONNECT_MAX_STREAMS, 64))),
            maxBodyBytes: Math.max(1024, int(env.CONNECT_MAX_BODY_BYTES, 100 * 1024 * 1024)),
            requestTimeoutMs: Math.max(1000, int(env.CONNECT_REQUEST_TIMEOUT_MS, 120_000)),
            // A share's requests per minute, and the bytes a person's shares may move in a day (both directions).
            perMinute: Math.max(1, int(env.CONNECT_REQUESTS_PER_MINUTE, 1200)),
            bytesPerDay: Math.max(1024 * 1024, int(env.CONNECT_BYTES_PER_DAY, 10 * 1024 * 1024 * 1024)),
        },
        // The tunnel: how often the server pings an idle tunnel (Cloudflare closes a WebSocket idle for 100 s), and
        // how long a client has to say hello.
        tunnel: {
            pingMs: Math.max(1000, int(env.CONNECT_PING_MS, 25_000)),
            helloMs: Math.max(500, int(env.CONNECT_HELLO_MS, 10_000)),
        },
    };
}

module.exports = { load };
