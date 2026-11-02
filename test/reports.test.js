'use strict';
// The abuse gate, v0 (CON-9): anyone reports a share by its address (from this site only, five an hour per address,
// no address stored); staff read the open reports and close a share, which disconnects its computer and makes the
// address say it was closed after a report; a report can be dismissed. Nobody else sees the queue. A reporter's
// account goes with them on erasure, and the report stays.
//   node test/reports.test.js
const assert = require('assert');
const { boot, startLocalApp } = require('./helpers/boot');
const { check, done } = require('./helpers/check');

const SAME = { origin: 'https://connect.openvibe.website' };

(async () => {
    const t = await boot();
    const app = await startLocalApp();
    const sam = t.network.addUser('sam_rpt');
    const rita = t.network.addUser('rita_rpt');
    const staff = t.network.addUser('staff_rpt', { role: 'admin' });
    try {
        const made = await t.makeShare(sam, { label: 'shop', port: app.port });
        const c = t.client({ key: made.key, port: app.port });
        await c.ready();

        await check('anyone reports a share by its address; the form takes the whole URL too', async () => {
            const form = await t.get(`/report?host=${made.share.host}`);
            assert.equal(form.status, 200);
            assert.ok(form.text.includes(`value="${made.share.host}"`));
            assert.match(form.text, /name="reason" value="phishing"/);
            const sent = await t.get('/report', { ...SAME, form: { host: `https://${made.share.host}/login`, reason: 'phishing', details: 'It asks for a bank password.' } });
            assert.equal(sent.status, 201, sent.text);
            assert.match(sent.text, /The report is in/);
            const signed = await t.get('/report', { ...SAME, as: rita, form: { host: made.share.host, reason: 'abuse' } });
            assert.equal(signed.status, 201);
        });

        await check('a report needs a share that exists, a reason, and this site', async () => {
            assert.equal((await t.get('/report', { ...SAME, form: { host: 'nope--nobody.openvibe.website', reason: 'other' } })).status, 404);
            assert.equal((await t.get('/report', { ...SAME, form: { host: made.share.host, reason: 'because' } })).status, 422);
            assert.equal((await t.get('/report', { origin: 'https://evil.example', form: { host: made.share.host, reason: 'other' } })).status, 403);
        });

        await check('only staff see the queue', async () => {
            assert.equal((await t.get('/admin/reports', { as: rita })).status, 404);
            assert.equal((await t.get('/admin/reports')).status, 303, 'signed out: sign in');
            const q = await t.get('/admin/reports', { as: staff });
            assert.equal(q.status, 200);
            assert.ok(q.text.includes(made.share.host));
            assert.match(q.text, /It asks for a bank password\./);
            assert.match(q.text, /2 reports/);
        });

        let ids = [];
        await check('a report can be dismissed; closing the share settles the rest, disconnects it and the address says why', async () => {
            const rows = await t.ctx.s.db.many("SELECT id, reason FROM share_reports WHERE share_id = $1 ORDER BY created_at", [made.share.id]);
            ids = rows.map((r) => r.id);
            assert.equal((await t.get(`/admin/reports/${ids[1]}/dismiss`, { ...SAME, as: staff, form: {}, method: 'POST' })).status, 303);
            assert.equal((await t.get(`/admin/reports/${ids[0]}/close`, { ...SAME, as: rita, form: {}, method: 'POST' })).status, 404, 'not staff');
            const closed = await t.get(`/admin/reports/${ids[0]}/close`, { ...SAME, as: staff, form: {}, method: 'POST' });
            assert.equal(closed.status, 303);
            assert.match(closed.headers.get('location'), /done=close/);
            const states = (await t.ctx.s.db.many('SELECT status FROM share_reports WHERE share_id = $1 ORDER BY created_at', [made.share.id])).map((r) => r.status);
            assert.deepStrictEqual(states, ['closed_share', 'dismissed']);
            const row = (await t.get(`/api/v1/shares/${made.share.id}`, { as: sam })).json().share;
            assert.deepStrictEqual([row.status, row.closed_reason], ['revoked', 'report']);
            await new Promise((r) => setTimeout(r, 100));
            assert.equal(t.ctx.tunnels.isConnected(made.share.id), false, 'its computer is let go');
            const page = await t.share(made.share.host, '/', { headers: { accept: 'text/html' } });
            assert.equal(page.status, 410);
            assert.match(page.text, /closed shop--sam-rpt\.openvibe\.website after a report|after a report/);
            assert.match((await t.get('/admin/reports', { as: staff })).text, /No open reports\./);
        });

        await check('the account goes with the reporter; the report stays', async () => {
            const { TABLES } = require('../server/identity/account-data');
            const map = TABLES.find((x) => x.table === 'share_reports');
            assert.ok(map && map.subject === 'reporter_subject');
            assert.deepStrictEqual(map.erase, { anonymize: {} });
            assert.ok(!map.columns.includes('reporter_subject'));
        });

        await check('five reports an hour per address, then a polite no', async () => {
            const other = await t.makeShare(rita, { label: 'blog', port: app.port });
            let last;
            for (let i = 0; i < 6; i++) last = await t.get('/report', { ...SAME, form: { host: other.share.host, reason: 'other' } });
            assert.equal(last.status, 429);
        });
    } finally { await t.close(); await app.close(); }
    done();
})();
