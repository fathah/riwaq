-- #9: push domain invariants that were only enforced in application code down
-- into the database, so a forgotten guard in any current/future handler cannot
-- silently break tenancy or data integrity.

-- --- Enumerated string columns → CHECK constraints ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_messages_role') THEN
    ALTER TABLE messages ADD CONSTRAINT chk_messages_role CHECK (role IN ('user','assistant'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_messages_feedback') THEN
    ALTER TABLE messages ADD CONSTRAINT chk_messages_feedback CHECK (feedback IS NULL OR feedback IN ('up','down'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_documents_status') THEN
    ALTER TABLE documents ADD CONSTRAINT chk_documents_status CHECK (status IN ('processing','ready','error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_documents_source') THEN
    ALTER TABLE documents ADD CONSTRAINT chk_documents_source CHECK (source IN ('file','text'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_agents_provider') THEN
    ALTER TABLE agents ADD CONSTRAINT chk_agents_provider CHECK (provider IS NULL OR provider IN ('anthropic','openai'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_org_llm_provider') THEN
    ALTER TABLE organizations ADD CONSTRAINT chk_org_llm_provider CHECK (llm_provider IS NULL OR llm_provider IN ('anthropic','openai'));
  END IF;
END $$;

-- --- Deterministic agent-name resolution (the OpenAI route resolves agents by
-- name). Unique per org, case-insensitive, so a name maps to exactly one agent. ---
CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_org_name ON agents(org_id, lower(name));

-- --- A chunk's KB must equal its document's KB (composite FK). ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_documents_id_kb') THEN
    ALTER TABLE documents ADD CONSTRAINT uq_documents_id_kb UNIQUE (id, knowledge_base_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chunks_doc_kb') THEN
    ALTER TABLE chunks ADD CONSTRAINT fk_chunks_doc_kb
      FOREIGN KEY (document_id, knowledge_base_id)
      REFERENCES documents(id, knowledge_base_id) ON DELETE CASCADE;
  END IF;
END $$;

-- --- Cross-org isolation of agent↔KB links, enforced by the DB (not just the
-- route guard). Carry org_id on the link table and require it to match BOTH the
-- agent's and the KB's org via composite FKs. A link across orgs is now impossible. ---
ALTER TABLE agent_knowledge_bases ADD COLUMN IF NOT EXISTS org_id uuid;

UPDATE agent_knowledge_bases akb
SET org_id = a.org_id
FROM agents a
WHERE a.id = akb.agent_id AND akb.org_id IS NULL;

ALTER TABLE agent_knowledge_bases ALTER COLUMN org_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_agents_id_org') THEN
    ALTER TABLE agents ADD CONSTRAINT uq_agents_id_org UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_kb_id_org') THEN
    ALTER TABLE knowledge_bases ADD CONSTRAINT uq_kb_id_org UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_akb_agent_org') THEN
    ALTER TABLE agent_knowledge_bases ADD CONSTRAINT fk_akb_agent_org
      FOREIGN KEY (agent_id, org_id) REFERENCES agents(id, org_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_akb_kb_org') THEN
    ALTER TABLE agent_knowledge_bases ADD CONSTRAINT fk_akb_kb_org
      FOREIGN KEY (knowledge_base_id, org_id) REFERENCES knowledge_bases(id, org_id) ON DELETE CASCADE;
  END IF;
END $$;
