-- P0 #1: give private (default) knowledge bases an explicit owning agent, and
-- enforce "at most one private KB per agent" in the database. Before this, any
-- same-org KB — including another agent's private KB — could be linked to any
-- agent. Ownership + constraints make cross-agent private access unrepresentable.

ALTER TABLE knowledge_bases
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE CASCADE;

-- Backfill: the owner of an existing default KB is the agent it is linked to.
UPDATE knowledge_bases kb
SET agent_id = akb.agent_id
FROM agent_knowledge_bases akb
WHERE akb.knowledge_base_id = kb.id
  AND kb.is_default = true
  AND kb.agent_id IS NULL;

-- Invariant: a private KB has an owner; a shared KB does not.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_kb_private_owner') THEN
    ALTER TABLE knowledge_bases
      ADD CONSTRAINT chk_kb_private_owner
      CHECK ((is_default AND agent_id IS NOT NULL) OR (NOT is_default AND agent_id IS NULL));
  END IF;
END $$;

-- One private KB per agent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_owner_agent
  ON knowledge_bases(agent_id)
  WHERE agent_id IS NOT NULL;
