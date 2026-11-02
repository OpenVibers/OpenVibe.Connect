# Security policy

OpenVibe is run in the open, and we want to hear about security problems before anyone else does.

## Reporting a vulnerability

Email **contact@openvibe.network** with "security" in the subject. Please include what you found, where (URL,
repository, file), how to reproduce it, and what an attacker could do with it. Do not open a public GitHub issue for
a vulnerability, and do not test against other people's accounts, data or streams.

We reply within 7 days, keep you updated while we fix it, and credit you when the fix ships if you would like.

## Scope

Every OpenVibe service and site (connect.openvibe.website and every <name>--<user>.openvibe.website, openvibe.live, openvibe.network, openvibe.today, openvibe.tools,
openvibe.media, openvibe.community, openvibe.games and the other openvibe.* domains) and every repository under
github.com/OpenVibers. Machine-readable contact details are at `/.well-known/security.txt` on each site.

## What OpenVibe Connect holds

- A person's shares: their subject id and username, the share's name and address, the local port they typed, who may
  open it, its status, counters (requests, bytes) and times. The connect key is stored only as a SHA-256 hash of a
  32-byte random value; the key itself is shown once and never stored, logged or rendered again.
- Visits: one row per share, person and day with a request count and a "turned away" count. No IP address, no path, no
  query string, no header, no body.
- Nothing that passes through a share is stored. Requests and responses stream through memory.
- Network session tokens only in httpOnly cookies; no token is stored in the database, rendered into a page or logged.

## How a share is protected

- **The gate.** Every visitor signs in with OpenVibe and must be allowed by the share's policy (only the owner, the
  owner and named people, or anyone signed in). There are no public shares: those wait for the abuse check and the
  Public Suffix List entry for openvibe.website (ADR-057, CON-9 and CON-21).
- **Host-only cookies.** The gate's cookie on a share host is `__Host-ovc` (Secure, HttpOnly, SameSite=Lax, Path=/, no
  Domain), HMAC-signed and bound to that share and its policy version; changing the policy invalidates every cookie.
  A Set-Cookie from the shared app loses any Domain attribute, and the app can never set or read the gate's cookie.
- **The share comes from the Host header** nginx sets, never from X-Forwarded-Host or any other visitor header; a
  visitor's X-OpenVibe-* headers are dropped before the app sees the request.
- **No cache past the gate.** Every share response carries `Cloudflare-CDN-Cache-Control: no-store` and a private
  Cache-Control.
- **The client reaches localhost only**, on the port its owner gave it; the server cannot make it connect anywhere else.
- **Limits:** five open shares per person, 64 requests at once and 1,200 a minute per share, 100 MB per request body,
  10 GB a day per person.

Please report anything that gets a visitor past the gate, lets one share read another's cookies, or makes a client
reach anything but its own port.
