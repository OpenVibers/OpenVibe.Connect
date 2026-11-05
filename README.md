# OpenVibe Connect

**Your computer, on the web, privately.** Share one port on your computer at its own HTTPS address,
`https://<name>--<you>.openvibe.website`, and only the people you pick can open it, signed in with OpenVibe. No router
settings, no open ports, no app to install: one file and Node.

Live at **[connect.openvibe.website](https://connect.openvibe.website)**. Part of openvibe.website: Connect is the
"your machine" half; [OpenVibe.Space](https://openvibe.space) builds and hosts sites.

## Use it

1. Sign in at connect.openvibe.website and make a share: a name (`agents`), the port on your computer (`8790`), and
   who can open it.
2. On your computer (Node 22 or newer):

   ```bash
   curl -fsSLO https://connect.openvibe.website/ov-connect.js
   node ov-connect.js --key ovc_… --port 8790
   ```

3. Open `https://agents--you.openvibe.website` anywhere, on a phone over 5G included, and sign in.

The client opens one outgoing connection, so it works behind any router or hotspot, and it reconnects by itself. It
only ever connects to `localhost` on the port you gave it.

### From a computer with OpenVibe Node (no key)

A computer you added on [openvibe.bot/machines](https://openvibe.bot/machines) runs OpenVibe Node and has its own
OpenVibe sign-in. On the share's page, pick it under "Or serve it from one of your computers", then on that computer:

```bash
openvibe-node share --share shr_…                # serve it now
sudo openvibe-node share add --share shr_…       # or keep it up with the Node service
```

There is no key to copy. The computer proves itself twice at every connection: with its Network node token (subject
`node:nod_…`, audience `openvibe.website`, 5 minutes) and with a tunnel token Connect gives it for that one share (60
seconds, one use). It sends a fresh node token before the old one runs out, so a computer removed on OpenVibe stops
serving within about five minutes. While a computer serves a share, the share's key does not work; "Use a connect key
instead" lets the computer go and shows a new key once (ADR-057 decision 4, CON-4).

### Webhooks that wait for your computer

On a share's page, "Make a webhook address" gives you `https://connect.openvibe.website/h/hk_…` and a path on your app
(`/webhooks/github`). Give that address to GitHub, Stripe or anything else that sends webhooks. Each webhook is kept for
up to 7 days and handed to your app, at that path, as soon as your computer is connected, so a laptop that sleeps
misses nothing (CON-15, ADR-057 decision 7):

- The address takes POST, PUT and PATCH, up to 1 MB and 120 a minute, and answers `202` at once.
- Connect keeps the method, the provider's headers (`content-type`, `user-agent`, `x-…`, `stripe-signature`,
  `svix-…`, `webhook-…`; never cookies, authorization or forwarding headers) and the body. It publishes only a
  pointer, `connect.hook.received`, to OpenVibe.Events, in the same transaction.
- The moment the computer connects, Connect hands it every webhook that waited, oldest first. Events also delivers the
  pointer back to Connect's own subscription, retried for about seven days, which finds it settled. Connect hands the
  webhook to your app with `x-openvibe-hook` and `x-openvibe-event-id` (dedupe on it). Your app's answer below 500 settles it, and
  its body is dropped. While the computer is offline, or the app answers 5xx, Connect says 503 and Events tries again.
- Nobody signs in to send a webhook, so check the provider's own signature in your app.

| Call | What |
|---|---|
| `GET /api/v1/shares/:id/hooks` | its webhook addresses, with `received`, `delivered` and `waiting` |
| `POST /api/v1/shares/:id/hooks` `{ path, label? }` | a new address → `201 { hook }` (at most 10 a share) |
| `DELETE /api/v1/shares/:id/hooks/:hook` | remove it; webhooks still waiting are dropped |

## What your app sees

- `Host: localhost:<port>`; the share's address in `X-Forwarded-Host`; `X-Forwarded-Proto: https`.
- Who the visitor is: `X-OpenVibe-User` (their username) and `X-OpenVibe-Subject` (their OpenVibe subject id).
  A visitor cannot send these themselves.
- The visitor's cookies for your share's address, never the gate's own cookie.
- WebSockets and server-sent events work. Request bodies up to 100 MB.

## Who can open a share

| Mode | Who |
|---|---|
| `owner` (default) | only you |
| `named` | you and the OpenVibe usernames you list |
| `signin` | anyone signed in to OpenVibe (OpenVibe staff only until the abuse check is in, as with Space's public publishing) |

Public shares (no sign-in) come once the abuse check and openvibe.website's entry in the Public Suffix List are in
(ADR-057, CON-9 and CON-21). Changing who can open a share signs everyone out of it.

Anyone can report a share at [/report](https://connect.openvibe.website/report) (CON-9 v0): its address, what is
wrong and what they saw. OpenVibe staff read the open reports at `/admin/reports` and can close a share; its computer
is disconnected and its address then says it was closed after a report. A report keeps the reporter's account only
when they were signed in, never an address.

Connect also checks each share itself, once a day, a little after its computer connects (CON-9, the signed probe). It
reads the share's front page through the tunnel with an `x-openvibe-probe: t=<unix>,v1=<hmac>` header, so your app can
tell the request is Connect's, and looks for the signs of a credential trap: a password, card or wallet-phrase field on a
page that names a brand (PayPal, Google, a bank…), or one with an urgent "verify your account" story. A page that looks
like one becomes an automatic report for staff; Connect never closes a share by itself here, and nothing of the page is
kept beyond the report's one line. An ordinary sign-in page for your own app is not reported.

### API keys for programs (CON-16)

A program can call a share without signing in: on the share's page, make an **API key** (a name and how many requests a
minute it may make, 60 by default), and send it as `Authorization: Bearer ovsk_…`. That is how a model on your
computer (Ollama, llama.cpp's server, anything OpenAI-compatible) or an API of yours is called from a script, an editor or
another app:

```
curl -H "Authorization: Bearer ovsk_…" https://llm--you.openvibe.website/v1/models
```

- **A key opens the share's API, never its pages.** An HTML answer to a key is refused at the edge (406), so a key
  posted in public cannot turn a share into a public website past the sign-in gate. A browser still signs in.
- **Your app never sees the key.** The edge drops it; your app sees `X-OpenVibe-Subject: key:<sak_…>` and
  `X-OpenVibe-User: key: <name>`.
- **A wrong, revoked or other share's key is 401**, never a redirect to sign in. Over its rate a key gets 429 with
  `Retry-After: 60`; the share's own limits still apply.
- Only the key's hash is kept and it is shown once. At most ten live keys a share; revoking one stops it at once, and
  closing the share stops them all. WebSocket upgrades take a key too.
- **A daily quota (v1).** A key may also have a number of requests a day (`per_day`, optional), counted in UTC days and
  kept in the database, so a restart does not reset it. Over it, a key gets 429 `key_daily_quota` with `Retry-After`
  until midnight UTC.
- **What each key did today (v1).** The share page and the list show each key's requests today (against its quota)
  and what it used: the MCP tools it called (JSON-RPC `tools/call`, by name, a batch counting each) and the models it
  asked for (an OpenAI- or Ollama-style `"model"` on a model path such as `/v1/chat/completions` or `/api/generate`).
  The edge reads the first 64 KB of a key's JSON POST for those names; names and counts are kept, never arguments,
  prompts or bodies.
- API: `GET`, `POST /api/v1/shares/:id/api-keys` (`{ name, per_minute, per_day }` → `{ api_key, key }`, the key once;
  the list adds `today` and `used: [{ what, n }]`) and `DELETE /api/v1/shares/:id/api-keys/:sak_id`. Cases:
  `test/api-keys.test.js`, `test/api-key-quotas.test.js`.

### Claude and other MCP clients (CON-16, MCP OAuth 2.1)

If what you share is an MCP server, its address works as a connector URL in Claude or any MCP client
(`https://tools--you.openvibe.website/mcp`). The client signs the person in with OpenVibe, with no key to paste:

1. The share answers a program that has no credentials `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://<share>/.well-known/oauth-protected-resource"`. That document
   (RFC 9728) names Connect as the authorization server. Connect's metadata (RFC 8414) is at
   `/.well-known/oauth-authorization-server`.
2. The client registers itself (`POST /oauth/register`, RFC 7591). Only public clients with PKCE are accepted, and their
   redirect URIs must be https, or http on a loopback address for a desktop app.
3. `GET /oauth/authorize` with `resource=<the share's address>` (RFC 8707) and an S256 challenge. The person signs in,
   the share's own rule decides whether they may, and they consent on Connect. An unknown client or redirect URI gets
   a page, never a redirect.
4. `POST /oauth/token` swaps the code (60 seconds, used once) and verifier for an access token (`ovat_…`, an hour) bound
   to that share, and a refresh token (`ovrt_…`, 30 days). Each refresh rotates both; the old pair stops.

The edge takes `Authorization: Bearer ovat_…` as the person who consented. The app sees `X-OpenVibe-Subject` and
`X-OpenVibe-User` as for a signed-in visitor, never the token. A policy change, the owner signing the app out (on the
share's page, under "Use it from Claude and other MCP clients") or the share closing stops every token. Only hashes are
kept. Cases: `test/mcp-oauth.test.js`.

## API

With a person's OpenVibe token as a Bearer (or the session on connect.openvibe.website):

| Call | What |
|---|---|
| `GET /api/v1/shares` | your shares, with `connected` |
| `POST /api/v1/shares` `{ label, port, mode?, named?, expires_in? }` | make one → `201 { share, key }` (the key is in this answer only); `expires_in` (600 s to 30 days) closes it by itself |
| `GET /api/v1/shares/:id` | one share |
| `PATCH /api/v1/shares/:id` `{ mode?, named?, port?, note?, expires_in? }` | change it; `expires_in: null` keeps it open until you close it |
| `DELETE /api/v1/shares/:id` | close it (410 from then on) |
| `POST /api/v1/shares/:id/key` | a new key → `{ share, key }`; the connected computer is disconnected |
| `GET /api/v1/shares/:id/visits` | who opened it in the last 7 days |
| `GET /api/v1/shares/:id/requests` `?after=<seq>` | the last 100 requests through it, newest first (the inspector, below) |
| `GET /api/v1/machines` | your computers that can serve a share (OpenVibe Node, from Network) |
| `PUT /api/v1/shares/:id/node` `{ node: 'nod_…' \| null }` | one of your computers serves it (the key stops working) → `{ share }`; `null` lets it go → `{ share, key }` |

A computer, with its Network node token (audience `openvibe.website`) as a Bearer:

| Call | What |
|---|---|
| `GET /api/v1/node/shares` | the open shares this computer serves: `id`, `host`, `url`, `local_port`, `mode` |
| `POST /api/v1/node/shares/:id/tunnel-token` | `{ tunnel_token, expires_in: 60, share }`, for one hello on `/tunnel`: `{ t: 'hello', v: 1, share, node_token, tunnel }`, then `{ t: 'reauth', node_token }` before the node token runs out |

## How it works

```
browser ──https──▶ Cloudflare ──▶ nginx ──▶ Connect (5240) ══ WebSocket (ovconnect-ws/1) ══▶ ov-connect.js ──▶ localhost:<port>
                                            gate: /grant → one-time code → __Host-ovc
```

- `server/shares.js` — shares, names, keys (hashed), policies, counters.
- `server/edge/tunnels.js` — the computers' WebSockets (`/tunnel`), one per share; a newer one takes over.
- `server/edge/frames.js` — the wire format: JSON control messages, binary data frames per stream.
- `server/edge/gate.js` — the one-time codes and the signed host-only cookie.
- `server/edge/proxy.js` — a visitor's request on a share host: the gate, then the tunnel, streaming both ways.
- `server/edge/inspector.js` — the share page's Requests list (CON-8 v0): the last 100 requests per share, in memory
  only, with the method, the path (query values shown as "…"), status, time, bytes and the visitor's name. No headers,
  no bodies; a restart forgets them.
- `server/auth/node-auth.js` — a computer as OpenVibe Node: its node token, and the single-use tunnel tokens (CON-4).
- `server/machines.js` — the owner's computers, read from Network with the owner's own token.
- `server/hooks.js`, `server/http/hooks.js` — webhook addresses, the kept webhooks, and Events' deliveries (CON-15).
- `public/ov-connect.js` — the client.

The v0 transport is a WebSocket on 443 through Cloudflare (ADR-057's fallback path), so nothing needs a UDP port or a
record that shows the origin. The QUIC edge, TCP/UDP shares, custom domains, the private mesh and durable webhooks
are the next steps (CON-3, CON-7, CON-11 to CON-15).

## Run it

```bash
npm install
npm run dev            # PGlite under data/pglite, http://localhost:5240
npm test               # every file on PGlite
npm run test:pg        # the same on the PostgreSQL + PgBouncer containers
```

Environment: `.env.example`. Production: `/etc/openvibe/connect.env`, unit `openvibe-connect`, vhost
`deploy/nginx/connect.openvibe.website.conf`.

## License

AGPL-3.0-only. The client (`public/ov-connect.js`) is part of this repository under the same license.

<!-- versions:start -->
- openvibe-contracts: v0.289.1
- openvibe-sdk: v0.82.0
- openvibe-shared: v4.109.2
<!-- versions:end -->
