-- Re-review P0 #1 follow-up: the route rejected linking a private KB to another
-- agent, but the DATABASE still permitted a direct `agent_knowledge_bases` row
-- doing so. Close that at the database layer (defense in depth), tie a private
-- KB's owner to the KB's org, and clean up any historical illegal links.

-- 1. A private KB's owner must be in the same org as the KB (composite FK).
--    NULL agent_id (shared KB) is skipped by MATCH SIMPLE, as intended.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_owner_org') THEN
    ALTER TABLE knowledge_bases ADD CONSTRAINT fk_kb_owner_org
      FOREIGN KEY (agent_id, org_id) REFERENCES agents(id, org_id) ON DELETE CASCADE;
  END IF;
END $$;

-- 2. Remove any historical illegal links: a private (default) KB linked to any
--    agent other than its owner. (The owner link itself is kept.)
DELETE FROM agent_knowledge_bases akb
USING knowledge_bases kb
WHERE akb.knowledge_base_id = kb.id
  AND kb.is_default = true
  AND kb.agent_id IS DISTINCT FROM akb.agent_id;

-- 3. Enforce the rule going forward with a trigger: a private KB may only ever be
--    linked to its owning agent. A shared KB (owner NULL) links freely. This makes
--    a same-org cross-agent private link impossible via any code path or raw SQL.
CREATE OR REPLACE FUNCTION enforce_private_kb_link() RETURNS trigger AS $$
DECLARE
  kb_owner uuid;
  kb_is_default boolean;
BEGIN
  SELECT agent_id, is_default INTO kb_owner, kb_is_default
  FROM knowledge_bases WHERE id = NEW.knowledge_base_id;

  IF kb_is_default AND kb_owner IS DISTINCT FROM NEW.agent_id THEN
    RAISE EXCEPTION 'private knowledge base % may only be linked to its owner agent (got %)',
      NEW.knowledge_base_id, NEW.agent_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_private_kb_link ON agent_knowledge_bases;
CREATE TRIGGER trg_enforce_private_kb_link
  BEFORE INSERT OR UPDATE ON agent_knowledge_bases
  FOR EACH ROW EXECUTE FUNCTION enforce_private_kb_link();

-- 4. Re-review #2 residual: index the per-user memory recall path.
CREATE INDEX IF NOT EXISTS idx_memories_agent_user ON memories(agent_id, end_user_id);
