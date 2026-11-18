-- phase: expand
-- Previews (plan §AD.25 "preview links"): a person's computer, as OpenVibe Link, opens a short-lived owner-only share
-- for a folder it built (`openvibe-link preview <dir>`), so a check or a reviewer has a page to open. `link_preview`
-- marks them, to cap how many one computer keeps open; each has an expires_at (at most a day) and the expiry sweep
-- closes it. Older releases read it as an ordinary owner-mode share.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS link_preview boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS shares_link_previews ON shares(node_id) WHERE link_preview AND status = 'active';
