'use strict';

/**
 * The gate in front of every share: who may open it, and how a visitor's browser proves it on a share host.
 *
 * A share host is another origin (agents--alex.openvibe.website), and openvibe.website is not on the Public Suffix
 * List yet, so the gate keeps every cookie host-only and signs it itself:
 *
 *   1. A visitor without a valid cookie is sent to https://connect.openvibe.website/grant?share=<id>&next=<path>.
 *   2. There, signed in to OpenVibe (sign-in happens first if needed), the share's policy is checked. A person it lets
 *      in gets a one-time code (60 seconds, used once, bound to that share) and goes back to
 *      https://<share host>/__ovc/callback?code=…&next=….
 *   3. The share host swaps the code for its own cookie: `__Host-ovc` (Secure, HttpOnly, SameSite=Lax, Path=/, no
 *      Domain), an HMAC-signed { share, subject, username, policy version, expiry }.
 *
 * A policy change bumps the share's policy_version, so every cookie made before it stops working on the next request
 * and its holder goes through the grant again (the owner never notices: they are let straight back in).
 */
const crypto = require('crypto');

const CODE_TTL_MS = 60_000;

function createGate({ config, now = () => Date.now() }) {
    const secret = config.shares.sessionSecret;
    if (!secret || secret.length < 32) throw new Error('CONNECT_SESSION_SECRET must be set (32+ characters): it signs the visitors\' cookies on share hosts');
    const cookieName = config.cookies.secure !== false ? '__Host-ovc' : 'ovc';
    const codes = new Map();   // code → { shareId, subject, username, exp }

    const sweeper = setInterval(() => {
        const t = now();
        for (const [k, v] of codes) if (v.exp <= t) codes.delete(k);
    }, 30_000);
    sweeper.unref();

    const mac = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

    function sign({ shareId, subject, username, policyVersion }) {
        const exp = now() + config.shares.sessionHours * 3600_000;
        const data = Buffer.from(JSON.stringify({ s: shareId, u: subject, n: username || null, v: policyVersion, e: exp })).toString('base64url');
        return `${data}.${mac(data)}`;
    }

    /** The cookie's claims when it is ours, unexpired and for this share at this policy version; else null. */
    function verify(value, share) {
        if (typeof value !== 'string' || value.length > 2048) return null;
        const dot = value.lastIndexOf('.');
        if (dot <= 0) return null;
        const data = value.slice(0, dot);
        const sig = value.slice(dot + 1);
        const want = mac(data);
        if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
        let c;
        try { c = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
        if (!c || c.s !== share.id || c.v !== share.policy_version || !(c.e > now())) return null;
        return { subject: c.u, username: c.n };
    }

    function cookieHeader(value) {
        const maxAge = config.shares.sessionHours * 3600;
        return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookies.secure !== false ? '; Secure' : ''}`;
    }
    const clearCookieHeader = () => `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.cookies.secure !== false ? '; Secure' : ''}`;

    /** Our cookie's value from a Cookie header, and the header without it (what the local app receives). */
    function splitCookies(header) {
        let ours = null;
        const rest = [];
        for (const part of String(header || '').split(';')) {
            const p = part.trim();
            if (!p) continue;
            const eq = p.indexOf('=');
            const name = eq < 0 ? p : p.slice(0, eq);
            if (name === cookieName || name === '__Host-ovc' || name === 'ovc') { if (name === cookieName) ours = eq < 0 ? '' : p.slice(eq + 1); continue; }
            rest.push(p);
        }
        return { ours, rest: rest.join('; ') };
    }

    function mintCode({ shareId, subject, username }) {
        const code = crypto.randomBytes(24).toString('base64url');
        codes.set(code, { shareId, subject, username, exp: now() + CODE_TTL_MS });
        return code;
    }
    function redeemCode(code, shareId) {
        if (typeof code !== 'string') return null;
        const v = codes.get(code);
        if (!v) return null;
        codes.delete(code);
        if (v.exp <= now() || v.shareId !== shareId) return null;
        return v;
    }

    /** A path on the share host to go back to: a local path only (never another host, never "//"). */
    function safeNext(next) {
        const s = typeof next === 'string' ? next : '/';
        if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\r\n\t]/.test(s) || s.length > 2000) return '/';
        if (s.startsWith('/__ovc/')) return '/';
        return s;
    }

    return { sign, verify, cookieHeader, clearCookieHeader, splitCookies, mintCode, redeemCode, safeNext, cookieName, stop: () => clearInterval(sweeper), CODE_TTL_MS };
}

module.exports = { createGate, CODE_TTL_MS };
