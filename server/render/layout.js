'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-shared/shell and is complete without JavaScript.
 * Connect is the "your machine" half of OpenVibe Link, so it wears the Website room's accent (openvibe-shared/rooms
 * `website`, #8EA0FF dark / #4B53C2 light); the navigation's name is `Connect`.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const shell = require('openvibe-shared/shell');
const seo = require('openvibe-shared/seo');
const rooms = require('openvibe-shared/rooms');
const ovServe = require('openvibe-shared/serve');
const cache = require('openvibe-shared/cache-policy');
const { esc } = require('./html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe Connect';
const MENU_NAME = 'Connect';
const TAGLINE = 'Your computer, on the web, privately.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NAV = [
    { label: 'Connect', href: '/', icon: 'plug' },
    { label: 'Sites on Space', href: 'https://openvibe.space', icon: 'globe' },
];
const API_BASE = 'https://connect.openvibe.link';

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/**
 * o: title, description, body (trusted HTML), viewer, config, path, active, robots, canonical, jsonLd
 */
function layout(o) {
    const config = o.config || { baseUrl: API_BASE };
    const signedIn = o.viewer && o.viewer.kind === 'user';
    const pathNow = o.path || '/';
    const active = o.active || pathNow;
    const canonical = o.canonical === undefined ? `${String(config.baseUrl).replace(/\/+$/, '')}${pathNow.split('?')[0]}` : o.canonical;
    const navbar = {
        service: 'connect',
        // Connect.OpenVibe.Link, the way the navbar names every product on a subdomain (Bench.OpenVibe.Services).
        // With tldLabel 'Connect' the host's own "connect" was added in front: "Connect.OpenVibe.Connect" (11-02).
        brand: { sub: 'connect', tld: 'link' },
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ ...l, active: l.href === active || (l.href !== '/' && pathNow.startsWith(`${l.href}/`)) })),
        appBar: [
            { label: 'Shares', href: '/', icon: 'plug' },
            { label: 'New', href: '/#new', icon: 'plus' },
        ],
        silentLogin: `${String(config.baseUrl).replace(/\/+$/, '')}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        tokenUrl: '/auth/navbar-token',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
        notificationsRealtime: true,
        history: { type: 'page', title: o.title || SITE_NAME },
    };
    const footer = { service: 'connect', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME };
    return shell.page({
        name: SITE_NAME,
        lang: 'en',
        title: o.title || `${SITE_NAME}: ${TAGLINE}`,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : '',
        siteName: SITE_NAME,
        description: o.description || `${SITE_NAME}: ${TAGLINE} Share one port on your computer at its own address, behind OpenVibe sign-in.`,
        canonical,
        robots: o.robots || (o.index ? 'index, follow' : 'noindex, follow'),
        jsonLd: (o.jsonLd || [seo.jsonLd.website({ name: SITE_NAME, url: `${config.baseUrl}/`, description: `${SITE_NAME}: ${TAGLINE}` })]).filter(Boolean),
        home: '/',
        navLinks: NAV,
        navbar,
        footer,
        head: `${appIcon.headTags({ site: 'website' })}
<link rel="stylesheet" href="${esc(ovServe.url('kit.css'))}">
<link rel="stylesheet" href="${esc(ovServe.url('room.css'))}">
<link rel="stylesheet" href="${esc(ovServe.url('showcase.css'))}">
<link rel="stylesheet" href="${asset('css/connect.css')}">
<script src="${asset('js/connect.js')}" defer></script>
<script src="${esc(ovServe.url('kit-web.js'))}" defer></script>
<script src="${esc(ovServe.url('motion.js'))}" defer></script>
<meta name="ov-boost" content="connect@${esc(RELEASE)}">`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<noscript><div class="account-bar" role="navigation" aria-label="Account">${signedIn
    ? `Signed in as <strong>${esc(o.viewer.displayName || o.viewer.username || 'you')}</strong>`
    : '<a href="/auth/login">Sign in with OpenVibe</a>'}</div></noscript>
<main id="main" class="cn ov-room" style="${rooms.style('website')}">${o.body}</main>
<script>window.__OV_PAGE = ${JSON.stringify({ navbar, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () { try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the Frame is optional */ } });</script>`,
    });
}

/** Send a page; a page rendered for a signed-in person is private and never cached. */
function send(res, status, o) {
    const personal = o.viewer && o.viewer.kind === 'user';
    if (!res.get('Cache-Control')) res.set('Cache-Control', personal ? cache.htmlHeaders({ private: true }) : (o.cache || cache.htmlHeaders({ public: true, maxAge: 60 })));
    res.set('Vary', 'Cookie');
    res.status(status).type('html').send(layout(o));
}

module.exports = { layout, send, renderPage: layout, asset, assetVersion, setRelease, SITE_NAME, MENU_NAME, TAGLINE, NETWORK_URL, NAV, API_BASE };
