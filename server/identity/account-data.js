'use strict';

/**
 * Account export and deletion → Connect (ADR-033; openvibe-sdk/account-data). A person owns their shares and their own
 * visits to other people's shares (one row per share and day: a count, never a path or an address).
 *
 * Erasing deletes both: the shares go (and with them their visit rows, ON DELETE CASCADE), so their addresses answer
 * "no share here" and a connected computer can no longer serve them. The export leaves out key_hash: it is the
 * hash of a random key, nothing a person can use, and it is not theirs to carry elsewhere.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'share_visits', subject: 'subject', value: (usr) => usr, file: 'visits.json', erase: 'delete' },
    // "Tell me when it's back" (CON-17): the shares a person waits on, until told.
    { table: 'share_waiters', subject: 'subject', value: (usr) => usr, file: 'waiting.json', erase: 'delete' },
    // Reports a person made (CON-9): exported; on erasure the report stays (a share may have been closed on it) and
    // the account is taken off it.
    { table: 'share_reports', subject: 'reporter_subject', value: (usr) => usr, file: 'reports.json', erase: { anonymize: {} },
        columns: ['id', 'host', 'reason', 'details', 'status', 'created_at'] },
    // Webhook addresses on a person's shares (CON-15). Their waiting webhooks (hook_requests) go with them, and with
    // the shares (ON DELETE CASCADE); the export names the addresses and their counts, never a webhook's body.
    { table: 'share_hooks', subject: 'owner_subject', value: (usr) => usr, file: 'webhooks.json', erase: 'delete',
        columns: ['id', 'share_id', 'label', 'local_path', 'status', 'created_at', 'removed_at', 'received', 'delivered', 'last_received_at', 'last_delivered_at', 'last_status'] },
    {
        table: 'shares', subject: 'owner_subject', value: (usr) => usr, file: 'shares.json', erase: 'delete',
        columns: ['id', 'owner_username', 'label', 'host', 'local_port', 'mode', 'named', 'status', 'policy_version', 'key_prefix', 'note',
            'node_id', 'node_name', 'created_at', 'updated_at', 'revoked_at', 'last_connected_at', 'last_visit_at', 'requests', 'bytes_in', 'bytes_out'],
    },
];

function create({ db, log = console } = {}) {
    return createAccountData({
        db,
        service: 'connect',
        tables: TABLES,
        note: 'Your shares on OpenVibe Connect, their webhook addresses, and your visits to other people\'s shares. Connect never stores what passed through a share; a webhook to one of your addresses is kept only until your computer takes it, at most 7 days.',
        log,
    });
}

module.exports = { create, TABLES, TOPICS };
