-- phase: expand
-- A share served by one of its owner's computers, as OpenVibe Node (CON-4, ADR-057 decision 4). The computer proves
-- itself with its Network node token (subject node:<node_id>, audience openvibe.website) and a single-use tunnel token
-- from Connect; the share's connect key stops working while a computer is bound. Null: the connect key, as before.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS node_id text;      -- nod_… (Network's node principal)
ALTER TABLE shares ADD COLUMN IF NOT EXISTS node_name text;    -- the computer's name on Network, as it was when bound
CREATE INDEX IF NOT EXISTS shares_node ON shares (node_id) WHERE node_id IS NOT NULL AND status = 'active';
