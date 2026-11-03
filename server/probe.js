'use strict';

/**
 * The signed probe (CON-9, the abuse gate before public shares, ADR-057 decision 6). When a share's computer connects,
 * at most once a day, Connect reads the share's front page itself, through the tunnel, with a signed
 * `x-openvibe-probe: t=<unix>,v1=<hmac>` header so the app can tell it is Connect. It looks for the signs of a credential
 * trap: a password, card or wallet-phrase field on a page that names a brand the share is not. A page that looks like
 * one becomes an automatic report for OpenVibe staff (/admin/reports). Connect never closes a share by itself here: a
 * person decides. Nothing of the page is kept beyond the report's one-line reason.
 *
 *   assess(html, share) → { verdict: 'ok' | 'review', flags: [..], brands: [..], why }
 *   createProbe({ shares, proxy, config, log, now }).run(share) → the assessment, or null when it did not run
 *   signature(shareId, secret, t) → the header value
 */
const crypto = require('crypto');

const DAY_MS = 86400_000;
// Brands people are tricked into signing in to. Matched as whole words in the page's title, headings, labels and
// buttons, never in a share's own address (a share named "paypal-demo" by its owner is still flagged: staff decide).
const BRANDS = ['paypal', 'google', 'gmail', 'microsoft', 'outlook', 'office 365', 'apple', 'icloud', 'amazon', 'facebook',
    'instagram', 'netflix', 'steam', 'discord', 'twitch', 'coinbase', 'binance', 'metamask', 'chase', 'wells fargo',
    'bank of america', 'citibank', 'hsbc', 'barclays', 'santander', 'dhl', 'fedex', 'ups', 'usps', 'irs', 'openvibe'];
const textOf = (html) => String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').toLowerCase();
const visibleBits = (html) => {
    const pick = (re) => [...String(html || '').matchAll(re)].map((m) => m[1]).join(' ');
    return [pick(/<title[^>]*>([\s\S]*?)<\/title>/gi), pick(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi), pick(/<label[^>]*>([\s\S]*?)<\/label>/gi),
        pick(/<button[^>]*>([\s\S]*?)<\/button>/gi), pick(/\b(?:placeholder|aria-label|alt|value)\s*=\s*"([^"]{1,120})"/gi)]
        .join(' ').replace(/<[^>]+>/g, ' ').toLowerCase();
};

function assess(html, share = {}) {
    const raw = String(html || '');
    const flags = [];
    if (/<input[^>]+type\s*=\s*["']?password/i.test(raw) || /autocomplete\s*=\s*["']?(?:current|new)-password/i.test(raw)) flags.push('password_field');
    if (/autocomplete\s*=\s*["']?cc-(?:number|csc|exp)/i.test(raw) || /\b(?:card number|cvv|cvc|security code)\b/i.test(textOf(raw))) flags.push('card_field');
    if (/\b(?:seed phrase|recovery phrase|secret phrase|12[- ]word|24[- ]word|private key|mnemonic)\b/i.test(textOf(raw))) flags.push('wallet_phrase');
    if (/\b(?:verify your account|account (?:has been )?(?:suspended|locked|limited)|unusual (?:sign-?in|activity)|confirm your identity)\b/i.test(textOf(raw))) flags.push('urgency');
    const bits = visibleBits(raw);
    const brands = BRANDS.filter((b) => new RegExp(`\\b${b.replace(/ /g, '\\s+')}\\b`, 'i').test(bits));
    const asks = flags.some((f) => f === 'password_field' || f === 'card_field' || f === 'wallet_phrase');
    // A sign-in or payment form is ordinary (people share their own apps). It is worth a person's look when it names a
    // brand, or when it pairs a secret field with an urgent "verify your account" story.
    const review = asks && (brands.length > 0 || flags.includes('urgency') || flags.includes('wallet_phrase'));
    const why = review
        ? `Automatic check: the front page asks for ${flags.filter((f) => f !== 'urgency').map((f) => ({ password_field: 'a password', card_field: 'card details', wallet_phrase: 'a wallet phrase' }[f])).join(' and ')}${brands.length ? ` and names ${brands.slice(0, 3).join(', ')}` : ''}${flags.includes('urgency') ? ', with an urgent account warning' : ''}.`
        : null;
    return { verdict: review ? 'review' : 'ok', flags, brands, why };
}

function signature(shareId, secret, t = Math.floor(Date.now() / 1000)) {
    const mac = crypto.createHmac('sha256', String(secret || '')).update(`${t}.${shareId}`).digest('hex');
    return `t=${t},v1=${mac}`;
}

function createProbe({ shares, proxy, config, log = console, now = () => Date.now() }) {
    const last = new Map();   // share id → when it was last probed (in memory: a restart probes again, which is fine)
    const base = (config.shares && config.shares.sessionSecret) || (config.session && config.session.secret) || '';
    const secret = `probe:${base}`;

    async function run(share, { force = false } = {}) {
        if (!share || share.status !== 'active') return null;
        const at = last.get(share.id) || 0;
        if (!force && now() - at < DAY_MS) return null;
        last.set(share.id, now());
        if (last.size > 10000) last.delete(last.keys().next().value);
        const out = await proxy.fetchThrough(share, { path: '/', headers: [['x-openvibe-probe', signature(share.id, secret, Math.floor(now() / 1000))], ['user-agent', 'OpenVibeConnectProbe/1 (+https://connect.openvibe.website/report)']] });
        if (!out || out.offline || out.error || !out.body) return null;
        if (!/html/i.test(out.type || '') && !/<html|<form/i.test(out.body.toString('utf8', 0, 2048))) return { verdict: 'ok', flags: [], brands: [], why: null };
        const a = assess(out.body.toString('utf8'), share);
        if (a.verdict === 'review') {
            try {
                await shares.report({ host: share.host, reason: 'phishing', details: a.why, reporter: null });
                log.warn(`[OpenVibe.Connect] probe: ${share.host} sent to staff review (${a.flags.join(', ')}${a.brands.length ? `; ${a.brands.join(', ')}` : ''})`);
            } catch (err) { log.warn('[OpenVibe.Connect] probe report not filed:', err.message); }
        }
        return a;
    }

    return { run };
}

module.exports = { assess, signature, createProbe, BRANDS };
