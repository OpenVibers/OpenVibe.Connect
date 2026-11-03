'use strict';
// SEO-1: the public pages' Markdown twins (server/agent-twins.js). A twin is the page rendered signed out, and the
// page names it in its head and in the Link: header.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/boot');
const { TWIN_PATH_RE } = require('../server/agent-twins');

// Public pages from the sitemap that render without data.
const PAGES = ['/'];

(async () => {
    const t = await boot();
    const origin = String(t.config.baseUrl).replace(/\/+$/, '');
    const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let failed = 0;
    const check = async (name, fn) => {
        try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e.stack || e).split('\n').slice(0, 6).join('\n      ')}`); }
    };
    try {
        await check('every listed page has a twin, and the page names it', async () => {
            for (const p of PAGES) {
                assert.ok(TWIN_PATH_RE.test(p), `${p} is a twin path`);
                const page = await t.get(p);
                assert.strictEqual(page.status, 200, p);
                const twinPath = p === '/' ? '/index.md' : `${p}.md`;
                const href = `${origin}${twinPath}`;
                assert.ok(page.text.includes(`<link rel="alternate" type="text/markdown" href="${href}">`), `${p} names its twin in the head`);
                assert.match(String(page.headers.get('link') || ''), new RegExp(`<${reEsc(href)}>; rel="alternate"; type="text/markdown"`), `${p} names it in the Link header`);
                const twin = await t.get(twinPath);
                assert.strictEqual(twin.status, 200, twinPath);
                assert.match(String(twin.headers.get('content-type') || ''), /^text\/markdown/, `${twinPath} is Markdown`);
                assert.ok(twin.text.startsWith('---\ntitle:') && /\ncanonical: "/.test(twin.text), `${twinPath} carries the page's title and address`);
                // Markup only inside fenced code (a page's own code samples), never the page's scripts or styles.
                const prose = twin.text.replace(/~~~~[\s\S]*?~~~~/g, '');
                assert.ok(!/<(?:script|style)\b/i.test(prose) && twin.text.length > 150, `${twinPath} is the page's words`);
            }
        });
        await check('a path with no twin answers a Markdown 404, and a missing page names no twin', async () => {
            const twin = await t.get('/no-such-page-here.md');
            assert.strictEqual(twin.status, 404);
            const page = await t.get('/no-such-page-here');
            assert.ok(!/type="text\/markdown"/.test(page.text) && !/text\/markdown/.test(String(page.headers.get('link') || '')));
        });
        if (t.network && typeof t.network.addUser === 'function') {
            await check('a page drawn for a signed-in person names no twin', async () => {
                const page = await t.get(PAGES[0], { as: t.network.addUser('twin-reader') });
                assert.ok(!/type="text\/markdown"/.test(page.text), 'no twin in the head');
                assert.ok(!/text\/markdown/.test(String(page.headers.get('link') || '')), 'no twin in the Link header');
            });
        }
        await check('the twins are mounted before the page routes', async () => {
            const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
            const at = src.indexOf("require('./agent-twins').mountTwins(app,");
            assert.ok(at > 0 && at < src.indexOf('app.use(pageRoutes);'));
        });
    } finally {
        await t.close();
    }
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
})();
