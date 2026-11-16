'use strict';
// openvibe-sdk/site (0.174.0) is the one implementation every site shares (the consolidation of 2026-11-16).
// The Network's signing key; this file stays for one release so nothing that requires it changes.
const site = require('openvibe-sdk/site');

module.exports = { createKeyStore: (o = {}) => site.createKeyStore({ name: 'OpenVibe.Connect', ...o }), jwksUrl: site.jwksUrl };
