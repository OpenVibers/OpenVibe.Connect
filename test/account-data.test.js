'use strict';
/**
 * ADR-033: Connect's part of an account export (a person's shares, without the key hash, and their visits) and of a
 * deletion, applied through /internal/events with a stand-in Network. A deletion erases the person's shares and
 * visits and leaves other people's alone. A redelivery changes nothing; a bad signature and a proxied request are
 * refused.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot } = require('./helpers/boot');
const { check, done } = require('./helpers/check');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');

const A = ids.newId('user');
const B = ids.newId('user');
const EXP = `exp_${ids.ulid()}`;
const DEL = `del_${ids.ulid()}`;
const SECRET = `fixture_${'account'.repeat(6)}`;
const WRONG = `fixture_${'mismatch'.repeat(6)}`;

const exportEvent = { event_id: `evt_${ids.ulid()}`, event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXP, subject: A } };
const deleteEvent = { event_id: `evt_${ids.ulid()}`, event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DEL, subject: A, aliases: [] } };
const bodyOf = (ev) => JSON.stringify({ event: ev, seq: 1 });

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_connect', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw.toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const stub = await startNetworkStub();
    const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'connect', clientSecret: 'connect-secret' });
    const t = await boot({ env: { CONNECT_EVENTS_SECRET: SECRET }, accountSend: sender });
    try {
        const db = t.ctx.s.db;
        const shareA = `shr_${ids.ulid()}`;
        const shareB = `shr_${ids.ulid()}`;
        await db.exec(
            `INSERT INTO shares (id, owner_subject, owner_username, label, host, local_port, key_prefix, key_hash)
             VALUES ($1, $2, 'ann', 'agents', 'agents--ann.openvibe.website', 8790, 'ovc_aaaaaa', 'hash-a'),
                    ($3, $4, 'ben', 'blog', 'blog--ben.openvibe.website', 3000, 'ovc_bbbbbb', 'hash-b')`,
            [shareA, A, shareB, B],
        );
        // A visited B's share; B visited A's.
        await db.exec(`INSERT INTO share_visits (share_id, day, subject, username, requests) VALUES ($1, current_date, $2, 'ann', 3), ($3, current_date, $4, 'ben', 2)`, [shareB, A, shareA, B]);

        await check('an export carries only A\'s shares (no key hash) and A\'s visits', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'exported');
            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.ok(part, 'the part was pushed to Network');
            assert.strictEqual(part.auth, 'Bearer tok_connect');
            assert.strictEqual(part.body.subject, A);
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['shares.json', 'visits.json']);
            const shares = part.body.files.find((f) => f.name === 'shares.json').content;
            assert.deepStrictEqual(shares.map((w) => w.id), [shareA]);
            assert.ok(!JSON.stringify(part.body).includes('hash-a'), 'the key hash stays here');
            const visits = part.body.files.find((f) => f.name === 'visits.json').content;
            assert.deepStrictEqual(visits.map((v) => v.share_id), [shareB]);
        });

        await check('a deletion erases A\'s shares and visits and confirms with counts; B\'s share stays', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'erased');
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM shares WHERE owner_subject = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM share_visits WHERE subject = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM shares WHERE owner_subject = $1', [B])), 1);
            const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.ok(confirmation, 'the confirmation was sent');
            assert.ok(confirmation.body.erased.shares >= 1);
            assert.ok(!Number.isNaN(Date.parse(confirmation.body.completed_at)));
        });

        await check('a redelivery changes nothing', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'unchanged');
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM shares WHERE owner_subject = $1', [A])), 0);
        });

        await check('the internal route refuses a bad signature (401) and a forwarded request (403)', async () => {
            const bad = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), WRONG) } });
            assert.strictEqual(bad.status, 401);
            const forwarded = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(forwarded.status, 403);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
