'use strict';
// "Tell me when it's back" (CON-17): a visitor the gate knows finds a share offline, asks from the offline page, and
// gets one OpenVibe notification when its computer connects; then the list is empty. Strangers, other sites and a
// share that is already back are handled plainly.
//   node test/notify-back.test.js
const assert = require('assert');
const { boot, startLocalApp } = require('./helpers/boot');
const { check, done } = require('./helpers/check');

(async () => {
    const told = [];
    const notifier = { enabled: true, shareBack: async (subject, share) => { told.push([subject, share.host]); return { sent: true }; } };
    const t = await boot({ notifier });
    const app = await startLocalApp();
    const alex = t.network.addUser('alex_back');
    try {
        const made = await t.makeShare(alex, { label: 'later', port: app.port });
        const host = made.share.host;
        const cookie = (await t.enter(alex, made.share)).cookie;
        const ORIGIN = { origin: `https://${host}` };

        await check('offline, the page offers to tell the visitor, and its CSP lets that one form post here', async () => {
            const page = await t.share(host, '/', { cookie });
            assert.equal(page.status, 503);
            assert.match(page.text, /<form method="post" action="\/__ovc\/notify"><button type="submit">Tell me when it is back<\/button><\/form>/);
            assert.match(page.headers['content-security-policy'], /form-action 'self'/);
            assert.match(page.headers['content-security-policy'], /default-src 'none'/, 'still no script');
        });

        await check('asking adds them once; strangers and other sites cannot', async () => {
            const asked = await t.share(host, '/__ovc/notify', { method: 'POST', cookie, headers: ORIGIN });
            assert.equal(asked.status, 200, asked.text);
            assert.match(asked.text, /We will tell you/);
            await t.share(host, '/__ovc/notify', { method: 'POST', cookie, headers: ORIGIN });
            const rows = await t.ctx.s.db.many('SELECT subject FROM share_waiters WHERE share_id = $1', [made.share.id]);
            assert.deepStrictEqual(rows.map((r) => r.subject), [alex.subject], 'once');
            assert.equal((await t.share(host, '/__ovc/notify', { method: 'POST', headers: ORIGIN })).status, 401, 'no gate cookie');
            assert.equal((await t.share(host, '/__ovc/notify', { method: 'POST', cookie, headers: { origin: 'https://evil.example' } })).status, 403);
        });

        await check('when the computer connects, each waiting person is told once and the list empties', async () => {
            const c = t.client({ key: made.key, port: app.port });
            await c.ready();
            for (let i = 0; i < 50 && !told.length; i++) await new Promise((r) => setTimeout(r, 20));
            assert.deepStrictEqual(told, [[alex.subject, host]]);
            assert.equal((await t.ctx.s.db.many('SELECT 1 FROM share_waiters WHERE share_id = $1', [made.share.id])).length, 0);
            // Asking while it is back just opens it.
            const back = await t.share(host, '/__ovc/notify', { method: 'POST', cookie, headers: ORIGIN });
            assert.equal(back.status, 303);
            c.stop();
        });

        await check('the waiting list goes with the person (account data)', async () => {
            const { TABLES } = require('../server/identity/account-data');
            const map = TABLES.find((x) => x.table === 'share_waiters');
            assert.ok(map && map.subject === 'subject' && map.erase === 'delete');
        });
    } finally { await t.close(); await app.close(); }
    done();
})();
