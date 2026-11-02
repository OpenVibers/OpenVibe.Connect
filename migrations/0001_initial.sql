-- phase: expand
-- OpenVibe.Connect (connect.openvibe.website): Website Connect's Share, v0 (ADR-057 as reviewed 2026-11-02, OQ-13).
-- A share is one port on a person's machine served at https://<label>--<user>.openvibe.website behind OpenVibe
-- sign-in. Nothing here is a secret: the connect key is stored only as a SHA-256 hash of a 32-byte random value,
-- and the visitors' rows hold a subject id and a username, never a token, a cookie, a body or a query string.

CREATE TABLE shares (
    id                text PRIMARY KEY,                 -- shr_<ulid>
    owner_subject     text NOT NULL,                    -- usr_… (Network's canonical subject)
    owner_username    text NOT NULL,                    -- as it was when the share was made (shown, not trusted)
    label             text NOT NULL,                    -- the part before "--"
    host              text NOT NULL,                    -- <label>--<user>.openvibe.website, lowercase
    local_port        integer NOT NULL CHECK (local_port BETWEEN 1 AND 65535),
    mode              text NOT NULL DEFAULT 'owner' CHECK (mode IN ('owner', 'named', 'signin')),
    named             jsonb NOT NULL DEFAULT '[]'::jsonb, -- lowercase usernames a 'named' share lets in
    status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    policy_version    integer NOT NULL DEFAULT 1,
    key_prefix        text NOT NULL,                    -- the first characters of the key, to tell keys apart
    key_hash          text NOT NULL,                    -- hex SHA-256 of the key
    note              text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    revoked_at        timestamptz,
    last_connected_at timestamptz,
    last_visit_at     timestamptz,
    requests          bigint NOT NULL DEFAULT 0,
    bytes_in          bigint NOT NULL DEFAULT 0,
    bytes_out         bigint NOT NULL DEFAULT 0
);
-- One live share per host; a revoked share keeps its row (and its host stays held, see shares.js).
CREATE UNIQUE INDEX shares_host_active ON shares (host) WHERE status = 'active';
CREATE INDEX shares_owner ON shares (owner_subject, created_at DESC);
CREATE UNIQUE INDEX shares_key_hash ON shares (key_hash);

-- Who came in, one row per share, person and day: the share page's "who opened it" list. No IP, no path.
CREATE TABLE share_visits (
    share_id   text NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    day        date NOT NULL,
    subject    text NOT NULL,
    username   text,
    requests   integer NOT NULL DEFAULT 0,
    denied     integer NOT NULL DEFAULT 0,
    last_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (share_id, day, subject)
);

-- openvibe-sdk/account-data keeps its own idempotency here (ADR-033).
CREATE TABLE account_data_events (
    id         text PRIMARY KEY,
    kind       text NOT NULL,
    subject    text NOT NULL,
    outcome    jsonb,
    applied_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz
);

-- Request telemetry (openvibe-sdk/telemetry): one row per aggregated sample, pruned after 14 days.
CREATE TABLE telemetry_samples (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                    timestamptz NOT NULL,
    service               text NOT NULL,
    project               text,
    subject               text,
    resource              text,
    provider              text,
    node                  text,
    cell                  text,
    region                text,
    operation             text NOT NULL,
    latency_ms            double precision,
    queue_delay_ms        double precision,
    ttfb_ms               double precision,
    throughput_per_second double precision,
    bytes                 bigint,
    status                text,
    cache_status          text,
    cost_estimate         double precision,
    route_epoch           bigint,
    trace_id              text,
    extra                 jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX telemetry_samples_at_idx ON telemetry_samples (at);
CREATE INDEX telemetry_samples_service_idx ON telemetry_samples (service, operation, at);
