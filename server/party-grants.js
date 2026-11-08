'use strict';
const crypto = require('crypto');

function verify(value, secret, now = Date.now()) {
    if (!secret || secret.length < 32 || typeof value !== 'string' || value.length > 4096) return null;
    const pieces = value.split('.');
    if (pieces.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(pieces[0]) || !/^[A-Za-z0-9_-]+$/.test(pieces[1])) return null;
    const expected = crypto.createHmac('sha256', secret).update(pieces[0]).digest('base64url');
    if (expected.length !== pieces[1].length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(pieces[1]))) return null;
    let claim;
    try { claim = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8')); } catch { return null; }
    if (!claim || !Number.isInteger(claim.exp) || claim.exp <= Math.floor(now / 1000) || claim.exp > Math.floor(now / 1000) + 120) return null;
    return claim;
}

module.exports = { verify };
