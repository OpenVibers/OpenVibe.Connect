-- phase: expand
-- Each kept webhook knows its event id (CON-15), so the app sees the same x-openvibe-event-id whether Connect hands it
-- over the moment the computer connects or Events' retry brings it: one id to dedupe on.
ALTER TABLE hook_requests ADD COLUMN IF NOT EXISTS event_id text;
