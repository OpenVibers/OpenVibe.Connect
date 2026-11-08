'use strict';

/**
 * Connect's pages, server-rendered and complete without JavaScript (forms are plain POSTs). The front door is
 * sc.room (hero → your shares → scenes → developers → questions → the rest of OpenVibe); a share has one page with
 * its address, whether it is connected, who may open it, who did, and the command. A key is shown once, on the page
 * that made it.
 */
const kit = require('openvibe-shared/kit');
const sc = require('openvibe-shared/showcase');
const { esc } = require('../render/html');

const CLIENT_URL = (base) => `${base}/ov-connect.js`;
const MODE_TEXT = {
    owner: 'Only you',
    named: 'You and the people you name',
    signin: 'Anyone signed in to OpenVibe',
};

function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
    return `${(v / 1024 ** 3).toFixed(2)} GB`;
}
function ago(iso, now = Date.now()) {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
}

/** The hero's picture: a port on a laptop, a line through OpenVibe, an address on a phone with a lock. */
function motif(domain) {
    return `<div class="cn-motif" aria-hidden="true">
<div class="cn-m-box cn-m-pc"><span class="cn-m-k">your computer</span><b>localhost:8080</b><span class="cn-m-dot"></span></div>
<div class="cn-m-line"><i></i><span>one outgoing connection</span></div>
<div class="cn-m-box cn-m-phone"><span class="cn-m-k">anywhere</span><b>agents--you.${esc(domain)}</b><span class="cn-m-lock">${kit.icon('lock')} signed in as you</span></div>
</div>`;
}

function terminal(lines) {
    return `<div class="cn-term" role="img" aria-label="A terminal running ov-connect"><div class="cn-term-bar"><i></i><i></i><i></i></div><pre>${lines.map((l) => (l.startsWith('$ ') ? `<span class="cn-term-cmd">${esc(l)}</span>` : `<span class="cn-term-out">${esc(l)}</span>`)).join('\n')}</pre></div>`;
}

function phone(domain) {
    return `<div class="cn-phone" role="img" aria-label="A phone opening a share"><div class="cn-phone-url">${kit.icon('lock')}<span>agents--you.${esc(domain)}</span></div>
<div class="cn-phone-body"><b>Your agent portal</b><span>Runs on your desk. Open here, over 5G.</span><span class="cn-phone-pill">Signed in as you</span></div></div>`;
}

function picker(mode = 'named') {
    // The ghost cursor (openvibe-shared 4.106.0 motion.js) walks the three choices; the server draws "named" chosen.
    return `<div class="cn-pick" role="img" aria-label="Choosing who can open a share" data-ov-ghost>${Object.entries(MODE_TEXT).map(([k, v], i) => `<span class="cn-pick-row${k === mode ? ' is-on' : ''}" data-ov-ghost-step="${i + 1}"><i></i>${esc(v)}</span>`).join('')}
<span class="cn-pick-names"><b>@sam</b><b>@riley</b></span></div>`;
}

function shareRow(s, { connected }) {
    const state = s.status !== 'active' ? ['closed', 'is-closed'] : connected ? ['connected', 'is-on'] : ['not connected', 'is-off'];
    return `<li class="cn-share"><a href="/shares/${esc(s.id)}">
<span class="cn-share-dot ${state[1]}" aria-hidden="true"></span>
<span class="cn-share-main"><b>${esc(s.host)}</b><span>${esc(state[0])} · port ${esc(s.local_port)} · ${esc(MODE_TEXT[s.mode] || s.mode)}</span></span>
${kit.icon('chevron')}</a></li>`;
}

/** The three choices; "anyone signed in" is staff-only until the abuse check (shares.js). */
function modeChoices(current, staff) {
    return Object.entries(MODE_TEXT).map(([k, v]) => {
        const off = k === 'signin' && !staff && current !== 'signin';
        return `<label${off ? ' class="is-off"' : ''}><input type="radio" name="mode" value="${k}"${current === k ? ' checked' : ''}${off ? ' disabled' : ''}> <span>${esc(v)}${off ? '<small>opens with the abuse check</small>' : ''}</span></label>`;
    }).join('');
}

// How long a share stays open by itself (CON-6), as the forms offer it: seconds → words.
const CLOSES = [['', 'When you close it'], ['3600', 'In 1 hour'], ['28800', 'In 8 hours'], ['86400', 'In 1 day'], ['604800', 'In 7 days']];

/** When a time to come is, in words: "in 3 hours", "in 2 days", "in 12 minutes". */
function until(iso, now = Date.now()) {
    const ms = Date.parse(iso) - now;
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'now';
    const m = Math.round(ms / 60000);
    if (m < 60) return `in ${m} minute${m === 1 ? '' : 's'}`;
    const h = Math.round(m / 60);
    if (h < 48) return `in ${h} hour${h === 1 ? '' : 's'}`;
    const d = Math.round(h / 24);
    return `in ${d} days`;
}

function closesField(current, { keep = null } = {}) {
    const opts = (keep ? [['keep', keep]] : []).concat(keep ? CLOSES.map(([v, t]) => [v || 'never', v ? `${t.replace('In ', '')} from now` : 'Only when you close it']) : CLOSES);
    return `<label class="cn-field cn-field-closes"><span>Closes by itself</span><select name="expires_in">${opts.map(([v, t]) => `<option value="${esc(v)}"${String(current) === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select><small>The address answers "ended" after that, and the computer is disconnected.</small></label>`;
}

function createForm({ values = {}, error = null, username = '', staff = false, domain = 'openvibe.link' } = {}) {
    const handle = String(username || 'you').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'you';
    return `<form class="cn-form" method="post" action="/shares" id="new">
<h2>Make a share</h2>
${error ? `<p class="cn-error" role="alert">${esc(error)}</p>` : ''}
<div class="cn-fields">
<label class="cn-field"><span>Name</span><span class="cn-addr"><input name="label" required maxlength="40" pattern="[a-z0-9]([a-z0-9]|-(?=[a-z0-9])){0,39}" value="${esc(values.label || '')}" placeholder="agents" autocapitalize="none" autocomplete="off" spellcheck="false"><span class="cn-addr-tail">--${esc(handle)}.${esc(domain)}</span></span><small>a–z, 0–9 and hyphens</small></label>
<label class="cn-field cn-field-port"><span>Port on your computer</span><input name="port" required inputmode="numeric" pattern="[0-9]{1,5}" maxlength="5" value="${esc(values.port || '')}" placeholder="8080"></label>
</div>
${closesField(values.expires_in == null ? '' : values.expires_in)}
<fieldset class="cn-modes"><legend>Who can open it</legend>
${modeChoices(values.mode || 'owner', staff)}
</fieldset>
<label class="cn-field"><span>People (for "the people you name")</span><input name="named" maxlength="2000" value="${esc(values.named || '')}" placeholder="sam, riley" autocapitalize="none" autocomplete="off" spellcheck="false"><small>OpenVibe usernames, separated by commas</small></label>
<button class="cn-btn" type="submit">${kit.icon('plus')} Make the share</button>
<p class="cn-fine">Every visitor signs in with OpenVibe first. Public shares, open to anyone, come once the abuse check is in. Seen a share that tricks people? <a href="/report">Report it</a>.</p>
</form>`;
}

function yourShares({ viewer, shares, connectedIds, form, domain }) {
    if (!viewer || viewer.kind !== 'user') return '';
    const open = shares.filter((s) => s.status === 'active');
    const closed = shares.filter((s) => s.status !== 'active');
    const list = open.length
        ? `<ul class="cn-shares">${open.map((s) => shareRow(s, { connected: connectedIds.has(s.id) })).join('')}</ul>`
        : '<p class="cn-empty">No shares yet. Make one below: a name, a port, who can open it.</p>';
    const closedList = closed.length ? `<details class="cn-closed"><summary>Closed shares (${closed.length})</summary><ul class="cn-shares">${closed.map((s) => shareRow(s, { connected: false })).join('')}</ul></details>` : '';
    return `<section class="cn-yours" aria-labelledby="cn-yours-h"><h2 id="cn-yours-h">Your shares</h2>${list}${closedList}${createForm({ domain, username: viewer.username, ...(form || {}), staff: viewer.role === 'admin' })}</section>`;
}

function home({ viewer, shares = [], connectedIds = new Set(), stats = {}, baseUrl, form = null, domain = 'openvibe.link' }) {
    const signedIn = viewer && viewer.kind === 'user';
    const body = sc.room({
        room: 'website',
        hero: {
            title: 'Your computer, on the web, privately',
            lede: `Share one port on your computer at its own address, like agents--you.${esc(domain)}. Only the people you pick can open it, signed in with OpenVibe. No router settings, no open ports, no app to install: one file and Node.`,
            start: signedIn ? { href: '#new', label: 'Make a share' } : { href: '/auth/login?next=%2F%23new', label: 'Sign in to make a share' },
            motif: motif(domain),
        },
        proof: [
            { value: stats.connected, label: stats.connected === 1 ? 'share connected now' : 'shares connected now', live: true },
            { value: stats.shares, label: 'shares open' },
        ],
        scenes: [
            {
                title: 'One command on your computer',
                text: 'Download ov-connect.js once and run it with your share\'s key and port. It opens one outgoing connection to OpenVibe, so it works behind any router, at home or on a phone hotspot, and it reconnects by itself after sleep.',
                html: terminal([
                    `$ curl -fsSLO ${CLIENT_URL(baseUrl)}`,
                    '$ node ov-connect.js --key ovc_… --port 8080',
                    `Connected. https://agents--you.${domain} → localhost:8080`,
                    'GET / → 200 (14 ms)',
                ]),
                action: signedIn ? { href: '#new', label: 'Make a share' } : { href: '/auth/login?next=%2F%23new', label: 'Sign in to start' },
            },
            {
                title: 'Open it anywhere, signed in',
                text: 'Your agent portal, a dev server, a home dashboard: open its address on your phone over 5G. It is real HTTPS, so the microphone, the camera and WebSockets work. Live streams (server-sent events) stream.',
                html: phone(domain),
            },
            {
                title: 'You pick who gets in',
                text: 'Only you, or you and the people you name. Change it any time and everyone already in is asked again. Your app is told who each visitor is, so it can greet them by name.',
                html: picker(),
            },
        ],
        dev: {
            title: 'For developers',
            lede: 'The share page is also an API, with your OpenVibe token. Your app receives X-OpenVibe-User and X-OpenVibe-Subject on every request, and never the gate\'s own cookie.',
            samples: [
                { label: 'Make a share', lang: 'bash', code: `curl -X POST ${baseUrl}/api/v1/shares \\\n  -H "Authorization: Bearer $OV_TOKEN" -H "Content-Type: application/json" \\\n  -d '{"label":"agents","port":8790,"mode":"owner"}'` },
                { label: 'Your shares', lang: 'bash', code: `curl ${baseUrl}/api/v1/shares -H "Authorization: Bearer $OV_TOKEN"` },
                { label: 'Run the client', lang: 'bash', code: 'OV_CONNECT_KEY=ovc_… node ov-connect.js 8790' },
            ],
            links: [{ label: 'The client\'s source', href: CLIENT_URL(baseUrl) }, { label: 'llms.txt', href: '/llms.txt' }],
        },
        faq: {
            items: [
                ['What can the server make my computer do?', 'Nothing but answer requests for your share on the one port you gave the client, on localhost. The client never opens a connection anywhere else, and you can read all of it: it is one file.'],
                ['Who can open my share?', 'People you allow, after they sign in with OpenVibe: only you, or you and the people you name. "Anyone signed in" is open to OpenVibe staff until the abuse check is in. Changing who can open a share signs everyone out of it at once.'],
                ['Can I make it public?', 'Not yet. A public address can be abused for phishing, so public shares come with the abuse check and openvibe.website\'s entry in the Public Suffix List. Until then every visitor signs in.'],
                ['What does my app see?', 'The request as the browser sent it, with Host set to localhost:<port>, the share\'s address in X-Forwarded-Host, the visitor\'s address in X-Forwarded-For, and who they are in X-OpenVibe-User and X-OpenVibe-Subject. Cookies your app sets stay on your share\'s address.'],
                ['What are the limits?', 'Five open shares per person, 64 requests at once per share, 1,200 requests a minute per share, 100 MB per request body, and 10 GB a day across your shares. Nothing is stored: requests pass through.'],
                ['How is this different from ngrok or Tailscale?', 'It is part of your OpenVibe account: the people you let in are OpenVibe people, no separate login, no install beyond one file. TCP and UDP shares (game servers), custom domains, a private mesh between your machines and durable webhooks are the next steps on the plan.'],
            ],
        },
        network: {
            service: 'website',
            title: 'Part of OpenVibe',
            lede: 'Connect shares a port from your machine through OpenVibe Link. Space builds and hosts sites.',
            items: [
                { to: 'space', what: 'Build and host a site at <name>.openvibe.website', href: 'https://openvibe.space' },
                { to: 'network', what: 'The sign-in your visitors use', href: 'https://openvibe.network' },
                { to: 'codes', what: 'Your agents and machines', href: 'https://openvibe.codes' },
            ],
        },
    });
    const yours = yourShares({ viewer, shares, connectedIds, form, domain });
    const at = body.indexOf('<section class="sc-room-scenes"');
    return `<div class="cn-wrap">${at < 0 ? body + yours : body.slice(0, at) + yours + body.slice(at)}</div>`;
}

function keyBlock(share, key, baseUrl) {
    const cmd = `node ov-connect.js --key ${key} --port ${share.local_port}`;
    return `<section class="cn-key" aria-labelledby="cn-key-h">
<h2 id="cn-key-h">Your connect key</h2>
<p>Shown this once. It lets a computer serve this share, so keep it like a password. Lost it? Make a new one below; the old one stops working.</p>
<div class="cn-copy"><code id="cn-key-v">${esc(key)}</code><button type="button" class="cn-btn cn-btn-quiet" data-ovk-copy="#cn-key-v" hidden>${kit.icon('copy')} Copy</button></div>
<h3>On your computer</h3>
<ol class="cn-steps">
<li><span>Download the client once (Node 22 or newer):</span><div class="cn-copy"><code id="cn-dl">curl -fsSLO ${esc(CLIENT_URL(baseUrl))}</code><button type="button" class="cn-btn cn-btn-quiet" data-ovk-copy="#cn-dl" hidden>${kit.icon('copy')} Copy</button></div></li>
<li><span>Run it next to what you are sharing:</span><div class="cn-copy"><code id="cn-run">${esc(cmd)}</code><button type="button" class="cn-btn cn-btn-quiet" data-ovk-copy="#cn-run" hidden>${kit.icon('copy')} Copy</button></div></li>
<li><span>Open <a href="${esc(share.url)}">${esc(share.host)}</a> anywhere and sign in.</span></li>
</ol>
</section>`;
}

/** Bytes as a person reads them. */
function size(n) {
    const b = Number(n) || 0;
    return b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const REQ_ERRORS = { local_refused: 'nothing listening', timeout: 'timed out', visitor_gone: 'visitor left', too_large: 'too large', tunnel_closed: 'dropped', bad_status: 'odd answer', bad_headers: 'odd answer', local_error: 'app stopped' };

/** One request in the inspector (public/js/connect.js draws the same row for new ones). */
function requestRow(q) {
    const tone = q.open ? 'open' : q.error && !q.status ? 'err' : q.status >= 500 ? 's5' : q.status >= 400 ? 's4' : q.status >= 300 ? 's3' : 's2';
    const badge = q.open ? (q.ws ? 'open' : '…') : q.status ? String(q.status) : (REQ_ERRORS[q.error] || q.error || '?');
    const meta = [q.ms != null ? `${q.ms} ms` : null, q.in ? `${size(q.in)} in` : null, q.out ? `${size(q.out)} out` : null,
        q.error && q.status ? (REQ_ERRORS[q.error] || q.error) : null, q.who ? `@${q.who}` : null].filter(Boolean).join(' · ');
    return `<li class="cn-req is-${tone}" data-seq="${esc(q.seq)}"><span class="cn-req-badge">${esc(badge)}</span><code class="cn-req-line"><b>${esc(q.ws ? 'WS' : q.method)}</b> ${esc(q.path)}</code><span class="cn-req-meta">${esc(meta)}</span><time datetime="${esc(q.at)}">${esc(String(q.at).slice(11, 19))}</time></li>`;
}

const MACHINES_URL = 'https://openvibe.bot/machines';

/**
 * Which computer serves it (CON-4): one of the owner's computers as OpenVibe Link (no key to copy; removing the computer
 * on OpenVibe stops it), or the one-file client with the connect key. `machines` is null when Network could not be read.
 */
function nodeBlock(share, machines, now) {
    if (share.node) {
        const run = `openvibe-node share --share ${share.id}`;
        const keep = `sudo openvibe-node share add --share ${share.id}`;
        return `<section class="cn-node" aria-labelledby="cn-node-h"><h2 id="cn-node-h">Your computer serves it</h2>
<p><b>${esc(share.node.name)}</b> serves this share as OpenVibe Link: no key to copy, and removing the computer on OpenVibe stops it within five minutes.</p>
<ol class="cn-steps">
<li><span>On that computer, serve it now:</span><div class="cn-copy"><code id="cn-node-run">${esc(run)}</code><button type="button" class="cn-btn cn-btn-quiet" data-ovk-copy="#cn-node-run" hidden>${kit.icon('copy')} Copy</button></div></li>
<li><span>Or keep it up with the Link service, across restarts:</span><div class="cn-copy"><code id="cn-node-keep">${esc(keep)}</code><button type="button" class="cn-btn cn-btn-quiet" data-ovk-copy="#cn-node-keep" hidden>${kit.icon('copy')} Copy</button></div></li>
</ol>
<form method="post" action="/shares/${esc(share.id)}/node"><input type="hidden" name="node" value=""><button class="cn-btn cn-btn-quiet" type="submit">${kit.icon('key')} Use a connect key instead</button><span>The computer stops serving it and a new key is shown once.</span></form>
</section>`;
    }
    const intro = '<p>Pick one of your computers that runs OpenVibe Link and it serves this share with its own sign-in: no key to copy, and removing the computer on OpenVibe stops it. The connect key stops working while a computer serves it.</p>';
    let list;
    if (machines === null) list = '<p class="cn-empty">Your computers could not be read from OpenVibe just now. Reload the page in a moment.</p>';
    else if (!machines.length) list = `<p class="cn-empty">No computers yet. <a href="${esc(MACHINES_URL)}">Add one on openvibe.bot/machines</a>, then come back here.</p>`;
    else {
        list = `<ul class="cn-machines">${machines.map((m) => `<li><span class="cn-machine"><b>${esc(m.name)}</b><small>${m.last_seen_at ? `seen ${esc(ago(m.last_seen_at, now))}` : 'not seen yet'}</small></span>
<form method="post" action="/shares/${esc(share.id)}/node"><input type="hidden" name="node" value="${esc(m.id)}"><button class="cn-btn cn-btn-quiet" type="submit">${kit.icon('check')} Serve it from this computer</button></form></li>`).join('')}</ul>`;
    }
    return `<section class="cn-node" aria-labelledby="cn-node-h"><h2 id="cn-node-h">Or serve it from one of your computers</h2>${intro}${list}</section>`;
}

/**
 * Webhooks that wait for your computer (CON-15): each address, where it goes on the computer's app, what came and what
 * was handed over, and how many wait; the form for another. Plain forms, no script.
 */
function hooksBlock(share, hooks, now) {
    const log = (h) => {
        const rows = Array.isArray(h.deliveries) ? h.deliveries.slice(0, 5) : [];
        if (!rows.length) return '';
        return `<details class="cn-delivery-log"><summary>Delivery log</summary><ul>${rows.map((d) => `<li><b>${d.status == null ? 'failed' : esc(d.status)}</b> ${esc(d.method)} ${esc(d.path)} · ${esc(ago(d.delivered_at || d.created_at, now))}${d.error ? ` · ${esc(d.error)}` : ''}</li>`).join('')}</ul></details>`;
    };
    const rows = hooks.length ? `<ul class="cn-hooks">${hooks.map((h, i) => `<li><div class="cn-hook-main"><div class="cn-copy"><code id="cn-hook-${i}">${esc(h.url)}</code><button type="button" class="cn-btn cn-btn-quiet" data-ovk-copy="#cn-hook-${i}" hidden>${kit.icon('copy')} Copy</button></div>
<small>→ localhost:${esc(share.local_port)}${esc(h.local_path)}${h.label ? ` · ${esc(h.label)}` : ''} · ${esc(h.received)} received, ${esc(h.delivered)} handed over${h.waiting ? `, <b>${esc(h.waiting)} waiting for your computer</b>` : ''}${h.last_received_at ? ` · last ${esc(ago(h.last_received_at, now))}` : ''}${h.last_status ? ` · your app answered ${esc(h.last_status)}` : ''}</small>${log(h)}</div>
<form method="post" action="/shares/${esc(share.id)}/hooks/${esc(h.id)}/remove"><button class="cn-btn cn-btn-quiet" type="submit">${kit.icon('close')} Remove</button></form></li>`).join('')}</ul>`
        : '<p class="cn-empty">No webhook addresses yet.</p>';
    return `<section class="cn-hooks-sec" aria-labelledby="cn-hooks-h"><h2 id="cn-hooks-h">Webhooks that wait for your computer</h2>
<p>Give a service (GitHub, Stripe, anything that sends webhooks) an address here instead of your share's. Each webhook is sealed, kept for up to 72 hours, and handed to your app, at the path you pick, as soon as your computer is connected: a laptop that sleeps misses nothing. A share holds at most 1,000 waiting webhooks; the log below says what your app answered. Nobody has to sign in to send one, so check the provider's signature in your app.</p>
${rows}
<form class="cn-form cn-hook-add" method="post" action="/shares/${esc(share.id)}/hooks">
<label class="cn-field"><span>Path on your app</span><input name="path" maxlength="500" value="/webhooks" placeholder="/webhooks/github" autocapitalize="none" autocomplete="off" spellcheck="false"></label>
<label class="cn-field"><span>Name (optional)</span><input name="label" maxlength="80" placeholder="GitHub pushes"></label>
<button class="cn-btn" type="submit">${kit.icon('plus')} Make a webhook address</button>
</form></section>`;
}

/**
 * MCP clients (CON-16): the share's address works as an MCP server URL in Claude or any MCP client, which signs the
 * person in with OpenVibe (OAuth). The owner sees each app and person signed in, and signs one out.
 */
function mcpBlock(share, sessions, now) {
    const url = `${share.url || `https://${share.host}`}/mcp`;
    const rows = sessions.length ? `<ul class="cn-hooks">${sessions.map((x) => `<li><div class="cn-hook-main"><b>${esc(x.client)}</b>
<small>as ${x.username ? `@${esc(x.username)}` : 'a person'} · signed in ${esc(ago(x.created_at, now))} · ${x.last_used_at ? `last used ${esc(ago(x.last_used_at, now))}` : 'not used yet'}</small></div>
<form method="post" action="/shares/${esc(share.id)}/oauth/${esc(x.id)}/revoke"><button class="cn-btn cn-btn-quiet" type="submit">${kit.icon('close')} Sign out</button></form></li>`).join('')}</ul>`
        : '<p class="cn-empty">No app has signed in yet.</p>';
    return `<section class="cn-hooks-sec" id="mcp" aria-labelledby="cn-mcp-h"><h2 id="cn-mcp-h">Use it from Claude and other MCP clients</h2>
<p>If this share is an MCP server, add <code>${esc(url)}</code> (or its own path) as a connector in Claude or any MCP client. The app asks the person to sign in with OpenVibe; this share's rule decides who may, and the app gets access to this share only.</p>
${rows}</section>`;
}

/** The consent page of an MCP client's sign-in (CON-16): who asks, for which share, as whom. */
function oauthConsent({ client, share, viewer, fields }) {
    const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    let to = '';
    try { to = new URL(fields.redirect_uri).host; } catch { /* checked before */ }
    return `<div class="cn-wrap cn-page cn-narrow"><header class="cn-head"><h1>Let ${esc(client.name)} use ${esc(share.host)}?</h1>
<p><b>${esc(client.name)}</b> (it goes back to <code>${esc(to)}</code>) asks to use <b>${esc(share.host)}</b>, shared by ${esc(share.owner_username)}, as ${viewer.username ? `@${esc(viewer.username)}` : 'you'}.</p></header>
<ul class="cn-fine">
<li>It can use what this share answers, as you would. Nothing else of your OpenVibe account.</li>
<li>It stays signed in until the share changes who it lets in, its owner signs it out, or 30 days pass unused.</li>
<li>Only say yes to an app you just added yourself.</li>
</ul>
<form class="cn-form" method="post" action="/oauth/authorize">${hidden}
<button class="cn-btn" type="submit" name="decision" value="allow">Allow</button>
<button class="cn-btn cn-btn-quiet" type="submit" name="decision" value="deny">No</button>
</form></div>`;
}

/**
 * A key's use today (CON-16 v1): its requests against its daily quota, and the MCP tools and models it used, by count.
 */
function keyUseToday(k) {
    if (!k.today) return '';
    const quota = k.per_day ? ` of ${esc(Number(k.per_day).toLocaleString('en-US'))}` : '';
    const used = (k.used || []).map((u) => {
        const [kind, ...rest] = String(u.what).split(':');
        return `<li><span class="cn-muted">${kind === 'tool' ? 'tool' : 'model'}</span> <code>${esc(rest.join(':'))}</code> ×${esc(u.n)}</li>`;
    }).join('');
    return `<div class="cn-keyuse"><small>Today: ${esc(Number(k.today).toLocaleString('en-US'))}${quota} requests</small>${used ? `<ul class="cn-keyuse-list">${used}</ul>` : ''}</div>`;
}

/**
 * API keys for the share (CON-16 v0): what a program sends to pass the gate. A new key is shown once, with the request
 * to try it; the list shows each key's start, its rate and when it was last used, and revokes it.
 */
function apiKeysBlock(share, keys, made, now) {
    const fresh = made ? `<div class="cn-newkey" role="status"><p><b>Your new key</b> for ${esc(made.key.name)}. Copy it now: it is not shown again.</p>
<div class="cn-copy"><code id="cn-apikey">${esc(made.token)}</code><button type="button" class="cn-btn cn-btn-quiet" data-ovk-copy="#cn-apikey" hidden>${kit.icon('copy')} Copy</button></div>
<p class="cn-hint">Try it: <code>curl -H "Authorization: Bearer ${esc(made.token)}" https://${esc(share.host)}/</code></p></div>` : '';
    const rows = keys.length ? `<ul class="cn-hooks">${keys.map((k) => `<li><div class="cn-hook-main"><b>${esc(k.name)}</b> <code>${esc(k.prefix)}…</code>
<small>${esc(k.per_minute)} a minute${k.per_day ? ` · ${esc(Number(k.per_day).toLocaleString('en-US'))} a day` : ''} · made ${esc(ago(k.created_at, now))} · ${k.last_used_at ? `last used ${esc(ago(k.last_used_at, now))}` : 'not used yet'}</small>
${keyUseToday(k)}</div>
<form method="post" action="/shares/${esc(share.id)}/api-keys/${esc(k.id)}/revoke"><button class="cn-btn cn-btn-quiet" type="submit">${kit.icon('close')} Revoke</button></form></li>`).join('')}</ul>`
        : '<p class="cn-empty">No API keys yet.</p>';
    return `<section class="cn-hooks-sec" aria-labelledby="cn-keys-h"><h2 id="cn-keys-h">API keys for programs</h2>
<p>A program (a script, an editor, another app) sends a key as <code>Authorization: Bearer …</code> and passes without signing in: share a model on your computer, like Ollama or llama.cpp, and call it from anywhere. A key opens what this share answers to programs, never its web pages, and your app never sees the key. Revoke one and it stops at once.</p>
${fresh}${rows}
<form class="cn-form cn-hook-add" method="post" action="/shares/${esc(share.id)}/api-keys">
<label class="cn-field"><span>Name</span><input name="name" maxlength="60" required placeholder="laptop script"></label>
<label class="cn-field"><span>Requests a minute</span><input name="per_minute" type="number" min="1" max="600" value="60" inputmode="numeric"></label>
<label class="cn-field"><span>Requests a day <small>(optional)</small></span><input name="per_day" type="number" min="1" max="1000000" inputmode="numeric" placeholder="no daily cap"></label>
<button class="cn-btn" type="submit">${kit.icon('plus')} Make an API key</button>
</form></section>`;
}

function sharePage({ share, connected, tunnel = null, visits = [], requests = [], key = null, baseUrl, notice = null, error = null, staff = false, machines = [], hooks = [], apiKeys = [], newApiKey = null, oauthSessions = [], now = Date.now() }) {
    const closed = share.status !== 'active';
    const state = closed ? 'Closed' : connected ? 'Connected' : 'Not connected';
    const stateText = closed ? `Closed ${ago(share.revoked_at, now)}. The address answers "closed" and stays yours.`
        : connected ? `Connected ${ago(tunnel && tunnel.connectedAt ? new Date(tunnel.connectedAt).toISOString() : share.last_connected_at, now)}${tunnel && tunnel.clientInfo && tunnel.clientInfo.port ? `, serving localhost:${tunnel.clientInfo.port}` : ''}.`
            : share.last_connected_at ? `Last connected ${ago(share.last_connected_at, now)}. ${share.node ? `Start OpenVibe Link on ${share.node.name}` : 'Run ov-connect on your computer'} to bring it back.` : 'Never connected yet. Run the command below on your computer.';
    const visitRows = visits.length
        ? `<ul class="cn-visits">${visits.map((v) => `<li><b>${v.username ? `@${esc(v.username)}` : 'someone'}</b><span>${esc(v.requests)} ${v.requests === 1 ? 'request' : 'requests'}${v.denied ? `, ${esc(v.denied)} turned away` : ''} · ${esc(ago(v.last_at, now))}</span></li>`).join('')}</ul>`
        : '<p class="cn-empty">Nobody has opened it in the last 7 days.</p>';
    const policy = closed ? '' : `<form class="cn-form cn-policy" method="post" action="/shares/${esc(share.id)}/policy">
<h2>Who can open it</h2>
<fieldset class="cn-modes"><legend class="cn-sr">Who can open it</legend>
${modeChoices(share.mode, staff)}
</fieldset>
<label class="cn-field"><span>People (for "the people you name")</span><input name="named" maxlength="2000" value="${esc(share.named.join(', '))}" placeholder="sam, riley" autocapitalize="none" autocomplete="off" spellcheck="false"><small>OpenVibe usernames, separated by commas</small></label>
<label class="cn-field cn-field-port"><span>Port on your computer</span><input name="port" inputmode="numeric" pattern="[0-9]{1,5}" maxlength="5" value="${esc(share.local_port)}"></label>
${closesField('keep', { keep: share.expires_at ? `As it is: ${until(share.expires_at, now)}` : 'As it is: only when you close it' })}
<label class="cn-field"><span>While your computer is off <small>(optional)</small></span><input name="offline_site" type="url" maxlength="300" value="${esc(share.offline_site || '')}" placeholder="https://yourname.openvibe.website" autocapitalize="none" autocomplete="off" spellcheck="false"><small>Send visitors to one of your OpenVibe.Space sites instead of the waiting page. The site's address alone keeps the page they asked for; with a path, everyone goes to that page.</small></label>
<button class="cn-btn" type="submit">${kit.icon('check')} Save</button>
<p class="cn-fine">Changing who can open it signs everyone out of this share; the people still allowed are let back in when they next open it.</p>
</form>`;
    const danger = closed ? '' : `<section class="cn-danger" aria-labelledby="cn-danger-h"><h2 id="cn-danger-h">Key and closing</h2>
<form method="post" action="/shares/${esc(share.id)}/key"><button class="cn-btn cn-btn-quiet" type="submit">${kit.icon('key')} Make a new key</button><span>The old key stops working and a connected computer is disconnected.</span></form>
<form method="post" action="/shares/${esc(share.id)}/close"><button class="cn-btn cn-btn-bad" type="submit">${kit.icon('close')} Close this share</button><span>The address answers "closed" from now on and stays yours.</span></form>
</section>`;
    return `<div class="cn-wrap cn-page">
<p class="cn-back"><a href="/">${kit.icon('back')} Your shares</a></p>
${notice ? `<p class="cn-notice" role="status">${esc(notice)}</p>` : ''}
${error ? `<p class="cn-error" role="alert">${esc(error)}</p>` : ''}
<header class="cn-head" data-cn-share="${esc(share.id)}"><span class="cn-state ${closed ? 'is-closed' : connected ? 'is-on' : 'is-off'}" role="status" aria-live="polite"><i aria-hidden="true"></i><span>${esc(state)}</span></span>
<h1>${closed ? esc(share.host) : `<a href="${esc(share.url)}">${esc(share.host)}</a>`}</h1>
<p data-cn-line>${esc(stateText)}</p></header>
${key ? keyBlock(share, key, baseUrl) : ''}
<dl class="cn-facts">
<div><dt>Who can open it</dt><dd>${esc(MODE_TEXT[share.mode] || share.mode)}${share.mode === 'named' && share.named.length ? `: ${share.named.map((n) => `@${esc(n)}`).join(', ')}` : ''}</dd></div>
<div><dt>Port</dt><dd>localhost:${esc(share.local_port)}</dd></div>
<div><dt>Requests</dt><dd>${esc(Number(share.requests).toLocaleString('en-US'))}</dd></div>
<div><dt>Data</dt><dd>${esc(fmtBytes(share.bytes_in))} in · ${esc(fmtBytes(share.bytes_out))} out</dd></div>
${share.node ? `<div><dt>Served by</dt><dd>${esc(share.node.name)} (OpenVibe Link)</dd></div>` : `<div><dt>Key</dt><dd><code>${esc(share.key_prefix)}…</code></dd></div>`}
<div><dt>Made</dt><dd>${esc(ago(share.created_at, now))}</dd></div>
${share.expires_at ? `<div><dt>${closed ? 'Ended' : 'Closes'}</dt><dd><time datetime="${esc(share.expires_at)}">${esc(closed ? ago(share.expires_at, now) : until(share.expires_at, now))}</time></dd></div>` : ''}
</dl>
${!key && !closed && !share.node ? `<section class="cn-run"><h2>Connect it</h2><div class="cn-copy"><code id="cn-run">node ov-connect.js --key ovc_… --port ${esc(share.local_port)}</code></div><p class="cn-fine">The key was shown once, when it was made. <a href="${esc(CLIENT_URL(baseUrl))}">Download ov-connect.js</a> (Node 22 or newer).</p></section>` : ''}
${closed ? '' : nodeBlock(share, machines, now)}
${closed ? '' : hooksBlock(share, hooks, now)}
${closed ? '' : apiKeysBlock(share, apiKeys, newApiKey, now)}
${closed ? '' : mcpBlock(share, oauthSessions, now)}
<section aria-labelledby="cn-visits-h"><h2 id="cn-visits-h">Who opened it (7 days)</h2>${visitRows}</section>
${closed ? '' : `<section class="cn-inspector" aria-labelledby="cn-reqs-h" data-cn-reqs="${esc(share.id)}"><h2 id="cn-reqs-h">Requests</h2>
<p class="cn-fine">The last 100 through this share, newest first, added as they happen. Kept in memory only, never written down: no headers, no bodies, and query values show as "…".</p>
<ol class="cn-reqs" data-cn-reqs-list>${requests.map(requestRow).join('')}</ol>
<p class="cn-empty" data-cn-reqs-empty${requests.length ? ' hidden' : ''}>No requests yet${connected ? '. Open the address and they appear here' : ''}.</p></section>`}
${policy}
${danger}
</div>`;
}

function grantDenied({ share, viewer }) {
    return `<div class="cn-wrap cn-page cn-narrow"><header class="cn-head"><span class="cn-state is-closed"><i aria-hidden="true"></i>Not for you</span>
<h1>You can't open ${esc(share.host)}</h1>
<p>${esc(share.owner_username)} has not let ${viewer && viewer.username ? `@${esc(viewer.username)}` : 'this account'} in. Ask them to add your OpenVibe username to the share.</p></header>
<p><a class="cn-btn cn-btn-quiet" href="/auth/logout?next=${encodeURIComponent(`/grant?share=${share.id}`)}">Use another account</a></p>
<p class="cn-fine"><a href="/report?host=${encodeURIComponent(share.host)}">Report this share</a></p></div>`;
}

/**
 * The report form (CON-9 v0): anyone, about any share, by its address. What a reporter writes reaches OpenVibe staff;
 * the share's owner is not told who reported.
 */
function reportForm({ host = '', values = {}, error = null, reasons = {}, signedIn = false } = {}) {
    const picked = values.reason || '';
    return `<div class="cn-wrap cn-page cn-narrow"><header class="cn-head"><h1>Report a share</h1>
<p>Tell OpenVibe about a share that tricks people, spreads harm or breaks the law. Staff read every report and can close the share. Its owner is not told who reported it.</p></header>
${error ? `<p class="cn-error" role="alert">${esc(error)}</p>` : ''}
<form class="cn-form" method="post" action="/report">
<label class="cn-field"><span>The share's address</span><input name="host" required maxlength="200" value="${esc(values.host || host)}" placeholder="name--someone.openvibe.link" autocapitalize="none" autocomplete="off" spellcheck="false"></label>
<fieldset class="cn-modes"><legend>What is wrong</legend>
${Object.entries(reasons).map(([k, v]) => `<label><input type="radio" name="reason" value="${esc(k)}"${picked === k ? ' checked' : ''} required> <span>${esc(v)}</span></label>`).join('\n')}
</fieldset>
<label class="cn-field"><span>What you saw <small>(optional, up to 2,000 characters)</small></span><textarea name="details" maxlength="2000" rows="4">${esc(values.details || '')}</textarea></label>
<button class="cn-btn" type="submit">${kit.icon('flag')} Send the report</button>
<p class="cn-fine">${signedIn ? 'The report keeps your OpenVibe account so staff can follow up; your address is never stored.' : 'Nothing about you is stored with the report: no account, no address.'} A copyright claim also goes through <a href="/dmca">the DMCA page</a>.</p>
</form></div>`;
}

/** The staff queue (CON-9 v0): open reports, newest first; close the share or dismiss the report. */
function reportsAdmin({ reports = [], reasons = {}, notice = null, now = Date.now() } = {}) {
    const rows = reports.map((r) => `<li class="cn-report"><div class="cn-report-head"><a href="https://${esc(r.host)}" rel="noopener noreferrer nofollow" target="_blank"><b>${esc(r.host)}</b></a><span>@${esc(r.owner_username)} · ${esc(r.mode)} · ${r.share_status === 'active' ? 'open' : 'closed'}${r.open_for_share > 1 ? ` · ${esc(r.open_for_share)} reports` : ''}</span></div>
<p><b>${esc(reasons[r.reason] || r.reason)}</b> · ${esc(ago(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, now))}${r.signed_in ? ' · signed in' : ''}</p>${r.details ? `<blockquote>${esc(r.details)}</blockquote>` : ''}
<div class="cn-report-acts">${r.share_status === 'active' ? `<form method="post" action="/admin/reports/${esc(r.id)}/close"><button class="cn-btn cn-btn-bad" type="submit">${kit.icon('close')} Close the share</button></form>` : ''}<form method="post" action="/admin/reports/${esc(r.id)}/dismiss"><button class="cn-btn cn-btn-quiet" type="submit">Dismiss</button></form></div></li>`).join('');
    return `<div class="cn-wrap cn-page"><header class="cn-head"><h1>Reports</h1><p>Open reports about shares, newest first. Closing a share settles every open report on it; its address then says it was closed after a report.</p></header>
${notice ? `<p class="cn-notice" role="status">${esc(notice)}</p>` : ''}
${reports.length ? `<ol class="cn-reports">${rows}</ol>` : '<p class="cn-empty">No open reports.</p>'}</div>`;
}

function message({ title, text, link = null }) {
    return `<div class="cn-wrap cn-page cn-narrow"><header class="cn-head"><h1>${esc(title)}</h1><p>${esc(text)}</p></header>${link ? `<p><a class="cn-btn cn-btn-quiet" href="${esc(link.href)}">${esc(link.label)}</a></p>` : ''}</div>`;
}

function notFound() { return message({ title: 'Not found', text: 'There is no page here.', link: { href: '/', label: 'OpenVibe Connect' } }); }

module.exports = { home, sharePage, grantDenied, oauthConsent, reportForm, reportsAdmin, message, notFound, MODE_TEXT, fmtBytes, ago, until, requestRow, size };
