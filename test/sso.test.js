'use strict';
/**
 * Sign-in through openvibe-sdk/sso (PKCE S256, client id connect; the SDK's cookies ov_token/ov_refresh/ov_oauth_state,
 * and connect_at read as the session), the session-token rules (a FedCM assertion or an app token is not a
 * session), the open-redirect guard, /auth/health, truthful readiness, loopback metrics, pages without JavaScript, and
 * cross-site sign-out.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot } = require('./helpers/boot');
const { check, done } = require('./helpers/check');
const { sanitizeNext } = require('../server/auth/sso');
const cookieJar = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');

    await check('login redirects to Network with state and an S256 code challenge, client id connect', async () => {
        const r = await t.get('/auth/login?next=/shares/shr_x');
        assert.strictEqual(r.status, 302);
        const loc = new URL(r.headers.get('location'));
        assert.strictEqual(loc.origin + loc.pathname, `${t.network.url}/oauth/authorize`);
        assert.strictEqual(loc.searchParams.get('client_id'), 'connect');
        assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
        assert.match(loc.searchParams.get('state'), /^[A-Za-z0-9_-]{32}$/);
        assert.match(r.headers.get('set-cookie'), /ov_oauth_state=.*Path=\/auth.*HttpOnly/i);
    });

    await check('callback exchanges the code with the matching verifier and sets httpOnly session cookies', async () => {
        const login = await t.get('/auth/login?next=/shares/shr_x');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = cookieJar(login);
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const r = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(r.status, 302, r.text);
        assert.strictEqual(r.headers.get('location'), '/shares/shr_x');
        const set = r.headers.get('set-cookie');
        assert.match(set, /ov_token=[^;]+;.*HttpOnly/i);
        assert.match(set, /ov_refresh=[^;]+;.*HttpOnly/i);
        assert.match(set, /ov_oauth_state=;/);
        const at = set.match(/ov_token=([^;]+)/)[1];
        const me = await t.get('/auth/me', { cookie: `ov_token=${at}` });
        assert.strictEqual(me.json().user.username, 'kim');
        assert.ok(!me.text.includes(at), '/auth/me never returns the token');
    });

    await check('a wrong state, a verifier that does not match, or no flow cookie starts the sign-in once more', async () => {
        const login = await t.get('/auth/login');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = cookieJar(login);
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const bad = await t.get(`/auth/callback?code=${code}&state=${'0'.repeat(32)}`, { cookie: flowCookie });
        assert.strictEqual(bad.status, 302, 'the SDK recovers by itself once');
        assert.match(bad.headers.get('location'), /^\/auth\/login/);
        const retry = cookieJar(bad);
        assert.match(retry, /ov_oauth_retry=1/);
        const again = await t.get(`/auth/callback?code=${code}&state=${'0'.repeat(32)}`, { cookie: `${flowCookie}; ${retry}` });
        assert.strictEqual(again.status, 400);
        assert.match(again.text, /Try again/);
        const other = t.network.issueCode(user, crypto.createHash('sha256').update('another-verifier').digest('base64url'));
        assert.strictEqual((await t.get(`/auth/callback?code=${other}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie })).status, 302);
        assert.strictEqual((await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`)).status, 302);
    });

    await check('next= only accepts same-site paths', async () => {
        const r = await t.get('/auth/login?next=//evil.example/x');
        assert.ok(/ov_oauth_next=;/.test(String(r.headers.get('set-cookie') || '')), 'a cross-site next is dropped');
        const opts = { baseUrl: 'https://connect.openvibe.website', networkUrl: 'https://openvibe.network' };
        assert.strictEqual(sanitizeNext('/shares/shr_x?x=1', opts), '/shares/shr_x?x=1');
        assert.strictEqual(sanitizeNext('https://connect.openvibe.website/drops?y=1', opts), 'https://connect.openvibe.website/drops?y=1');
        for (const v of ['//evil.com', '/\\evil.com', 'https://evil.com/x', '/\t/evil.com', 'javascript:alert(1)', 'https://connect.openvibe.website.evil.com/x']) assert.strictEqual(sanitizeNext(v, opts), '/', v);
    });

    await check('/auth/health says whether the Network accepts this client (the sign-in canary)', async () => {
        const r = await t.get('/auth/health');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json(), { ok: true, client: 'ok' });
    });

    await check('the old cookie is still the session, so nobody is signed out by the move', async () => {
        const me = await t.get('/auth/me', { cookie: `connect_at=${t.network.userToken(user)}` });
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.json().user.username, 'kim');
    });

    await check('readiness is truthful: db required; JWKS, the OAuth client and Valkey optional', async () => {
        const r = await t.get('/api/ready');
        const b = r.json();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(b.checks.db.status, 'ok');
        assert.strictEqual(b.checks.db.required, true);
        assert.strictEqual(b.checks.network_jwks.status, 'ok');
        assert.strictEqual(b.checks.network_jwks.required, false);
        assert.strictEqual(b.checks.oauth_client.status, 'ok');
        assert.strictEqual(b.checks.oauth_client.required, false);
        assert.ok('valkey' in b.checks);
    });

    await check('/release.json and /metrics (loopback only)', async () => {
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json().service, 'connect');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json()).errors, []);
        const m = await t.get('/metrics');
        assert.strictEqual(m.status, 200);
        assert.match(m.text, /http_requests_total|release_info/);
        const proxied = await t.get('/metrics', { headers: { 'x-forwarded-for': '203.0.113.9' } });
        assert.notStrictEqual(proxied.status, 200, 'a proxied request is not loopback');
    });

    await check('public pages are complete without JavaScript', async () => {
        for (const p of ['/']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, p);
            assert.match(r.text, /<noscript>/);
            assert.match(r.text, /<footer id="ov-footer"/);
            assert.match(r.text, /<main id="main"/);
        }
    });

    await check('the API asks for a person, and unknown routes are problem+json 404', async () => {
        const anon = await t.get('/api/v1/shares');
        assert.strictEqual(anon.status, 401);
        assert.strictEqual(anon.json().code, 'token.required');
        const gone = await t.get('/api/nope');
        assert.strictEqual(gone.status, 404);
        assert.match(gone.headers.get('content-type'), /application\/problem\+json/);
        assert.strictEqual(gone.json().code, 'route.not_found');
    });

    await check('a FedCM assertion and an app token are not sessions', async () => {
        const now = Math.floor(Date.now() / 1000);
        const fedcm = t.network.signJwt({ iss: t.network.issuer(), sub: user.id, id: user.id, subject_id: user.subject, username: user.username, display_name: user.username, nonce: null, typ: 'fedcm', jti: 'x', aud: 'https://tenant.openvibe.host', iat: now, exp: now + 300 });
        assert.strictEqual((await t.get('/auth/me', { cookie: `connect_at=${fedcm}` })).status, 401);
        const page = await t.get('/', { cookie: `connect_at=${fedcm}` });
        assert.ok(!page.text.includes('Signed in as <strong>kim'));
        const app = t.network.signJwt({ iss: t.network.issuer(), sub: 'app:app_01JABCDEFGHJKMNPQRSTVWXYZ0', actor_type: 'app', aud: ['openvibe.network'], cap: ['x.y.z'], subject_id: user.subject, iat: now, exp: now + 300 });
        assert.strictEqual((await t.get('/auth/me', { cookie: `connect_at=${app}` })).status, 401);
    });

    await check('/auth/me: a guest is signed out (200 { user: null }); a failing session cookie is 401', async () => {
        const guest = await t.get('/auth/me');
        assert.strictEqual(guest.status, 200);
        assert.deepStrictEqual(JSON.parse(guest.text), { user: null });
        assert.strictEqual(guest.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual((await t.get('/auth/me', { cookie: 'connect_at=garbage' })).status, 401);
        assert.strictEqual((await t.get('/auth/me', { cookie: 'connect_rt=stale' })).status, 401);
        assert.strictEqual((await t.get('/auth/me', { as: user })).status, 200);
    });

    await check('another site cannot sign a person out; this site can', async () => {
        const cross = await t.get('/auth/logout', { as: user, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(cross.status, 200);
        assert.ok(!/connect_at=;|connect_at=deleted/i.test(String(cross.headers.get('set-cookie') || '')));
        assert.match(cross.text, /method="post"/);
        const crossPost = await t.get('/auth/logout', { as: user, method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(crossPost.status, 403);
        const same = await t.get('/auth/logout?next=/shares', { as: user, headers: { 'sec-fetch-site': 'same-origin' } });
        assert.strictEqual(same.status, 303);
        assert.strictEqual(same.headers.get('location'), '/shares');
        assert.match(String(same.headers.get('set-cookie') || ''), /connect_at=;/);
    });

    await t.close();
    done();
})();
