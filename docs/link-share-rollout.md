# Connect shares on Link: Opus rollout

This PR makes no DNS, Cloudflare or host changes. Leave the four PRs for review. The operator must complete the
following stages in order; do not release the new Link audience before Network and Connect accept it.

## 1. Prepare trust and the dual-host service

Merge/release the Shared overlay fix and pin it in services that serve overlay.js before publishing share URLs on
Link. Both share domains are untrusted card sources and handoff destinations; Connect also denies framing at the
edge. Shared's new version is assigned by the normal release/pin process after review, not by these PRs.

Network adds the exact Connect callback `https://connect.openvibe.link/auth/callback` beside the existing Website
callback, preserving the credential and other registered callbacks. No wildcard callback is registered. It accepts
both node audiences (`openvibe.link`, `openvibe.website`), and only the Link apex and Connect control host receive
SSO trust. Its frame entry points at `connect.openvibe.link`; deploy Network only once that host is reachable (stage 3).

Initially deploy Connect with these non-secret overrides through the normal service environment mechanism:

```text
CONNECT_SHARE_DOMAIN=openvibe.website
CONNECT_SHARE_DOMAINS=openvibe.link,openvibe.website
CONNECT_REDIRECT_LEGACY=false
BASE_URL=https://connect.openvibe.website
OV_OAUTH_REDIRECT_URI=https://connect.openvibe.website/auth/callback
```

Migration 0015 keeps stored share hosts, IDs and connect keys intact, enforces uniqueness across aliases, and
backfills existing MCP sessions' exact host audience. Old browser gate cookies are intentionally invalidated once:
the visitor goes through Network sign-in again and receives a new host-bound, host-only cookie. Neither gate nor
control-panel cookies may have a Domain attribute. Never set a cookie on `.openvibe.link`.

## 2. DNS and certificates (operator only)

In Cloudflare's **openvibe.link** zone add these records, leaving apex/www records alone:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `connect` | Copy the **origin IPv4 value** of the existing `connect.openvibe.website` A record from its DNS dashboard | Proxied |
| CNAME | `*` | `connect.openvibe.link` | Proxied |

If the existing Connect origin is a CNAME rather than an A record, use that same origin CNAME target for `connect`.
Do not copy the public `dig` answer of a proxied host (it is a Cloudflare edge address). Leave existing Website
records in place. Enable WebSockets, use Full (strict) TLS, and apply the same cache bypass as Website to
`connect.openvibe.link` and `*--*.openvibe.link`; do not add a Cache Everything rule. Arbitrary non-share Link
subdomains have no Connect application route. No QUIC or DNS-only transport is introduced.

Expand the existing `/etc/letsencrypt/live/openvibe.link/` certificate to cover `openvibe.link`, `www.openvibe.link`,
and `*.openvibe.link`. Keep its existing automated DNS-01 renewal method if configured. An exact interactive
DNS-01 issuance command, if automation is unavailable, is:

```sh
sudo certbot certonly --manual --preferred-challenges dns --cert-name openvibe.link --expand \
  -d openvibe.link -d www.openvibe.link -d '*.openvibe.link'
```

Create each TXT record Certbot requests in Cloudflare (`_acme-challenge.openvibe.link` for apex/wildcard and
`_acme-challenge.www.openvibe.link` if requested for www; keep all simultaneously
requested values until validation finishes), then continue Certbot. This manual alternative requires a DNS hook
or manual renewal before expiry; preserve/configure automated DNS-01 renewal before considering rollout complete.
Do not replace the Website certificate. The Link certificate must exist **before** the combined vhost is installed.

## 3. Install the vhost and prove both names

From the reviewed/deployed **OpenVibe.Connect** checkout on openvibe-ovh run:

```sh
sudo ov-vhost-install deploy/nginx/connect.openvibe.website.conf connect.openvibe.website.conf
sudo nginx -t
```

The installer owns installation/reload. Do not install a second copy of this combined file: its maps and rate-limit
zones are declared once. The file retains both Website servers and adds the exact Link control host and a
`<label>--<user>.openvibe.link` regex, forwarding to `127.0.0.1:5240` with HTTP/1.1 Upgrade, streaming and no buffering.
The Link apex's Network vhost stays untouched. `/tunnel` works on either control hostname; HTTP control pages on
the noncanonical hostname 302 to BASE_URL, so callbacks and sessions are never split between control hosts.

Use an existing private share and a new test share to verify over Cloudflare, with redirects still disabled:

* Both share aliases reach the Network gate, preserve a deep path/query, and open after sign-in.
* A different user is denied unless explicitly named; revocation closes both aliases.
* Inspect each gate Set-Cookie: `__Host-ovc`, Secure, HttpOnly, SameSite=Lax, Path=/, **no Domain**. A cookie copied
  to the other alias or another share fails. Local-app cookies also have Domain stripped.
* GET, POST, SSE, and an authenticated WebSocket work on both hosts; responses bypass Cloudflare cache.
* The existing Link binary still connects, and the new audience works after deploying Network. MCP sessions
  keep their exact original host audience; changing alias requires authorization for that alias.
* `https://connect.openvibe.link/auth/health` (following the control redirect) passes and the old control host works.

## 4. Publish Link URLs, then redirect

Once both names work, deploy Network, then set/redeploy Connect with:

```text
CONNECT_SHARE_DOMAIN=openvibe.link
CONNECT_SHARE_DOMAINS=openvibe.link,openvibe.website
CONNECT_REDIRECT_LEGACY=false
BASE_URL=https://connect.openvibe.link
OV_OAUTH_REDIRECT_URI=https://connect.openvibe.link/auth/callback
```

Keep CONNECT_AUDIENCE at its existing service/admin value (`openvibe.website`); the node verifier separately
accepts both audiences, so owner configuration calls continue working.

The old control URL remains usable (HTTP pages redirect; tunnel upgrades remain direct). Both share aliases still
answer, while API/list/ready responses and `openvibe-link share` advertise Link. Verify sign-in on the new control
origin; its host-only cookie requires one fresh sign-in. Release Link after this stage.

After the new share URL is proved, set `CONNECT_REDIRECT_LEGACY=true` and redeploy Connect. Old share requests
receive **302**, preserving path and query exactly. Gate codes/cookies are never copied into the new host's session;
an in-flight old-host callback may require retrying sign-in. Legacy WebSocket upgrades also receive 302; clients
that do not follow upgrade redirects must reconnect at the Link URL. Existing tunnel connections use the same ID.
For APIs, 302 can change POST to GET in clients, so update callers to Link before enabling the switch.

Rollback without losing shares: set `CONNECT_REDIRECT_LEGACY=false`, keep both domains, and restore
`CONNECT_SHARE_DOMAIN=openvibe.website` / the Website BASE_URL and OAuth redirect. Keep the dual-audience server
versions and additive migration in place (new Link binaries need Link audience; old server code cannot insert the
new required MCP audience column). No DNS/certificate removal is required.
