-- phase: expand
-- A party share remains a normal private share, with its party identity attached
-- so its embed and cookie rules apply only to that share.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS party_slug text COLLATE "C";
CREATE UNIQUE INDEX IF NOT EXISTS shares_party_slug ON shares (party_slug) WHERE party_slug IS NOT NULL AND status = 'active';
