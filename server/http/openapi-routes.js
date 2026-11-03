'use strict';
// GET /openapi.json (SEO-3): this service's API as OpenAPI 3.1, read from the routes the app really mounts.
//
// The API is not in openvibe-contracts, so there is no generated document to serve. This one cannot drift from the
// code: its paths and methods are the app's own routes under /api/, read from Express's router when first asked
// (every route is mounted by then), with each path's parameters. A route's summary is its line in the header comment
// of the API files ("GET /x   what it does"); the request and response bodies are on the developer page the
// document names.
const fs = require('fs');
const path = require('path');

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];
// Not the API: health and readiness probes, and this document.
const SKIP = /^\/api\/(?:health|ready|metrics)(?:\/|$)|\/openapi\.json$/;

/** The mount path of a nested router (Express 4 keeps it only as a regexp): '/x', '/x/:id', or null when not a plain path. */
function mountPathOf(layer) {
    if (layer.regexp && layer.regexp.fast_slash) return '';
    let src = layer.regexp && layer.regexp.source;
    if (!src) return null;
    src = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '').replace(/\(\?=\\\/\|\$\)$/i, '');
    let k = 0;
    // A parameter: (?:\/([^/]+?)) in a mount path, (?:([^\/]+?)) after a slash.
    src = src.replace(/\(\?:(\\\/)?\(\[\^\\?\/\]\+\?\)\)/g, (_, slash) => `${slash ? '\\/' : ''}:${(layer.keys[k++] || {}).name || 'param'}`);
    src = src.replace(/\\\//g, '/');
    return /^[A-Za-z0-9_\-/:.]*$/.test(src) ? src : null;
}

/** Every route of a router (or app), as { method, path }. */
function routesOf(router, prefix = '', out = []) {
    for (const layer of (router && router.stack) || []) {
        if (layer.route && typeof layer.route.path === 'string') {
            for (const m of METHODS) if (layer.route.methods[m]) out.push({ method: m, path: prefix + layer.route.path });
        } else if (layer.handle && Array.isArray(layer.handle.stack)) {
            const at = mountPathOf(layer);
            if (at != null) routesOf(layer.handle, prefix + at, out);
        }
    }
    return out;
}

/** "GET /x/:id   what it does" lines from the header comments of the API files: { 'get /api/v1/x/{id}': 'what it does' }. */
function summariesFrom(files, apiBase) {
    const out = {};
    for (const file of files) {
        let src = '';
        try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const m of src.matchAll(/^\s*\*\s+(GET|PUT|POST|DELETE|PATCH)\s+(\/[^\s?]*)(?:\?\S*)?\s+(.+?)\s*$/gm)) {
            const p = m[2].startsWith('/api/') ? m[2] : `${apiBase}${m[2] === '/' ? '' : m[2]}`;
            out[`${m[1].toLowerCase()} ${p.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`] = m[3].replace(/\s{2,}/g, ' ').slice(0, 200);
        }
    }
    return out;
}

/**
 * The route handler. app: the Express app; o: { title, description, version, baseUrl, docs, apiBase = '/api/v1',
 * files: the API source files whose header comments name the routes }.
 */
function openapiRoute(app, o) {
    let doc = null;
    const build = () => {
        const apiBase = o.apiBase || '/api/v1';
        const said = summariesFrom(o.files || [], apiBase);
        const paths = {};
        for (const r of routesOf(app._router)) {
            if (!r.path.startsWith('/api/') || SKIP.test(r.path)) continue;
            const p = r.path.replace(/:([A-Za-z0-9_]+)\??/g, '{$1}').replace(/\/+$/, '') || '/';
            const params = [...p.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((x) => ({ name: x[1], in: 'path', required: true, schema: { type: 'string' } }));
            const op = {
                operationId: `${r.method}${p.replace(/\{([^}]+)\}/g, 'By_$1').replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))}`,
                ...(said[`${r.method} ${p}`] ? { summary: said[`${r.method} ${p}`] } : {}),
                ...(params.length ? { parameters: params } : {}),
                responses: { default: { description: o.docs ? `See ${o.docs}` : 'See the developer page' } },
            };
            paths[p] = paths[p] || {};
            if (!paths[p][r.method]) paths[p][r.method] = op;
        }
        return {
            openapi: '3.1.0',
            info: { title: o.title, version: String(o.version || '1'), description: `${o.description || ''} The paths and methods are the routes this service mounts${o.docs ? `; the request and response bodies are on ${o.docs}` : ''}.`.trim() },
            servers: [{ url: String(o.baseUrl).replace(/\/+$/, '') }],
            ...(o.docs ? { externalDocs: { url: o.docs } } : {}),
            paths: Object.fromEntries(Object.keys(paths).sort().map((k) => [k, paths[k]])),
        };
    };
    return (_req, res) => {
        if (!doc) doc = build();
        res.set('Cache-Control', 'public, max-age=3600').set('Access-Control-Allow-Origin', '*').json(doc);
    };
}

module.exports = { openapiRoute, routesOf, summariesFrom, mountPathOf };
