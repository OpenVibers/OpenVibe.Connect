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
    {
        table: 'shares', subject: 'owner_subject', value: (usr) => usr, file: 'shares.json', erase: 'delete',
        columns: ['id', 'owner_username', 'label', 'host', 'local_port', 'mode', 'named', 'status', 'policy_version', 'key_prefix', 'note',
            'created_at', 'updated_at', 'revoked_at', 'last_connected_at', 'last_visit_at', 'requests', 'bytes_in', 'bytes_out'],
    },
];

function create({ db, log = console } = {}) {
    return createAccountData({
        db,
        service: 'connect',
        tables: TABLES,
        note: 'Your shares on OpenVibe Connect and your visits to other people\'s shares. Connect never stores what passed through a share.',
        log,
    });
}

module.exports = { create, TABLES, TOPICS };
