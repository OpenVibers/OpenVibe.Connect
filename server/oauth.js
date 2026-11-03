'use strict';

/**
 * MCP OAuth 2.1 for shares (CON-16): an MCP client signs a person in to a share with OpenVibe, so a model or tools on
 * someone's computer can be used from Claude, an editor or any MCP client without a pasted key.
 *
 * Connect is the authorization server; each share host is a protected resource (RFC 9728):
 *
 *   https://<share>/.well-known/oauth-protected-resource   { resource, authorization_servers: [Connect] }
 *   https://connect…/.well-known/oauth-authorization-server (RFC 8414)
 *   POST /oauth/register   a public client registers itself (RFC 7591): a name and its exact redirect URIs (https, or
 *                          http on a loopback address for a desktop app)
 *   GET  /oauth/authorize  the person signs in; the share (named by `resource`, RFC 8707) must let them in by its own
 *                          policy; they see who asks and consent (POST); the client gets a code (60 s, used once,
 *                          bound to the client, the redirect URI, the PKCE S256 challenge, the share and the person)
 *   POST /oauth/token      code + verifier → an access token (ovat_, an hour) bound to that share and a refresh token
 *                          (ovrt_, 30 days, rotated on each use; an old one used again revokes the grant)
 *
 * The edge (server/edge/proxy.js) takes `Authorization: Bearer ovat_…` as the person who consented. Only hashes are kept.
 * A policy change (policy_version), the owner's revoke, the person no longer let in, or the share closing stops it.
 */
const crypto = require('crypto');

const ACCESS_TTL_MS = 3600_000;
const REFRESH_TTL_MS = 30 * 86_400_000;
const CODE_TTL_MS = 60_000;
const ACCESS_RE = /^ovat_[A-Za-z0-9_-]{43}$/;
const REFRESH_RE = /^ovrt_[A-Za-z0-9_-]{43}$/;
const CLIENT_RE = /^occ_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN_ID = /^sot_[0-9A-HJKMNP-TV-Z]{26}$/;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

class OAuthError extends Error {
    /** `error` is the RFC 6749 code a client reads; `status` the HTTP status. */
    constructor(status, error, description) { super(description); this.status = status; this.error = error; }
}

/** A redirect URI a public client may register: https anywhere, or http on a loopback address (a desktop app). */
function okRedirect(uri) {
    let u;
    try { u = new URL(String(uri)); } catch { return false; }
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
}

function createOAuth(s, { shares, scheme = 'https', now = () => Date.now() } = {}) {
    const { db } = s;
    const codes = new Map();   // code → { clientId, redirectUri, challenge, shareId, subject, username, policyVersion, exp }
    const sweep = () => { const t = now(); for (const [k, v] of codes) if (v.exp <= t) codes.delete(k); };

    async function register(input = {}) {
        const name = String(input.client_name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'An MCP client';
        const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.map(String) : [];
        if (!uris.length || uris.length > 10 || !uris.every(okRedirect) || uris.some((u) => u.length > 500)) {
            throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris: 1 to 10 exact addresses, https or http on a loopback address');
        }
        const method = input.token_endpoint_auth_method || 'none';
        if (method !== 'none') throw new OAuthError(400, 'invalid_client_metadata', 'only public clients (token_endpoint_auth_method "none", with PKCE)');
        const grants = input.grant_types || ['authorization_code', 'refresh_token'];
        if (!Array.isArray(grants) || grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) throw new OAuthError(400, 'invalid_client_metadata', 'grant_types: authorization_code, refresh_token');
        const id = s.newId('occ');
        await db.exec('INSERT INTO oauth_clients (id, name, redirect_uris) VALUES ($1, $2, $3)', [id, name, JSON.stringify(uris)]);
        return {
            client_id: id, client_id_issued_at: Math.floor(now() / 1000), client_name: name, redirect_uris: uris,
            grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
        };
    }

    async function client(id) {
        if (!CLIENT_RE.test(String(id || ''))) return null;
        const r = await db.maybe('SELECT * FROM oauth_clients WHERE id = $1', [id]);
        if (!r) return null;
        return { id: r.id, name: r.name, redirect_uris: typeof r.redirect_uris === 'string' ? JSON.parse(r.redirect_uris) : r.redirect_uris };
    }

    /** The share a `resource` names (its origin, with any path), or null. */
    async function shareFor(resource) {
        let u;
        try { u = new URL(String(resource || '')); } catch { return null; }
        if (u.protocol !== `${scheme}:`) return null;   // https in production (CONNECT_SHARE_SCHEME)
        const share = await shares.byHost(u.host.toLowerCase());
        return share && share.status === 'active' ? share : null;
    }

    /**
     * Check an authorization request (before sign-in and consent). Errors that must not redirect (an unknown client, a
     * redirect URI it did not register) throw with `direct: true`; the rest go back to the client.
     */
    async function checkRequest(q) {
        const c = await client(q.client_id);
        if (!c) throw Object.assign(new OAuthError(400, 'invalid_client', 'Unknown client_id: the app must register first.'), { direct: true });
        if (!q.redirect_uri || !c.redirect_uris.includes(String(q.redirect_uri))) throw Object.assign(new OAuthError(400, 'invalid_request', 'That redirect_uri is not one the app registered.'), { direct: true });
        if (q.response_type !== 'code') throw new OAuthError(400, 'unsupported_response_type', 'response_type must be code');
        if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(String(q.code_challenge || ''))) throw new OAuthError(400, 'invalid_request', 'PKCE with S256 is required');
        const share = await shareFor(q.resource);
        if (!share) throw new OAuthError(400, 'invalid_target', 'resource must be the address of an open share');
        return { client: c, share };
    }

    function issueCode({ client: c, share, viewer, redirectUri, challenge }) {
        sweep();
        const code = b64url(crypto.randomBytes(32));
        codes.set(code, { clientId: c.id, redirectUri, challenge, shareId: share.id, subject: viewer.subject, username: viewer.username || null, policyVersion: share.policy_version, exp: now() + CODE_TTL_MS });
        return code;
    }

    async function mintTokens({ shareId, clientId, subject, username, policyVersion }) {
        const access = `ovat_${b64url(crypto.randomBytes(32))}`;
        const refresh = `ovrt_${b64url(crypto.randomBytes(32))}`;
        const id = s.newId('sot');
        await db.exec(`INSERT INTO share_oauth_tokens (id, share_id, client_id, subject, username, policy_version, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [id, shareId, clientId, subject, username, policyVersion, sha256(access), new Date(now() + ACCESS_TTL_MS), sha256(refresh), new Date(now() + REFRESH_TTL_MS)]);
        db.exec('UPDATE oauth_clients SET last_used_at = now() WHERE id = $1', [clientId]).catch(() => {});
        return { access_token: access, token_type: 'Bearer', expires_in: Math.round(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: 'share' };
    }

    /** POST /oauth/token. */
    async function token(b = {}) {
        if (b.grant_type === 'authorization_code') {
            sweep();
            const g = codes.get(String(b.code || ''));
            if (g) codes.delete(String(b.code));
            if (!g || g.exp <= now()) throw new OAuthError(400, 'invalid_grant', 'That code is unknown, used or out of date.');
            if (b.client_id !== g.clientId || b.redirect_uri !== g.redirectUri) throw new OAuthError(400, 'invalid_grant', 'The code was given to another client or redirect_uri.');
            const verifier = String(b.code_verifier || '');
            if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(crypto.createHash('sha256').update(verifier).digest()) !== g.challenge) throw new OAuthError(400, 'invalid_grant', 'The PKCE code_verifier does not match.');
            if (b.resource) { const share = await shareFor(b.resource); if (!share || share.id !== g.shareId) throw new OAuthError(400, 'invalid_target', 'resource is not the share the code was for'); }
            return mintTokens(g);
        }
        if (b.grant_type === 'refresh_token') {
            const rt = String(b.refresh_token || '');
            if (!REFRESH_RE.test(rt)) throw new OAuthError(400, 'invalid_grant', 'That refresh token is not one of ours.');
            const r = await db.maybe('SELECT * FROM share_oauth_tokens WHERE refresh_hash = $1', [sha256(rt)]);
            if (!r || r.client_id !== b.client_id) throw new OAuthError(400, 'invalid_grant', 'That refresh token is unknown.');
            if (r.revoked_at || new Date(r.refresh_expires_at).getTime() <= now()) {
                throw new OAuthError(400, 'invalid_grant', 'That refresh token was used, revoked or is out of date: sign in again.');
            }
            const share = await shares.get(r.share_id);
            if (!share || share.status !== 'active' || share.policy_version !== Number(r.policy_version) || !shares.allows(share, { subject: r.subject, username: r.username })) {
                await db.exec('UPDATE share_oauth_tokens SET revoked_at = now() WHERE id = $1', [r.id]);
                throw new OAuthError(400, 'invalid_grant', 'The share changed who it lets in: sign in again.');
            }
            // Rotation: this row ends, a new one starts; the old refresh token used again finds a revoked row.
            await db.exec('UPDATE share_oauth_tokens SET revoked_at = now() WHERE id = $1', [r.id]);
            return mintTokens({ shareId: r.share_id, clientId: r.client_id, subject: r.subject, username: r.username, policyVersion: Number(r.policy_version) });
        }
        throw new OAuthError(400, 'unsupported_grant_type', 'grant_type is authorization_code or refresh_token');
    }

    const touched = new Map();
    /** The edge's check of `Authorization: Bearer ovat_…` for this share: { subject, username, client } or null. */
    async function check(share, accessToken) {
        if (!share || share.status !== 'active' || !ACCESS_RE.test(String(accessToken || ''))) return null;
        const r = await db.maybe(`SELECT t.*, c.name AS client_name FROM share_oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
            WHERE t.access_hash = $1 AND t.share_id = $2 AND t.revoked_at IS NULL`, [sha256(accessToken), share.id]);
        if (!r || new Date(r.access_expires_at).getTime() <= now() || Number(r.policy_version) !== share.policy_version) return null;
        if (!shares.allows(share, { subject: r.subject, username: r.username })) return null;
        const t = now();
        if (!touched.has(r.id) || t - touched.get(r.id) > 60_000) {
            touched.set(r.id, t);
            db.exec('UPDATE share_oauth_tokens SET last_used_at = now() WHERE id = $1', [r.id]).catch(() => {});
        }
        return { id: r.id, subject: r.subject, username: r.username, client: r.client_name };
    }

    /** The share's live sign-ins, for its owner: one per app and person. */
    async function list(shareId) {
        const rows = await db.many(`SELECT t.id, t.subject, t.username, t.created_at, t.last_used_at, c.name AS client_name FROM share_oauth_tokens t
            JOIN oauth_clients c ON c.id = t.client_id
            WHERE t.share_id = $1 AND t.revoked_at IS NULL AND t.refresh_expires_at > $2 ORDER BY t.created_at DESC LIMIT 50`, [shareId, new Date(now())]);
        return rows.map((r) => ({ id: r.id, client: r.client_name, username: r.username, created_at: new Date(r.created_at).toISOString(), last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null }));
    }

    async function revoke(owner, share, id) {
        if (!share || !owner || share.owner_subject !== owner.subject || !TOKEN_ID.test(String(id || ''))) throw new OAuthError(404, 'not_found', 'No such sign-in.');
        const r = await db.maybe('UPDATE share_oauth_tokens SET revoked_at = now() WHERE id = $1 AND share_id = $2 AND revoked_at IS NULL RETURNING id', [id, share.id]);
        if (!r) throw new OAuthError(404, 'not_found', 'No such sign-in.');
    }

    return { register, client, shareFor, checkRequest, issueCode, token, check, list, revoke };
}

module.exports = { createOAuth, OAuthError, okRedirect, ACCESS_RE };
