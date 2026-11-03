'use strict';

/**
 * Hooks that wait for your computer (CON-15, ADR-057 decision 7). A hook is an address a provider sends webhooks to,
 * https://connect.openvibe.website/h/<hk_…>, bound to one share and a path on the computer's app. A webhook is kept
 * (7 days) and a pointer to it is published as connect.hook.received through the outbox, in one transaction. Events
 * delivers it to Connect's own subscription (retried for up to seven days), and Connect hands it to the share's
 * computer when it is connected. The computer may be asleep for days and still get every webhook, in order of arrival
 * or not, each once it answers.
 *
 *   create(owner, share, { path, label }) → hook          list(shareId) → hooks       remove(owner, id)
 *   get(id)                                                receive(hook, { method, headers, body }) → { ref }
 *   request(ref) → the stored request with its hook       settle(ref, status)         sweep() → rows removed
 */
const crypto = require('crypto');

const HOOK_ID = /^hk_[0-9A-HJKMNP-TV-Z]{26}$/;
const REF_RE = /^hb_[A-Za-z0-9_-]{16,64}$/;
const PATH_RE = /^\/[\x21-\x7e]{0,499}$/;
const METHODS = ['POST', 'PUT', 'PATCH'];
const KEEP_MS = 7 * 86400_000;
const MAX_BODY = 1024 * 1024;
const PER_SHARE = 10;
// The provider headers a webhook keeps: what apps check signatures and events with. Never cookies, authorization,
// forwarding or Cloudflare headers, and never Connect's own.
const DROP = /^(x-forwarded-|x-real-ip$|x-openvibe-|cf-|x-amz-cf-)/;
const KEEP = /^(content-type|content-encoding|user-agent|stripe-signature|svix-.+|webhook-.+|x-.+)$/;

class HookError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** The headers a stored webhook keeps: at most 40, each at most 2 KB. → [[name, value]] */
function keepHeaders(headers) {
    const out = [];
    for (const [k, v] of Object.entries(headers || {})) {
        const name = String(k).toLowerCase();
        if (DROP.test(name) || !KEEP.test(name)) continue;
        const value = Array.isArray(v) ? v.join(', ') : String(v);
        if (value.length > 2048) continue;
        out.push([name, value]);
        if (out.length >= 40) break;
    }
    return out;
}

function createHooks(s, { config, outbox = null, now = () => Date.now() }) {
    const { db } = s;
    const base = config.baseUrl;
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    const view = (r) => r && ({
        id: r.id, share_id: r.share_id, url: `${base}/h/${r.id}`, local_path: r.local_path, label: r.label || null, status: r.status,
        created_at: iso(r.created_at), received: Number(r.received || 0), delivered: Number(r.delivered || 0),
        last_received_at: iso(r.last_received_at), last_delivered_at: iso(r.last_delivered_at), last_status: r.last_status == null ? null : Number(r.last_status),
        waiting: r.waiting == null ? undefined : Number(r.waiting),
    });

    async function get(id) {
        if (!HOOK_ID.test(String(id || ''))) return null;
        return view(await db.maybe('SELECT * FROM share_hooks WHERE id = $1', [id]));
    }

    async function list(shareId) {
        const rows = await db.many(`SELECT h.*, (SELECT count(*)::int FROM hook_requests r WHERE r.hook_id = h.id AND r.delivered_at IS NULL AND r.expires_at > now()) AS waiting
                                      FROM share_hooks h WHERE h.share_id = $1 AND h.status = 'active' ORDER BY h.created_at`, [shareId]);
        return rows.map(view);
    }

    async function create(owner, share, input = {}) {
        if (!share || share.owner_subject !== owner.subject) throw new HookError(404, 'share.not_found', 'No such share.');
        if (share.status !== 'active') throw new HookError(410, 'share.revoked', 'That share is closed.');
        const localPath = String(input.path || '').trim() || '/';
        if (!PATH_RE.test(localPath)) throw new HookError(422, 'hook.invalid_path', 'The path on your app starts with "/" and has no spaces, like /webhooks/github.');
        const label = input.label ? String(input.label).trim().slice(0, 80) || null : null;
        const n = await db.one("SELECT count(*)::int AS n FROM share_hooks WHERE share_id = $1 AND status = 'active'", [share.id]);
        if (n.n >= PER_SHARE) throw new HookError(409, 'hook.limit', `A share can have ${PER_SHARE} webhook addresses. Remove one first.`);
        const id = s.newId('hk');
        await db.exec('INSERT INTO share_hooks (id, share_id, owner_subject, label, local_path) VALUES ($1, $2, $3, $4, $5)', [id, share.id, owner.subject, label, localPath]);
        return get(id);
    }

    async function remove(owner, id) {
        const hook = await db.maybe('SELECT * FROM share_hooks WHERE id = $1', [String(id || '')]);
        if (!hook || hook.owner_subject !== owner.subject) throw new HookError(404, 'hook.not_found', 'No such webhook address.');
        await db.exec("UPDATE share_hooks SET status = 'removed', removed_at = now() WHERE id = $1", [hook.id]);
        await db.exec('DELETE FROM hook_requests WHERE hook_id = $1 AND delivered_at IS NULL', [hook.id]);
        return view({ ...hook, status: 'removed' });
    }

    /** A webhook arrived: kept, and its pointer published, together. → { ref } */
    async function receive(hook, { method, headers, body }) {
        if (!METHODS.includes(method)) throw new HookError(405, 'hook.method', 'A webhook address takes POST, PUT or PATCH.');
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body));
        if (buf.length > MAX_BODY) throw new HookError(413, 'hook.too_large', 'A webhook is at most 1 MB.');
        const kept = keepHeaders(headers);
        const contentType = (kept.find(([k]) => k === 'content-type') || [null, null])[1];
        const ref = `hb_${crypto.randomBytes(18).toString('base64url')}`;
        const at = new Date(now());
        await s.tx(async (t) => {
            await t.exec('INSERT INTO hook_requests (id, hook_id, method, headers, body, received_at, expires_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)',
                [ref, hook.id, method, JSON.stringify(kept), buf, at.toISOString(), new Date(at.getTime() + KEEP_MS).toISOString()]);
            await t.exec('UPDATE share_hooks SET received = received + 1, last_received_at = $2 WHERE id = $1', [hook.id, at.toISOString()]);
            if (outbox) {
                await outbox.emitIn(t, {
                    event_type: 'connect.hook.received', version: 1, source: 'connect',
                    actor: { type: 'service', id: 'connect' }, subject: { type: 'connect.hook', id: hook.id },
                    visibility: 'internal', priority: 'important',
                    payload: { hook_id: hook.id, share_id: hook.share_id, body_ref: ref, method, size: buf.length, content_type: contentType ? String(contentType).slice(0, 200) : null, received_at: at.toISOString() },
                });
            }
        });
        if (outbox && outbox.kick) outbox.kick().catch(() => {});
        return { ref };
    }

    /** The stored request a delivery points at, with its hook; null when it was delivered, removed or expired. */
    async function request(ref) {
        if (!REF_RE.test(String(ref || ''))) return null;
        const r = await db.maybe(`SELECT r.*, h.share_id, h.local_path, h.status AS hook_status FROM hook_requests r JOIN share_hooks h ON h.id = r.hook_id
                                   WHERE r.id = $1`, [ref]);
        if (!r || r.hook_status !== 'active' || r.delivered_at || new Date(r.expires_at).getTime() <= now()) return null;
        return { ref: r.id, hookId: r.hook_id, shareId: r.share_id, path: r.local_path, method: r.method, headers: Array.isArray(r.headers) ? r.headers : [], body: r.body };
    }

    /** The computer's app answered: the request is delivered (its body is dropped) and the hook counts it. */
    async function settle(ref, status) {
        const at = new Date(now()).toISOString();
        const r = await db.maybe("UPDATE hook_requests SET delivered_at = $2, status = $3, body = ''::bytea WHERE id = $1 AND delivered_at IS NULL RETURNING hook_id", [ref, at, status]);
        if (r) await db.exec('UPDATE share_hooks SET delivered = delivered + 1, last_delivered_at = $2, last_status = $3 WHERE id = $1', [r.hook_id, at, status]);
        return Boolean(r);
    }

    /** Requests older than 7 days go, delivered or not. */
    async function sweep() {
        const r = await db.many('DELETE FROM hook_requests WHERE expires_at <= $1 RETURNING id', [new Date(now()).toISOString()]);
        return r.length;
    }

    return { get, list, create, remove, receive, request, settle, sweep, KEEP_MS, MAX_BODY };
}

module.exports = { createHooks, HookError, keepHeaders, HOOK_ID, METHODS, MAX_BODY, KEEP_MS };
