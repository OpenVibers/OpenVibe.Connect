-- phase: expand
-- The abuse gate, v0 (CON-9): anyone can report a share; OpenVibe staff read the reports and close a share. A report
-- names the share, a reason and what the reporter wrote; the reporter's account when signed in (erased by
-- anonymizing: the report stays for safety). No address is stored. closed_reason says why a share was closed by
-- someone other than its owner ('report'); null for every share today.
CREATE TABLE IF NOT EXISTS share_reports (
    id               text PRIMARY KEY,                 -- rpt_<random>
    share_id         text NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    host             text NOT NULL,
    reason           text NOT NULL CHECK (reason IN ('phishing', 'malware', 'illegal', 'copyright', 'abuse', 'other')),
    details          text,
    reporter_subject text,
    status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed_share', 'dismissed')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    handled_by       text,
    handled_at       timestamptz
);
CREATE INDEX IF NOT EXISTS share_reports_open ON share_reports (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS share_reports_reporter ON share_reports (reporter_subject) WHERE reporter_subject IS NOT NULL;
ALTER TABLE shares ADD COLUMN IF NOT EXISTS closed_reason text;
