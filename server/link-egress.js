'use strict';

// This route carries ONLY authenticated session traffic. A share cookie, API key or owner sign-in cannot open it.
function createEgressAuth({ config, fetchImpl = globalThis.fetch }) {
    async function network(path, body, token) {
        try {
            const r = await fetchImpl(`${config.networkInternalUrl}${path}`, { method: body ? 'POST' : 'GET',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000), redirect: 'error' });
            return r.ok ? await r.json() : null;
        } catch { return null; }
    }
    return {
        identity: token => network('/api/v1/link/self/egress/identity', null, token),
        async open(share, req) {
            if (req.url !== '/__ov_egress' || req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket') return false;
            const session = req.headers['x-ov-session'], credential = req.headers['x-ov-egress'];
            if (typeof session !== 'string' || typeof credential !== 'string' || credential.length !== 43) return false;
            const result = await network('/api/v1/link-egress/open', { session_id: session, credential, node_id: share.node?.id });
            return !!result && result.node_id === share.node?.id && result.session_id === session;
        },
    };
}
module.exports = { createEgressAuth };
