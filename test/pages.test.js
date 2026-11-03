'use strict';
/**
 * The pages without JavaScript: the front door for a guest and for a person, making a share with the form (the key
 * shown on that page only), a refused name keeping what was typed, the share page, who can open it, a new key,
 * closing, the grant's "not for you" page, cross-site writes refused, and another person's share is a 404.
 */
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { check, done } = require('./helpers/check');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    let id;

    await check('a guest sees what Connect is and a sign-in to start; no form', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /Your computer, on the web, privately/);
        assert.match(r.text, /Sign in to make a share/);
        assert.ok(!r.text.includes('action="/shares"'));
        assert.match(r.text, /<meta name="robots" content="index, follow"/);
    });

    await check('signed in: your shares and the form, with your own address in it', async () => {
        const r = await t.get('/', { as: kim });
        assert.match(r.text, /No shares yet/);
        assert.match(r.text, /action="\/shares"/);
        assert.match(r.text, /--kim\.openvibe\.website/);
    });

    await check('the form makes a share and shows its key once, with the commands', async () => {
        const r = await t.get('/shares', { as: kim, form: { label: 'portal', port: '8790', mode: 'owner', named: '' } });
        assert.strictEqual(r.status, 201, r.text.slice(0, 300));
        const key = r.text.match(/ovc_[A-Za-z0-9_-]{43}/)[0];
        assert.match(r.text, /Your connect key/);
        assert.ok(r.text.includes(`node ov-connect.js --key ${key} --port 8790`));
        assert.match(r.text, /curl -fsSLO https:\/\/connect\.openvibe\.website\/ov-connect\.js/);
        assert.match(r.headers.get('cache-control'), /no-store|private/);
        id = (await t.get('/api/v1/shares', { as: kim })).json().shares[0].id;
        const again = await t.get(`/shares/${id}`, { as: kim });
        assert.strictEqual(again.status, 200);
        assert.ok(!again.text.includes(key), 'never shown again');
        assert.match(again.text, /The key was shown once/);
    });

    await check('a refused name says why and keeps what was typed', async () => {
        const r = await t.get('/shares', { as: kim, form: { label: 'portal', port: '8790', mode: 'named', named: 'sam' } });
        assert.strictEqual(r.status, 409);
        assert.match(r.text, /You already have a share with that name/);
        assert.match(r.text, /value="sam"/);
    });

    await check('who can open it: saved, then shown', async () => {
        const r = await t.get(`/shares/${id}/policy`, { as: kim, form: { mode: 'named', named: '@lee, sam', port: '8791' } });
        assert.strictEqual(r.status, 303);
        const page = await t.get(r.headers.get('location'), { as: kim });
        assert.match(page.text, /Saved\./);
        assert.match(page.text, /@lee, @sam/);
        assert.match(page.text, /localhost:8791/);
    });

    await check('another site cannot change a share (the form must come from Connect)', async () => {
        const r = await t.get(`/shares/${id}/close`, { as: kim, method: 'POST', form: {}, origin: 'https://evil.example' });
        assert.strictEqual(r.status, 403);
        assert.strictEqual((await t.get('/api/v1/shares', { as: kim })).json().shares[0].status, 'active');
        const api = await t.get(`/api/v1/shares/${id}`, { as: kim, method: 'DELETE', origin: 'https://evil.example' });
        assert.strictEqual(api.status, 403);
        assert.strictEqual(api.json().code, 'connect.cross_site');
    });

    await check('another person: the share page is a 404, and the grant says "not for you"', async () => {
        assert.strictEqual((await t.get(`/shares/${id}`, { as: lee })).status, 404);
        await t.get(`/shares/${id}/policy`, { as: kim, form: { mode: 'owner', named: '' } });
        const g = await t.get(`/grant?share=${id}`, { as: lee });
        assert.strictEqual(g.status, 403);
        assert.match(g.text, /You can.t open portal--kim\.openvibe\.website/);
        assert.match(g.text, /Use another account/);
    });

    await check('a new key is shown once on the page; closing says so and keeps the address', async () => {
        const k = await t.get(`/shares/${id}/key`, { as: kim, method: 'POST', form: {} });
        assert.strictEqual(k.status, 200);
        assert.match(k.text, /A new key is made/);
        assert.match(k.text, /ovc_[A-Za-z0-9_-]{43}/);
        const c = await t.get(`/shares/${id}/close`, { as: kim, method: 'POST', form: {} });
        assert.match(c.text, /Closed\. The address answers/);
        assert.ok(!c.text.includes('action="/shares/' + id + '/policy"'), 'a closed share has no settings');
        const home = await t.get('/', { as: kim });
        assert.match(home.text, /Closed shares \(1\)/);
    });

    await check('signed out, the share pages ask for sign-in first', async () => {
        const r = await t.get(`/shares/${id}`);
        assert.strictEqual(r.status, 303);
        assert.match(r.headers.get('location'), /^\/auth\/login\?next=/);
    });

    await check('robots, llms.txt and the client download', async () => {
        assert.match((await t.get('/robots.txt')).text, /Disallow: \/grant/);
        assert.match((await t.get('/llms.txt')).text, /OpenVibe Connect/);
        // SEO-2: the agent manifest is served (11-03: the mount had landed inside the share-host middleware, after its
        // return, so it never ran while the source check passed).
        const agent = await t.get('/.well-known/agent.json');
        assert.strictEqual(agent.status, 200);
        const m = agent.json();
        assert.deepStrictEqual([m.network, m.id, m.home], ['OpenVibe', 'connect', 'https://connect.openvibe.website']);
        // SEO-33: llms.txt, then the README (Connect's full documentation).
        const full = await t.get('/llms-full.txt');
        assert.strictEqual(full.status, 200);
        assert.ok(full.text.startsWith('# OpenVibe Connect'));
        assert.match(full.text, /## The documentation \(README\)\n\n# /);
        assert.match(full.text, /API keys for programs/, 'the README\'s sections are in it');
        assert.ok(full.text.length > 5000, `${full.text.length} characters`);
        const js = await t.get('/ov-connect.js');
        assert.strictEqual(js.status, 200);
        assert.match(js.headers.get('content-type'), /javascript/);
        assert.match(js.text, /ovconnect-ws\/1/);
    });

    await t.close();
    done();
})();
