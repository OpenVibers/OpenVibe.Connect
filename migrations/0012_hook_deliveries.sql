-- phase: expand
-- Arrival order: a share's waiting webhooks replay oldest first, including two that arrive in the same millisecond.
ALTER TABLE hook_requests ADD COLUMN IF NOT EXISTS seq bigserial;
CREATE INDEX IF NOT EXISTS hook_requests_seq ON hook_requests (hook_id, seq);

-- The owner's delivery log (CON-15): what arrived at a webhook address, what the computer's app answered (or why it
-- could not), and when. It never keeps a body or a provider header: the log says that a delivery happened, not what
-- the provider said. Rows are removed 72 hours after they are made, with the webhooks they describe.
CREATE TABLE IF NOT EXISTS hook_deliveries (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    share_id     text NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    hook_id      text NOT NULL REFERENCES share_hooks(id) ON DELETE CASCADE,
    owner_subject text NOT NULL,                          -- usr_…: the person's account export names these rows
    request_id   text,                                    -- hb_… of the kept webhook; gone once it is delivered
    event_id     text,                                    -- evt_… the app also sees in x-openvibe-event-id
    method       text NOT NULL,
    path         text NOT NULL,                           -- the path on the computer's app
    status       integer,                                 -- the app's answer; null when it did not answer
    error        text,                                    -- why a delivery failed, at most 200 characters
    received_at  timestamptz,                             -- when the provider's webhook first arrived
    delivered_at timestamptz,                             -- null for a failed attempt
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hook_deliveries_share ON hook_deliveries (share_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hook_deliveries_hook ON hook_deliveries (hook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hook_deliveries_owner ON hook_deliveries (owner_subject, created_at DESC);
