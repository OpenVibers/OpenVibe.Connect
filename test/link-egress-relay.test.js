'use strict';
const assert = require('assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const WebSocket = require('ws');
const { once } = require('events');

(async () => {
    const fetchOriginal = globalThis.fetch;
    const credential = crypto.randomBytes(32).toString('base64url');
    let identity, checks = 0, allowed = true;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/api/v1/node/self/egress/identity')) return new Response(JSON.stringify(identity));
        if (String(url).endsWith('/api/v1/link-egress/open')) {
            checks++;
            const b = JSON.parse(options.body);
            return allowed && b.credential === credential && b.node_id === identity.node_id
                ? new Response(JSON.stringify({ node_id: b.node_id, session_id: b.session_id })) : new Response(null, { status: 403 });
        }
        return fetchOriginal(url, options);
    };
    const { boot } = require('./helpers/boot');
    const t = await boot({ env: { CONNECT_SHARE_DOMAIN: 'openvibe.link', CONNECT_SHARE_DOMAINS: 'openvibe.link' } });
    const endpoint = http.createServer();
    const streams = new WebSocket.Server({ noServer: true });
    endpoint.on('upgrade', (req, socket, head) => {
        if (req.headers['x-ov-egress'] !== credential || req.headers['x-ov-session'] !== 'ses_test') { socket.destroy(); return; }
        streams.handleUpgrade(req, socket, head, ws => ws.on('message', data => ws.send(data)));
    });
    await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
    let tunnel;
    const sockets = new Map();
    try {
        const owner = t.network.addUser('egressowner');
        const node = t.network.addNode(owner, { name: 'Home PC' });
        identity = { node_id: node.id, owner: owner.subject, name: 'Home PC' };
        const made = await t.get('/api/v1/node/egress-share', { method: 'POST', bearer: t.network.nodeToken(node),
            json: { network_token: 'test-network-token', port: endpoint.address().port } });
        assert.equal(made.status, 200, 'Node creates its dedicated share after Network confirms ownership');
        const share = made.json().share;
        const ticket = await t.get(`/api/v1/node/shares/${share.id}/tunnel-token`, { method: 'POST', bearer: t.network.nodeToken(node) });
        tunnel = new WebSocket(`ws://127.0.0.1:${t.port}/tunnel`);
        const packet = (kind, id, data = Buffer.alloc(0)) => { const h = Buffer.alloc(5); h[0] = kind; h.writeUInt32BE(id, 1); return Buffer.concat([h, data]); };
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('relay did not connect')), 5000);
            tunnel.on('message', (data, binary) => {
                if (binary) {
                    const socket = sockets.get(data.readUInt32BE(1));
                    if (socket) { if (data[0] === 1) socket.write(data.subarray(5)); else socket.end(); }
                    return;
                }
                const frame = JSON.parse(data);
                if (frame.t === 'ready') { clearTimeout(timer); resolve(); }
                if (frame.t === 'raw') {
                    const socket = net.connect(endpoint.address().port, '127.0.0.1', () => socket.write(frame.head));
                    sockets.set(frame.id, socket);
                    socket.on('data', b => { if (tunnel.readyState === WebSocket.OPEN) tunnel.send(packet(1, frame.id, b)); });
                    socket.on('end', () => { if (tunnel.readyState === WebSocket.OPEN) tunnel.send(packet(2, frame.id)); });
                    socket.on('error', () => socket.destroy());
                }
            });
            tunnel.on('error', reject);
        });
        await once(tunnel, 'open');
        tunnel.send(JSON.stringify({ t: 'hello', v: 1, client: 'egress-test', share: share.id,
            node_token: t.network.nodeToken(node), tunnel: ticket.json().tunnel_token, port: endpoint.address().port }));
        await ready;
        const connect = () => new WebSocket(`ws://127.0.0.1:${t.port}/__ov_egress`, { headers: { Host: share.host, 'X-OV-Session': 'ses_test', 'X-OV-Egress': credential } });
        const visitor = connect(); await once(visitor, 'open');
        const returned = once(visitor, 'message'); visitor.send(Buffer.from('through the existing relay'));
        assert.equal((await returned)[0].toString(), 'through the existing relay'); visitor.terminate();
        allowed = false;
        const refused = connect();
        const status = await new Promise((resolve, reject) => { refused.on('unexpected-response', (_, res) => { res.resume(); resolve(res.statusCode); refused.terminate(); }); refused.on('error', e => { if (!String(e.message).includes('closed before')) reject(e); }); });
        assert.equal(status, 403, 'a later owner refusal stops the next tunnel');
        assert.equal(checks, 2, 'each tunnel opens through Network');
        assert.ok(!String(t.logs()).includes(credential), 'credentials do not enter logs');
        process.stdout.write('Link egress relay: authenticated Node share, binary round-trip and fresh owner refusal passed\n');
    } finally {
        globalThis.fetch = fetchOriginal;
        if (tunnel) tunnel.terminate();
        for (const socket of sockets.values()) socket.destroy();
        for (const ws of streams.clients) ws.terminate();
        streams.close(); endpoint.close(); await t.close();
    }
})().catch(e => { process.stderr.write(`${e.stack}\n`); process.exitCode = 1; });
