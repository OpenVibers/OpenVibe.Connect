# Changelog

What changed in OpenVibe Connect, newest first.

## Unreleased — 2026-11-03

- MCP OAuth 2.1 (CON-16): a share's address works as a connector in Claude or any MCP client. The client is sent to
  Connect to sign the person in with OpenVibe: protected-resource metadata on the share, then registration, authorize
  with PKCE S256 and consent, then tokens bound to that share and rotated on refresh. The owner sees and signs out each
  app (`server/oauth.js`, `server/http/oauth-routes.js`, migration `0010_share_oauth`).

- API keys, v1 (CON-16): a key may have a daily quota (`per_day`, UTC days, kept across restarts; over it, 429
  `key_daily_quota` until midnight UTC), and the share page shows what each key did today: its requests, the MCP tools
  it called and the models it asked for, by name and count (migration `0009_share_api_key_usage`).

## 0.1.0 — 2026-11-02

The first version (Website Connect v0, plan 2026-10-28 §5.9b; ADR-057 as reviewed 2026-11-02, OQ-13): your
computer, on the web, privately.

- **Shares.** A person makes a share (a name and a local port) and it answers at
  `https://<name>--<user>.openvibe.website`. OpenVibe.Space's site names can never contain "--", so the two never
  meet. Five open shares per person; a closed share keeps its address.
- **The client.** `public/ov-connect.js`: one file, Node 22+, no dependencies. It opens one outgoing WebSocket to
  `wss://connect.openvibe.website/tunnel` (through Cloudflare on 443), says hello with the share's key, and carries
  requests to `localhost:<port>`: HTTP with streaming bodies both ways, server-sent events, and WebSocket upgrades as a
  byte pipe. It reconnects after sleep, stops on a wrong key or a closed share, and a newer client takes over.
- **The gate.** Every visitor signs in with OpenVibe: `/grant` checks the share's policy (only me, me and named
  people, anyone signed in) and hands the share host a one-time code; the host sets its own `__Host-ovc` cookie.
  Changing who may open it signs everyone out of that share.
- **What the app gets.** Host `localhost:<port>`, the share's host in X-Forwarded-Host, the visitor in
  X-OpenVibe-User and X-OpenVibe-Subject; never the gate's cookie. Set-Cookie loses its Domain; nothing is cached by
  Cloudflare.
- **Pages and API.** The front door (sc.room), your shares and the form, a share's page (connected or not, who may
  open it, who did in 7 days, a new key, closing), and `/api/v1/shares` for a person's token.
- **Account export and deletion** (ADR-033): shares (without the key hash) and visits.
- **Checks:** the pure rules, the pages, sign-in, account data, and a share end to end through a real client and a
  real local app.
