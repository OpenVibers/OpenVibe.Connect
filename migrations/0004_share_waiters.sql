-- phase: expand
-- "Tell me when it's back" (CON-17): a signed-in visitor who found a share offline asks for one OpenVibe notification
-- when its computer connects again. One row per share and person, deleted once told (or with the share).
CREATE TABLE IF NOT EXISTS share_waiters (
    share_id   text NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    subject    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (share_id, subject)
);
