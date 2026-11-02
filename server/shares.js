'use strict';

/**
 * Shares: one port on a person's machine, served at https://<label>--<user>.<domain> behind OpenVibe sign-in.
 *
 *   create(owner, { label, port, mode, named, note })  → { share, key }   the key is returned once, never stored
 *   list(ownerSubject), get(id), byHost(host), byKey(key)
 *   setPolicy(owner, id, { mode, named })              bumps policy_version: every visitor's cookie goes stale
 *   rotateKey(owner, id) → key                         the old key stops working; a connected tunnel is closed
 *   revoke(owner, id)                                  the host answers 410 from now on
 *   hostFor(label, username), parseHost(host)          the naming rule (pure)
 *
 * Names: the label and the person's handle are DNS-safe (a–z, 0–9, single hyphens, no hyphen at either end), joined
 * by "--". OpenVibe.Space's site names can never contain "--" (its NAME_RE), so a share never takes a Space site's
 * name and Space never takes a share's. The whole label is at most 63 characters.
 *
 * Modes (website.policy@1's subset that v0 serves): owner (only the person who made it), named (the owner and the
 * OpenVibe usernames listed) and signin (anyone signed in to OpenVibe). A public share waits for the abuse screen
 * and the Public Suffix List entry (ADR-057, CON-9 and CON-21), so it is refused here.
 */
const crypto = require('crypto');

const LABEL_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;
const MODES = ['owner', 'named', 'signin'];
const RESERVED_LABELS = new Set(['www', 'api', 'app', 'admin', 'connect', 'hooks', 'edge', 'share', 'status', 'mail', 'space', 'auth', 'login', 'openvibe']);
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

class ShareError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** A person's OpenVibe username as one DNS-safe handle ("Japanese_Old.Guy" → "japanese-old-guy"). */
function handleOf(username) {
    return String(username || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
}

function hostFor(label, username, domain) {
    const handle = handleOf(username);
    if (!handle) return null;
    const first = `${label}--${handle}`;
    if (first.length > 63) return null;
    return `${first}.${domain}`;
}

/** The share label in a host, or null: "agents--alex.openvibe.website" → { label: 'agents', handle: 'alex' }. */
function parseHost(host, domain) {
    const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
    const suffix = `.${domain}`;
    if (!h.endsWith(suffix)) return null;
    const first = h.slice(0, -suffix.length);
    if (!first || first.length > 63 || first.includes('.')) return null;
    const at = first.indexOf('--');
    if (at <= 0) return null;
    const label = first.slice(0, at);
    const handle = first.slice(at + 2);
    if (!LABEL_RE.test(label) || !LABEL_RE.test(handle)) return null;
    return { host: h, label, handle };
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function newKey() { return `ovc_${crypto.randomBytes(32).toString('base64url')}`; }

function normalizeNamed(list) {
    const raw = Array.isArray(list) ? list : String(list || '').split(/[\s,]+/);
    const out = [];
    for (const item of raw) {
        const u = String(item || '').trim().replace(/^@/, '');
        if (!u) continue;
        if (!USERNAME_RE.test(u)) throw new ShareError(422, 'share.invalid_username', `"${u.slice(0, 64)}" is not an OpenVibe username`);
        const lower = u.toLowerCase();
        if (!out.includes(lower)) out.push(lower);
    }
    if (out.length > 50) throw new ShareError(422, 'share.too_many_people', 'A share can name up to 50 people.');
    return out;
}

function createShares(s, { config }) {
    const { db } = s;
    const domain = config.shares.domain;
    const scheme = config.shares.scheme;

    const urlOf = (row) => `${scheme}://${row.host}`;
    function view(row) {
        if (!row) return null;
        return {
            id: row.id,
            owner_subject: row.owner_subject,
            owner_username: row.owner_username,
            label: row.label,
            host: row.host,
            url: urlOf(row),
            local_port: Number(row.local_port),
            mode: row.mode,
            named: Array.isArray(row.named) ? row.named : [],
            status: row.status,
            policy_version: Number(row.policy_version),
            key_prefix: row.key_prefix,
            note: row.note || null,
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
            revoked_at: iso(row.revoked_at),
            last_connected_at: iso(row.last_connected_at),
            last_visit_at: iso(row.last_visit_at),
            requests: Number(row.requests || 0),
            bytes_in: Number(row.bytes_in || 0),
            bytes_out: Number(row.bytes_out || 0),
        };
    }

    async function list(ownerSubject) {
        const rows = await db.many("SELECT * FROM shares WHERE owner_subject = $1 ORDER BY status = 'active' DESC, created_at DESC LIMIT 100", [ownerSubject]);
        return rows.map(view);
    }
    async function get(id) { return view(await db.maybe('SELECT * FROM shares WHERE id = $1', [String(id || '')])); }
    async function byHost(host) {
        return view(await db.maybe("SELECT * FROM shares WHERE host = $1 ORDER BY status = 'active' DESC, created_at DESC LIMIT 1", [String(host || '').toLowerCase()]));
    }
    async function byKey(key) {
        if (typeof key !== 'string' || !/^ovc_[A-Za-z0-9_-]{43}$/.test(key)) return null;
        return view(await db.maybe('SELECT * FROM shares WHERE key_hash = $1', [sha256(key)]));
    }

    async function owned(owner, id) {
        const share = await get(id);
        if (!share || share.owner_subject !== owner.subject) throw new ShareError(404, 'share.not_found', 'No such share.');
        return share;
    }

    async function create(owner, input = {}) {
        if (!owner || !owner.subject || !owner.username) throw new ShareError(401, 'token.required', 'Sign in to make a share.');
        const label = String(input.label || '').trim().toLowerCase();
        if (!LABEL_RE.test(label)) throw new ShareError(422, 'share.invalid_label', 'A name is 1–40 characters: a–z, 0–9 and single hyphens, not at either end.');
        if (RESERVED_LABELS.has(label)) throw new ShareError(422, 'share.reserved_label', `"${label}" is kept for OpenVibe itself. Pick another name.`);
        const port = Number(input.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ShareError(422, 'share.invalid_port', 'The port is a number from 1 to 65535.');
        const mode = input.mode == null || input.mode === '' ? 'owner' : String(input.mode);
        if (mode === 'public') throw new ShareError(422, 'share.public_not_yet', 'Public shares open once the abuse check is in. For now a share asks every visitor to sign in with OpenVibe.');
        if (!MODES.includes(mode)) throw new ShareError(422, 'share.invalid_mode', `Who can open it: ${MODES.join(', ')}.`);
        const named = normalizeNamed(input.named);
        const host = hostFor(label, owner.username, domain);
        if (!host) throw new ShareError(422, 'share.name_too_long', 'That name and your username make an address longer than 63 characters. Pick a shorter name.');
        const note = input.note ? String(input.note).slice(0, 200) : null;

        const live = await db.one("SELECT count(*)::int AS n FROM shares WHERE owner_subject = $1 AND status = 'active'", [owner.subject]);
        if (live.n >= config.shares.perPerson) throw new ShareError(409, 'share.limit', `You have ${live.n} shares open, the most for now. Close one first.`);
        // A host someone else used stays theirs (a revoked share holds its address, so nobody else can serve on links
        // that still point there). The owner may reuse their own.
        const taken = await db.maybe('SELECT owner_subject, status FROM shares WHERE host = $1 ORDER BY created_at DESC LIMIT 1', [host]);
        if (taken && (taken.status === 'active' || taken.owner_subject !== owner.subject)) {
            throw new ShareError(409, 'share.taken', taken.owner_subject === owner.subject ? 'You already have a share with that name.' : 'That address is taken. Pick another name.');
        }

        const key = newKey();
        const id = s.newId('shr');
        try {
            await db.exec(
                `INSERT INTO shares (id, owner_subject, owner_username, label, host, local_port, mode, named, key_prefix, key_hash, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
                [id, owner.subject, String(owner.username).slice(0, 64), label, host, port, mode, JSON.stringify(named), key.slice(0, 10), sha256(key), note],
            );
        } catch (err) {
            if (err && err.code === '23505') throw new ShareError(409, 'share.taken', 'That address is taken. Pick another name.');
            throw err;
        }
        return { share: await get(id), key };
    }

    async function setPolicy(owner, id, input = {}) {
        const share = await owned(owner, id);
        if (share.status !== 'active') throw new ShareError(410, 'share.revoked', 'That share is closed.');
        const mode = input.mode == null ? share.mode : String(input.mode);
        if (mode === 'public') throw new ShareError(422, 'share.public_not_yet', 'Public shares open once the abuse check is in.');
        if (!MODES.includes(mode)) throw new ShareError(422, 'share.invalid_mode', `Who can open it: ${MODES.join(', ')}.`);
        const named = input.named === undefined ? share.named : normalizeNamed(input.named);
        const port = input.port === undefined ? share.local_port : Number(input.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ShareError(422, 'share.invalid_port', 'The port is a number from 1 to 65535.');
        const note = input.note === undefined ? share.note : (input.note ? String(input.note).slice(0, 200) : null);
        const policyChanged = mode !== share.mode || JSON.stringify(named) !== JSON.stringify(share.named);
        await db.exec(
            `UPDATE shares SET mode = $2, named = $3::jsonb, local_port = $4, note = $5, updated_at = now(),
                    policy_version = policy_version + $6 WHERE id = $1`,
            [share.id, mode, JSON.stringify(named), port, note, policyChanged ? 1 : 0],
        );
        return get(share.id);
    }

    async function rotateKey(owner, id) {
        const share = await owned(owner, id);
        if (share.status !== 'active') throw new ShareError(410, 'share.revoked', 'That share is closed.');
        const key = newKey();
        await db.exec('UPDATE shares SET key_prefix = $2, key_hash = $3, updated_at = now() WHERE id = $1', [share.id, key.slice(0, 10), sha256(key)]);
        return { share: await get(share.id), key };
    }

    async function revoke(owner, id) {
        const share = await owned(owner, id);
        if (share.status === 'revoked') return share;
        await db.exec("UPDATE shares SET status = 'revoked', revoked_at = now(), updated_at = now(), policy_version = policy_version + 1 WHERE id = $1", [share.id]);
        return get(share.id);
    }

    async function touchConnected(id) { await db.exec('UPDATE shares SET last_connected_at = now() WHERE id = $1', [id]); }

    /** Flush counters gathered in memory: { [shareId]: { requests, bytesIn, bytesOut, visits: { [subject]: { username, requests, denied } } } } */
    async function flushCounters(counters, day) {
        for (const [id, c] of Object.entries(counters)) {
            await db.exec(
                `UPDATE shares SET requests = requests + $2, bytes_in = bytes_in + $3, bytes_out = bytes_out + $4,
                        last_visit_at = CASE WHEN $2 > 0 THEN now() ELSE last_visit_at END WHERE id = $1`,
                [id, c.requests, c.bytesIn, c.bytesOut],
            );
            for (const [subject, v] of Object.entries(c.visits || {})) {
                await db.exec(
                    `INSERT INTO share_visits (share_id, day, subject, username, requests, denied, last_at) VALUES ($1, $2, $3, $4, $5, $6, now())
                     ON CONFLICT (share_id, day, subject) DO UPDATE SET requests = share_visits.requests + EXCLUDED.requests,
                        denied = share_visits.denied + EXCLUDED.denied, username = COALESCE(EXCLUDED.username, share_visits.username), last_at = now()`,
                    [id, day, subject, v.username || null, v.requests || 0, v.denied || 0],
                );
            }
        }
    }

    async function visits(id, { days = 7 } = {}) {
        const rows = await db.many(
            `SELECT subject, max(username) AS username, sum(requests)::int AS requests, sum(denied)::int AS denied, max(last_at) AS last_at
               FROM share_visits WHERE share_id = $1 AND day >= (current_date - $2::int) GROUP BY subject ORDER BY max(last_at) DESC LIMIT 50`,
            [id, days],
        );
        return rows.map((r) => ({ subject: r.subject, username: r.username, requests: r.requests, denied: r.denied, last_at: iso(r.last_at) }));
    }

    /** Is this person let in by the share's policy? */
    function allows(share, viewer) {
        if (!share || share.status !== 'active' || !viewer || !viewer.subject) return false;
        if (viewer.subject === share.owner_subject) return true;
        if (share.mode === 'signin') return true;
        if (share.mode === 'named') return Boolean(viewer.username) && share.named.includes(String(viewer.username).toLowerCase());
        return false;
    }

    return { create, list, get, byHost, byKey, setPolicy, rotateKey, revoke, touchConnected, flushCounters, visits, allows, view, domain };
}

function iso(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { createShares, ShareError, hostFor, parseHost, handleOf, normalizeNamed, LABEL_RE, MODES, RESERVED_LABELS, sha256 };
