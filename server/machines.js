'use strict';

/**
 * A person's computers, as Network knows them (CON-4): GET /api/v1/me/nodes with the person's own Network token, so
 * Connect sees only what they could see themself. A share can be bound only to one of their active machines.
 *
 *   list(userToken) → { ok: true, machines: [{ id, name, last_seen_at, paired_for }] } | { ok: false, reason }
 *   find(userToken, id) → the machine, or null
 *
 * Every call reaches Network from this one address, and Network limits /api/v1/me/nodes per address, so a person's list
 * is kept 20 seconds (by a hash of their token; at most 500 people). Binding always reads it fresh.
 */
const crypto = require('crypto');
const { NODE_ID } = require('./auth/node-auth');

const KEEP_MS = 20_000;
const KEEP_MAX = 500;

function createMachines({ config, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
    const base = config.networkInternalUrl || config.networkUrl;
    const kept = new Map();   // sha256(token) → { at, machines }

    async function list(userToken, { fresh = false } = {}) {
        if (!userToken) return { ok: false, reason: 'signed_out' };
        const k = crypto.createHash('sha256').update(String(userToken)).digest('hex');
        const hit = kept.get(k);
        if (!fresh && hit && now() - hit.at < KEEP_MS) return { ok: true, machines: hit.machines };
        try {
            const res = await fetchImpl(`${base}/api/v1/me/nodes`, {
                headers: { Accept: 'application/json', Authorization: `Bearer ${userToken}` },
                signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) return { ok: false, reason: `network_${res.status}` };
            const body = await res.json();
            const machines = (Array.isArray(body && body.nodes) ? body.nodes : [])
                .filter((n) => n && n.status === 'active' && NODE_ID.test(String(n.principal || '')))
                .map((n) => ({
                    id: n.principal,
                    name: typeof n.name === 'string' && n.name.trim() ? n.name.trim().slice(0, 80) : 'A computer',
                    last_seen_at: n.last_seen_at || null,
                    paired_for: n.paired_for && n.paired_for.service ? String(n.paired_for.service).slice(0, 40) : null,
                }));
            kept.delete(k);
            if (kept.size >= KEEP_MAX) kept.delete(kept.keys().next().value);
            kept.set(k, { at: now(), machines });
            return { ok: true, machines };
        } catch (err) {
            log.warn(`[OpenVibe.Connect] machines not read: ${(err && err.message) || err}`);
            return { ok: false, reason: 'error' };
        }
    }

    async function find(userToken, id) {
        const r = await list(userToken, { fresh: true });
        if (!r.ok) return { ok: false, reason: r.reason };
        return { ok: true, machine: r.machines.find((m) => m.id === id) || null };
    }

    return { list, find };
}

module.exports = { createMachines };
