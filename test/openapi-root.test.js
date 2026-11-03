'use strict';
// SEO-3: /openapi.json answered 404 here (11-03). It is this service's API as OpenAPI 3.1 (routes: 'serve' is the
// document /api/v1/openapi.json already served; 'routes' is read from the routes the app mounts).
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    const t = await boot();
    let failed = 0;
    try {
        const r = await t.get('/openapi.json');
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.match(String(r.headers.get('content-type')), /^application\/json/);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'any agent may read it');
        const doc = JSON.parse(r.text);
        assert.match(doc.openapi, /^3\.1/);
        assert.ok(doc.info && doc.info.title && doc.info.version, 'a title and a version');
        const paths = Object.keys(doc.paths || {});
        assert.ok(paths.length >= 2, `paths: ${paths.join(' ')}`);
        for (const p of paths) {
            for (const [m, op] of Object.entries(doc.paths[p])) {
                if (!['get', 'put', 'post', 'delete', 'patch'].includes(m)) continue;
                assert.ok(op.responses && Object.keys(op.responses).length, `${m} ${p} has responses`);
                for (const name of [...p.matchAll(/\{([^}]+)\}/g)].map((x) => x[1])) {
                    assert.ok((op.parameters || []).some((q) => q.name === name && q.in === 'path') || (doc.paths[p].parameters || []).some((q) => q.name === name), `${m} ${p} declares {${name}}`);
                }
            }
        }
        if ('routes' === 'routes') {
            assert.ok(paths.every((p) => p.startsWith('/api/')), 'only the API');
            assert.ok(!paths.some((p) => /\/(?:health|ready)$|openapi\.json$/.test(p)), 'no probes, not itself');
            assert.ok(Object.values(doc.paths).some((item) => Object.values(item).some((op) => op.summary)), 'the header comments give summaries');
            const again = JSON.parse((await t.get('/openapi.json')).text);
            assert.deepStrictEqual(Object.keys(again.paths), paths, 'the same document each time');
        } else {
            const api = await t.get('/api/v1/openapi.json');
            assert.deepStrictEqual(JSON.parse(api.text), doc, 'the same document as /api/v1/openapi.json');
        }
        console.log(`  ✓ /openapi.json: ${paths.length} paths`);
    } catch (e) {
        failed++;
        console.log(`  ✗ /openapi.json\n      ${String(e.stack || e).split('\n').slice(0, 6).join('\n      ')}`);
    } finally {
        await t.close();
    }
    process.exit(failed ? 1 : 0);
})();
