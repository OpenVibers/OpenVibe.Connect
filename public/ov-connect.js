#!/usr/bin/env node
'use strict';
/**
 * ov-connect: put one port on your computer at your OpenVibe Connect address, behind OpenVibe sign-in.
 *
 *   node ov-connect.js --key ovc_… --port 8080
 *   OV_CONNECT_KEY=ovc_… node ov-connect.js 8080
 *
 * Needs Node 22 or newer and nothing else. It only ever opens connections to localhost on the port you give it: the
 * server cannot make it reach anything else. Your key is sent once per connection, over TLS, as the first message.
 *
 *   --key <ovc_…>      your share's connect key (or OV_CONNECT_KEY)
 *   --port <n>         the local port to share (or the first bare number)
 *   --server <wss://>  default wss://connect.openvibe.link/tunnel
 *   --quiet            no line per request
 *
 * Source: https://github.com/OpenVibers/OpenVibe.Connect (AGPL-3.0). Protocol: ovconnect-ws/1 (server/edge/frames.js).
 */
const http = require('http');
const net = require('net');

const VERSION = '0.1.0';
const PROTOCOL_VERSION = 1;
const HIGH_WATER = 4 * 1024 * 1024;
const KIND = { DATA: 1, END: 2 };

function parseArgs(argv) {
    const o = { key: process.env.OV_CONNECT_KEY || '', port: 0, server: process.env.OV_CONNECT_SERVER || DEFAULT_SERVER, quiet: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--key') o.key = argv[++i] || '';
        else if (a.startsWith('--key=')) o.key = a.slice(6);
        else if (a === '--port') o.port = Number(argv[++i]);
        else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
        else if (a === '--server') o.server = argv[++i] || o.server;
        else if (a.startsWith('--server=')) o.server = a.slice(9);
        else if (a === '--quiet' || a === '-q') o.quiet = true;
        else if (a === '--help' || a === '-h') o.help = true;
        else if (a === '--version') o.version = true;
        else if (/^\d+$/.test(a) && !o.port) o.port = Number(a);
    }
    return o;
}

function encode(kind, id, payload) {
    const body = payload ? Buffer.from(payload) : Buffer.alloc(0);
    const out = Buffer.allocUnsafe(5 + body.length);
    out.writeUInt8(kind, 0);
    out.writeUInt32BE(id >>> 0, 1);
    body.copy(out, 5);
    return out;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.version) { console.log(`ov-connect ${VERSION}`); return; }
    if (opts.help || !opts.key || !opts.port) {
        console.log('ov-connect: share a port on this computer at your OpenVibe Connect address.\n\n  node ov-connect.js --key ovc_… --port 8080\n\nMake a share and its key at https://connect.openvibe.link');
        process.exitCode = opts.help ? 0 : 2;
        return;
    }
    if (typeof WebSocket !== 'function') { console.error('ov-connect needs Node 22 or newer (it uses the built-in WebSocket).'); process.exitCode = 2; return; }
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) { console.error('The port is a number from 1 to 65535.'); process.exitCode = 2; return; }
    const client = createClient(opts);
    client.start();
    const stop = () => { client.stop(); setTimeout(() => process.exit(0), 300).unref(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

/**
 * The client itself (exported for tests): createClient({ key, port, server, quiet, log, localHost }) → { start, stop, onReady }
 */
const DEFAULT_SERVER = 'wss://connect.openvibe.link/tunnel';

function createClient(opts) {
    opts = { ...opts, server: opts.server || DEFAULT_SERVER };
    const log = opts.log || ((line) => console.log(line));
    const localHost = opts.localHost || 'localhost';
    let ws = null;
    let stopped = false;
    let backoff = 1000;
    let readyShare = null;
    const streams = new Map();   // id → { kind: 'http'|'raw', req?, res?, sock? }
    const listeners = { ready: [] };

    const sendJson = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
    const sendData = (id, buf) => { if (ws && ws.readyState === 1 && buf.length) ws.send(encode(KIND.DATA, id, buf)); };
    const sendEnd = (id) => { if (ws && ws.readyState === 1) ws.send(encode(KIND.END, id)); };
    const congested = () => ws && ws.bufferedAmount > HIGH_WATER;
    function whenDrained(fn) { const tick = () => { if (!congested()) fn(); else setTimeout(tick, 10); }; setTimeout(tick, 10); }
    function abort(id, code, message) { sendJson({ t: 'abort', id, code, message: String(message || '').slice(0, 200) }); cleanup(id); }
    function cleanup(id) {
        const s = streams.get(id);
        if (!s) return;
        streams.delete(id);
        try { if (s.req) s.req.destroy(); } catch { /* gone */ }
        try { if (s.sock) s.sock.destroy(); } catch { /* gone */ }
    }

    function onRequest(m) {
        const started = Date.now();
        const flat = [];
        for (const [k, v] of Array.isArray(m.headers) ? m.headers : []) flat.push(k, v);
        let req;
        try {
            req = http.request({ host: localHost, port: opts.port, method: m.method, path: m.path, headers: flat, setHost: false });
        } catch (err) {
            sendJson({ t: 'abort', id: m.id, code: 'local_error', message: String(err && err.code || 'bad request') });
            return;
        }
        const s = { kind: 'http', req, res: null };
        streams.set(m.id, s);
        req.on('response', (res) => {
            s.res = res;
            const headers = [];
            for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
            sendJson({ t: 'res', id: m.id, status: res.statusCode, headers });
            if (!opts.quiet) log(`${m.method} ${String(m.path).slice(0, 120)} returned ${res.statusCode} (${Date.now() - started} ms)`);
            res.on('data', (chunk) => {
                sendData(m.id, chunk);
                if (congested()) { res.pause(); whenDrained(() => res.resume()); }
            });
            res.on('end', () => { sendEnd(m.id); streams.delete(m.id); });
            res.on('error', () => abort(m.id, 'local_error', 'the response broke off'));
        });
        req.on('error', (err) => {
            if (!streams.has(m.id)) return;
            const refused = err && (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL');
            if (!opts.quiet) log(`${m.method} ${String(m.path).slice(0, 120)} failed: ${refused ? `nothing listening on port ${opts.port}` : err.message}`);
            abort(m.id, refused ? 'local_refused' : 'local_error', err && err.code);
        });
        req.on('drain', () => sendJson({ t: 'resume', id: m.id }));
    }

    function onRaw(m) {
        const sock = net.connect({ host: localHost, port: opts.port });
        const s = { kind: 'raw', sock, connected: false, buffered: [] };
        streams.set(m.id, s);
        sock.on('connect', () => {
            s.connected = true;
            sock.write(String(m.head));
            for (const b of s.buffered) sock.write(b);
            s.buffered = [];
            if (s.ended) sock.end();
        });
        sock.on('data', (chunk) => {
            sendData(m.id, chunk);
            if (congested()) { sock.pause(); whenDrained(() => sock.resume()); }
        });
        sock.on('end', () => { sendEnd(m.id); });
        sock.on('close', () => { if (streams.has(m.id)) { streams.delete(m.id); sendEnd(m.id); } });
        sock.on('error', (err) => {
            const refused = err && err.code === 'ECONNREFUSED';
            abort(m.id, refused ? 'local_refused' : 'local_error', err && err.code);
        });
        sock.on('drain', () => sendJson({ t: 'resume', id: m.id }));
        if (!opts.quiet) log(`upgrade ${String(m.head).split('\r\n')[0].slice(0, 120)}`);
    }

    function onBinary(buf) {
        if (buf.length < 5) return;
        const kind = buf.readUInt8(0);
        const id = buf.readUInt32BE(1);
        const s = streams.get(id);
        if (!s) return;
        if (kind === KIND.DATA) {
            const payload = buf.subarray(5);
            if (s.kind === 'http') { if (!s.req.write(payload)) sendJson({ t: 'pause', id }); }
            else if (!s.connected) s.buffered.push(payload);
            else if (!s.sock.write(payload)) sendJson({ t: 'pause', id });
        } else if (kind === KIND.END) {
            if (s.kind === 'http') s.req.end();
            else if (s.connected) s.sock.end();
            else s.ended = true;
        }
    }

    function onControl(m) {
        if (m.t === 'ready') {
            backoff = 1000;
            readyShare = m.share;
            log(`Connected. ${m.share.url} now serves localhost:${opts.port}  (only people you let in can open it)`);
            for (const fn of listeners.ready) fn(m.share);
            return;
        }
        if (m.t === 'error') { log(`The server refused: ${m.message}`); return; }
        if (m.t === 'req') return onRequest(m);
        if (m.t === 'raw') return onRaw(m);
        const s = Number.isInteger(m.id) ? streams.get(m.id) : null;
        if (!s) return;
        if (m.t === 'abort') cleanup(m.id);
        else if (m.t === 'pause') { if (s.res) s.res.pause(); if (s.sock) s.sock.pause(); }
        else if (m.t === 'resume') { if (s.res) s.res.resume(); if (s.sock) s.sock.resume(); }
    }

    function connect() {
        if (stopped) return;
        ws = new WebSocket(opts.server);
        ws.binaryType = 'arraybuffer';
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, key: opts.key, client: `ov-connect/${VERSION}`, port: opts.port }));
        });
        ws.addEventListener('message', (ev) => {
            if (typeof ev.data === 'string') {
                let m;
                try { m = JSON.parse(ev.data); } catch { return; }
                if (m && typeof m === 'object') onControl(m);
            } else onBinary(Buffer.from(ev.data));
        });
        ws.addEventListener('close', (ev) => {
            for (const id of [...streams.keys()]) cleanup(id);
            if (stopped) return;
            if (ev.code === 4001) { log('Another ov-connect took over this share. Stopping here.'); stopped = true; return; }
            if (ev.code === 4002 || ev.code === 4003) { log(`Stopped: ${ev.reason || 'the share or its key is no longer valid'}.`); stopped = true; process.exitCode = 1; return; }
            const wait = backoff;
            backoff = Math.min(backoff * 2, 30_000);
            log(`Disconnected${ev.reason ? ` (${ev.reason})` : ''}. Trying again in ${Math.round(wait / 1000)} s…`);
            setTimeout(connect, wait);
        });
        ws.addEventListener('error', () => { /* the close event follows */ });
    }

    return {
        start() { stopped = false; connect(); },
        stop() { stopped = true; for (const id of [...streams.keys()]) cleanup(id); try { if (ws) ws.close(1000, 'bye'); } catch { /* gone */ } },
        onReady(fn) { listeners.ready.push(fn); if (readyShare) fn(readyShare); },
        get share() { return readyShare; },
    };
}

if (require.main === module) main();

module.exports = { createClient, parseArgs, encode, VERSION, DEFAULT_SERVER };
