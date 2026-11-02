'use strict';

/**
 * The inspector (CON-8 v0): the last 100 requests through each share, for its owner, so someone sharing an app can
 * see what reaches it as it happens (the share page lists them and adds new ones every few seconds).
 *
 * Memory only: a restart forgets them and nothing is written anywhere. Each entry holds what a log line would:
 *   the method; the path, with every query value replaced by "…" (a token in a query string never reaches a page);
 *   the status, the time to the end, the bytes each way; the visitor's OpenVibe name when the share asked for one;
 *   whether it was a WebSocket; and why it failed (timeout, nothing listening…).
 * No headers, no bodies, no addresses.
 *
 *   begin(shareId, { method, path, who, ws }) → entry; set entry.status / add to entry.in and entry.out as it goes
 *   end(entry, { status?, error? })           → stamps the time taken (once)
 *   list(shareId, { after })                  → newest first, only entries after that sequence number
 *   forget(shareId)                           → a closed share's list goes
 */

const KEEP = 100;
const PATH_MAX = 300;

/** The path as the inspector shows it: query values become "…", and only the first 12 keys are kept. */
function redact(url) {
    const s = String(url || '/');
    const q = s.indexOf('?');
    const path = (q === -1 ? s : s.slice(0, q)).slice(0, PATH_MAX) || '/';
    if (q === -1) return path;
    const keys = s.slice(q + 1).split('&').map((kv) => kv.split('=')[0]).filter(Boolean).slice(0, 12)
        .map((k) => k.slice(0, 40).replace(/[^\w.%~[\]-]/g, ''));
    return keys.length ? `${path}?${keys.map((k) => `${k}=…`).join('&')}` : path;
}

function createInspector({ now = () => Date.now(), keep = KEEP } = {}) {
    const rings = new Map();   // share id → { seq, items }

    function begin(shareId, { method = 'GET', path = '/', who = null, ws = false } = {}) {
        let r = rings.get(shareId);
        if (!r) { r = { seq: 0, items: [] }; rings.set(shareId, r); }
        const entry = {
            seq: ++r.seq, at: new Date(now()).toISOString(), method: String(method).slice(0, 12), path: redact(path),
            who: who && who.username ? String(who.username) : null, ws: Boolean(ws),
            status: null, ms: null, in: 0, out: 0, error: null, started: now(),
        };
        r.items.push(entry);
        if (r.items.length > keep) r.items.splice(0, r.items.length - keep);
        return entry;
    }

    function end(entry, { status = null, error = null } = {}) {
        if (!entry || entry.ms != null) return;
        if (status != null) entry.status = status;
        if (error) entry.error = String(error).slice(0, 40);
        entry.ms = Math.max(0, now() - entry.started);
    }

    const wire = (e) => ({ seq: e.seq, at: e.at, method: e.method, path: e.path, who: e.who, ws: e.ws, status: e.status, ms: e.ms, in: e.in, out: e.out, error: e.error, open: e.ms == null });

    function list(shareId, { after = 0 } = {}) {
        const r = rings.get(shareId);
        if (!r) return [];
        const from = Number(after) || 0;
        return r.items.filter((e) => e.seq > from).reverse().map(wire);
    }

    function forget(shareId) { rings.delete(shareId); }

    return { begin, end, list, forget, KEEP: keep };
}

module.exports = { createInspector, redact, KEEP };
