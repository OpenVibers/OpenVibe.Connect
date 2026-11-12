'use strict';
// Every page of connect.openvibe.link gives the shared navbar Connect's own page list (the owner, 2026-11-12), and
// the row that leaves for OpenVibe.Space is labelled with the site it opens.
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { check, done } = require('./helpers/check');
const { NAV } = require('../server/render/layout');

function initLinks(html) {
    const at = html.indexOf('OpenVibeNavbar.init');
    if (at < 0) return null;
    const start = html.indexOf('links', at);
    const open = html.indexOf('[', start);
    let depth = 0, q = null, esc = false;
    for (let i = open; i < html.length; i += 1) {
        const c = html[i];
        if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '[') depth += 1; else if (c === ']') { depth -= 1; if (!depth) return JSON.parse(html.slice(open, i + 1)); }
    }
    return null;
}

(async () => {
    const t = await boot();
    try {
        const own = NAV.map(({ label, href }) => ({ label, href }));
        await check('every page sends Connect\'s own list, and the Space row names Space', async () => {
            for (const path of ['/', '/terms', '/privacy', '/dmca']) {
                const r = await t.get(path);
                assert.ok([200, 301, 302].includes(r.status), `${path} answered ${r.status}`);
                if (r.status !== 200) continue;
                const links = (initLinks(r.text) || []).map(({ label, href }) => ({ label, href }));
                assert.deepStrictEqual(links, own, `${path} sends Connect's list`);
            }
            const space = own.find((l) => l.href.includes('openvibe.space'));
            assert.ok(space && /space/i.test(space.label), 'the off-site row names OpenVibe.Space');
        });
        await check('every row is a route or a labelled door', async () => {
            for (const { href } of own) {
                if (!href.startsWith('/')) continue;
                const r = await t.get(href);
                assert.notStrictEqual(r.status, 404, `${href} is a route`);
                assert.ok(r.status < 500, `${href} does not fail (${r.status})`);
            }
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
