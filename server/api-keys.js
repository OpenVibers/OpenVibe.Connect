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
 *   - revoking a key stops it at once; closing the share stops them all;
 *   - (v1) a key may have a daily quota (per_day, UTC days, kept in the database so a restart does not reset it), and
 *     the owner sees what each key did today: its requests, the MCP tools it called (JSON-RPC tools/call) and the
 *     models it asked for (an OpenAI-style "model"), as names and counts, never arguments or prompts.
 *
 *   create(owner, share, { name, per_minute, per_day }) → { key, token }   list(shareId) → keys (with today's use)
 *   revoke(owner, share, id)        check(share, token) → key | null       overRate(key) → true when over its minute
 *   overDay(key) → true when today's quota is spent (and counts this request otherwise)
 *   audit(key, path, body)          what a request's JSON body used: tools/call names, the model asked for
 */
const crypto = require('crypto');

const KEY_ID = /^sak_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN_RE = /^ovsk_[A-Za-z0-9_-]{43}$/;
const PER_SHARE = 10;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const MODEL_PATH = /\/(?:chat\/completions|completions|embeddings|responses|messages|api\/chat|api\/generate|api\/embed(?:dings)?)(?:[/?]|$)/;
const NAME = (v) => String(v).replace(/[^\w.:/@+-]/g, '').slice(0, 80);

/**
 * What a key's request used, from its JSON body: `tool:<name>` for each JSON-RPC tools/call (an MCP server; a batch
 * counts each), `model:<name>` for an OpenAI- or Ollama-style model request. At most five names; nothing else is read.
 */
function usageOf(path, body) {
    let j;
    try { j = JSON.parse(body); } catch { return []; }
    const out = [];
    for (const m of (Array.isArray(j) ? j : [j]).slice(0, 20)) {
        if (!m || typeof m !== 'object') continue;
        if (m.method === 'tools/call' && m.params && typeof m.params.name === 'string' && NAME(m.params.name)) out.push(`tool:${NAME(m.params.name)}`);
        else if (typeof m.model === 'string' && NAME(m.model) && MODEL_PATH.test(String(path || '').split('?')[0])) out.push(`model:${NAME(m.model)}`);
    }
    return [...new Set(out)].slice(0, 5);
}

class ApiKeyError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function createApiKeys(s, { now = () => Date.now() } = {}) {
    const { db } = s;
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    const view = (r) => r && ({
        id: r.id, share_id: r.share_id, name: r.name, prefix: r.key_prefix, per_minute: Number(r.per_minute),
        per_day: r.per_day == null ? null : Number(r.per_day),
        created_at: iso(r.created_at), last_used_at: iso(r.last_used_at),
    });
    const today = () => new Date(now()).toISOString().slice(0, 10);
    const count = (keyId, what, by = 1) => db.exec(`INSERT INTO share_api_key_usage (key_id, day, what, n) VALUES ($1, $2, $3, $4)
        ON CONFLICT (key_id, day, what) DO UPDATE SET n = share_api_key_usage.n + excluded.n, last_at = now()`, [keyId, today(), what, by]).catch(() => {});
    const owns = (owner, share) => share && owner && share.owner_subject === owner.subject;

    async function list(shareId) {
        const keys = (await db.many('SELECT * FROM share_api_keys WHERE share_id = $1 AND revoked_at IS NULL ORDER BY created_at', [shareId])).map(view);
        if (!keys.length) return keys;
        const rows = await db.many('SELECT key_id, what, n FROM share_api_key_usage WHERE day = $1 AND key_id = ANY($2::text[]) ORDER BY n DESC, what', [today(), keys.map((k) => k.id)]);
        for (const k of keys) {
            const mine = rows.filter((r) => r.key_id === k.id);
            const total = mine.find((r) => r.what === '*');
            k.today = total ? Number(total.n) : 0;
            k.used = mine.filter((r) => r.what !== '*').slice(0, 8).map((r) => ({ what: r.what, n: Number(r.n) }));
        }
        return keys;
    }

    async function create(owner, share, input = {}) {
        if (!owns(owner, share)) throw new ApiKeyError(404, 'share.not_found', 'No such share.');
        if (share.status !== 'active') throw new ApiKeyError(410, 'share.revoked', 'That share is closed.');
        const name = String(input.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!name) throw new ApiKeyError(422, 'key.name_required', 'Name the key after the program that will use it, like "laptop script".');
        const perMinute = input.per_minute == null || input.per_minute === '' ? 60 : Number(input.per_minute);
        if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 600) throw new ApiKeyError(422, 'key.invalid_rate', 'A key allows 1 to 600 requests a minute.');
        const perDay = input.per_day == null || input.per_day === '' ? null : Number(input.per_day);
        if (perDay !== null && (!Number.isInteger(perDay) || perDay < 1 || perDay > 1000000)) throw new ApiKeyError(422, 'key.invalid_quota', 'A daily quota is 1 to 1,000,000 requests, or none.');
        const n = await db.one('SELECT count(*)::int AS n FROM share_api_keys WHERE share_id = $1 AND revoked_at IS NULL', [share.id]);
        if (n.n >= PER_SHARE) throw new ApiKeyError(409, 'key.limit', `A share can have ${PER_SHARE} API keys. Revoke one first.`);
        const token = `ovsk_${crypto.randomBytes(32).toString('base64url')}`;
        const id = s.newId('sak');
        await db.exec('INSERT INTO share_api_keys (id, share_id, owner_subject, name, key_prefix, key_hash, per_minute, per_day) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [id, share.id, owner.subject, name, token.slice(0, 12), sha256(token), perMinute, perDay]);
        return { key: view(await db.one('SELECT * FROM share_api_keys WHERE id = $1', [id])), token };
    }

    async function revoke(owner, share, id) {
        if (!owns(owner, share) || !KEY_ID.test(String(id || ''))) throw new ApiKeyError(404, 'key.not_found', 'No such key.');
        const r = await db.maybe('UPDATE share_api_keys SET revoked_at = now() WHERE id = $1 AND share_id = $2 AND revoked_at IS NULL RETURNING id', [id, share.id]);
        if (!r) throw new ApiKeyError(404, 'key.not_found', 'No such key.');
        minutes.delete(id);
        days.delete(id);
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

    // Today's requests per key: read from the database the first time a key is seen each day, then counted here and
    // written through, so a restart neither resets a quota nor loses the owner's numbers.
    const days = new Map();   // key id → { day, n }
    async function overDay(key) {
        const d = today();
        let c = days.get(key.id);
        if (!c || c.day !== d) {
            const r = await db.maybe("SELECT n FROM share_api_key_usage WHERE key_id = $1 AND day = $2 AND what = '*'", [key.id, d]).catch(() => null);
            c = { day: d, n: r ? Number(r.n) : 0 };
            days.set(key.id, c);
        }
        if (key.per_day != null && c.n >= key.per_day) return true;
        c.n++;
        count(key.id, '*');
        return false;
    }

    function audit(key, path, body) {
        for (const what of usageOf(path, body)) count(key.id, what);
    }

    /** Seconds until midnight UTC, when a spent daily quota opens again. */
    const untilTomorrow = () => { const t = now(); return Math.max(1, Math.ceil((Math.floor(t / 86_400_000 + 1) * 86_400_000 - t) / 1000)); };

    return { list, create, revoke, check, overRate, overDay, audit, untilTomorrow, PER_SHARE };
}

module.exports = { createApiKeys, ApiKeyError, usageOf, TOKEN_RE, KEY_ID };
