'use strict';

/**
 * The tunnels: one WebSocket per connected share, opened by the client (public/ov-connect.js) to
 * wss://connect.openvibe.website/tunnel and authenticated by its first message, { t: 'hello', key }.
 *
 *   createTunnels({ shares, config, log }) → { handleUpgrade(req, socket, head), get(shareId), close(shareId, code, why),
 *                                              closeAll(), status() }
 *   tunnel.open({ onRes, onData, onEnd, onAbort, onPause, onResume }) → stream id
 *   tunnel.send(obj), tunnel.data(id, buf), tunnel.end(id), tunnel.abort(id, code, message), tunnel.release(id)
 *
 * A computer bound to a share as OpenVibe Node (CON-4) says hello with two credentials instead of a key:
 * { t: 'hello', share: 'shr_…', node_token: <its Network node token>, tunnel: 'ovt_…' } (server/auth/node-auth.js). Its
 * node token lasts 300 s, so it sends { t: 'reauth', node_token } with a fresh one before then (answered
 * { t: 'reauthed', until }); a tunnel whose token ran out is closed (4000, the computer reconnects), so a computer
 * removed on Network loses its shares within about five minutes. A refused node token is 4002 and a share this
 * computer does not serve is 4003 (the computer stops both); a spent or late tunnel token is 4000 (it asks again).
 *
 * A newer connection for the same share replaces the older one (close code 4001), so a laptop that reconnects after
 * sleep never leaves a dead tunnel behind. A wrong key is 4002; a revoked share or a rotated key closes its tunnel
 * (4003); a tunnel that stops answering pings is 4008. The server
 * pings every CONNECT_PING_MS so Cloudflare does not close an idle tunnel, and a tunnel that misses two pings is
 * closed.
 */
const { WebSocketServer } = require('ws');
const frames = require('./frames');

const HIGH_WATER = 4 * 1024 * 1024;

class Tunnel {
    constructor(ws, share, { log, maxStreams }) {
        this.ws = ws;
        this.share = share;
        this.log = log;
        this.maxStreams = maxStreams;
        this.streams = new Map();
        this.nextId = 1;
        this.connectedAt = Date.now();
        this.alive = true;
        this.closed = false;
        this.clientInfo = null;
    }

    get busy() { return this.streams.size >= this.maxStreams; }
    get congested() { return this.ws.bufferedAmount > HIGH_WATER; }

    open(handlers) {
        const id = this.nextId++;
        this.streams.set(id, handlers);
        return id;
    }
    release(id) { this.streams.delete(id); }

    send(obj) { if (!this.closed && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
    data(id, buf) { if (!this.closed && this.ws.readyState === 1 && buf && buf.length) this.ws.send(frames.encode(frames.KIND.DATA, id, buf)); }
    end(id) { if (!this.closed && this.ws.readyState === 1) this.ws.send(frames.encode(frames.KIND.END, id)); }
    abort(id, code = 'aborted', message = '') {
        this.send({ t: 'abort', id, code, message: String(message).slice(0, 200) });
        this.release(id);
    }

    /** Wait until the socket's send buffer drains below the high-water mark (or the tunnel closes). */
    drained() {
        if (!this.congested || this.closed) return Promise.resolve();
        return new Promise((resolve) => {
            const tick = () => { if (!this.congested || this.closed) resolve(); else setTimeout(tick, 10); };
            setTimeout(tick, 10);
        });
    }

    onMessage(message, isBinary) {
        if (isBinary) {
            const f = frames.decode(message);
            if (!f) return;
            const h = this.streams.get(f.id);
            if (!h) return;
            if (f.kind === frames.KIND.DATA) { if (h.onData) h.onData(f.payload); } else if (h.onEnd) h.onEnd();
            return;
        }
        let m;
        try { m = JSON.parse(String(message)); } catch { return; }
        if (!m || typeof m !== 'object') return;
        const h = Number.isInteger(m.id) ? this.streams.get(m.id) : null;
        if (!h) return;
        if (m.t === 'res' && h.onRes) h.onRes(m);
        else if (m.t === 'abort') { this.release(m.id); if (h.onAbort) h.onAbort(m); }
        else if (m.t === 'pause' && h.onPause) h.onPause();
        else if (m.t === 'resume' && h.onResume) h.onResume();
    }

    shutdown(code, why) {
        if (this.closed) return;
        this.closed = true;
        for (const [, h] of this.streams) { try { if (h.onAbort) h.onAbort({ code: 'tunnel_closed', message: why }); } catch { /* the visitor is gone */ } }
        this.streams.clear();
        try { this.ws.close(code, String(why || '').slice(0, 120)); } catch { /* already closing */ }
        setTimeout(() => { try { this.ws.terminate(); } catch { /* gone */ } }, 2000).unref();
    }
}

// How long past its node token's expiry a computer's tunnel may stay open while its reauth is on the way.
const REAUTH_GRACE_MS = 30_000;

function createTunnels({ shares, config, log = console, onConnect = null, nodeAuth = null, now = () => Date.now() }) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
    const live = new Map();   // share id → Tunnel
    const stats = { connects: 0, refused: 0, replaced: 0 };

    /** Close every computer's tunnel whose node token ran out with no reauth (CON-4); the computer reconnects. */
    function sweep() {
        let n = 0;
        for (const t of live.values()) if (t.authUntil && now() > t.authUntil + REAUTH_GRACE_MS) { t.shutdown(4000, 'the node token ran out'); n++; }
        return n;
    }

    const pinger = setInterval(() => {
        sweep();
        for (const t of live.values()) {
            if (t.closed) continue;
            if (!t.alive) { t.shutdown(4008, 'no answer to ping'); continue; }
            t.alive = false;
            try { t.ws.ping(); } catch { /* closing */ }
        }
    }, config.tunnel.pingMs);
    pinger.unref();

    function refuse(ws, code, message) {
        stats.refused++;
        try { ws.send(JSON.stringify({ t: 'error', code, message })); } catch { /* gone */ }
        // 4002: the key (or the computer's node token) is wrong, 4003: the share is closed or not this computer's (the
        // client stops for both); 4000: anything else, the client tries again.
        const close = code === 'key_invalid' || code === 'node_invalid' ? 4002 : code === 'share_revoked' || code === 'node_not_bound' ? 4003 : 4000;
        try { ws.close(close, message.slice(0, 120)); } catch { /* gone */ }
    }

    function accept(ws) {
        let tunnel = null;
        const hello = setTimeout(() => refuse(ws, 'hello_timeout', 'Say hello with your connect key first.'), config.tunnel.helloMs);
        ws.on('pong', () => { if (tunnel) tunnel.alive = true; });
        ws.on('error', () => {});
        ws.on('close', () => {
            clearTimeout(hello);
            if (tunnel) {
                tunnel.shutdown(1000, 'closed');
                if (live.get(tunnel.share.id) === tunnel) live.delete(tunnel.share.id);
            }
        });
        ws.on('message', async (message, isBinary) => {
            if (tunnel) {
                tunnel.alive = true;
                if (tunnel.node && !isBinary && message.length < 8192 && String(message).includes('"reauth"')) {
                    let r = null;
                    try { r = JSON.parse(String(message)); } catch { /* not ours */ }
                    if (r && r.t === 'reauth') return reauth(tunnel, r);
                }
                return tunnel.onMessage(message, isBinary);
            }
            if (isBinary) return refuse(ws, 'hello_expected', 'The first message is the hello.');
            let m;
            try { m = JSON.parse(String(message)); } catch { return refuse(ws, 'hello_expected', 'The first message is the hello.'); }
            if (!m || m.t !== 'hello') return refuse(ws, 'hello_expected', 'The first message is the hello.');
            clearTimeout(hello);
            if (m.v !== frames.VERSION) return refuse(ws, 'version', `This server speaks ${frames.PROTOCOL}. Download the client again from ${config.baseUrl}/ov-connect.js`);
            let share;
            let node = null;
            if (m.key === undefined && (m.node_token !== undefined || m.tunnel !== undefined)) {
                // A computer as OpenVibe Node (CON-4): its node token and a tunnel token, both checked.
                if (!nodeAuth) return refuse(ws, 'unavailable', 'Try again in a moment.');
                const v = await nodeAuth.verify(m.node_token);
                if (!v.ok) return v.status === 503 ? refuse(ws, 'unavailable', 'Try again in a moment.') : refuse(ws, 'node_invalid', 'OpenVibe did not take this computer\'s node token. Pair it with OpenVibe again.');
                try { share = await shares.get(typeof m.share === 'string' ? m.share.slice(0, 64) : ''); } catch (err) { log.warn('[OpenVibe.Connect] share lookup failed:', err.message); return refuse(ws, 'unavailable', 'Try again in a moment.'); }
                // The ticket is spent whatever happens next: one try each.
                const ticket = share ? nodeAuth.redeem(m.tunnel, share.id, v.node) : false;
                if (!share || !share.node || share.node.id !== v.node) return refuse(ws, 'node_not_bound', 'This computer does not serve that share. Pick it on the share\'s page.');
                if (share.status !== 'active') return refuse(ws, 'share_revoked', 'That share is closed.');
                if (!ticket) return refuse(ws, 'tunnel_token', 'That tunnel token is spent or late. Ask for a new one.');
                node = v;
            } else {
                try { share = await shares.byKey(m.key); } catch (err) { log.warn('[OpenVibe.Connect] key lookup failed:', err.message); return refuse(ws, 'unavailable', 'Try again in a moment.'); }
                if (!share) return refuse(ws, 'key_invalid', 'That connect key is not one we know. Make a new one on your share page.');
                if (share.status !== 'active') return refuse(ws, 'share_revoked', 'That share is closed.');
            }
            const t = new Tunnel(ws, share, { log, maxStreams: config.shares.maxStreams });
            if (node) { t.node = node.node; t.authUntil = node.exp; }
            t.clientInfo = { client: String(m.client || '').slice(0, 60), port: Number.isInteger(m.port) ? m.port : null };
            const old = live.get(share.id);
            if (old) { stats.replaced++; old.shutdown(4001, 'replaced by a newer connection'); }
            live.set(share.id, t);
            tunnel = t;
            stats.connects++;
            shares.touchConnected(share.id).catch(() => {});
            // The people who asked to be told it is back (CON-17); never in the way of the connection.
            if (onConnect) Promise.resolve().then(() => onConnect(share)).catch(() => {});
            t.send({ t: 'ready', v: frames.VERSION, share: { id: share.id, host: share.host, url: share.url, mode: share.mode, local_port: share.local_port }, ...(node ? { node: true, until: new Date(node.exp).toISOString() } : {}) });
            return undefined;
        });
    }

    /** A fresh node token from a computer's open tunnel: the same computer, still bound to the share. */
    async function reauth(t, m) {
        const v = nodeAuth ? await nodeAuth.verify(m.node_token) : { ok: false, status: 503 };
        if (!v.ok && v.status === 503) return t.send({ t: 'error', code: 'unavailable', message: 'Try again in a moment.' });
        if (!v.ok || v.node !== t.node) { stats.refused++; return t.shutdown(4002, 'node token refused'); }
        let share = null;
        try { share = await shares.get(t.share.id); } catch { return t.send({ t: 'error', code: 'unavailable', message: 'Try again in a moment.' }); }
        if (!share || share.status !== 'active' || !share.node || share.node.id !== v.node) return t.shutdown(4003, 'this computer no longer serves the share');
        t.authUntil = v.exp;
        return t.send({ t: 'reauthed', until: new Date(v.exp).toISOString() });
    }

    function handleUpgrade(req, socket, head) {
        wss.handleUpgrade(req, socket, head, (ws) => accept(ws));
    }

    function close(shareId, code = 4003, why = 'closed') {
        const t = live.get(shareId);
        if (!t) return false;
        live.delete(shareId);
        t.shutdown(code, why);
        return true;
    }

    function closeAll() {
        clearInterval(pinger);
        for (const id of [...live.keys()]) close(id, 1001, 'server restarting');
        wss.close();
    }

    function status() {
        return { connected: live.size, streams: [...live.values()].reduce((n, t) => n + t.streams.size, 0), ...stats };
    }

    return { handleUpgrade, get: (id) => live.get(id) || null, close, closeAll, status, sweep, isConnected: (id) => live.has(id) };
}

module.exports = { createTunnels, Tunnel, HIGH_WATER };
