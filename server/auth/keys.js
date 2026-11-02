'use strict';

/**
 * The Network's RS256 signing key, fetched once from GET /api/.well-known/jwks on the configured internal URL and
 * kept fresh by openvibe-sdk/auth's JWKS client. Tokens are verified offline against it: the person's session token
 * (sign-in) and a person's Bearer token (the API).
 *
 * keys.get() / keys.ensure() / keys.loaded() for readiness and the SSO middleware, and verification through the
 * SDK's verifyUserToken / verifyAppToken with `jwks: <url>`. Nothing the SDK says about a failed key fetch leaves
 * this module: token.no_key answers 'signing key not loaded yet'.
 */
const sdk = require('openvibe-sdk/auth');

const KEY_UNAVAILABLE = 'signing key not loaded yet';
const DOES_NOT_VERIFY = 'token does not verify';

function publicReason(err) {
    const code = err && err.code;
    if (!code || code === 'token.no_key') return code ? KEY_UNAVAILABLE : DOES_NOT_VERIFY;
    return (err.message && String(err.message).slice(0, 200)) || DOES_NOT_VERIFY;
}

function jwksUrl(config) {
    return (config.networkInternalUrl || config.networkUrl) + '/api/.well-known/jwks';
}

function createKeyStore({ config, fetchImpl = globalThis.fetch, log = console }) {
    const url = jwksUrl(config);
    const client = sdk.jwksClient(url, { fetch: fetchImpl, log });
    let mirror = null;

    async function refreshMirror() {
        try {
            const ks = await client.keys();
            const first = ks && ks[0];
            mirror = first ? { pem: first.key.export({ type: 'spki', format: 'pem' }), count: ks.length } : null;
        } catch (err) { log.warn(`[OpenVibe.Connect] JWKS mirror refresh failed: ${err && err.message || err}`); mirror = null; }
    }
    async function ensure() { await refreshMirror(); }
    function get() { return mirror ? mirror.pem : null; }
    function loaded() { return Boolean(mirror); }

    const asMs = (v) => (typeof v === 'function' ? v() : (typeof v === 'number' ? v : Date.now()));

    async function verifyUser(token, { issuer, audience, now = Date.now() } = {}) {
        try {
            const claims = await sdk.verifyUserToken(token, { jwks: url, issuer, audience, now: asMs(now), log });
            await refreshMirror();
            return { ok: true, claims };
        } catch (err) {
            await refreshMirror();
            const code = err && err.code;
            log.warn(`[OpenVibe.Connect] user token rejected (${code || 'error'}):`, (err && err.message) || err);
            return { ok: false, reason: publicReason(err), code, expired: code === 'token.expired' };
        }
    }

    async function verifyApp(token, { issuer, audience, acceptSandbox = true, now = Date.now() } = {}) {
        try {
            const claims = await sdk.verifyAppToken(token, { jwks: url, issuer, audience, acceptSandbox, now: asMs(now), log });
            await refreshMirror();
            return { ok: true, claims };
        } catch (err) {
            await refreshMirror();
            const code = err && err.code;
            log.warn(`[OpenVibe.Connect] app token rejected (${code || 'error'}):`, (err && err.message) || err);
            return { ok: false, reason: publicReason(err), code };
        }
    }

    async function pemForToken(token) {
        let kid = null;
        try { kid = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')).kid || null; } catch { /* the guard refuses it */ }
        try {
            const ks = await client.keysForKid(kid);
            const k = (kid && ks.find((x) => x.kid === kid)) || ks[0];
            return k ? k.key.export({ type: 'spki', format: 'pem' }) : null;
        } catch { return null; }
    }

    return { ensure, get, loaded, status: client.status, verifyUser, verifyApp, pemForToken, client };
}

module.exports = { createKeyStore, jwksUrl };
