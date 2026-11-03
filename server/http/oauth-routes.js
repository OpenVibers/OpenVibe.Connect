'use strict';

/**
 * Connect as an OAuth 2.1 authorization server for MCP clients (CON-16; server/oauth.js holds the rules):
 *
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   POST /oauth/register                           RFC 7591, public clients only (20 an hour from one address)
 *   GET  /oauth/authorize                          sign in, the share's policy, then the consent page
 *   POST /oauth/authorize                          the person's answer (from this site only) → back to the client
 *   POST /oauth/token                              code + PKCE verifier, or a refresh token → tokens
 *
 * The metadata, registration and token answers carry CORS for any origin (MCP clients run in browsers too); the
 * consent is a page on connect.openvibe.website and cannot be posted from elsewhere.
 */
const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { send } = require('../render/layout');
const views = require('../views');
const { OAuthError } = require('../oauth');

function createOAuthRoutes(ctx) {
    const { config, oauth, shares, proxy } = ctx;
    const r = asyncRouter();
    const issuer = config.baseUrl;
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => Boolean(req.viewer && req.viewer.kind === 'user' && req.viewer.subject);
    const cors = (res) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', 'content-type, authorization, mcp-protocol-version'); res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); };
    const oauthError = (res, err) => { res.set('Cache-Control', 'no-store'); return res.status(err.status || 400).json({ error: err.error || 'invalid_request', error_description: err.message }); };
    const back = (redirectUri, params) => {
        const u = new URL(redirectUri);
        for (const [k, v] of Object.entries({ ...params, iss: issuer })) if (v != null && v !== '') u.searchParams.set(k, String(v));
        return u.toString();
    };

    const metadata = () => ({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['share'],
        authorization_response_iss_parameter_supported: true,
        service_documentation: `${issuer}/#mcp`,
    });
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
        r.options(p, (req, res) => { cors(res); res.status(204).end(); });
        r.get(p, (req, res) => { cors(res); res.set('Cache-Control', 'public, max-age=3600'); res.json(metadata()); });
    }

    const registered = new Map();   // address → times this hour (memory only)
    const overRegister = (req) => {
        const key = String(req.ip || ''), cut = Date.now() - 3600_000;
        const hits = (registered.get(key) || []).filter((t) => t > cut);
        if (hits.length >= 20) return true;
        hits.push(Date.now());
        registered.set(key, hits);
        if (registered.size > 10_000) registered.delete(registered.keys().next().value);
        return false;
    };
    for (const p of ['/oauth/register', '/oauth/token']) r.options(p, (req, res) => { cors(res); res.status(204).end(); });
    r.post('/oauth/register', express.json({ limit: '16kb' }), async (req, res) => {
        cors(res);
        if (overRegister(req)) return oauthError(res, new OAuthError(429, 'slow_down', 'Too many registrations from this address; try again later.'));
        try {
            const out = await oauth.register(req.body || {});
            res.set('Cache-Control', 'no-store');
            return res.status(201).json(out);
        } catch (err) {
            if (err instanceof OAuthError) return oauthError(res, err);
            throw err;
        }
    });

    const FIELDS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope'];
    const pick = (src) => Object.fromEntries(FIELDS.map((k) => [k, typeof src[k] === 'string' ? src[k].slice(0, 2000) : '']));

    /** The checked request, or an answer already sent (a page for a bad client, a redirect for the rest). */
    async function checked(req, res, q) {
        try {
            return await oauth.checkRequest(q);
        } catch (err) {
            if (!(err instanceof OAuthError)) throw err;
            if (err.direct) { page(req, res, { title: 'That sign-in link is not right', body: views.message({ title: 'That sign-in link is not right', text: `${err.message} Start again from the app.`, link: { href: '/', label: 'OpenVibe Connect' } }) }, 400); return null; }
            res.redirect(303, back(q.redirect_uri, { error: err.error, error_description: err.message, state: q.state }));
            return null;
        }
    }

    r.get('/oauth/authorize', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        const q = pick(req.query);
        const ok = await checked(req, res, q);
        if (!ok) return undefined;
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        if (!shares.allows(ok.share, req.viewer)) {
            if (proxy) proxy.denied(ok.share, req.viewer);
            return page(req, res, { title: 'Not for you', body: views.grantDenied({ share: ok.share, viewer: req.viewer }) }, 403);
        }
        // The answer redirects to the app: this page's form-action must allow that one origin, or the browser refuses
        // the redirect after the form is sent (CSP applies form-action to the redirects of a submission).
        const csp = res.get('Content-Security-Policy');
        if (csp) res.set('Content-Security-Policy', csp.replace(/form-action ([^;]*)/, (_, list) => `form-action ${list} ${new URL(q.redirect_uri).origin}`));
        return page(req, res, { title: `Let ${ok.client.name} in?`, body: views.oauthConsent({ client: ok.client, share: ok.share, viewer: req.viewer, fields: q }) });
    });

    r.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2F');
        if (!sameOrigin(req, config.baseUrl)) return page(req, res, { title: 'Not from this site', body: views.message({ title: 'That came from somewhere else', text: 'Answer on connect.openvibe.website itself.', link: { href: '/', label: 'OpenVibe Connect' } }) }, 403);
        const q = pick(req.body || {});
        const ok = await checked(req, res, q);
        if (!ok) return undefined;
        if (req.body.decision !== 'allow') return res.redirect(303, back(q.redirect_uri, { error: 'access_denied', error_description: 'The person said no.', state: q.state }));
        if (!shares.allows(ok.share, req.viewer)) return page(req, res, { title: 'Not for you', body: views.grantDenied({ share: ok.share, viewer: req.viewer }) }, 403);
        const code = oauth.issueCode({ client: ok.client, share: ok.share, viewer: req.viewer, redirectUri: q.redirect_uri, challenge: q.code_challenge });
        return res.redirect(303, back(q.redirect_uri, { code, state: q.state }));
    });

    r.post('/oauth/token', express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), async (req, res) => {
        cors(res);
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        try {
            return res.json(await oauth.token(req.body || {}));
        } catch (err) {
            if (err instanceof OAuthError) return oauthError(res, err);
            throw err;
        }
    });

    return r;
}

module.exports = { createOAuthRoutes };
