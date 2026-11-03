-- phase: expand
-- CON-16 v1: a key's daily quota and what it was used for. The owner may cap a key's requests a day (per_day; NULL is
-- no daily cap beyond the per-minute rate and the share's own limits), counted in UTC days. The usage rows say, per key
-- and day, how many requests it made ('*'), which MCP tools it called ('tool:<name>', from JSON-RPC tools/call) and
-- which models it asked for ('model:<name>', from an OpenAI-style body): names and counts only, never arguments or
-- prompts. They go with the key.
ALTER TABLE share_api_keys ADD COLUMN IF NOT EXISTS per_day integer CHECK (per_day IS NULL OR per_day BETWEEN 1 AND 1000000);
CREATE TABLE IF NOT EXISTS share_api_key_usage (
    key_id   text NOT NULL REFERENCES share_api_keys(id) ON DELETE CASCADE,
    day      date NOT NULL,
    what     text NOT NULL,
    n        integer NOT NULL DEFAULT 0,
    last_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_id, day, what)
);
