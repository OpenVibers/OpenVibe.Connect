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
- openvibe-contracts: v0.279.0
- openvibe-sdk: v0.82.0
- openvibe-shared: v4.106.1
<!-- versions:end -->
