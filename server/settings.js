'use strict';

/**
 * Owner settings (D11) for OpenVibe.Connect: the outside sign-in apps in `connect.signin_apps`.
 *
 * Connect's apps and trigger sources sign in to Twitch, Google, Linear, Notion, Meta and Twilio with
 * an OAuth app that the owner registers. Each app has a client id and a client secret; the secret is
 * sealed by the shared store under OV_CONFIG_KEKS and is write-only through
 * /internal/config/connect.signin_apps/secrets/:key. Credentials are read at the moment a sign-in
 * starts (credentials()); the environment is the fallback. Network's admin proxy reaches this
 * namespace with `connect.config.manage`, acting for the owner (X-OV-Subject), and a secret change
 * needs X-OV-Fresh: 1. The test route makes one cheap authenticated read per provider and answers
 * ok or failed in one line, never echoing a key.
 */
const { createConfigStore, adminRoutes } = require('openvibe-shared/config');

const SERVICE = 'connect';
const NAMESPACE = 'connect.signin_apps';
const BASE_PATH = '/internal/config';
const GROUP = 'Sign-in apps';
const REDIRECT = 'https://connect.openvibe.website/auth/callback';

/**
 * One entry per outside service. `env` names the fallback variables; `test` is the one cheap
 * authenticated read the owner's Test button makes. A provider's own error text is redacted before
 * it is answered.
 */
const PROVIDERS = Object.freeze({
    twitch: {
        label: 'Twitch', feature: 'Twitch sign-in',
        unlocks: 'People can sign in with Twitch and let their agents use their Twitch account.',
        get_it_at: 'https://dev.twitch.tv/console/apps',
        get_it_how: 'Create an application, add the Connect callback URL it shows you, and paste the client ID and secret.',
        test: async ({ clientId, clientSecret, fetchImpl }) => {
            const r = await fetchImpl('https://id.twitch.tv/oauth2/token', {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
            });
            const body = await json(r);
            if (r.ok && body.access_token) return;
            throw new Error(oauthReason(body, r.status));
        },
    },
    google: {
        label: 'Google', feature: 'Google sign-in',
        unlocks: 'People can sign in with Google and let their agents use Google services.',
        get_it_at: 'https://console.cloud.google.com/apis/credentials',
        get_it_how: 'Create an OAuth client ID of type Web application, add the Connect callback URL, and paste the client ID and secret.',
        test: async ({ clientId, clientSecret, fetchImpl }) => {
            // Google has no client-credentials grant. A deliberately bad code with a good client answers
            // invalid_grant; a bad client answers invalid_client, which is the cheap authenticated check.
            const r = await fetchImpl('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: 'openvibe-test', grant_type: 'authorization_code', redirect_uri: REDIRECT }),
            });
            const body = await json(r);
            if (body.error === 'invalid_grant') return;
            throw new Error(oauthReason(body, r.status));
        },
    },
    linear: {
        label: 'Linear', feature: 'Linear sign-in',
        unlocks: 'People can sign in with Linear and let their agents read and write their Linear issues.',
        get_it_at: 'https://linear.app/settings/api/applications',
        get_it_how: 'Create an OAuth application, add the Connect callback URL, and paste its client ID and secret.',
        test: async ({ clientId, clientSecret, fetchImpl }) => {
            const r = await fetchImpl('https://api.linear.app/oauth/token', {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: 'openvibe-test', grant_type: 'authorization_code', redirect_uri: REDIRECT }),
            });
            const body = await json(r);
            if (body.error === 'invalid_grant') return;
            throw new Error(oauthReason(body, r.status));
        },
    },
    notion: {
        label: 'Notion', feature: 'Notion sign-in',
        unlocks: 'People can sign in with Notion and let their agents read and write the pages they choose.',
        get_it_at: 'https://www.notion.so/my-integrations',
        get_it_how: 'Create a public integration, set the Connect callback URL as its redirect URI, and paste the OAuth client ID and secret.',
        test: async ({ clientId, clientSecret, fetchImpl }) => {
            const r = await fetchImpl('https://api.notion.com/v1/oauth/token', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'notion-version': '2022-06-28' },
                body: JSON.stringify({ grant_type: 'authorization_code', code: 'openvibe-test', redirect_uri: REDIRECT }),
            });
            const body = await json(r);
            if (body.error === 'invalid_grant') return;
            throw new Error(oauthReason(body, r.status));
        },
    },
    meta: {
        label: 'Meta', feature: 'Meta sign-in',
        unlocks: 'People can sign in with Facebook or Instagram and let their agents use the accounts they choose.',
        get_it_at: 'https://developers.facebook.com/apps/',
        get_it_how: 'Create an app with Facebook Login, add the Connect callback URL, and paste the app ID and app secret from Settings.',
        test: async ({ clientId, clientSecret, fetchImpl }) => {
            const q = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
            const r = await fetchImpl(`https://graph.facebook.com/oauth/access_token?${q}`);
            const body = await json(r);
            if (r.ok && body.access_token) return;
            throw new Error(oauthReason(body, r.status));
        },
    },
    twilio: {
        label: 'Twilio', feature: 'Twilio sign-in',
        unlocks: 'People can sign in with Twilio and let their agents send and read messages from their Twilio account.',
        get_it_at: 'https://console.twilio.com/us1/account/keys-credentials/api-keys',
        get_it_how: 'Create a standard API key. The client ID is the account SID (AC...) or the API key SID (SK...); the secret is the auth token or API key secret.',
        test: async ({ clientId, clientSecret, fetchImpl }) => {
            const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(clientId)}.json`, {
                headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
            });
            const body = await json(r);
            if (r.ok && body.sid) return;
            throw new Error(oauthReason(body, r.status));
        },
    },
});

async function json(res) {
    try { return await res.json(); } catch { return {}; }
}

/** The provider's reason without a credential in it (a client id can appear in some OAuth errors). */
function oauthReason(body, status) {
    const s = String((body && (body.error_description || body.error && body.error.message || body.error || body.message)) || `HTTP ${status}`);
    return s.split(/\s+/).join(' ').slice(0, 160);
}

const SECRETS = new Set(Object.keys(PROVIDERS).map((p) => `${p}_client_secret`));

function field(provider, kind) {
    const p = PROVIDERS[provider];
    const secret = kind === 'secret';
    const name = `${provider}_client_${secret ? 'secret' : 'id'}`;
    return [name, {
        type: 'string',
        title: `${p.label} client ${secret ? 'secret' : 'ID'}`,
        'x-group': GROUP,
        description: secret
            ? `The OAuth client secret of the ${p.label} app. It is locked when saved and never shown again; enter it again if you rotate it at ${p.label}.`
            : `The OAuth client ID of the ${p.label} app people sign in with. It is public in the sign-in redirect, but only with the secret does it let anyone in.`,
        'x-owner-input': {
            group: GROUP,
            unlocks: p.unlocks,
            get_it_at: p.get_it_at,
            get_it_how: p.get_it_how,
            test: true,
        },
        'x-required-for': p.feature,
    }];
}

const SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Sign-in apps',
    description: 'The OAuth apps Connect uses to sign people in to outside services. An app with no client id or secret stays hidden; the others keep working.',
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(Object.keys(PROVIDERS).flatMap((p) => [field(p, 'id'), field(p, 'secret')])),
});

const ACTIVE = { settings: null };

function providerOfKey(key) {
    const m = /^([a-z]+)_client_(id|secret)$/.exec(String(key || ''));
    return m && PROVIDERS[m[1]] ? m[1] : null;
}

/** Create the connect.signin_apps store. `ready` must resolve before mount(). */
function createSettings({ db, env = process.env, log = console, fetchImpl = globalThis.fetch, probes = null } = {}) {
    let store = null;
    const ready = createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA,
        classify: (key) => (SECRETS.has(key) ? 'secret' : 'internal'),
        env, log,
    }).then((s) => { store = s; return s; });

    const values = () => (store ? store.get() : {});

    function valueOf(key, envName, fallback = '') {
        const v = values()[key];
        if (v !== undefined && v !== null && v !== '') return v;
        const e = envName ? env[envName] : undefined;
        return e !== undefined && e !== null && e !== '' ? e : fallback;
    }

    /** The app a provider signs in with, read at the moment the sign-in starts. */
    function credentials(provider) {
        const p = PROVIDERS[provider];
        if (!p) return null;
        const upper = provider.toUpperCase();
        return {
            clientId: valueOf(`${provider}_client_id`, `CONNECT_${upper}_CLIENT_ID`),
            clientSecret: valueOf(`${provider}_client_secret`, `CONNECT_${upper}_CLIENT_SECRET`),
        };
    }

    function configured(provider) {
        const c = credentials(provider);
        return Boolean(c && c.clientId && c.clientSecret);
    }

    const probeFor = (provider) => {
        const p = probes && probes[provider];
        return typeof p === 'function' ? p : (creds) => PROVIDERS[provider].test({ ...creds, fetchImpl });
    };

    /** POST /internal/config/connect.signin_apps/test/:key → { ok, detail } (one line, never a value). */
    async function test(key) {
        const provider = providerOfKey(key);
        if (!provider) return { ok: false, detail: 'That setting has no test.' };
        const creds = credentials(provider);
        if (!creds.clientId || !creds.clientSecret) return { ok: false, detail: `${PROVIDERS[provider].label} is not configured: both the client ID and its secret are needed.` };
        try {
            await probeFor(provider)(creds);
            return { ok: true, detail: `ok — ${PROVIDERS[provider].label} accepted the app credentials.` };
        } catch (err) {
            const words = String((err && err.message) || 'the provider refused the credentials').split(/\s+/).join(' ').slice(0, 160);
            const redacted = [creds.clientId, creds.clientSecret].filter((s) => s && s.length >= 4).reduce((out, s) => out.split(s).join('[redacted]'), words);
            return { ok: false, detail: `failed — ${PROVIDERS[provider].label} said: ${redacted}` };
        }
    }

    /** Mount the admin routes and the test route; `guard` is the service-token capability middleware. */
    function mount(app, { guard, log: appLog = log } = {}) {
        if (!store) throw new Error('createSettings: await ready before mount()');
        const routes = adminRoutes([store], {
            basePath: BASE_PATH,
            requireAdmin: guard,
            actor: (req) => {
                const id = String(req.get('x-ov-subject') || '').trim();
                return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? { type: 'user', id } : null;
            },
            requireFresh: (req) => String(req.get('x-ov-fresh') || '') === '1',
            log: appLog,
        });
        app.use(routes.handle);
        app.post(`${BASE_PATH}/:namespace/test/:key`, guard, async (req, res) => {
            if (req.params.namespace !== NAMESPACE) return res.status(404).json({ error: 'no such configuration namespace' });
            let key = String(req.params.key || '');
            try { key = decodeURIComponent(key); } catch { /* keep it as it is */ }
            if (!SCHEMA.properties[key]) return res.status(404).json({ error: 'no such setting' });
            try {
                const out = await test(key);
                return res.status(200).json({ ok: Boolean(out.ok), detail: String(out.detail).replace(/\s+/g, ' ').slice(0, 200) });
            } catch (err) {
                appLog.warn(`[config] ${NAMESPACE}: the test for ${key} failed: ${String((err && err.message) || err).slice(0, 160)}`);
                return res.status(200).json({ ok: false, detail: 'failed — the test did not finish. The service log has the reason.' });
            }
        });
        return routes;
    }

    return { namespace: NAMESPACE, schema: SCHEMA, providers: PROVIDERS, ready, value: valueOf, get: values, credentials, configured, test, mount };
}

function activate(settings) { ACTIVE.settings = settings; return settings; }

/** The app a provider signs in with (server/oauth-apps.js), read at use time. */
function credentials(provider) {
    if (ACTIVE.settings) return ACTIVE.settings.credentials(provider);
    const p = PROVIDERS[provider];
    if (!p) return null;
    const upper = String(provider).toUpperCase();
    return { clientId: process.env[`CONNECT_${upper}_CLIENT_ID`] || '', clientSecret: process.env[`CONNECT_${upper}_CLIENT_SECRET`] || '' };
}

module.exports = { SERVICE, NAMESPACE, SCHEMA, SECRETS, PROVIDERS, createSettings, activate, credentials, configured: (p) => { const c = credentials(p); return Boolean(c && c.clientId && c.clientSecret); } };
