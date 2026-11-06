'use strict';

/**
 * Hooks that wait for your computer (CON-15, ADR-057 decision 7). A hook is an address a provider sends webhooks to,
 * https://connect.openvibe.website/h/<hk_…>, bound to one share and a path on the computer's app. A webhook is kept
 * (72 hours) and a pointer to it is published as connect.hook.received through the outbox, in one transaction. Events
 * delivers it to Connect's own subscription (retried for up to 72 hours), and Connect hands it to the share's
 * computer when it is connected. The computer may be asleep for days and still get every webhook, in order of arrival,
 * each once it answers. A share's queue holds at most 1,000 undelivered webhooks, and each body is sealed at rest.
 *
 *   create(owner, share, { path, label }) → hook          list(shareId) → hooks       remove(owner, id)
 *   get(id)                                                receive(hook, { method, headers, body }) → { ref }
 *   request(ref) → the stored request with its hook       settle(ref, status)         fail(ref, status, error)
 *   pending(shareId) → its undelivered refs, oldest first (handed over one at a time when its computer connects)
 *   deliveries(shareId, hookId?) → the owner's delivery log            sweep() → rows removed
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');

const HOOK_ID = /^hk_[0-9A-HJKMNP-TV-Z]{26}$/;
const REF_RE = /^hb_[A-Za-z0-9_-]{16,64}$/;
const PATH_RE = /^\/[\x21-\x7e]{0,499}$/;
const METHODS = ['POST', 'PUT', 'PATCH'];
const KEEP_MS = 72 * 3600_000;
const MAX_BODY = 1024 * 1024;
const MAX_WAITING = 1000;
const PER_SHARE = 10;
// The request headers a webhook keeps: everything but the hop-by-hop headers, forwarding and Cloudflare headers, and
// credentials (a provider's cookie or Authorization header is not the app's). Signatures and event names are kept.
const DROP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
    'upgrade', 'host', 'content-length', 'cookie', 'cookie2', 'authorization', 'forwarded', 'x-real-ip', 'cdn-loop', 'true-client-ip']);
const DROP_RE = /^(x-forwarded-|x-openvibe-|cf-|x-amz-cf-)/;

// A sealed body starts with this magic; a row written before sealing has no magic and is read as it is until the next
// sweep seals it.
const SEAL_MAGIC = Buffer.from('OVC1');
const SEAL_IV = 12;
const SEAL_TAG = 16;

class HookError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** The key that seals a webhook body: derived from the session secret, never stored. */
function bodyKey(secret) {
    if (!secret) throw new Error('CONNECT_SESSION_SECRET is not set: a webhook body cannot be sealed');
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret)), Buffer.from('openvibe-connect'), 'hook-body-v1', 32));
}

function sealBody(key, hookId, ref, body) {
    const iv = crypto.randomBytes(SEAL_IV);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`connect.hook|${hookId}|${ref}`));
    const sealed = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([SEAL_MAGIC, iv, cipher.getAuthTag(), sealed]);
}

/** → { body, sealed }. A body written before sealing has no magic and is returned as it is. */
function openBody(key, hookId, ref, blob) {
    const b = Buffer.from(blob || []);
    if (b.length < SEAL_MAGIC.length + SEAL_IV + SEAL_TAG || !b.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)) {
        return { body: b, sealed: false };
    }
    const iv = b.subarray(SEAL_MAGIC.length, SEAL_MAGIC.length + SEAL_IV);
    const tag = b.subarray(SEAL_MAGIC.length + SEAL_IV, SEAL_MAGIC.length + SEAL_IV + SEAL_TAG);
    const sealed = b.subarray(SEAL_MAGIC.length + SEAL_IV + SEAL_TAG);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`connect.hook|${hookId}|${ref}`));
    decipher.setAuthTag(tag);
    return { body: Buffer.concat([decipher.update(sealed), decipher.final()]), sealed: true };
}

/** The headers a stored webhook keeps: at most 40, each at most 2 KB. → [[name, value]] */
function keepHeaders(headers) {
    const out = [];
    for (const [k, v] of Object.entries(headers || {})) {
        const name = String(k).toLowerCase();
        if (DROP.has(name) || DROP_RE.test(name)) continue;
        const value = Array.isArray(v) ? v.join(', ') : String(v);
        if (value.length > 2048) continue;
        out.push([name, value]);
        if (out.length >= 40) break;
    }
    return out;
}

function createHooks(s, { config, outbox = null, now = () => Date.now(), log = console } = {}) {
    const { db } = s;
    const base = config.baseUrl;
    const key = bodyKey(config.shares && config.shares.sessionSecret);
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    const view = (r, recent) => r && ({
        id: r.id, share_id: r.share_id, url: `${base}/h/${r.id}`, local_path: r.local_path, label: r.label || null, status: r.status,
        created_at: iso(r.created_at), received: Number(r.received || 0), delivered: Number(r.delivered || 0),
        last_received_at: iso(r.last_received_at), last_delivered_at: iso(r.last_delivered_at), last_status: r.last_status == null ? null : Number(r.last_status),
        waiting: r.waiting == null ? undefined : Number(r.waiting),
        deliveries: recent === undefined ? undefined : recent,
    });
    const delivery = (d) => ({
        id: Number(d.id), hook_id: d.hook_id, request_id: d.request_id || null, event_id: d.event_id || null,
        method: d.method, path: d.path, status: d.status == null ? null : Number(d.status), error: d.error || null,
        received_at: iso(d.received_at), delivered_at: iso(d.delivered_at), created_at: iso(d.created_at),
    });

    async function get(id) {
        if (!HOOK_ID.test(String(id || ''))) return null;
        return view(await db.maybe('SELECT * FROM share_hooks WHERE id = $1', [id]));
    }

    async function list(shareId) {
        const rows = await db.many(`SELECT h.*, (SELECT count(*)::int FROM hook_requests r WHERE r.hook_id = h.id AND r.delivered_at IS NULL AND r.expires_at > now()) AS waiting
                                      FROM share_hooks h WHERE h.share_id = $1 AND h.status = 'active' ORDER BY h.created_at`, [shareId]);
        const recent = await db.many(`SELECT id, hook_id, request_id, event_id, method, path, status, error, received_at, delivered_at, created_at
                                        FROM hook_deliveries WHERE share_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [shareId]);
        const byHook = new Map();
        for (const d of recent) {
            const arr = byHook.get(d.hook_id) || [];
            if (arr.length < 5) arr.push(delivery(d));
            byHook.set(d.hook_id, arr);
        }
        return rows.map((r) => view(r, byHook.get(r.id) || []));
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

    /** A webhook arrived: sealed, queued under the share's cap, and its pointer published, together. → { ref } */
    async function receive(hook, { method, headers, body }) {
        if (!METHODS.includes(method)) throw new HookError(405, 'hook.method', 'A webhook address takes POST, PUT or PATCH.');
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body));
        if (buf.length > MAX_BODY) throw new HookError(413, 'hook.too_large', 'A webhook is at most 1 MB.');
        const kept = keepHeaders(headers);
        const contentType = (kept.find(([k]) => k === 'content-type') || [null, null])[1];
        const ref = `hb_${crypto.randomBytes(18).toString('base64url')}`;
        const at = new Date(now());
        // The event's id is chosen here and kept with the request: the app sees the same x-openvibe-event-id however
        // the webhook reaches it (handed over on connect, or Events' retry).
        const eventId = ids.newId('event');
        const sealed = sealBody(key, hook.id, ref, buf);
        await s.tx(async (t) => {
            // One row lock per share makes the queue cap exact while two providers post at once.
            await t.exec('SELECT id FROM shares WHERE id = $1 FOR UPDATE', [hook.share_id]);
            const q = await t.one(`SELECT count(*)::int AS n FROM hook_requests r JOIN share_hooks h ON h.id = r.hook_id
                                    WHERE h.share_id = $1 AND r.delivered_at IS NULL AND r.expires_at > $2`, [hook.share_id, at.toISOString()]);
            if (q.n >= MAX_WAITING) throw new HookError(429, 'hook.queue_full', `This share is holding ${MAX_WAITING} webhooks already; they go to the computer first.`);
            await t.exec('INSERT INTO hook_requests (id, hook_id, method, headers, body, received_at, expires_at, event_id) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)',
                [ref, hook.id, method, JSON.stringify(kept), sealed, at.toISOString(), new Date(at.getTime() + KEEP_MS).toISOString(), eventId]);
            await t.exec('UPDATE share_hooks SET received = received + 1, last_received_at = $2 WHERE id = $1', [hook.id, at.toISOString()]);
            if (outbox) {
                await outbox.emitIn(t, {
                    event_id: eventId, event_type: 'connect.hook.received', version: 1, source: 'connect',
                    actor: { type: 'service', id: 'connect' }, subject: { type: 'connect.hook', id: hook.id },
                    visibility: 'internal', priority: 'important',
                    payload: { hook_id: hook.id, share_id: hook.share_id, body_ref: ref, method, size: buf.length, content_type: contentType ? String(contentType).slice(0, 200) : null, received_at: at.toISOString() },
                });
            }
        });
        if (outbox && outbox.kick) outbox.kick().catch(() => {});
        return { ref };
    }

    /** The stored request a delivery points at, with its hook and its original arrival time; null when it is gone. */
    async function request(ref) {
        if (!REF_RE.test(String(ref || ''))) return null;
        const r = await db.maybe(`SELECT r.*, h.share_id, h.local_path, h.status AS hook_status FROM hook_requests r JOIN share_hooks h ON h.id = r.hook_id
                                   WHERE r.id = $1`, [ref]);
        if (!r || r.hook_status !== 'active' || r.delivered_at || new Date(r.expires_at).getTime() <= now()) return null;
        let body;
        try { body = openBody(key, r.hook_id, r.id, r.body).body; }
        catch (err) {
            log.warn('[OpenVibe.Connect] a webhook body cannot be opened:', err && err.message);
            return null;
        }
        return { ref: r.id, hookId: r.hook_id, shareId: r.share_id, path: r.local_path, method: r.method, headers: Array.isArray(r.headers) ? r.headers : [], body, eventId: r.event_id || null, receivedAt: iso(r.received_at) };
    }

    /**
     * A share's webhooks still waiting for its computer, oldest first, up to the share's 1,000 cap. It returns refs,
     * not bodies: the caller opens one at a time, so a full queue never sits in memory at once.
     */
    async function pending(shareId, limit = MAX_WAITING) {
        const rows = await db.many(`SELECT r.id FROM hook_requests r JOIN share_hooks h ON h.id = r.hook_id
                                     WHERE h.share_id = $1 AND h.status = 'active' AND r.delivered_at IS NULL AND r.expires_at > $2
                                     ORDER BY r.seq LIMIT $3`, [shareId, new Date(now()).toISOString(), Math.min(Number(limit) || MAX_WAITING, MAX_WAITING)]);
        return rows.map((r) => r.id);
    }

    /** The computer's app answered: the request is delivered (its body is dropped), logged and counted. */
    async function settle(ref, status) {
        let settled = false;
        await s.tx(async (t) => {
            const at = new Date(now()).toISOString();
            const r = await t.maybe('UPDATE hook_requests SET delivered_at = $2, status = $3, body = \'\'::bytea WHERE id = $1 AND delivered_at IS NULL RETURNING hook_id, method, event_id, received_at', [ref, at, status]);
            if (!r) return;
            const h = await t.maybe('SELECT share_id, owner_subject, local_path FROM share_hooks WHERE id = $1', [r.hook_id]);
            if (!h) return;
            await t.exec(`INSERT INTO hook_deliveries (share_id, hook_id, owner_subject, request_id, event_id, method, path, status, received_at, delivered_at, created_at)
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)`,
                [h.share_id, r.hook_id, h.owner_subject, ref, r.event_id || null, r.method, h.local_path, status, r.received_at || at]);
            await t.exec('UPDATE share_hooks SET delivered = delivered + 1, last_delivered_at = $2, last_status = $3 WHERE id = $1', [r.hook_id, at, status]);
            settled = true;
        });
        return settled;
    }

    /** The computer's app refused a webhook: the request stays queued for another try, and the owner sees why. */
    async function fail(ref, status, error) {
        const r = await db.maybe('SELECT hook_id, method, event_id, received_at FROM hook_requests WHERE id = $1', [ref]);
        if (!r) return false;
        const h = await db.maybe('SELECT share_id, owner_subject, local_path FROM share_hooks WHERE id = $1', [r.hook_id]);
        if (!h) return false;
        const at = new Date(now()).toISOString();
        const why = String(error || '').slice(0, 200) || `the app answered ${status || 'nothing'}`;
        await db.exec(`INSERT INTO hook_deliveries (share_id, hook_id, owner_subject, request_id, event_id, method, path, status, error, received_at, created_at)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
            [h.share_id, r.hook_id, h.owner_subject, ref, r.event_id || null, r.method, h.local_path, status || null, why, r.received_at || at]);
        await db.exec('UPDATE share_hooks SET last_status = $2 WHERE id = $1', [r.hook_id, status || null]);
        return true;
    }

    /** The owner's delivery log, newest first: what arrived, what the app answered, and when. */
    async function deliveries(shareId, hookId = null, limit = 50) {
        const rows = hookId
            ? await db.many('SELECT * FROM hook_deliveries WHERE share_id = $1 AND hook_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [shareId, hookId, Math.min(Number(limit) || 50, 200)])
            : await db.many('SELECT * FROM hook_deliveries WHERE share_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [shareId, Math.min(Number(limit) || 50, 200)]);
        return rows.map(delivery);
    }

    /** Bodies written before sealing are sealed now, so nothing readable is left at rest. → sealed count */
    async function sealLegacy() {
        const rows = await db.many("SELECT id, hook_id, body FROM hook_requests WHERE body <> ''::bytea AND encode(substr(body, 1, 4), 'hex') <> '4f564331'");
        for (const r of rows) {
            await db.exec('UPDATE hook_requests SET body = $2 WHERE id = $1', [r.id, sealBody(key, r.hook_id, r.id, Buffer.from(r.body))]);
        }
        return rows.length;
    }

    /** Requests and delivery-log rows older than 72 hours go, delivered or not. → removed request count */
    async function sweep() {
        await sealLegacy();
        await db.exec('DELETE FROM hook_deliveries WHERE created_at <= $1', [new Date(now() - KEEP_MS).toISOString()]);
        const r = await db.many('DELETE FROM hook_requests WHERE expires_at <= $1 RETURNING id', [new Date(now()).toISOString()]);
        return r.length;
    }

    return { get, list, create, remove, receive, request, pending, settle, fail, deliveries, sealLegacy, sweep, KEEP_MS, MAX_BODY, MAX_WAITING };
}

module.exports = { createHooks, HookError, keepHeaders, bodyKey, HOOK_ID, METHODS, MAX_BODY, MAX_WAITING, KEEP_MS };
