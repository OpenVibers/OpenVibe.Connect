'use strict';

/**
 * The visitor's side of a share: every request to https://<label>--<user>.openvibe.website.
 *
 *   handle(req, res)               an HTTP request (SSE and streaming bodies included)
 *   upgrade(req, socket, head)     a WebSocket upgrade: after the gate, a byte pipe to the local port
 *   isShareHost(host)              is this host a share's (the naming rule only)
 *   flush()                        write the counters gathered in memory (every 30 s, and on stop)
 *
 * The share comes from the Host header nginx sets ($host), never from X-Forwarded-Host or any other header a
 * visitor controls. The local app receives the request with Host `localhost:<port>`, the share's host in
 * X-Forwarded-Host, the visitor's address in X-Forwarded-For, and who they are in X-OpenVibe-User and
 * X-OpenVibe-Subject (headers of those names from the visitor are dropped). The gate's own cookie never reaches it.
 *
 * Responses: a Set-Cookie's Domain attribute is removed (until openvibe.website is on the Public Suffix List, a
 * cookie for .openvibe.website would reach every other share and every Space site), and nothing a share sends may be
 * kept by Cloudflare's cache (Cloudflare-CDN-Cache-Control: no-store; Cache-Control is made private): a cached copy
 * would be served past the gate.
 */
const { parseHost } = require('../shares');

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const DROP_IN = /^(host|cookie|forwarded|x-forwarded-.*|x-real-ip|x-openvibe-.*|cf-.*|cdn-loop|true-client-ip)$/;
const SHARE_CACHE_MS = 5000;

/**
 * The app's Cache-Control, made safe to pass a CDN: `public` and `s-maxage` are dropped and `private` is added, so
 * the browser may still keep what the app says it may, and no shared cache ever does. No header → `private, no-cache`.
 */
function privateCache(value) {
    const parts = String(value || '').split(',').map((p) => p.trim()).filter(Boolean)
        .filter((p) => !/^(public|s-maxage\s*=.*|proxy-revalidate)$/i.test(p));
    if (!parts.length) return 'private, no-cache';
    if (parts.some((p) => /^(private|no-store)$/i.test(p))) return parts.join(', ');
    return ['private', ...parts].join(', ');
}

const AUDIT_MAX = 64 * 1024;
const PRM = '/.well-known/oauth-protected-resource';

function createProxy({ config, shares, tunnels, gate, apiKeys = null, oauth = null, log = console, now = () => Date.now() }) {
    // The last requests through each share, for its owner's page (CON-8 v0; memory only).
    const inspector = require('./inspector').createInspector({ now });
    const domain = config.shares.domain;
    const cache = new Map();          // host → { share, at }
    const windows = new Map();        // share id → { start, count }
    const ownerBytes = new Map();     // owner subject → { day, bytes }
    let counters = {};                // share id → { requests, bytesIn, bytesOut, visits }

    const isShareHost = (host) => Boolean(parseHost(host, domain));
    const today = () => new Date(now()).toISOString().slice(0, 10);
    const shareUrl = (share) => share.url || `https://${share.host}`;
    const resourceMetadata = (share) => `${shareUrl(share)}${PRM}`;
    const grantUrl = (share, next) => `${config.baseUrl}/grant?share=${encodeURIComponent(share.id)}&next=${encodeURIComponent(gate.safeNext(next))}`;

    async function lookup(host) {
        const hit = cache.get(host);
        if (hit && now() - hit.at < SHARE_CACHE_MS) return hit.share;
        const share = await shares.byHost(host);
        cache.set(host, { share, at: now() });
        if (cache.size > 5000) cache.delete(cache.keys().next().value);
        return share;
    }
    /** Forget what is cached for a share (a policy change, a new key, a revoke). */
    function forget(host) { cache.delete(String(host || '').toLowerCase()); }

    function counter(shareId) {
        if (!counters[shareId]) counters[shareId] = { requests: 0, bytesIn: 0, bytesOut: 0, visits: {} };
        return counters[shareId];
    }
    function visit(share, who, { denied = false } = {}) {
        const c = counter(share.id);
        if (!denied) c.requests++;
        if (!who || !who.subject) return;
        const v = c.visits[who.subject] || (c.visits[who.subject] = { username: who.username || null, requests: 0, denied: 0 });
        if (denied) v.denied++; else v.requests++;
    }
    function addBytes(share, dir, n) {
        if (!n) return;
        const c = counter(share.id);
        if (dir === 'in') c.bytesIn += n; else c.bytesOut += n;
        const d = today();
        const o = ownerBytes.get(share.owner_subject);
        if (!o || o.day !== d) ownerBytes.set(share.owner_subject, { day: d, bytes: n });
        else o.bytes += n;
    }
    const overBytes = (share) => { const o = ownerBytes.get(share.owner_subject); return Boolean(o && o.day === today() && o.bytes >= config.shares.bytesPerDay); };
    function overRate(share) {
        const t = now();
        const w = windows.get(share.id);
        if (!w || t - w.start >= 60_000) { windows.set(share.id, { start: t, count: 1 }); return false; }
        w.count++;
        return w.count > config.shares.perMinute;
    }

    async function flush() {
        const batch = counters;
        counters = {};
        if (!Object.keys(batch).length) return;
        try { await shares.flushCounters(batch, today()); } catch (err) { log.warn('[OpenVibe.Connect] counters not written:', err.message); }
    }
    const flusher = setInterval(() => { flush().catch(() => {}); }, 30_000);
    flusher.unref();

    function forwardHeaders(req, share, who, port, { raw = false } = {}) {
        const out = [];
        const pairs = req.rawHeaders;
        for (let i = 0; i + 1 < pairs.length; i += 2) {
            const name = String(pairs[i]).toLowerCase();
            if (DROP_IN.test(name)) continue;
            // An API key (CON-16) is for the edge alone: the app never sees it, only X-OpenVibe-Subject key:<id>.
            if ((who.apiKey || who.oauth) && name === 'authorization') continue;
            if (HOP.has(name) && !(raw && (name === 'connection' || name === 'upgrade'))) continue;
            out.push([name, String(pairs[i + 1])]);
        }
        const { rest } = gate.splitCookies(req.headers.cookie);
        if (rest) out.push(['cookie', rest]);
        out.push(['host', `localhost:${port}`]);
        out.push(['x-forwarded-host', share.host]);
        out.push(['x-forwarded-proto', config.shares.scheme]);
        const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '').slice(0, 64);
        if (ip) out.push(['x-forwarded-for', ip]);
        out.push(['x-openvibe-user', String(who.username || '')]);
        out.push(['x-openvibe-subject', String(who.subject || '')]);
        return out;
    }

    function responseHeaders(pairs) {
        const out = {};
        const cookies = [];
        let cacheControl = null;
        for (const pair of Array.isArray(pairs) ? pairs : []) {
            if (!Array.isArray(pair) || pair.length !== 2) continue;
            const name = String(pair[0]).toLowerCase();
            const value = String(pair[1]);
            if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/.test(name) || /[\r\n\0]/.test(value)) continue;
            if (HOP.has(name) || name === 'cloudflare-cdn-cache-control' || name === 'cdn-cache-control' || name === 'x-robots-tag') continue;
            if (name === 'set-cookie') {
                const c = scrubCookie(value);
                if (c) cookies.push(c);
                continue;
            }
            if (name === 'cache-control') { cacheControl = value; continue; }
            if (out[name] === undefined) out[name] = value;
            else out[name] = Array.isArray(out[name]) ? [...out[name], value] : [out[name], value];
        }
        if (cookies.length) out['set-cookie'] = cookies;
        out['cache-control'] = privateCache(cacheControl);
        out['cloudflare-cdn-cache-control'] = 'no-store';
        out['x-robots-tag'] = 'noindex, nofollow';
        return out;
    }

    function scrubCookie(value) {
        const parts = value.split(';');
        const name = parts[0].split('=')[0].trim();
        if (name === gate.cookieName || name === '__Host-ovc' || name === 'ovc') return null;
        return parts.filter((p, i) => i === 0 || !/^\s*domain\s*=/i.test(p)).join(';');
    }

    // ── Pages the gate answers itself (self-contained: a share host loads nothing from anywhere else) ──
    function sendPage(res, status, title, text, { link = null, headers = {}, refresh = 0, note = '', report = '', notify = '' } = {}) {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(status, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'cloudflare-cdn-cache-control': 'no-store',
            'x-robots-tag': 'noindex, nofollow',
            'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action ${notify ? "'self'" : "'none'"}; frame-ancestors 'none'`,
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            ...headers,
        });
        res.end(page(title, text, link, { refresh, note, report, notify }));
    }
    /** Does a response's head say it is a web page (HTML or XHTML)? `headers` is [[name, value]] or an object. */
    function isHtml(headers) {
        const pairs = Array.isArray(headers) ? headers : Object.entries(headers || {});
        const ct = pairs.find(([k]) => String(k).toLowerCase() === 'content-type');
        return Boolean(ct) && /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(String(ct[1]));
    }
    function wantsHtml(req) { return /text\/html/.test(String(req.headers.accept || '')) && (req.method === 'GET' || req.method === 'HEAD'); }
    function sendProblem(req, res, status, code, title, text, extra = {}) {
        if (wantsHtml(req)) return sendPage(res, status, title, text, extra);
        if (res.headersSent) { res.destroy(); return undefined; }
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'no-store', 'x-robots-tag': 'noindex', ...(extra.headers || {}) });
        res.end(JSON.stringify({ error: code, message: text, ...(extra.json || {}) }));
        return undefined;
    }

    /** The share, the person and the tunnel for a request, or an answer already sent. */
    async function admit(req, res, share, parsedPath) {
        // An API key (CON-16) passes without signing in; a wrong or revoked one is refused, never sent to sign in.
        const bearer = /^Bearer\s+(ovsk_\S+)$/i.exec(String(req.headers.authorization || ''));
        let who = null;
        if (bearer && apiKeys) {
            const key = await apiKeys.check(share, bearer[1]);
            if (!key) { sendProblem(req, res, 401, 'bad_key', 'That key does not open this share', 'The API key is wrong, revoked, or for another share.', { json: { error: 'bad_key' } }); return null; }
            who = { subject: `key:${key.id}`, username: `key: ${key.name}`, apiKey: key.id, key };
            if (apiKeys.overRate(key)) { visit(share, who, { denied: true }); sendProblem(req, res, 429, 'key_rate_limited', 'Too many requests', `This key allows ${key.per_minute} requests a minute.`, { headers: { 'retry-after': '60' } }); return null; }
            // Its daily quota (CON-16 v1), in UTC days: spent, it opens again at midnight UTC.
            if (await apiKeys.overDay(key)) { visit(share, who, { denied: true }); sendProblem(req, res, 429, 'key_daily_quota', 'Over today\'s quota', `This key allows ${key.per_day} requests a day. It opens again at midnight UTC.`, { headers: { 'retry-after': String(apiKeys.untilTomorrow()) }, json: { per_day: key.per_day } }); return null; }
        } else if (oauth && /^Bearer\s+ovat_/i.test(String(req.headers.authorization || ''))) {
            // An MCP client signed in with OpenVibe (CON-16, server/oauth.js): the person who consented, for this share.
            const g = await oauth.check(share, String(req.headers.authorization).replace(/^Bearer\s+/i, '').trim());
            if (!g) { sendProblem(req, res, 401, 'invalid_token', 'Sign in again', 'That sign-in is out of date or was signed out. The app should sign in again.', { json: { error: 'invalid_token' }, headers: { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${resourceMetadata(share)}"` } }); return null; }
            who = { subject: g.subject, username: g.username, oauth: g.id, client: g.client };
        } else {
            const { ours } = gate.splitCookies(req.headers.cookie);
            who = ours ? gate.verify(ours, share) : null;
        }
        if (!who) {
            const url = grantUrl(share, parsedPath);
            if (wantsHtml(req)) { res.writeHead(302, { location: url, 'cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'no-store' }); res.end(); return null; }
            // A program is told where to sign in: an MCP client follows resource_metadata to Connect's OAuth (RFC 9728).
            sendProblem(req, res, 401, 'sign_in_required', 'Sign in first', 'This share asks every visitor to sign in with OpenVibe.', { json: { sign_in: url }, headers: oauth ? { 'www-authenticate': `Bearer resource_metadata="${resourceMetadata(share)}"` } : {} });
            return null;
        }
        if (overRate(share)) { visit(share, who, { denied: true }); sendProblem(req, res, 429, 'rate_limited', 'Too many requests', 'This share had too many requests in the last minute. Try again shortly.', { headers: { 'retry-after': '30' } }); return null; }
        if (overBytes(share)) { visit(share, who, { denied: true }); sendProblem(req, res, 429, 'over_daily_limit', 'Over today\'s limit', `${share.owner_username}'s shares moved as much data as they can today. They open again at midnight UTC.`); return null; }
        const tunnel = tunnels.get(share.id);
        if (!tunnel) {
            // Keep-online, v0 (CON-17): a browser waits on this page, asking again every 10 seconds, and lands on the app
            // the moment its computer is back; when it was last connected says how long the wait may be.
            const last = share.last_connected_at ? ` It was last connected ${ago(share.last_connected_at, now())}.` : '';
            sendProblem(req, res, 503, 'offline', `${share.owner_username}'s computer is not connected`, `Nothing is connected to ${share.host} right now.${last} If it is yours, start ov-connect on your computer.`, {
                link: { href: `${config.baseUrl}/shares/${share.id}`, text: 'Open the share page' }, headers: { 'retry-after': '10' },
                refresh: 10, note: 'This page asks again every 10 seconds and opens the app as soon as the computer is back.',
                notify: who && who.subject ? '/__ovc/notify' : '',
                report: `${config.baseUrl}/report?host=${encodeURIComponent(share.host)}`,
            });
            return null;
        }
        if (tunnel.busy) { sendProblem(req, res, 503, 'busy', 'Busy', 'This share is answering as many requests as it can at once. Try again in a moment.', { headers: { 'retry-after': '2' } }); return null; }
        return { who, tunnel };
    }

    async function resolve(req, res) {
        const parsed = parseHost(req.headers.host, domain);
        if (!parsed) return null;
        let share;
        try { share = await lookup(parsed.host); } catch (err) {
            log.warn('[OpenVibe.Connect] share lookup failed:', err.message);
            sendProblem(req, res, 503, 'unavailable', 'Try again in a moment', 'OpenVibe Connect could not look this share up just now.');
            return null;
        }
        if (!share) { sendProblem(req, res, 404, 'no_share', 'No share here', `Nothing is shared at ${parsed.host}.`, { link: { href: config.baseUrl, text: 'What is OpenVibe Connect?' } }); return null; }
        // Its time is up: closed now, even before the sweep (app.js) marks it.
        const expired = share.expired || (share.status === 'active' && share.expires_at && Date.parse(share.expires_at) <= now());
        if (expired) { sendProblem(req, res, 410, 'expired', 'This share has ended', `${share.host} was shared until ${new Date(share.expires_at).toUTCString().replace(' GMT', ' UTC')}, and that time is up.`, { link: { href: config.baseUrl, text: 'What is OpenVibe Connect?' } }); return null; }
        if (share.status !== 'active' && share.closed_reason === 'report') { sendProblem(req, res, 410, 'closed', 'This share was closed', `OpenVibe closed ${share.host} after a report.`, { link: { href: config.baseUrl, text: 'What is OpenVibe Connect?' } }); return null; }
        if (share.status !== 'active') { sendProblem(req, res, 410, 'closed', 'This share is closed', `${share.owner_username} closed ${share.host}.`, { link: { href: config.baseUrl, text: 'What is OpenVibe Connect?' } }); return null; }
        return share;
    }

    async function handle(req, res) {
        const share = await resolve(req, res);
        if (!share) return;
        const url = String(req.url || '/');
        const path = url.split('?')[0];

        if (path === '/__ovc/callback') {
            const q = new URL(url, 'http://x').searchParams;
            const v = gate.redeemCode(q.get('code'), share.id);
            if (!v) return sendPage(res, 400, 'That link ran out', 'Sign-in links work once, for a minute.', { link: { href: grantUrl(share, q.get('next') || '/'), text: 'Try again' } });
            const cookie = gate.sign({ shareId: share.id, subject: v.subject, username: v.username, policyVersion: share.policy_version });
            res.writeHead(303, { location: gate.safeNext(q.get('next')), 'set-cookie': gate.cookieHeader(cookie), 'cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
            return res.end();
        }
        if (path === '/__ovc/notify' && req.method === 'POST') {
            const { ours } = gate.splitCookies(req.headers.cookie);
            const who = ours ? gate.verify(ours, share) : null;
            if (!who || !who.subject) return sendPage(res, 401, 'Sign in first', 'Open the share again to sign in, then ask to be told.');
            if (String(req.headers.origin || `https://${share.host}`) !== `https://${share.host}`) return sendPage(res, 403, 'Not from this page', 'Ask from the share\'s own page.');
            if (tunnels.get(share.id)) { res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'no-store' }); return res.end(); }
            const ok = await shares.addWaiter(share.id, who.subject).catch(() => false);
            return sendPage(res, ok ? 200 : 429, ok ? 'We will tell you' : 'Too many waiting', ok
                ? `You get one OpenVibe notification when ${share.owner_username}'s computer connects again. This page keeps asking too.`
                : 'Too many people are waiting on this share already. This page keeps asking every 10 seconds.', { refresh: 10 });
        }
        // MCP OAuth (CON-16): the share says who signs its programs in (RFC 9728), to anyone, before the gate.
        if (oauth && (path === PRM || path.startsWith(`${PRM}/`))) {
            const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'mcp-protocol-version' };
            if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
            res.writeHead(200, headers);
            return res.end(JSON.stringify({
                resource: `${shareUrl(share)}${path.slice(PRM.length)}`, resource_name: share.host,
                authorization_servers: [config.baseUrl], bearer_methods_supported: ['header'], scopes_supported: ['share'],
                resource_documentation: `${config.baseUrl}/#mcp`,
            }));
        }
        if (path === '/__ovc/signout') {
            return sendPage(res, 200, 'Signed out of this share', `You are signed out of ${share.host}. Your OpenVibe sign-in is untouched.`, { headers: { 'set-cookie': gate.clearCookieHeader() } });
        }

        const admitted = await admit(req, res, share, url);
        if (!admitted) return;
        const { who, tunnel } = admitted;
        visit(share, who);
        const rec = inspector.begin(share.id, { method: req.method, path: url, who });
        res.on('finish', () => inspector.end(rec, { status: res.statusCode }));
        res.on('close', () => inspector.end(rec, { error: res.writableFinished ? null : 'visitor_gone' }));

        const port = (tunnel.clientInfo && tunnel.clientInfo.port) || share.local_port;
        let finished = false;
        let headTimer = null;
        let received = 0;
        let blocked = false;
        const id = tunnel.open({
            onRes(m) {
                clearTimeout(headTimer);
                // A key opens the share's API, never its pages: an HTML answer to a key is refused here, so a key posted
                // in public cannot make the share a public website past the sign-in gate (CON-16, CON-9).
                if (who.apiKey && isHtml(m.headers)) {
                    blocked = true;
                    tunnel.abort(id, 'html_to_key');
                    return sendProblem(req, res, 406, 'api_only', 'Keys open this share\'s API', 'An API key opens what this share answers to programs, not its web pages. Open the page in a browser and sign in with OpenVibe.', { json: { error: 'api_only' } });
                }
                const status = Number(m.status);
                if (!Number.isInteger(status) || status < 100 || status > 599 || status === 101) {
                    tunnel.abort(id, 'bad_status');
                    return sendProblem(req, res, 502, 'bad_response', 'The app answered something odd', 'The app on the other end sent a response OpenVibe Connect cannot pass on.');
                }
                rec.status = status;
                try { res.writeHead(status, responseHeaders(m.headers)); } catch { tunnel.abort(id, 'bad_headers'); res.destroy(); }
                return undefined;
            },
            onData(buf) {
                if (blocked) return;
                addBytes(share, 'out', buf.length);
                rec.out += buf.length;
                if (!res.write(buf)) {
                    tunnel.send({ t: 'pause', id });
                    res.once('drain', () => tunnel.send({ t: 'resume', id }));
                }
            },
            onEnd() { finished = true; tunnel.release(id); clearTimeout(headTimer); if (!blocked) res.end(); },
            onAbort(m) {
                finished = true;
                if (blocked) return;
                clearTimeout(headTimer);
                if (m && m.code) rec.error = String(m.code).slice(0, 40);
                if (res.headersSent) { res.destroy(); return; }
                if (m && m.code === 'local_refused') {
                    sendProblem(req, res, 502, 'local_refused', 'Nothing is listening', `${share.owner_username}'s computer is connected, but nothing answered on port ${port}.`);
                } else if (m && m.code === 'tunnel_closed') {
                    sendProblem(req, res, 502, 'offline', 'The connection dropped', `${share.owner_username}'s computer disconnected while answering. Try again in a moment.`, { headers: { 'retry-after': '5' } });
                } else {
                    sendProblem(req, res, 502, 'local_error', 'The app did not answer', 'The app on the other end stopped before it answered.');
                }
            },
            onPause() { req.pause(); },
            onResume() { req.resume(); },
        });
        headTimer = setTimeout(() => {
            if (res.headersSent || finished) return;
            finished = true;
            rec.error = 'timeout';
            tunnel.abort(id, 'timeout');
            sendProblem(req, res, 504, 'timeout', 'That took too long', `The app on ${share.owner_username}'s computer did not answer in ${Math.round(config.shares.requestTimeoutMs / 1000)} seconds.`);
        }, config.shares.requestTimeoutMs);
        headTimer.unref();

        tunnel.send({ t: 'req', id, method: req.method, path: url, headers: forwardHeaders(req, share, who, port) });
        // What a key's request used (CON-16 v1): the first 64 KB of a JSON POST are read for an MCP tools/call name or a
        // model name, counted per key and day; the body itself is not kept.
        const audited = who.key && apiKeys && req.method === 'POST' && /json/i.test(String(req.headers['content-type'] || '')) ? [] : null;
        let auditedBytes = 0;
        req.on('data', (chunk) => {
            if (audited && auditedBytes < AUDIT_MAX) { audited.push(chunk.subarray(0, AUDIT_MAX - auditedBytes)); auditedBytes += Math.min(chunk.length, AUDIT_MAX - auditedBytes); }
            received += chunk.length;
            addBytes(share, 'in', chunk.length);
            rec.in += chunk.length;
            if (received > config.shares.maxBodyBytes) {
                if (!finished) { finished = true; rec.error = 'too_large'; tunnel.abort(id, 'too_large'); sendProblem(req, res, 413, 'too_large', 'Too large', 'That request is larger than a share takes.'); }
                req.destroy();
                return;
            }
            tunnel.data(id, chunk);
            if (tunnel.congested) { req.pause(); tunnel.drained().then(() => req.resume()); }
        });
        req.on('end', () => {
            if (!finished) tunnel.end(id);
            if (audited && audited.length) { try { apiKeys.audit(who.key, url, Buffer.concat(audited).toString('utf8')); } catch { /* the audit never stops a request */ } }
        });
        res.on('close', () => { if (!finished && !res.writableFinished) { finished = true; clearTimeout(headTimer); tunnel.abort(id, 'visitor_gone'); } });
    }

    /** A WebSocket upgrade on a share host: the gate, then the raw bytes both ways. */
    async function upgrade(req, socket, head) {
        socket.on('error', () => {});
        // A tiny response object over the raw socket, so the gate's answers read the same here.
        const fake = rawResponder(socket);
        const share = await resolve(req, fake);
        if (!share) return;
        const admitted = await admit(req, fake, share, String(req.url || '/'));
        if (!admitted) return;
        const { who, tunnel } = admitted;
        visit(share, who);
        const rec = inspector.begin(share.id, { method: req.method, path: String(req.url || '/'), who, ws: true });
        socket.on('close', () => inspector.end(rec));
        const port = (tunnel.clientInfo && tunnel.clientInfo.port) || share.local_port;

        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [k, v] of forwardHeaders(req, share, who, port, { raw: true })) lines.push(`${k}: ${v.replace(/[\r\n]/g, ' ')}`);
        const headText = `${lines.join('\r\n')}\r\n\r\n`;
        let opened = false;
        const id = tunnel.open({
            onData(buf) {
                if (!opened) rec.status = /^HTTP\/1\.[01] (\d{3})/.test(buf.toString('latin1', 0, 16)) ? Number(RegExp.$1) : null;
                opened = true;
                addBytes(share, 'out', buf.length);
                rec.out += buf.length;
                if (!socket.write(buf)) { tunnel.send({ t: 'pause', id }); socket.once('drain', () => tunnel.send({ t: 'resume', id })); }
            },
            onEnd() { tunnel.release(id); socket.end(); },
            onAbort(m) {
                if (m && m.code) rec.error = String(m.code).slice(0, 40);
                if (!opened && m && m.code === 'local_refused') {
                    rec.status = 502;
                    socket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nNothing answered on port ${port}.`);
                } else socket.destroy();
            },
            onPause() { socket.pause(); },
            onResume() { socket.resume(); },
        });
        tunnel.send({ t: 'raw', id, head: headText });
        if (head && head.length) { addBytes(share, 'in', head.length); rec.in += head.length; tunnel.data(id, head); }
        socket.on('data', (chunk) => {
            addBytes(share, 'in', chunk.length);
            rec.in += chunk.length;
            tunnel.data(id, chunk);
            if (tunnel.congested) { socket.pause(); tunnel.drained().then(() => socket.resume()); }
        });
        socket.on('end', () => tunnel.end(id));
        socket.on('close', () => { if (tunnel.streams.has(id)) tunnel.abort(id, 'visitor_gone'); });
    }

    function stop() { clearInterval(flusher); return flush(); }

    /** The grant refused someone: counted on the share page as "turned away". */
    function denied(share, who) { visit(share, who, { denied: true }); }

    /**
     * One stored webhook to the share's computer (CON-15): the request as it arrived, at the hook's path, with
     * x-openvibe-hook and x-openvibe-event-id so the app can tell and dedupe. The answer's body is read and dropped.
     * → { status } when the app answered, { offline: true } with no computer, { error } when it broke on the way.
     */
    function deliverHook(share, { method, path, headers = [], body, hookId, eventId }) {
        const tunnel = tunnels.get(share.id);
        if (!tunnel) return Promise.resolve({ offline: true });
        const port = (tunnel.clientInfo && tunnel.clientInfo.port) || share.local_port;
        const rec = inspector.begin(share.id, { method, path, who: { username: 'webhook' } });
        return new Promise((resolve) => {
            let done = false;
            const finish = (out) => { if (done) return; done = true; clearTimeout(timer); inspector.end(rec, out.status ? { status: out.status } : { error: out.error || 'offline' }); resolve(out); };
            let status = 0;
            const id = tunnel.open({
                onRes(m) { status = Number(m.status) || 0; },
                onData() {},
                onEnd() { tunnel.release(id); finish(status >= 100 && status <= 599 ? { status } : { error: 'bad_status' }); },
                onAbort(m) { finish({ error: (m && m.code) || 'local_error' }); },
                onPause() {}, onResume() {},
            });
            const timer = setTimeout(() => { tunnel.abort(id, 'timeout'); finish({ error: 'timeout' }); }, config.shares.requestTimeoutMs);
            timer.unref();
            const out = (Array.isArray(headers) ? headers : []).filter((h) => Array.isArray(h) && h.length === 2 && !/^(host|content-length|x-openvibe-)/i.test(String(h[0])));
            out.push(['host', `localhost:${port}`], ['x-forwarded-host', share.host], ['x-forwarded-proto', config.shares.scheme],
                ['x-openvibe-hook', String(hookId || '')], ['x-openvibe-event-id', String(eventId || '')], ['content-length', String(body ? body.length : 0)]);
            tunnel.send({ t: 'req', id, method, path, headers: out });
            if (body && body.length) {
                rec.in += body.length;
                const CHUNK = 32 * 1024;
                for (let i = 0; i < body.length; i += CHUNK) tunnel.data(id, body.subarray(i, i + CHUNK));
            }
            tunnel.end(id);
        });
    }

    /**
     * One GET through a share's tunnel for Connect itself (CON-9's probe): the answer's status, content type and the
     * first maxBytes of its body. → { status, type, body } | { offline: true } | { error }
     */
    function fetchThrough(share, { path = '/', headers = [], maxBytes = 512 * 1024 } = {}) {
        const tunnel = tunnels.get(share.id);
        if (!tunnel) return Promise.resolve({ offline: true });
        const port = (tunnel.clientInfo && tunnel.clientInfo.port) || share.local_port;
        return new Promise((resolve) => {
            let done = false;
            let status = 0;
            let type = '';
            const chunks = [];
            let size = 0;
            const finish = (out) => { if (done) return; done = true; clearTimeout(timer); resolve(out); };
            const id = tunnel.open({
                onRes(m) {
                    status = Number(m.status) || 0;
                    for (const pair of Array.isArray(m.headers) ? m.headers : []) if (Array.isArray(pair) && String(pair[0]).toLowerCase() === 'content-type') type = String(pair[1]).slice(0, 120);
                },
                onData(buf) {
                    if (size >= maxBytes) return;
                    const take = buf.subarray(0, maxBytes - size);
                    chunks.push(take);
                    size += take.length;
                    if (size >= maxBytes) { tunnel.abort(id, 'enough'); finish({ status, type, body: Buffer.concat(chunks) }); }
                },
                onEnd() { tunnel.release(id); finish({ status, type, body: Buffer.concat(chunks) }); },
                onAbort(m) { finish(size ? { status, type, body: Buffer.concat(chunks) } : { error: (m && m.code) || 'local_error' }); },
                onPause() {}, onResume() {},
            });
            const timer = setTimeout(() => { tunnel.abort(id, 'timeout'); finish(size ? { status, type, body: Buffer.concat(chunks) } : { error: 'timeout' }); }, config.shares.requestTimeoutMs);
            timer.unref();
            const out = (Array.isArray(headers) ? headers : []).filter((h) => Array.isArray(h) && h.length === 2);
            out.push(['host', `localhost:${port}`], ['x-forwarded-host', share.host], ['x-forwarded-proto', config.shares.scheme], ['accept', 'text/html,*/*;q=0.5'], ['content-length', '0']);
            tunnel.send({ t: 'req', id, method: 'GET', path, headers: out });
            tunnel.end(id);
        });
    }

    return { handle, upgrade, isShareHost, flush, forget, denied, stop, responseHeaders, forwardHeaders, deliverHook, fetchThrough, inspector };
}

/** Write an HTTP answer straight to an upgrade's socket (the gate's 302/401/404/502 before any tunnel opens). */
function rawResponder(socket) {
    let sent = false;
    let status = 200;
    let headers = {};
    return {
        get headersSent() { return sent; },
        writeHead(s, h) { status = s; headers = h || {}; sent = true; },
        end(body = '') {
            const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'Error'}`];
            const b = Buffer.from(String(body));
            for (const [k, v] of Object.entries(headers)) for (const one of [].concat(v)) lines.push(`${k}: ${one}`);
            lines.push(`content-length: ${b.length}`, 'connection: close');
            socket.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), b]));
        },
        destroy() { socket.destroy(); },
    };
}
const STATUS_TEXT = { 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 410: 'Gone', 429: 'Too Many Requests', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "3 minutes ago", "2 hours ago", "4 days ago". */
function ago(iso, nowMs = Date.now()) {
    const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
    if (!Number.isFinite(s)) return 'a while ago';
    if (s < 90) return 'a minute ago';
    const m = Math.round(s / 60);
    if (m < 90) return `${m} minutes ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
    return `${Math.round(h / 24)} days ago`;
}

/**
 * The gate's own page: plain, readable in both themes, no outside resources. `refresh` (seconds) asks again by itself:
 * a meta refresh, so it works under the page's no-script CSP.
 */
function page(title, text, link, { refresh = 0, note = '', report = '', notify = '' } = {}) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${Number(refresh) | 0}">` : ''}<meta name="robots" content="noindex"><title>${escapeHtml(title)} · OpenVibe Connect</title>
<style>:root{color-scheme:light dark;--bg:#f6f7fb;--fg:#141824;--muted:#5b6275;--card:#fff;--line:#dfe3ee;--accent:#4B53C2}
@media (prefers-color-scheme:dark){:root{--bg:#0d131d;--fg:#e8ecf5;--muted:#9aa3b8;--card:#141c2a;--line:#253047;--accent:#8EA0FF}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px max(16px,env(safe-area-inset-left))}
main{max-width:30rem;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:1.35rem;margin:0 0 .5rem;text-wrap:balance}p{margin:0 0 1rem;color:var(--muted)}
a{display:inline-block;color:var(--accent);font-weight:600;text-decoration:none;padding:10px 0;min-height:24px}a:hover{text-decoration:underline}
.mark{font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}.note{font-size:.9rem;padding:10px 12px;border-radius:10px;border:1px solid var(--line)}form{margin:0 0 1rem}button{font:inherit;font-weight:600;padding:10px 16px;min-height:44px;border-radius:10px;border:1px solid var(--line);background:var(--accent);color:#fff;cursor:pointer}.report{margin:0;font-size:.85rem}.report a{font-weight:500;color:var(--muted)}</style></head>
<body><main><div class="mark">OpenVibe Connect</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}${notify ? `<form method="post" action="${escapeHtml(notify)}"><button type="submit">Tell me when it is back</button></form>` : ''}${link ? `<a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a>` : ''}${report ? `<p class="report"><a href="${escapeHtml(report)}">Report this share</a></p>` : ''}</main></body></html>`;
}

module.exports = { createProxy, page, rawResponder };
