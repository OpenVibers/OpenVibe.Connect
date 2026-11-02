'use strict';

/**
 * OpenVibe notifications from Connect (CON-17, "tell me when it's back"): one notification, pushed as service connect
 * (POST /internal/notifications/push, contracts network.notification-push-request@1, capability
 * network.notifications.push, Network namespace connect), addressed by the person's usr_ subject.
 *
 * Best effort: off without a client secret, never retried, and a failure never touches a share. → { sent, reason? }
 */
const { serviceAuth } = require('openvibe-contracts');

const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createNotifier({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = config.networkInternalUrl;
    const enabled = Boolean(base && config.oauth && config.oauth.clientSecret);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'network.notifications.push', fetchImpl,
    }) : null;

    async function push(subject, body) {
        if (!enabled) return { sent: false, reason: 'off' };
        if (!SUBJECT.test(String(subject || ''))) return { sent: false, reason: 'bad_subject' };
        try {
            const res = await fetchImpl(`${base}/internal/notifications/push`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) },
                body: JSON.stringify({ ...body, subject, service: 'connect' }),
                signal: AbortSignal.timeout(10_000),
            });
            return res.ok ? { sent: true } : { sent: false, reason: `network_${res.status}` };
        } catch (err) {
            log.warn(`[OpenVibe.Connect] notification not sent: ${(err && err.message) || err}`);
            return { sent: false, reason: 'error' };
        }
    }

    /** The share's computer is back: tell one person who asked. */
    async function shareBack(subject, share) {
        return push(subject, {
            category: 'service', icon: '🔌', title: `${share.host} is back`,
            message: `${share.owner_username}'s computer is connected again. Open it while it is.`, url: share.url,
        });
    }

    return { push, shareBack, enabled };
}

module.exports = { createNotifier };
