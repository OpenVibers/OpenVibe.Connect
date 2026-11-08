'use strict';
// What OpenVibe Connect tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json (SEO-2).
// Every field is something this site really serves; the purpose is its own llms.txt summary.
module.exports = {
    id: "connect",
    name: "OpenVibe Connect",
    purpose: "Share one port on your computer at https://<name>--<username>.openvibe.link, behind OpenVibe sign-in; programs pass with a share's API key, MCP clients sign in with OAuth.",
    home: "https://connect.openvibe.link",
    site: "connect.openvibe.link",
    api: "/api/v1",
    openapi: '/openapi.json',
    policy: {
        auth: ["Network OIDC"],
    },
};
