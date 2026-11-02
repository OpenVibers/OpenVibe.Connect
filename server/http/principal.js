'use strict';

/**
 * Who is calling /api/v1 — req.principal:
 *
 *   { kind: 'user', subject: 'usr_…', username, role, token, viaSession }
 *       a person: their Network user token as a Bearer, or this site's session cookie (the connect session).
 *   { kind: 'app', requester: 'app:…' | 'agent:…' | 'service:…', project, claims }
 *       a Network app, agent or service token for audience connect.openvibe.website. No Connect route needs one; the shape is
 *       kept so a future capability route can be added in one place.
 *   { kind: 'anonymous' }
 *
 * A request that presents a token is judged on that token alone: a bad one is refused, never downgraded to the
 * session or to anonymous. A write made with the session cookie must come from this site (Sec-Fetch-Site
 * same-origin, or an Origin equal to ours): another site cannot make a signed-in visitor vote, caption or report.
 */
const { serviceAuth, http, ids } = require('openvibe-contracts');

const PRINCIPAL_SUB = /^(svc|app|mod|agent):/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;

// Connect's routes are a person acting for themself. No capability.
const CAPABILITIES = [];

function decodePayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

function roleClaim(claims) {
    return typeof claims.role === 'string' && claims.role ? claims.role.slice(0, 32) : 'user';
}
function usernameClaim(claims) {
    return typeof claims.username === 'string' ? claims.username.slice(0, 64) : null;
}

function requesterOfSub(sub) {
    if (sub.startsWith('svc:')) return `service:${sub.slice(4)}`;
    return sub;
}

/** Same-origin for a signed-in write: the browser's fetch metadata, else the Origin header. */
function sameOrigin(req, baseUrl) {
    const site = String(req.get('sec-fetch-site') || '');
    if (site) return site === 'same-origin';
    const origin = req.get('origin');
    if (origin) return origin === baseUrl || origin === `${req.protocol}://${req.get('host')}`;
    return false;
}

function createPrincipal({ config, keys }) {
    async function resolve(req) {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const token = header.slice(7).trim();
            const payload = decodePayload(token);
            if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
                const publicKey = await keys.pemForToken(token);
                if (!publicKey) return { error: [503, 'identity.unavailable', 'the Network signing key is not loaded yet'] };
                const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkIssuer, audience: config.audience });
                if (!r.ok) return { error: [401, r.code || 'token.invalid', r.reason || 'the token does not verify'] };
                const project = typeof r.claims.project_id === 'string' && PROJECT_RE.test(r.claims.project_id) ? r.claims.project_id : null;
                return { principal: { kind: 'app', requester: requesterOfSub(r.claims.sub), project, claims: r.claims } };
            }
            const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: config.oauth.sessionAudience });
            if (!v.ok) return { error: [401, v.expired ? 'token.expired' : 'token.invalid', v.reason] };
            if (v.claims.typ === 'fedcm' || v.claims.actor_type !== undefined) return { error: [401, 'token.invalid', 'not a person\'s token'] };
            if (!ids.isSubjectId('user', v.claims.subject_id)) return { error: [403, 'identity.no_subject', 'this account has no canonical subject yet; sign in again'] };
            return { principal: { kind: 'user', subject: v.claims.subject_id, requester: `user:${v.claims.subject_id}`, project: null, role: roleClaim(v.claims), username: usernameClaim(v.claims), token, viaSession: false } };
        }
        const viewer = req.viewer;
        if (viewer && viewer.kind === 'user' && ids.isSubjectId('user', viewer.subject)) {
            return { principal: { kind: 'user', subject: viewer.subject, requester: `user:${viewer.subject}`, project: null, role: viewer.role || 'user', username: viewer.username || null, token: viewer.token, viaSession: true } };
        }
        return { principal: { kind: 'anonymous' } };
    }

    async function middleware(req, res, next) {
        const r = await resolve(req);
        if (r.error) return http.sendProblem(res, r.error[0], r.error[1], { detail: r.error[2], ctx: req.ov });
        req.principal = r.principal;
        return next();
    }

    function require_(cap) {
        if (!CAPABILITIES.includes(cap)) throw new Error(`requireCapability(${cap}): not one of OpenVibe.Connect's capabilities`);
        return function guard(req, res, next) {
            if (req.principal.kind === 'anonymous') return http.sendProblem(res, 401, 'token.required', { detail: 'Sign in at connect.openvibe.website, or send a person\'s Network token as a Bearer.', ctx: req.ov });
            if (req.principal.kind === 'user') {
                if (req.principal.viaSession && req.method !== 'GET' && !sameOrigin(req, config.baseUrl)) return http.sendProblem(res, 403, 'connect.cross_site', { detail: 'A signed-in request that changes something must come from connect.openvibe.website itself.', ctx: req.ov });
                return next();
            }
            return http.sendProblem(res, 403, 'connect.person_required', { detail: 'This route is for a person, not an app.', ctx: req.ov });
        };
    }

    /** A person (session cookie or Bearer); a write made with the session must come from this site. */
    function requirePerson(req, res, next) {
        if (req.principal.kind === 'user') {
            if (req.principal.viaSession && req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req, config.baseUrl)) {
                return http.sendProblem(res, 403, 'connect.cross_site', { detail: 'A signed-in request that changes something must come from connect.openvibe.website itself.', ctx: req.ov });
            }
            return next();
        }
        if (req.principal.kind === 'app') return http.sendProblem(res, 403, 'connect.person_required', { detail: 'This route is for a person, not an app or a service.', ctx: req.ov });
        return http.sendProblem(res, 401, 'token.required', { detail: 'Sign in at connect.openvibe.website, or send a person\'s Network token as a Bearer.', ctx: req.ov });
    }

    return { middleware, resolve, requireCapability: require_, requirePerson };
}

module.exports = { createPrincipal, CAPABILITIES, decodePayload, sameOrigin };
