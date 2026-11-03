-- phase: expand
-- MCP OAuth 2.1 for shares (CON-16): an MCP client (Claude, an editor) signs a person in to a share with OpenVibe instead
-- of a pasted key. Connect is the authorization server (connect.openvibe.website/oauth/*): clients register themselves
-- (RFC 7591, public clients with PKCE), the person signs in, the share's own policy is checked and they consent, and the
-- client gets an access token bound to that one share (an hour) and a refresh token (30 days, rotated on each use).
-- Only token hashes are kept. A policy change, the owner's revoke or the share closing stops them.
CREATE TABLE IF NOT EXISTS oauth_clients (
    id             text PRIMARY KEY,                    -- the client_id, occ_<ulid>
    name           text NOT NULL,
    redirect_uris  jsonb NOT NULL,                      -- exact matches only
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_used_at   timestamptz
);
CREATE TABLE IF NOT EXISTS share_oauth_tokens (
    id                  text PRIMARY KEY,               -- sot_<ulid>
    share_id            text NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    client_id           text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    subject             text NOT NULL,                  -- usr_… (the person who consented)
    username            text,
    policy_version      integer NOT NULL,
    access_hash         text NOT NULL UNIQUE,
    access_expires_at   timestamptz NOT NULL,
    refresh_hash        text UNIQUE,
    refresh_expires_at  timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at        timestamptz,
    revoked_at          timestamptz
);
CREATE INDEX IF NOT EXISTS share_oauth_tokens_share ON share_oauth_tokens (share_id) WHERE revoked_at IS NULL;
