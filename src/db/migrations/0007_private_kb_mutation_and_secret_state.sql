-- Round 3 hardening:
-- 1. Keep private-KB links valid when ownership fields change, not only when links
--    are inserted.
-- 2. Track whether an org LLM key is encrypted so legacy plaintext is never
--    guessed from a string prefix.

CREATE OR REPLACE FUNCTION enforce_private_kb_mutation() RETURNS trigger AS $$
DECLARE
  invalid_link_count integer;
BEGIN
  -- Shared KBs must remain ownerless; private KBs must have an owner. The existing
  -- CHECK constraint also enforces this, but keeping the condition here makes the
  -- link validation explicit.
  IF (NEW.is_default AND NEW.agent_id IS NULL)
     OR (NOT NEW.is_default AND NEW.agent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'knowledge base private/owner state is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.is_default THEN
    SELECT count(*) INTO invalid_link_count
    FROM agent_knowledge_bases
    WHERE knowledge_base_id = NEW.id
      AND agent_id IS DISTINCT FROM NEW.agent_id;

    IF invalid_link_count > 0 THEN
      RAISE EXCEPTION
        'private knowledge base % ownership change would invalidate % existing link(s)',
        NEW.id, invalid_link_count
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_private_kb_mutation ON knowledge_bases;
CREATE TRIGGER trg_enforce_private_kb_mutation
  BEFORE UPDATE OF agent_id, is_default, org_id ON knowledge_bases
  FOR EACH ROW EXECUTE FUNCTION enforce_private_kb_mutation();

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS llm_api_key_encrypted boolean NOT NULL DEFAULT false;

-- Keys written by the previous application version used this authenticated
-- ciphertext prefix. Mark them explicitly; all other existing values remain
-- legacy plaintext and will be re-encrypted by the startup migration.
UPDATE organizations
SET llm_api_key_encrypted = true
WHERE llm_api_key IS NOT NULL
  AND llm_api_key LIKE 'enc:v1:%'
  AND llm_api_key_encrypted = false;
