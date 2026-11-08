-- phase: expand
-- Both public names identify the same share; keep stored hosts and keys intact.
CREATE UNIQUE INDEX shares_alias_active ON shares
    ((regexp_replace(host, '\.openvibe\.(website|link)$', '.openvibe.link')))
    WHERE status = 'active';

-- Existing MCP sessions retain their original host audience.
ALTER TABLE share_oauth_tokens ADD COLUMN resource_host text;
UPDATE share_oauth_tokens t SET resource_host = s.host FROM shares s WHERE s.id = t.share_id;
ALTER TABLE share_oauth_tokens ALTER COLUMN resource_host SET NOT NULL;
