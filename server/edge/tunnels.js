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

function createTunnels({ shares, config, log = console }) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
    const live = new Map();   // share id → Tunnel
    const stats = { connects: 0, refused: 0, replaced: 0 };

    const pinger = setInterval(() => {
        for (const t of live.values()) {
            if (!t.alive) { t.shutdown(4008, 'no answer to ping'); continue; }
            t.alive = false;
            try { t.ws.ping(); } catch { /* closing */ }
        }
    }, config.tunnel.pingMs);
    pinger.unref();

    function refuse(ws, code, message) {
        stats.refused++;
        try { ws.send(JSON.stringify({ t: 'error', code, message })); } catch { /* gone */ }
        // 4002: the key is wrong, 4003: the share is closed (the client stops for both); 4000: anything else.
        try { ws.close(code === 'key_invalid' ? 4002 : code === 'share_revoked' ? 4003 : 4000, message.slice(0, 120)); } catch { /* gone */ }
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
            if (tunnel) { tunnel.alive = true; return tunnel.onMessage(message, isBinary); }
            if (isBinary) return refuse(ws, 'hello_expected', 'The first message is the hello.');
            let m;
            try { m = JSON.parse(String(message)); } catch { return refuse(ws, 'hello_expected', 'The first message is the hello.'); }
            if (!m || m.t !== 'hello') return refuse(ws, 'hello_expected', 'The first message is the hello.');
            clearTimeout(hello);
            if (m.v !== frames.VERSION) return refuse(ws, 'version', `This server speaks ${frames.PROTOCOL}. Download the client again from ${config.baseUrl}/ov-connect.js`);
            let share;
            try { share = await shares.byKey(m.key); } catch (err) { log.warn('[OpenVibe.Connect] key lookup failed:', err.message); return refuse(ws, 'unavailable', 'Try again in a moment.'); }
            if (!share) return refuse(ws, 'key_invalid', 'That connect key is not one we know. Make a new one on your share page.');
            if (share.status !== 'active') return refuse(ws, 'share_revoked', 'That share is closed.');
            const t = new Tunnel(ws, share, { log, maxStreams: config.shares.maxStreams });
            t.clientInfo = { client: String(m.client || '').slice(0, 60), port: Number.isInteger(m.port) ? m.port : null };
            const old = live.get(share.id);
            if (old) { stats.replaced++; old.shutdown(4001, 'replaced by a newer connection'); }
            live.set(share.id, t);
            tunnel = t;
            stats.connects++;
            shares.touchConnected(share.id).catch(() => {});
            t.send({ t: 'ready', v: frames.VERSION, share: { id: share.id, host: share.host, url: share.url, mode: share.mode } });
            return undefined;
        });
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

    return { handleUpgrade, get: (id) => live.get(id) || null, close, closeAll, status, isConnected: (id) => live.has(id) };
}

module.exports = { createTunnels, Tunnel, HIGH_WATER };
