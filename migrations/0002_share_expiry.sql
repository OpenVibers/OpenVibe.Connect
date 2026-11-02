-- phase: expand
-- A share can close itself (CON-6, the contract's website.share@1 expires_at): "Closes in 1 hour / 8 hours / 1 day /
-- 7 days" on the share page. Null is "until you close it", every row's value today, and the code before this one
-- never reads it. The sweep (app.js) finds the due ones by this index.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS shares_expiring ON shares (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;
