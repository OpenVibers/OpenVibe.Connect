'use strict';
// openvibe-sdk/site (0.174.0) is the one implementation every site shares (the consolidation of 2026-11-16).
// GET /openapi.json (SEO-3), read from the routes the app really mounts.
const { mountPathOf, openapiRoute, routesOf, summariesFrom } = require('openvibe-sdk/site');

module.exports = { mountPathOf, openapiRoute, routesOf, summariesFrom };
