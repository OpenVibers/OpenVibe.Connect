-- phase: expand
-- CON-17 (2026-11-03): while a share's computer is off, a browser may be sent to one of the sites on the same domain
-- (an OpenVibe.Space site, https://<name>.openvibe.website) instead of the waiting page. NULL keeps the waiting page.
-- The address is checked in server/shares.js (the domain is configuration); the column only bounds it.
ALTER TABLE shares ADD COLUMN offline_site text;
ALTER TABLE shares ADD CONSTRAINT shares_offline_site CHECK (offline_site IS NULL OR (length(offline_site) <= 300 AND offline_site ~ '^https?://'));
