'use strict';
/**
 * The pure rules: share names and hosts, the wire frames, the gate's cookie and its "next", and the client being one
 * file with nothing but Node's own modules.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, done } = require('./helpers/check');
const { hostFor, parseHost, handleOf, normalizeNamed } = require('../server/shares');
const frames = require('../server/edge/frames');
const { createGate } = require('../server/edge/gate');

(async () => {
    await check('a handle is the username made DNS-safe; a host joins label and handle with "--"', async () => {
        assert.strictEqual(handleOf('JapaneseOldGuy'), 'japaneseoldguy');
        assert.strictEqual(handleOf('Alex_Dev.2'), 'alex-dev-2');
        assert.strictEqual(handleOf('__'), '');
        assert.strictEqual(hostFor('agents', 'Alex', 'openvibe.website'), 'agents--alex.openvibe.website');
        assert.strictEqual(hostFor('a'.repeat(40), 'b'.repeat(30), 'openvibe.website'), null, 'over 63 characters');
        assert.strictEqual(hostFor('x', '__', 'openvibe.website'), null);
    });

    await check('parseHost reads only a share host: one label, "--" once, both sides DNS-safe', async () => {
        assert.deepStrictEqual(parseHost('Agents--Alex.openvibe.website:443', 'openvibe.website'), { host: 'agents--alex.openvibe.website', label: 'agents', handle: 'alex' });
        const notShares = ['openvibe.website', 'connect.openvibe.website', 'mysite.openvibe.website', 'a.b--c.openvibe.website', '--x.openvibe.website',
            'x--.openvibe.website', 'x---y.openvibe.website', 'x--y.openvibe.website.evil.com', 'x--y.evil.com', '', null];
        notShares.forEach((h) => assert.strictEqual(parseHost(h, 'openvibe.website'), null, String(h)));
    });

    await check('named people: lowercase, deduplicated, @ allowed, junk refused', async () => {
        assert.deepStrictEqual(normalizeNamed('@Sam, riley  sam'), ['sam', 'riley']);
        assert.throws(() => normalizeNamed(['bad name!']), /not an OpenVibe username/);
    });

    await check('frames: data and end round-trip; anything else is dropped', async () => {
        const f = frames.decode(frames.encode(frames.KIND.DATA, 70000, Buffer.from('hi')));
        assert.deepStrictEqual([f.kind, f.id, f.payload.toString()], [1, 70000, 'hi']);
        assert.strictEqual(frames.decode(frames.encode(frames.KIND.END, 3)).payload.length, 0);
        assert.strictEqual(frames.decode(Buffer.from([9, 0, 0, 0, 1])), null);
        assert.strictEqual(frames.decode(Buffer.from([1, 0])), null);
    });

    await check('the gate\'s cookie: bound to the share, its policy version and its expiry', async () => {
        let now = 1_800_000_000_000;
        const config = { shares: { sessionSecret: 'x'.repeat(40), sessionHours: 12 }, cookies: { secure: true } };
        const gate = createGate({ config, now: () => now });
        const share = { id: 'shr_1', policy_version: 2 };
        const v = gate.sign({ shareId: 'shr_1', subject: 'usr_1', username: 'alex', policyVersion: 2 });
        assert.deepStrictEqual(gate.verify(v, share), { subject: 'usr_1', username: 'alex' });
        assert.strictEqual(gate.verify(v, { id: 'shr_2', policy_version: 2 }), null);
        assert.strictEqual(gate.verify(v, { id: 'shr_1', policy_version: 3 }), null);
        assert.strictEqual(gate.verify(`${v}x`, share), null);
        now += 13 * 3600_000;
        assert.strictEqual(gate.verify(v, share), null, 'expired');
        assert.strictEqual(gate.cookieName, '__Host-ovc');
        assert.match(gate.cookieHeader('v'), /^__Host-ovc=v; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
        assert.deepStrictEqual(gate.splitCookies('a=1; __Host-ovc=abc; ovc=old; b=2'), { ours: 'abc', rest: 'a=1; b=2' });
        gate.stop();
        assert.throws(() => createGate({ config: { shares: { sessionSecret: 'short' }, cookies: {} } }), /CONNECT_SESSION_SECRET/);
    });

    await check('next: a local path only', async () => {
        const gate = createGate({ config: { shares: { sessionSecret: 'y'.repeat(40), sessionHours: 1 }, cookies: { secure: false } } });
        const cases = [['/a?b=1', '/a?b=1'], ['//evil.com', '/'], ['/\\evil.com', '/'], ['https://evil.com', '/'], ['/x\r\nSet-Cookie: a', '/'], ['/__ovc/callback', '/'], [null, '/']];
        cases.forEach(([inp, out]) => assert.strictEqual(gate.safeNext(inp), out, String(inp)));
        gate.stop();
    });

    await check('the client is one file that needs nothing but Node', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ov-connect.js'), 'utf8');
        const mods = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
        assert.deepStrictEqual(mods.sort(), ['http', 'net']);
        assert.match(src, /^#!\/usr\/bin\/env node/);
        const { parseArgs } = require('../public/ov-connect');
        assert.strictEqual(parseArgs(['--key', 'ovc_x', '8080']).port, 8080);
        assert.strictEqual(parseArgs(['--key=ovc_y', '--port=9']).key, 'ovc_y');
        // Used as a module (createClient) with no server, it still goes to production, not to "undefined".
        const { DEFAULT_SERVER } = require('../public/ov-connect');
        assert.strictEqual(DEFAULT_SERVER, 'wss://connect.openvibe.website/tunnel');
        assert.strictEqual(parseArgs([]).server, DEFAULT_SERVER);
    });

    done();
})();
