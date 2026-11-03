-- phase: expand
-- Hooks that wait for your computer (CON-15, ADR-057 decision 7). A hook is one address,
-- https://connect.openvibe.website/h/<id>, that a provider (GitHub, Stripe, …) sends webhooks to. Connect keeps each
-- request here for 7 days and publishes only a pointer to it (connect.hook.received, contracts 0.282.0) through the
-- outbox below. Events retries Connect's own subscription for up to seven days, and Connect hands the request to the
-- share's computer, at the hook's local path, once it is connected.
CREATE TABLE IF NOT EXISTS share_hooks (
    id                text PRIMARY KEY,                  -- hk_<ulid>
    share_id          text NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    owner_subject     text NOT NULL,                     -- usr_… (the share's owner)
    label             text,
    local_path        text NOT NULL,                     -- where on the computer's app it goes: /webhooks/github
    status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    removed_at        timestamptz,
    received          bigint NOT NULL DEFAULT 0,
    delivered         bigint NOT NULL DEFAULT 0,
    last_received_at  timestamptz,
    last_delivered_at timestamptz,
    last_status       integer                            -- what the computer's app answered last
);
CREATE INDEX IF NOT EXISTS share_hooks_share ON share_hooks (share_id, created_at DESC);

-- One webhook as it arrived: its method, the provider's headers (an allowlist; never cookies or forwarding headers),
-- and its body, until it is delivered or 7 days pass.
CREATE TABLE IF NOT EXISTS hook_requests (
    id           text PRIMARY KEY,                       -- hb_<random>: the body_ref in the event
    hook_id      text NOT NULL REFERENCES share_hooks(id) ON DELETE CASCADE,
    method       text NOT NULL,
    headers      jsonb NOT NULL DEFAULT '[]'::jsonb,
    body         bytea NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    delivered_at timestamptz,
    status       integer
);
CREATE INDEX IF NOT EXISTS hook_requests_expiry ON hook_requests (expires_at);
CREATE INDEX IF NOT EXISTS hook_requests_hook ON hook_requests (hook_id, received_at DESC);

-- The events outbox (openvibe-sdk/events createServiceOutbox): a request and its event commit together.
CREATE TABLE IF NOT EXISTS service_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS service_outbox_due ON service_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS service_outbox_sent ON service_outbox (sent_at) WHERE sent_at IS NOT NULL;
