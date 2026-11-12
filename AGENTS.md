# AGENTS.md — OpenVibe.Connect

## Project overview

"Your computer, on the web, privately." Connect gives one port on a person's computer its own HTTPS
address, `https://<name>--<you>.openvibe.link`, visible only to the people the owner picks, signed in
with OpenVibe. A small Link client opens one outgoing WebSocket (the tunnel), so no router setting or
open port is needed; Connect terminates TLS, runs the gate and proxies to the app through the tunnel.
Node.js/Express + `ws`, PostgreSQL, CommonJS, **no build step**.

- Canonical origin `https://connect.openvibe.link`; the old `*.openvibe.website` addresses redirect.
  Share hosts are `<label>--<user>.openvibe.link` (a regex vhost).
- Port `5240`, unit `openvibe-connect.service`, release root `/opt/openvibe.connect`.
- Design: ADR-057 in OpenVibe.Contracts; CON-4/CON-16 are the Link and MCP decisions.

## What it owns

- Shares (a port, a name, an audience rule), their aliases and their lifecycle; the `shr_` id and the
  one-time `ovc_` connect key.
- The gate (who may open a share: owner, named people, signed-in, public), the tunnel registry, the
  edge proxy (HTTP, WebSocket, SSE, 100 MB bodies) and the inspector.
- A computer as an **OpenVibe Link** endpoint (`/api/v1/link/*`, node tokens, `openvibe-link share`),
  the `link.egress` relay and the party desktop grant.
- Project webhooks that wait for a computer (`server/hooks.js`), API keys for programs (`ovk_`/…, with
  quotas) and the MCP OAuth 2.1 authorization server for shares that are MCP servers.
- Pages, `/ov-connect.js` (the client, served as-is), `/openapi.json`, `/llms.txt`, agent descriptor,
  `robots.txt`, `sitemap.xml`, `/release.json`, health/ready, `/metrics` (loopback only).
- Its own PostgreSQL database (ADR-035; migrations applied at boot) and the `connect.*` events.

Not owned: the tunnel's app (the person's own server), the Link machine/plugins (OpenVibe.Link),
identity (Network), the sites Space builds and hosts (Space).

## Who calls it, and whom it calls

- Callers: people in the browser; the Link client on a person's computer (`/tunnel`); OpenVibe Link's
  share commands; MCP clients (Claude and others) through the OAuth flow; other services through the
  API with a Network service token and `connect.*`.
- Depends on: **Network** (SSO with PKCE, JWKS, node tokens for Link machines,
  `identity.subject.resolve`), **Events** (outbox; account export/deletion), and the person's
  computer over the tunnel. There is no Media/AI/Live dependency in the serving path.
- What the app behind a share sees: `Host: localhost:<port>`, `X-Forwarded-Host`, `X-Forwarded-Proto:
  https`, `X-OpenVibe-User` and `X-OpenVibe-Subject` (set by the edge, never forwardable by a visitor),
  the visitor's cookies for that share, WebSockets/SSE, bodies up to 100 MB.

## Repository map

- **Entry:** [server/index.js](server/index.js) — `createApp()`, HTTP listen, `/tunnel` upgrade;
  lifecycle closes tunnels, proxy, gate, keys and telemetry.
- **App:** [server/app.js](server/app.js) — the share-host branch comes **first** (gate → tunnel →
  proxy), then `/`, `/shares/*`, `/grant`, `/api/v1/link/*`, `/api/v1/*`, `/ov-connect.js`, `/auth`,
  `/internal/events`, machine endpoints, `/tunnel`.
- **Config/db:** [server/config.js](server/config.js), [server/db.js](server/db.js).
- **Shares/gate/tunnel:** [server/shares.js](server/shares.js), [server/edge/gate.js](server/edge/gate.js),
  [server/edge/tunnels.js](server/edge/tunnels.js), [server/edge/proxy.js](server/edge/proxy.js),
  [server/edge/inspector.js](server/edge/inspector.js), [server/edge/frames.js](server/edge/frames.js).
- **Link:** [server/auth/link-auth.js](server/auth/link-auth.js), [server/machines.js](server/machines.js),
  [server/link-egress.js](server/link-egress.js), [server/http/link-api.js](server/http/link-api.js),
  [server/party-grants.js](server/party-grants.js).
- **Programs:** [server/api-keys.js](server/api-keys.js), [server/oauth.js](server/oauth.js),
  [server/http/oauth-routes.js](server/http/oauth-routes.js), [server/hooks.js](server/hooks.js),
  [server/http/hooks.js](server/http/hooks.js).
- **Pages/render:** [server/http/pages.js](server/http/pages.js), [server/views/index.js](server/views/index.js),
  [server/render/layout.js](server/render/layout.js), [public/js/connect.js](public/js/connect.js).
- **Client:** [public/ov-connect.js](public/ov-connect.js) — a single file, no install.
- **Deploy:** [deploy/systemd/openvibe-connect.service](deploy/systemd/openvibe-connect.service),
  [deploy/nginx/connect.openvibe.website.conf](deploy/nginx/connect.openvibe.website.conf),
  [docs/link-share-rollout.md](docs/link-share-rollout.md).

## Commands

```bash
npm install
npm run dev                # NODE_ENV=development node server/index.js; PGlite under data/pglite
npm start                  # node server/index.js, http://127.0.0.1:5240
npm test                   # test/run.js, temp PGlite, mock Network
npm run test:pg            # same suite on PostgreSQL (CONNECT_TEST_STORE=pg)
npm test -- hooks          # filter by file name; --strict makes a skip fail
ov test                    # the harness's sharded run of what the change reaches
```

End-to-end from a computer: `node ov-connect.js --key ovc_… --port 8790`, or
`openvibe-link share --share shr_…` on a Link machine.

## Database and migrations

Connect's own PostgreSQL database (ADR-035), PGlite in development/tests. Async through
`openvibe-sdk/db`; migrations `migrations/NNNN_*.sql` are applied at boot — never edit an applied one,
add a new number. Only hashes of API keys, tunnel tokens and OAuth tokens are stored; a webhook body
is sealed at rest with a key derived from the service session secret and is never readable from the
database by a reader. Rows that a share/computer no longer needs are removed at expiry.

## Auth

- **People** sign in through Network SSO (PKCE, HttpOnly cookie). A share's rule decides whether a
  signed-in person may open it; the edge then sets `X-OpenVibe-User`/`X-OpenVibe-Subject`. The
  visitor's own `Authorization` is consumed at the edge, never forwarded.
- **Link machines** prove themselves twice at every connection: a Network node token
  (`link:lnk_…`, audience `openvibe.link`, 5 minutes) and a one-use tunnel token from Connect (60 s)
  for that share. A computer removed on Network stops serving within about five minutes because the
  node token is refreshed and checked.
- **MCP clients** use OAuth 2.1: `401` with RFC 9728 resource metadata, RFC 8414 server metadata,
  RFC 7591 dynamic registration (public clients + PKCE only; https or loopback redirect URIs),
  RFC 8707 `resource`, a 60-second one-use code and rotating `ovat_`/`ovrt_` tokens bound to the
  share. Unknown clients/redirects get a page, never a redirect.
- **API keys** for programs are shown once, stored hashed and carry quotas; a policy change, the owner
  signing the app out or closing the share stops every token.

## Frontend loading model

Server-rendered pages and plain forms; the only page script is [public/js/connect.js](public/js/connect.js).
`public/ov-connect.js` is the downloadable client and is served as-is. There is no SPA, bundler or
transpiler; `openvibe-shared` supplies the Frame, legal/SEO helpers and `/shared/*` from the pinned
node_modules.

## Deploy

Unit [deploy/systemd/openvibe-connect.service](deploy/systemd/openvibe-connect.service) runs
`/opt/openvibe.connect/server/index.js` on `127.0.0.1:5240`, env `/etc/openvibe/connect.env` (0600).
The vhost is the **combined** file
[deploy/nginx/connect.openvibe.website.conf](deploy/nginx/connect.openvibe.website.conf), installed
with `sudo ov-vhost-install …` and reloaded by that installer — it keeps both Website servers, the
exact Link control host and the `<label>--<user>.openvibe.link` regex, with HTTP/1.1 Upgrade,
streaming and no buffering. The repository does not document an `ovhost deploy connect` command; use
the host's normal service environment and the staged rollout in
[docs/link-share-rollout.md](docs/link-share-rollout.md). Do not install a second copy of the vhost
(its maps and rate-limit zones are declared once) and do not replace the Website certificate.

## Tests

`npm test` runs each `test/*.test.js` in its own process with a temp PGlite database, an in-process
Network mock and Chat/Live/Video fixtures. It covers share creation and the gate, both share aliases,
tunnel auth and revocation, the Link API and egress relay, API key quotas, MCP OAuth (metadata,
registration, PKCE, rotation), webhooks and their sealed bodies, the pages/llms/openapi, the nginx Link
rules and owner settings. `ov test` runs the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; factories with injectable config/db/clock/fetch/
  log; the edge has its own modules and must not import page code.
- Errors are problem+json on the API and small pages elsewhere; never echo an upstream app's body on a
  proxy error.
- Hostnames and origins are validated exactly: a share is `<label>--<user>.openvibe.link`
  (lowercase letters/digits/hyphens; a Space site name can never contain `--`).
- Secrets (connect keys, tunnel/OAuth tokens, webhook bodies) are shown once or sealed; never logged.

## Pitfalls

- **Order matters in the app:** the share-host branch must stay before every ordinary route, or a
  share can reach Connect's own pages/API.
- **The client only ever connects to `localhost`** on the port it was given; do not add a remote
  target.
- **A share key stops working while a Link computer serves the share**; "Use a connect key instead"
  lets the computer go and shows a new key once.
- **The tunnel token is one-use and 60 seconds**; the node token is 5 minutes and refreshed. Do not
  cache or log either.
- **`X-OpenVibe-User`/`X-OpenVibe-Subject` come from the edge only.** A visitor-supplied value must be
  stripped.
- **OAuth errors that must not redirect** (unknown client, bad redirect URI) render a page; never
  redirect.
- **One combined vhost only**; a second install duplicates maps/zones and breaks nginx.
- **100 MB bodies and WebSockets are part of the product**; a proxy change that buffers or caps them
  lower is a regression.
- **Store a webhook body sealed** and remove it at expiry; a plaintext copy is a bug.

## Documentation

- [README.md](README.md) — what a share is, the gate, Link, MCP OAuth, API and run instructions.
- [docs/link-share-rollout.md](docs/link-share-rollout.md) — the staged host rollout and commands.
- ADR-057 (Link shares) in OpenVibe.Contracts; CON-4/CON-16 track the work.
