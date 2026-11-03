-- phase: expand
-- API keys for a share (CON-16 v0). A share's owner makes a key and gives it to a program: a request that sends it as
-- `Authorization: Bearer ovsk_…` passes the gate without signing in, so a model or an API on the owner's computer
-- (Ollama, llama.cpp, a small service) can be called from a script or another app. A key opens the share's API, never
-- its pages (an HTML answer to a key is refused at the edge, server/edge/proxy.js), so a key posted in public cannot
-- turn a share into a public website. Only the key's hash is kept; it is shown once. Each key has its own rate.
CREATE TABLE IF NOT EXISTS share_api_keys (
    id             text PRIMARY KEY,                    -- sak_<ulid>
    share_id       text NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    owner_subject  text NOT NULL,                       -- usr_… (the share's owner)
    name           text NOT NULL,
    key_prefix     text NOT NULL,                       -- the first 12 characters, to tell keys apart
    key_hash       text NOT NULL UNIQUE,                -- sha256 of the key
    per_minute     integer NOT NULL DEFAULT 60 CHECK (per_minute BETWEEN 1 AND 600),
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_used_at   timestamptz,
    revoked_at     timestamptz
);
CREATE INDEX IF NOT EXISTS share_api_keys_share ON share_api_keys (share_id) WHERE revoked_at IS NULL;
