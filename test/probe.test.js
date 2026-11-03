'use strict';
/**
 * The signed probe (CON-9): a share's front page is read through its tunnel once a day after its computer connects,
 * marked with a signed x-openvibe-probe header; a credential trap (a password, card or wallet-phrase field on a page
 * that names a brand, or with an urgent "verify your account") becomes an automatic report for staff, once; an
 * ordinary sign-in page does not.
 */
const assert = require('assert');
const http = require('http');
const { boot } = require('./helpers/boot');
const { check, done } = require('./helpers/check');
const { assess } = require('../server/probe');

const PHISH = `<html><head><title>PayPal: Log in to your account</title></head><body><h1>Log in to PayPal</h1>
<p>Your account has been limited. Verify your account to restore access.</p>
<form method="post"><label>Email</label><input name="email"><label>Password</label><input type="password" name="pw"><button>Log In</button></form></body></html>`;
const OWN_APP = `<html><head><title>My homelab</title></head><body><h1>Sign in to Grafana-lite</h1><form><input name="u"><input type="password" name="p"><button>Sign in</button></form></body></html>`;
const WALLET = `<html><head><title>Claim your airdrop</title></head><body><h1>Connect wallet</h1><p>Enter your 12-word seed phrase to claim.</p><textarea></textarea></body></html>`;

function appServing(html) {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push({ url: req.url, probe: req.headers['x-openvibe-probe'] || null, ua: req.headers['user-agent'] || '' }); res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) })));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    await check('assess: a branded sign-in trap and a wallet phrase go to review; an ordinary sign-in page does not', async () => {
        const a = assess(PHISH, { label: 'login' });
        assert.strictEqual(a.verdict, 'review');
        assert.deepStrictEqual(a.brands, ['paypal']);
        assert.ok(a.flags.includes('password_field') && a.flags.includes('urgency'));
        assert.match(a.why, /^Automatic check: the front page asks for a password and names paypal, with an urgent account warning\.$/);
        assert.strictEqual(assess(OWN_APP).verdict, 'ok', 'a person\'s own sign-in page is ordinary');
        assert.strictEqual(assess(WALLET).verdict, 'review');
        assert.ok(assess(WALLET).flags.includes('wallet_phrase'));
        assert.strictEqual(assess('<html><h1>Google Sheets export of my budget</h1></html>').verdict, 'ok', 'a brand without a secret field is fine');
        assert.strictEqual(assess('').verdict, 'ok');
    });

    const t = await boot({ probeDelayMs: 50 });
    const alex = t.network.addUser('alex');

    await check('a phishing page behind a share: one automatic report, the app sees the signed probe', async () => {
        const app = await appServing(PHISH);
        const made = await t.makeShare(alex, { label: 'pp-verify', port: app.port });
        const c = t.client({ key: made.key, port: app.port });
        await c.ready();
        let reports = [];
        for (let i = 0; i < 100 && !reports.length; i++) { await sleep(30); reports = await t.ctx.s.db.many('SELECT reason, details, reporter_subject FROM share_reports WHERE share_id = $1', [made.share.id]); }
        assert.strictEqual(reports.length, 1, 'one report');
        assert.strictEqual(reports[0].reason, 'phishing');
        assert.strictEqual(reports[0].reporter_subject, null, 'filed by the check, not a person');
        assert.match(reports[0].details, /names paypal/);
        const probe = app.seen.find((x) => x.probe);
        assert.ok(probe, 'the app saw the probe');
        assert.match(probe.probe, /^t=\d+,v1=[0-9a-f]{64}$/);
        assert.match(probe.ua, /OpenVibeConnectProbe/);
        // A reconnect the same day probes nothing more.
        c.stop();
        const c2 = t.client({ key: made.key, port: app.port });
        await c2.ready();
        await sleep(300);
        const again = await t.ctx.s.db.many('SELECT id FROM share_reports WHERE share_id = $1', [made.share.id]);
        assert.strictEqual(again.length, 1, 'once a day');
        const staff = t.network.addUser('staffer', { role: 'admin' });
        const page = await t.get('/admin/reports', { as: staff });
        assert.match(page.text, /Automatic check/);
        c2.stop();
        await app.close();
    });

    await check('an ordinary app behind a share: no report', async () => {
        const app = await appServing(OWN_APP);
        const made = await t.makeShare(alex, { label: 'homelab', port: app.port });
        const c = t.client({ key: made.key, port: app.port });
        await c.ready();
        for (let i = 0; i < 40 && !app.seen.some((x) => x.probe); i++) await sleep(30);
        assert.ok(app.seen.some((x) => x.probe), 'it was probed');
        await sleep(100);
        const reports = await t.ctx.s.db.many('SELECT id FROM share_reports WHERE share_id = $1', [made.share.id]);
        assert.strictEqual(reports.length, 0);
        c.stop();
        await app.close();
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
