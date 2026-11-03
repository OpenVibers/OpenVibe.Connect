'use strict';
// The Markdown twins of this site's public pages (SEO-1, openvibe-shared/agent-layer).
//
// - A twin is the page's own render, signed out: the site's page router runs for a request that carries no session,
//   so the twin says exactly what a visitor who is not signed in reads. Only the public pages the sitemap lists have
//   one (TWIN_PATH_RE).
// - `/x.md`, `/index.md`, `?format=markdown` or `Accept: text/markdown` asks for a twin; every other request goes on
//   to the pages.
// - Such a page names its twin in the head and in a Link: header when it answered 200 to a visitor who is not signed
//   in. A signed-in page is that person's own and names none.
const express = require('express');
const agentLayer = require('openvibe-shared/agent-layer');

const TWIN_PATH_RE = /^\/$/;

/** A response the page code can write to; the first body written is the page's HTML. */
function mockRes() {
    return {
        statusCode: 200, headers: {}, headersSent: false, locals: {}, finished: false,
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
        getHeader(k) { return this.headers[String(k).toLowerCase()]; },
        removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
        set(k, v) { if (k && typeof k === 'object') { for (const [a, b] of Object.entries(k)) this.setHeader(a, b); return this; } return this.setHeader(k, v); },
        get(k) { return this.getHeader(k); },
        header(k, v) { return this.set(k, v); },
        append(k, v) { return this.setHeader(k, v); },
        status(code) { this.statusCode = code; return this; },
        type(t) { return this.setHeader('content-type', t); },
        vary() { return this; },
        location(url) { return this.setHeader('location', url); },
        redirect(a, b) { this.statusCode = typeof a === 'number' ? a : 302; this.headers.location = typeof a === 'number' ? b : a; this.finished = true; return this; },
        cookie() { return this; }, clearCookie() { return this; }, attachment() { return this; }, links() { return this; },
        format() { return this; }, render() { return this; },
        write(chunk) { this.body = (this.body || '') + chunk; return true; },
        on() { return this; }, once() { return this; }, emit() { return false; },
    };
}

/** A request without a session, so the page renders signed out. */
function mockReq(path, host) {
    return {
        method: 'GET', url: path, originalUrl: path, path, baseUrl: '', params: {}, query: {}, body: {},
        headers: { host, accept: 'text/html' }, hostname: host, protocol: 'https', secure: true,
        ip: '127.0.0.1', ips: [], socket: {}, connection: {}, cookies: {}, signedCookies: {},
        viewer: { kind: 'anonymous' }, ov: {},
        get(name) { return this.headers[String(name).toLowerCase()]; },
        header(name) { return this.get(name); },
        accepts(types) { return Array.isArray(types) ? types[0] : (types || 'html'); },
        is() { return false; },
    };
}

/** Run the site's page router for one path; the HTML of a 200 page, or null. */
function renderWithRouter(router, path, host) {
    return new Promise((resolve) => {
        const res = mockRes();
        const keep = (body) => { resolve(res.statusCode === 200 && typeof body === 'string' ? body : null); return res; };
        res.send = keep; res.end = keep; res.json = () => keep(null); res.sendStatus = () => keep(null);
        try {
            router.handle(mockReq(path, host), res, () => resolve(null));
        } catch {
            resolve(null);
        }
    });
}

const wantsTwin = (req) => {
    const p = String(req.path || '');
    return p.endsWith('.md') || (req.query && req.query.format === 'markdown') || req.accepts(['html', 'text/markdown']) === 'text/markdown';
};

/** Mount before the page routes: router is the site's page router, baseUrl its own origin. */
function mountTwins(app, { router, descriptor, baseUrl, llms = '/llms.txt' }) {
    const origin = String(baseUrl).replace(/\/+$/, '');
    const host = new URL(origin).host;
    const twins = express.Router();
    agentLayer.mount(twins, {
        descriptor,
        render: async (path) => {
            const p = String(path || '/').replace(/(.)\/+$/, '$1');
            if (!TWIN_PATH_RE.test(p)) return null;
            const html = await renderWithRouter(router, p, host);
            return html ? { html, title: null, updated: null } : null;
        },
    });
    app.use((req, res, next) => (wantsTwin(req) ? twins(req, res, next) : next()));
    app.use((req, res, next) => {
        // A page with a query (a search, a filter) is not the page its twin renders: it names none.
        if ((req.method !== 'GET' && req.method !== 'HEAD') || !TWIN_PATH_RE.test(req.path) || String(req.originalUrl || '').includes('?')) return next();
        const send = res.send;
        res.send = function sendNamingTheTwin(body) {
            if (typeof body === 'string' && res.statusCode === 200 && !(req.viewer && req.viewer.kind === 'user')
                && /^text\/html\b/i.test(String(res.get('Content-Type') || 'text/html'))) {
                const links = agentLayer.linkHeaderTags(`${origin}${req.path}`, llms);
                if (!/<link\b[^>]*text\/markdown/i.test(body)) body = body.replace(/<\/head>/i, `${links.head}\n</head>`);
                if (!res.get('Link')) res.set('Link', links.header);
            }
            return send.call(this, body);
        };
        next();
    });
}

module.exports = { mountTwins, TWIN_PATH_RE, renderWithRouter };
