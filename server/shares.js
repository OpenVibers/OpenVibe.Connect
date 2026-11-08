'use strict';

/**
 * Shares: one port on a person's machine, served at https://<label>--<user>.<domain> behind OpenVibe sign-in.
 *
 *   create(owner, { label, port, mode, named, note })  → { share, key }   the key is returned once, never stored
 *   list(ownerSubject), get(id), byHost(host), byKey(key)
 *   setPolicy(owner, id, { mode, named, offline_site }) bumps policy_version when who may open it changes
 *   offlineSite(value, { domain, scheme })             the CON-17 fallback rule (pure): a site on the domain, or null
 *   rotateKey(owner, id) → key                         the old key stops working; a connected tunnel is closed
 *   bindNode(owner, id, machine | null)                one of the owner's computers serves it (CON-4); the key stops
 *                                                      working while one is bound. null: back to a new connect key
 *   byNode(nodeId)                                     the open shares a computer serves
 *   revoke(owner, id)                                  the host answers 410 from now on
 *   hostFor(label, username), parseHost(host)          the naming rule (pure)
 *
 * Names: the label and the person's handle are DNS-safe (a–z, 0–9, single hyphens, no hyphen at either end), joined
 * by "--". OpenVibe.Space's site names can never contain "--" (its NAME_RE), so a share never takes a Space site's
 * name and Space never takes a share's. The whole label is at most 63 characters.
 *
 * Modes (website.policy@1's subset that v0 serves): owner (only the person who made it), named (the owner and the
 * OpenVibe usernames listed) and signin (anyone signed in to OpenVibe). A public share waits for the abuse screen
 * and the Public Suffix List entry (ADR-057, CON-9 and CON-21), so it is refused here. Since anyone can make an
 * OpenVibe account, "anyone signed in" is nearly public too: like Space's public publishing, it is open to OpenVibe
 * staff (Network role admin) until the abuse check is in.
 */
const crypto = require('crypto');

const LABEL_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;
const MODES = ['owner', 'named', 'signin'];
const RESERVED_LABELS = new Set(['www', 'api', 'app', 'admin', 'connect', 'hooks', 'edge', 'share', 'status', 'mail', 'space', 'auth', 'login', 'openvibe']);
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
// How long a share may stay open by itself (CON-6): 10 minutes to 30 days, or until its owner closes it (null).
const EXPIRES_MIN = 600;
const EXPIRES_MAX = 30 * 86400;
// What a report can be about (CON-9 v0). Copyright goes to the DMCA page too; the form says so.
const REPORT_REASONS = {
    phishing: 'It pretends to be someone else to get passwords or payment details',
    malware: 'It offers harmful files or software',
    illegal: 'Illegal content',
    copyright: 'It copies my work',
    abuse: 'Harassment, threats or spam',
    other: 'Something else',
};
const SIGNIN_NOT_YET = '"Anyone signed in" opens with the abuse check. For now, name the people who may open it.';

const isStaff = (owner) => Boolean(owner && owner.role === 'admin');
// A Space site's name: one DNS label with single hyphens, so never a share's "--" host (OpenVibe.Space's NAME_RE).
const SITE_LABEL_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,62}$/;
const OFFLINE_SITE_HELP = 'The fallback is one of your OpenVibe.Space sites: https://<name>.openvibe.website, optionally with a path.';

/**
 * Where a browser goes while a share's computer is off (CON-17): '' / null / undefined-as-cleared → null; otherwise
 * a Space site on the Website domain (https://<name>.openvibe.website, one label, never a share's "--" host), no port
 * and no credentials, a path and query allowed, the fragment dropped. Anything else throws, so a share can never send
 * its visitors off the allowed domain.
 */
function offlineSite(value, { domain, scheme = 'https' }) {
    if (value == null || String(value).trim() === '') return null;
    let u;
    try { u = new URL(String(value).trim()); } catch { throw new ShareError(422, 'share.invalid_offline_site', OFFLINE_SITE_HELP); }
    const suffix = `.${domain}`;
    const label = u.hostname.endsWith(suffix) ? u.hostname.slice(0, -suffix.length) : '';
    if (u.protocol !== `${scheme}:` || u.port || u.username || u.password || !SITE_LABEL_RE.test(label)) {
        throw new ShareError(422, 'share.invalid_offline_site', OFFLINE_SITE_HELP);
    }
    u.hash = '';
    if (u.href.length > 300) throw new ShareError(422, 'share.invalid_offline_site', 'That address is too long.');
    return u.href;
}

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

/** The share label in a host, or null: "agents--alex.openvibe.link" → { label: 'agents', handle: 'alex' }. */
function parseHost(host, domain) {
    if (Array.isArray(domain)) return domain.map((d) => parseHost(host, d)).find(Boolean) || null;
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

/** `expires_in` as given (seconds; '' / null / 0 / 'never' = no end) → seconds or null; a bad one throws. */
function expiresIn(value) {
    if (value == null || value === '' || value === 0 || value === '0' || value === 'never') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < EXPIRES_MIN || n > EXPIRES_MAX) {
        throw new ShareError(422, 'share.invalid_expiry', 'A share can close itself after 10 minutes to 30 days, or stay open until you close it.');
    }
    return n;
}

function createShares(s, { config }) {
    const { db } = s;
    const domain = config.shares.domain;
    const scheme = config.shares.scheme;
    const domains = config.shares.domains || [domain];
    const aliases = (host) => {
        const p = parseHost(host, domains);
        return p ? domains.map((d) => `${p.label}--${p.handle}.${d}`) : [];
    };

    const urlOf = (row) => `${scheme}://${row.host}`;
    function view(row) {
        if (!row) return null;
        const parsed = parseHost(row.host, domains);
        if (parsed) row = { ...row, host: `${parsed.label}--${parsed.handle}.${domain}` };
        return {
            id: row.id,
            owner_subject: row.owner_subject,
            owner_username: row.owner_username,
            label: row.label,
            host: row.host,
            url: urlOf(row),
            local_port: Number(row.local_port),
            mode: row.mode,
            party_slug: row.party_slug || null,
            named: Array.isArray(row.named) ? row.named : [],
            status: row.status,
            policy_version: Number(row.policy_version),
            key_prefix: row.node_id ? null : row.key_prefix,
            // Served by one of the owner's computers, as OpenVibe Link (CON-4): its Network node principal and name.
            node: row.node_id ? { id: row.node_id, name: row.node_name || 'A computer' } : null,
            note: row.note || null,
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
            revoked_at: iso(row.revoked_at),
            expires_at: iso(row.expires_at),
            closed_reason: row.closed_reason || null,
            // CON-17: where a browser goes while the computer is off (one of the sites on the domain), or null.
            offline_site: row.offline_site || null,
            // It closed itself: revoked at (or just after) the time it was given.
            expired: row.status === 'revoked' && Boolean(row.expires_at && row.revoked_at && new Date(row.revoked_at) >= new Date(row.expires_at)),
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
        return view(await db.maybe("SELECT * FROM shares WHERE host = ANY($1::text[]) ORDER BY status = 'active' DESC, created_at DESC LIMIT 1", [aliases(host)]));
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
        if (mode === 'signin' && !isStaff(owner)) throw new ShareError(403, 'share.signin_not_yet', SIGNIN_NOT_YET);
        const named = normalizeNamed(input.named);
        const host = hostFor(label, owner.username, domain);
        if (!host) throw new ShareError(422, 'share.name_too_long', 'That name and your username make an address longer than 63 characters. Pick a shorter name.');
        const note = input.note ? String(input.note).slice(0, 200) : null;
        const ttl = expiresIn(input.expires_in);

        const live = await db.one("SELECT count(*)::int AS n FROM shares WHERE owner_subject = $1 AND status = 'active'", [owner.subject]);
        if (live.n >= config.shares.perPerson) throw new ShareError(409, 'share.limit', `You have ${live.n} shares open, the most for now. Close one first.`);
        // A host someone else used stays theirs (a revoked share holds its address, so nobody else can serve on links
        // that still point there). The owner may reuse their own.
        const taken = await db.maybe('SELECT owner_subject, status FROM shares WHERE host = ANY($1::text[]) ORDER BY created_at DESC LIMIT 1', [aliases(host)]);
        if (taken && (taken.status === 'active' || taken.owner_subject !== owner.subject)) {
            throw new ShareError(409, 'share.taken', taken.owner_subject === owner.subject ? 'You already have a share with that name.' : 'That address is taken. Pick another name.');
        }

        const key = newKey();
        const id = s.newId('shr');
        try {
            await db.exec(
                `INSERT INTO shares (id, owner_subject, owner_username, label, host, local_port, mode, named, key_prefix, key_hash, note, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, CASE WHEN $12::int IS NULL THEN NULL ELSE now() + make_interval(secs => $12::int) END)`,
                [id, owner.subject, String(owner.username).slice(0, 64), label, host, port, mode, JSON.stringify(named), key.slice(0, 10), sha256(key), note, ttl],
            );
        } catch (err) {
            if (err && err.code === '23505') throw new ShareError(409, 'share.taken', 'That address is taken. Pick another name.');
            throw err;
        }
        return { share: await get(id), key };
    }

    async function setPolicy(owner, id, input = {}) {
        const share = await owned(owner, id);
        if (share.party_slug) throw new ShareError(403, 'share.party_managed', 'The party manages this share');
        if (share.status !== 'active') throw new ShareError(410, 'share.revoked', 'That share is closed.');
        const mode = input.mode == null ? share.mode : String(input.mode);
        if (mode === 'public') throw new ShareError(422, 'share.public_not_yet', 'Public shares open once the abuse check is in.');
        if (!MODES.includes(mode)) throw new ShareError(422, 'share.invalid_mode', `Who can open it: ${MODES.join(', ')}.`);
        if (mode === 'signin' && mode !== share.mode && !isStaff(owner)) throw new ShareError(403, 'share.signin_not_yet', SIGNIN_NOT_YET);
        const named = input.named === undefined ? share.named : normalizeNamed(input.named);
        const port = input.port === undefined ? share.local_port : Number(input.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ShareError(422, 'share.invalid_port', 'The port is a number from 1 to 65535.');
        const note = input.note === undefined ? share.note : (input.note ? String(input.note).slice(0, 200) : null);
        const policyChanged = mode !== share.mode || JSON.stringify(named) !== JSON.stringify(share.named);
        // offline_site: undefined keeps it; '' / null clears it (not a policy change: nobody is signed out).
        const keepOffline = input.offline_site === undefined;
        const offline = keepOffline ? null : offlineSite(input.offline_site, { domain: domain === 'openvibe.link' ? 'openvibe.website' : domain, scheme });
        // expires_in: undefined keeps the time it has; null / '' / 'never' takes it away; seconds set it from now.
        const keepExpiry = input.expires_in === undefined || input.expires_in === 'keep';
        const ttl = keepExpiry ? null : expiresIn(input.expires_in);
        await db.exec(
            `UPDATE shares SET mode = $2, named = $3::jsonb, local_port = $4, note = $5, updated_at = now(),
                    policy_version = policy_version + $6,
                    expires_at = CASE WHEN $7::boolean THEN expires_at WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(secs => $8::int) END,
                    offline_site = CASE WHEN $9::boolean THEN offline_site ELSE $10 END
              WHERE id = $1`,
            [share.id, mode, JSON.stringify(named), port, note, policyChanged ? 1 : 0, keepExpiry, ttl, keepOffline, offline],
        );
        return get(share.id);
    }

    async function rotateKey(owner, id) {
        const share = await owned(owner, id);
        if (share.party_slug) throw new ShareError(403, 'share.party_managed', 'The party manages this share');
        if (share.status !== 'active') throw new ShareError(410, 'share.revoked', 'That share is closed.');
        const key = newKey();
        // A new key means the key serves it: a computer bound as OpenVibe Link is let go (CON-4).
        await db.exec('UPDATE shares SET key_prefix = $2, key_hash = $3, node_id = NULL, node_name = NULL, updated_at = now() WHERE id = $1', [share.id, key.slice(0, 10), sha256(key)]);
        return { share: await get(share.id), key };
    }

    /**
     * One of the owner's computers serves the share (CON-4): `machine` is { id: 'nod_…', name }, already checked to be
     * the owner's and active (the route asks Network with the owner's own token). The connect key is replaced by one
     * nobody is shown, so only that computer, with its node token and a tunnel token, can serve it now. null unbinds
     * and returns a new key (shown once), for the one-file client again.
     */
    async function bindNode(owner, id, machine) {
        const share = await owned(owner, id);
        if (share.party_slug) throw new ShareError(403, 'share.party_managed', 'The party manages this share');
        if (share.status !== 'active') throw new ShareError(410, 'share.revoked', 'That share is closed.');
        const key = newKey();
        if (machine) {
            await db.exec('UPDATE shares SET node_id = $2, node_name = $3, key_prefix = $4, key_hash = $5, updated_at = now() WHERE id = $1',
                [share.id, machine.id, String(machine.name || '').slice(0, 80) || null, 'node', sha256(key)]);
            return { share: await get(share.id), key: null };
        }
        await db.exec('UPDATE shares SET node_id = NULL, node_name = NULL, key_prefix = $2, key_hash = $3, updated_at = now() WHERE id = $1',
            [share.id, key.slice(0, 10), sha256(key)]);
        return { share: await get(share.id), key };
    }

    async function byNode(nodeId) {
        const rows = await db.many("SELECT * FROM shares WHERE node_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 100", [String(nodeId || '')]);
        return rows.map(view);
    }

    async function createParty({ party, owner, username, node, port }) {
        if (!/^party-[a-f0-9]{8}$/.test(String(party || '')) || !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(owner || '')) ||
            !/^nod_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(node || ''))) throw new ShareError(422, 'party.invalid', 'Invalid party or machine');
        const existing = await db.maybe("SELECT * FROM shares WHERE party_slug = $1 AND status = 'active'", [party]);
        if (existing) {
            const current = view(existing);
            if (current.owner_subject !== owner || !current.node || current.node.id !== node || current.local_port !== port)
                throw new ShareError(409, 'party.in_use', 'This party is already hosted elsewhere');
            return current;
        }
        const acting = { subject: owner, username, role: 'admin' };
        const { share } = await create(acting, { label: party, port, mode: 'named', named: [username], expires_in: 86400, note: 'Shared party computer' });
        try {
            await bindNode(acting, share.id, { id: node, name: 'Party host' });
            await db.exec('UPDATE shares SET party_slug = $2 WHERE id = $1', [share.id, party]);
            return get(share.id);
        } catch (err) {
            await revoke(acting, share.id);
            throw err;
        }
    }

    async function partyMembers(share, node, members) {
        if (!share || !share.party_slug || !share.node || share.node.id !== node || share.status !== 'active')
            throw new ShareError(404, 'party.not_found', 'No such party share');
        const named = normalizeNamed(members);
        if (!named.includes(String(share.owner_username).toLowerCase())) named.push(String(share.owner_username).toLowerCase());
        if (JSON.stringify(named) !== JSON.stringify(share.named)) {
            await db.exec('UPDATE shares SET named = $2::jsonb, policy_version = policy_version + 1, updated_at = now() WHERE id = $1', [share.id, JSON.stringify(named)]);
        }
        return get(share.id);
    }

    async function closeParty(share, node) {
        if (!share || !share.party_slug || !share.node || share.node.id !== node) throw new ShareError(404, 'party.not_found', 'No such party share');
        return revoke({ subject: share.owner_subject }, share.id);
    }

    async function revoke(owner, id) {
        const share = await owned(owner, id);
        if (share.status === 'revoked') return share;
        await db.exec("UPDATE shares SET status = 'revoked', revoked_at = now(), updated_at = now(), policy_version = policy_version + 1 WHERE id = $1", [share.id]);
        return get(share.id);
    }

    // ── Reports (CON-9 v0) ──────────────────────────────────────────────────────────────────────────────────────
    /** Anyone reports a share by its address. Returns { id, share }. */
    async function report({ host, reason, details, reporter = null }) {
        const parsed = parseHost(String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), domains);
        const share = parsed ? await byHost(parsed.host) : null;
        if (!share) throw new ShareError(404, 'share.not_found', 'There is no share at that address. Check it, or paste the whole address.');
        if (!REPORT_REASONS[reason]) throw new ShareError(422, 'report.invalid_reason', 'Pick what the report is about.');
        const text = String(details || '').trim().slice(0, 2000);
        const id = `rpt_${crypto.randomBytes(12).toString('base64url')}`;
        await db.exec('INSERT INTO share_reports (id, share_id, host, reason, details, reporter_subject) VALUES ($1, $2, $3, $4, $5, $6)',
            [id, share.id, share.host, reason, text || null, reporter || null]);
        return { id, share };
    }
    /** The open reports, newest first, with their share's owner and state (staff only; the route checks). */
    async function openReports() {
        return db.many(`SELECT r.id, r.share_id, r.host, r.reason, r.details, r.created_at, r.reporter_subject IS NOT NULL AS signed_in,
                               s.owner_username, s.status AS share_status, s.mode,
                               (SELECT count(*)::int FROM share_reports x WHERE x.share_id = r.share_id AND x.status = 'open') AS open_for_share
                          FROM share_reports r JOIN shares s ON s.id = r.share_id
                         WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 200`);
    }
    /** Staff act on a report: 'close' closes its share (and settles every open report on it); 'dismiss' settles one. */
    async function handleReport(staff, id, action) {
        if (!isStaff(staff)) throw new ShareError(403, 'report.staff_only', 'Only OpenVibe staff handle reports.');
        const r = await db.maybe('SELECT * FROM share_reports WHERE id = $1', [String(id || '')]);
        if (!r) throw new ShareError(404, 'report.not_found', 'No such report.');
        if (action === 'close') {
            await db.exec(`UPDATE shares SET status = 'revoked', revoked_at = now(), updated_at = now(), closed_reason = 'report',
                                  policy_version = policy_version + 1 WHERE id = $1 AND status = 'active'`, [r.share_id]);
            await db.exec(`UPDATE share_reports SET status = 'closed_share', handled_by = $2, handled_at = now() WHERE share_id = $1 AND status = 'open'`, [r.share_id, staff.subject]);
            return { action, share: await get(r.share_id) };
        }
        if (action === 'dismiss') {
            await db.exec(`UPDATE share_reports SET status = 'dismissed', handled_by = $2, handled_at = now() WHERE id = $1 AND status = 'open'`, [r.id, staff.subject]);
            return { action, share: await get(r.share_id) };
        }
        throw new ShareError(422, 'report.invalid_action', 'Close the share or dismiss the report.');
    }

    // ── "Tell me when it's back" (CON-17) ───────────────────────────────────────────────────────────────────────
    /** A person asks to be told when the share's computer connects again (at most 500 waiting per share). */
    async function addWaiter(shareId, subject) {
        const n = Number((await db.maybe('SELECT count(*)::int AS n FROM share_waiters WHERE share_id = $1', [shareId]) || {}).n || 0);
        if (n >= 500) return false;
        await db.exec('INSERT INTO share_waiters (share_id, subject) VALUES ($1, $2) ON CONFLICT DO NOTHING', [shareId, subject]);
        return true;
    }
    /** Everyone waiting on a share, taken off the list at once (each is told once). */
    async function takeWaiters(shareId) {
        return (await db.many('DELETE FROM share_waiters WHERE share_id = $1 RETURNING subject', [shareId])).map((r) => r.subject);
    }

    /** Close every share whose time is up (the sweep in app.js); returns them, so their computers are let go. */
    async function expireDue() {
        return db.many(
            `UPDATE shares SET status = 'revoked', revoked_at = now(), updated_at = now(), policy_version = policy_version + 1
              WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now() RETURNING id, host`,
        );
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

    return { create, createParty, partyMembers, closeParty, list, get, byHost, byKey, byNode, bindNode, setPolicy, rotateKey, revoke, expireDue, report, openReports, handleReport, addWaiter, takeWaiters, touchConnected, flushCounters, visits, allows, view, domain };
}

function iso(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { offlineSite, createShares, ShareError, isStaff, REPORT_REASONS, hostFor, parseHost, handleOf, normalizeNamed, LABEL_RE, MODES, RESERVED_LABELS, sha256 };
