-- phase: expand
ALTER TABLE shares ADD COLUMN link_egress boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX shares_link_egress_node ON shares(node_id) WHERE link_egress AND status = 'active';
