'use strict';

/**
 * A person's computer, as OpenVibe Node (CON-4, ADR-057 decision 4). Two credentials, both checked:
 *
 *   1. its Network node token: an RS256 service token whose subject is node:<nod_…> (actor_type node), for audience
 *      openvibe.website, 300 s. Network issues it to any active machine a person owns (Network #538);
 *   2. a tunnel token Connect mints for one share and that computer: `ovt_` + 32 random bytes, 60 s, one use. It is
 *      kept in memory as a SHA-256 hash only, never logged, stored or put in an event.
 *
 *   verify(token)                  → { ok, node, exp } | { ok: false, status, code, reason }
 *   mint(shareId, node)            → { token, expires_in }
 *   redeem(token, shareId, node)   → true once, for that share and computer, within 60 s; any other try spends it
 */
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

const NODE_SUB = /^node:(nod_[0-9A-HJKMNP-TV-Z]{26})$/;
const NODE_ID = /^nod_[0-9A-HJKMNP-TV-Z]{26}$/;
const TUNNEL_RE = /^ovt_[A-Za-z0-9_-]{43}$/;
const TUNNEL_TTL_MS = 60_000;
const MAX_TICKETS = 10_000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function createNodeAuth({ config, keys, now = () => Date.now() }) {
    async function verify(token) {
        if (typeof token !== 'string' || token.split('.').length !== 3) return { ok: false, status: 401, code: 'token.malformed', reason: 'not a node token' };
        const publicKey = await keys.pemForToken(token);
        if (!publicKey) return { ok: false, status: 503, code: 'identity.unavailable', reason: 'the Network signing key is not loaded yet' };
        const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkIssuer, audience: config.audience, now: now() });
        if (!r.ok) return { ok: false, status: 401, code: r.code || 'token.invalid', reason: r.reason || 'the token does not verify' };
        const m = NODE_SUB.exec(String(r.claims.sub || ''));
        if (!m || r.claims.actor_type !== 'node') return { ok: false, status: 401, code: 'token.not_node', reason: 'this is not a computer\'s node token' };
        return { ok: true, node: m[1], exp: Number(r.claims.exp) * 1000 };
    }

    const tickets = new Map();   // sha256(token) → { shareId, node, exp }
    function mint(shareId, node) {
        const t = now();
        for (const [k, v] of tickets) if (v.exp <= t) tickets.delete(k);
        while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
        const token = `ovt_${crypto.randomBytes(32).toString('base64url')}`;
        tickets.set(sha256(token), { shareId, node, exp: t + TUNNEL_TTL_MS });
        return { token, expires_in: TUNNEL_TTL_MS / 1000 };
    }
    function redeem(token, shareId, node) {
        if (typeof token !== 'string' || !TUNNEL_RE.test(token)) return false;
        const k = sha256(token);
        const v = tickets.get(k);
        if (!v) return false;
        tickets.delete(k);
        return v.exp > now() && v.shareId === shareId && v.node === node;
    }

    return { verify, mint, redeem, TUNNEL_TTL_MS, pending: () => tickets.size };
}

module.exports = { createNodeAuth, NODE_ID, NODE_SUB, TUNNEL_TTL_MS };
