'use strict';
/**
 * MCP OAuth 2.1 for shares (CON-16): an MCP client signs a person in to a share with OpenVibe.
 *   - the share answers a program without credentials 401 + WWW-Authenticate resource_metadata, and serves its
 *     protected-resource document (RFC 9728) naming Connect as the authorization server (RFC 8414 metadata there);
 *   - a public client registers (RFC 7591; https or loopback redirect URIs only);
 *   - authorize: unknown client or redirect URI is a page, never a redirect; no PKCE goes back with an error; the person
 *     signs in, the share's own policy decides, they consent (the consent page's form-action allows the app's origin);
 *     "no" goes back with access_denied;
 *   - token: PKCE S256 checked, a code works once, the access token opens this share only, as the person, and the app
 *     never sees it; refresh rotates (the old refresh token and access token stop);
 *   - the owner sees the app signed in and signs it out; a policy change stops every token.
 *   node test/mcp-oauth.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, startLocalApp } = require('./helpers/boot');
const { check, done } = require('./helpers/check');

const b64url = (b) => Buffer.from(b).toString('base64url');
const pkce = () => { const verifier = b64url(crypto.randomBytes(48)); return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) }; };
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

(async () => {
    const t = await boot();
    const app = await startLocalApp();
    const alex = t.network.addUser('alex');
    const bob = t.network.addUser('bob');
    const made = await t.makeShare(alex, { label: 'mcp', port: app.port });
    const other = await t.makeShare(alex, { label: 'other', port: app.port });
    const c = t.client({ key: made.key, port: app.port });
    await c.ready();
    const host = made.share.host;
    const resource = made.share.url;
    const mcp = (headers = {}) => t.share(host, '/mcp', { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers } });
    const query = (o) => `/oauth/authorize?${new URLSearchParams(o).toString()}`;
    let clientId;

    await check('a program without credentials is told where to sign in (RFC 9728), and Connect publishes its metadata', async () => {
        const r = await mcp();
        assert.strictEqual(r.status, 401, r.text);
        assert.strictEqual(r.headers['www-authenticate'], `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource"`);
        const prm = await t.share(host, '/.well-known/oauth-protected-resource', { headers: { accept: 'application/json' } });
        assert.strictEqual(prm.status, 200);
        assert.deepStrictEqual(prm.json().authorization_servers, [t.config.baseUrl]);
        assert.strictEqual(prm.json().resource, resource);
        assert.strictEqual((await t.share(host, '/.well-known/oauth-protected-resource/mcp', { headers: { accept: 'application/json' } })).json().resource, `${resource}/mcp`);
        const meta = await t.get('/.well-known/oauth-authorization-server');
        assert.strictEqual(meta.status, 200);
        const m = meta.json();
        assert.strictEqual(m.issuer, t.config.baseUrl);
        assert.strictEqual(m.authorization_endpoint, `${t.config.baseUrl}/oauth/authorize`);
        assert.deepStrictEqual(m.code_challenge_methods_supported, ['S256']);
        assert.strictEqual(meta.headers.get('access-control-allow-origin'), '*');
    });

    await check('a public client registers; a bad redirect URI or a confidential client is refused', async () => {
        const r = await t.get('/oauth/register', { json: { client_name: 'Claude', redirect_uris: [CALLBACK, 'http://127.0.0.1:33418/callback'], token_endpoint_auth_method: 'none' } });
        assert.strictEqual(r.status, 201, r.text);
        clientId = r.json().client_id;
        assert.match(clientId, /^occ_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual((await t.get('/oauth/register', { json: { client_name: 'x', redirect_uris: ['http://evil.example/cb'] } })).json().error, 'invalid_redirect_uri');
        assert.strictEqual((await t.get('/oauth/register', { json: { client_name: 'x', redirect_uris: ['https://a.example/cb#frag'] } })).status, 400);
        assert.strictEqual((await t.get('/oauth/register', { json: { client_name: 'x', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_basic' } })).json().error, 'invalid_client_metadata');
    });

    const grant = async (as, p = pkce(), extra = {}) => {
        const q = { response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: p.challenge, code_challenge_method: 'S256', state: 'st-1', resource, ...extra };
        const ok = await t.get('/oauth/authorize', { as, method: 'POST', form: { ...q, decision: 'allow' } });
        assert.strictEqual(ok.status, 303, ok.text.slice(0, 300));
        const back = new URL(ok.headers.get('location'));
        return { code: back.searchParams.get('code'), back, p };
    };
    const token = (form) => t.get('/oauth/token', { form });

    await check('authorize: bad client and redirect URI are pages; no PKCE goes back with an error; sign-in and the share\'s policy come first', async () => {
        const p = pkce();
        const q = { response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: p.challenge, code_challenge_method: 'S256', state: 'st-1', resource };
        const unknown = await t.get(query({ ...q, client_id: 'occ_01M6FWGEVYZYQTP5ZPZ75CWB7P' }), { as: alex });
        assert.strictEqual(unknown.status, 400);
        assert.ok(!unknown.headers.get('location'), 'never redirected to an address nobody registered');
        assert.strictEqual((await t.get(query({ ...q, redirect_uri: 'https://evil.example/cb' }), { as: alex })).status, 400);
        const nopkce = await t.get(query({ ...q, code_challenge: '' }), { as: alex });
        assert.strictEqual(nopkce.status, 303);
        assert.strictEqual(new URL(nopkce.headers.get('location')).searchParams.get('error'), 'invalid_request');
        const notshare = await t.get(query({ ...q, resource: 'https://example.com' }), { as: alex });
        assert.strictEqual(new URL(notshare.headers.get('location')).searchParams.get('error'), 'invalid_target');
        const anon = await t.get(query(q));
        assert.strictEqual(anon.status, 303);
        assert.match(anon.headers.get('location'), /^\/auth\/login\?next=/);
        assert.strictEqual((await t.get(query(q), { as: bob })).status, 403, 'the share lets only alex in');
        const consent = await t.get(query(q), { as: alex });
        assert.strictEqual(consent.status, 200);
        assert.match(consent.text, new RegExp(`Let Claude use ${host.replace(/\./g, '\\.')}\\?`));
        assert.match(consent.text, /name="decision" value="allow">Allow/);
        assert.match(consent.headers.get('content-security-policy'), /form-action [^;]*https:\/\/claude\.ai/, 'the browser may follow the answer back to the app');
        const no = await t.get('/oauth/authorize', { as: alex, method: 'POST', form: { ...q, decision: 'deny' } });
        assert.strictEqual(new URL(no.headers.get('location')).searchParams.get('error'), 'access_denied');
        const cross = await t.get('/oauth/authorize', { as: alex, method: 'POST', form: { ...q, decision: 'allow' }, origin: 'https://evil.example' });
        assert.strictEqual(cross.status, 403, 'consent is given on Connect itself');
    });

    let tokens;
    await check('token: PKCE checked, a code works once; the token opens this share as alex, and the app never sees it', async () => {
        const bad = await grant(alex);
        assert.strictEqual(bad.back.searchParams.get('state'), 'st-1');
        assert.strictEqual(bad.back.searchParams.get('iss'), t.config.baseUrl);
        assert.strictEqual((await token({ grant_type: 'authorization_code', code: bad.code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: pkce().verifier })).json().error, 'invalid_grant');
        const g = await grant(alex);
        const r = await token({ grant_type: 'authorization_code', code: g.code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: g.p.verifier, resource });
        assert.strictEqual(r.status, 200, r.text);
        tokens = r.json();
        assert.match(tokens.access_token, /^ovat_/);
        assert.match(tokens.refresh_token, /^ovrt_/);
        assert.strictEqual(tokens.expires_in, 3600);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        assert.strictEqual((await token({ grant_type: 'authorization_code', code: g.code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: g.p.verifier })).json().error, 'invalid_grant', 'once');
        const call = await mcp({ authorization: `Bearer ${tokens.access_token}` });
        assert.strictEqual(call.status, 200, call.text);
        const seen = app.seen[app.seen.length - 1];
        assert.strictEqual(seen.headers['x-openvibe-subject'], alex.subject);
        assert.strictEqual(seen.headers['x-openvibe-user'], 'alex');
        assert.strictEqual(seen.headers.authorization, undefined, 'the token is dropped at the edge');
        const elsewhere = await t.share(other.share.host, '/mcp', { method: 'POST', body: '{}', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` } });
        assert.strictEqual(elsewhere.status, 401, 'bound to its own share');
        assert.match(elsewhere.headers['www-authenticate'], /error="invalid_token"/);
    });

    await check('refresh rotates: new tokens work, the old refresh and access tokens stop', async () => {
        const r = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
        assert.strictEqual(r.status, 200, r.text);
        const next = r.json();
        assert.notStrictEqual(next.access_token, tokens.access_token);
        assert.strictEqual((await mcp({ authorization: `Bearer ${next.access_token}` })).status, 200);
        assert.strictEqual((await mcp({ authorization: `Bearer ${tokens.access_token}` })).status, 401);
        assert.strictEqual((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })).json().error, 'invalid_grant');
        tokens = next;
    });

    await check('the owner sees the app signed in and signs it out; a policy change stops every token', async () => {
        const page = await t.get(`/shares/${made.share.id}`, { as: alex });
        assert.match(page.text, /Use it from Claude and other MCP clients/);
        assert.match(page.text, /<b>Claude<\/b>\n<small>as @alex/);
        const id = /\/oauth\/(sot_[0-9A-HJKMNP-TV-Z]{26})\/revoke/.exec(page.text)[1];
        assert.strictEqual((await t.get(`/shares/${made.share.id}/oauth/${id}/revoke`, { as: bob, method: 'POST', form: {} })).status, 404);
        const out = await t.get(`/shares/${made.share.id}/oauth/${id}/revoke`, { as: alex, method: 'POST', form: {} });
        assert.strictEqual(out.status, 200);
        assert.strictEqual((await mcp({ authorization: `Bearer ${tokens.access_token}` })).status, 401);
        const g = await grant(alex);
        const fresh = (await token({ grant_type: 'authorization_code', code: g.code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: g.p.verifier })).json();
        assert.strictEqual((await mcp({ authorization: `Bearer ${fresh.access_token}` })).status, 200);
        const policy = await t.get(`/shares/${made.share.id}/policy`, { as: alex, method: 'POST', form: { mode: 'named', named: 'bob' } });
        assert.strictEqual(policy.status, 303);
        assert.strictEqual((await mcp({ authorization: `Bearer ${fresh.access_token}` })).status, 401, 'the policy changed: sign in again');
        assert.strictEqual((await token({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: clientId })).json().error, 'invalid_grant');
        const stored = JSON.stringify(await t.ctx.s.db.many('SELECT * FROM share_oauth_tokens'));
        assert.ok(!stored.includes(fresh.access_token) && !stored.includes(fresh.refresh_token), 'only hashes are kept');
    });

    c.stop();
    app.close();
    await done(t);
})().catch((e) => { console.error(e); process.exit(1); });
