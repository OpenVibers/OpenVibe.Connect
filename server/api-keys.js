'use strict';

/**
 * API keys for a share (CON-16 v0). The owner of a share makes a key, names it and gives it to a program. A request
 * that sends it as `Authorization: Bearer ovsk_…` passes the gate without signing in (server/edge/proxy.js), so a model
 * or an API on the owner's computer (Ollama, llama.cpp, a small service of theirs) can be called from a script, an
 * editor or another app. What keeps it safe:
 *
 *   - a key opens the share's API, never its pages: an HTML answer to a key is refused at the edge, so a key posted in
 *     public cannot turn a share into a public website past the sign-in gate (the abuse gate, CON-9);
 *   - the key never reaches the app (the edge drops it); the app sees X-OpenVibe-Subject `key:<sak_…>`;
 *   - only its hash is kept, it is shown once, at most ten live keys a share, each with its own rate per minute
 *     (60 by default) on top of the share's own limits;
 *   - revoking a key stops it at once; closing the share stops them all.
 *
 *   create(owner, share, { name, per_minute }) → { key, token }     list(shareId) → keys     revoke(owner, share, id)
 *   check(share, token) → key | null                                overRate(key) → true when over its minute
 */
const crypto = require('crypto');

const KEY_ID = /^sak_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN_RE = /^ovsk_[A-Za-z0-9_-]{43}$/;
const PER_SHARE = 10;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

class ApiKeyError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function createApiKeys(s, { now = () => Date.now() } = {}) {
    const { db } = s;
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    const view = (r) => r && ({
        id: r.id, share_id: r.share_id, name: r.name, prefix: r.key_prefix, per_minute: Number(r.per_minute),
        created_at: iso(r.created_at), last_used_at: iso(r.last_used_at),
    });
    const owns = (owner, share) => share && owner && share.owner_subject === owner.subject;

    async function list(shareId) {
        return (await db.many('SELECT * FROM share_api_keys WHERE share_id = $1 AND revoked_at IS NULL ORDER BY created_at', [shareId])).map(view);
    }

    async function create(owner, share, input = {}) {
        if (!owns(owner, share)) throw new ApiKeyError(404, 'share.not_found', 'No such share.');
        if (share.status !== 'active') throw new ApiKeyError(410, 'share.revoked', 'That share is closed.');
        const name = String(input.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!name) throw new ApiKeyError(422, 'key.name_required', 'Name the key after the program that will use it, like "laptop script".');
        const perMinute = input.per_minute == null || input.per_minute === '' ? 60 : Number(input.per_minute);
        if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 600) throw new ApiKeyError(422, 'key.invalid_rate', 'A key allows 1 to 600 requests a minute.');
        const n = await db.one('SELECT count(*)::int AS n FROM share_api_keys WHERE share_id = $1 AND revoked_at IS NULL', [share.id]);
        if (n.n >= PER_SHARE) throw new ApiKeyError(409, 'key.limit', `A share can have ${PER_SHARE} API keys. Revoke one first.`);
        const token = `ovsk_${crypto.randomBytes(32).toString('base64url')}`;
        const id = s.newId('sak');
        await db.exec('INSERT INTO share_api_keys (id, share_id, owner_subject, name, key_prefix, key_hash, per_minute) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, share.id, owner.subject, name, token.slice(0, 12), sha256(token), perMinute]);
        return { key: view(await db.one('SELECT * FROM share_api_keys WHERE id = $1', [id])), token };
    }

    async function revoke(owner, share, id) {
        if (!owns(owner, share) || !KEY_ID.test(String(id || ''))) throw new ApiKeyError(404, 'key.not_found', 'No such key.');
        const r = await db.maybe('UPDATE share_api_keys SET revoked_at = now() WHERE id = $1 AND share_id = $2 AND revoked_at IS NULL RETURNING id', [id, share.id]);
        if (!r) throw new ApiKeyError(404, 'key.not_found', 'No such key.');
        minutes.delete(id);
    }

    const touched = new Map();   // key id → when last_used_at was last written (at most once a minute)
    async function check(share, token) {
        if (!share || share.status !== 'active' || !TOKEN_RE.test(String(token || ''))) return null;
        const r = await db.maybe('SELECT * FROM share_api_keys WHERE key_hash = $1 AND share_id = $2 AND revoked_at IS NULL', [sha256(token), share.id]);
        if (!r) return null;
        const t = now();
        if (!touched.has(r.id) || t - touched.get(r.id) > 60_000) {
            touched.set(r.id, t);
            db.exec('UPDATE share_api_keys SET last_used_at = now() WHERE id = $1', [r.id]).catch(() => {});
        }
        return view(r);
    }

    const minutes = new Map();   // key id → { m, n }
    function overRate(key) {
        const m = Math.floor(now() / 60_000);
        const c = minutes.get(key.id);
        if (!c || c.m !== m) { minutes.set(key.id, { m, n: 1 }); return false; }
        c.n++;
        return c.n > key.per_minute;
    }

    return { list, create, revoke, check, overRate, PER_SHARE };
}

module.exports = { createApiKeys, ApiKeyError, TOKEN_RE, KEY_ID };
