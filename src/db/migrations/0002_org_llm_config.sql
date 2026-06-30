-- Per-org LLM configuration (provider/baseURL/apiKey/model), each nullable so it
-- falls back to the .env default. And demote agent provider/model to optional
-- overrides (null = inherit from org/.env) rather than always-set columns.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS llm_provider text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS llm_base_url text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS llm_api_key text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS llm_model text;

ALTER TABLE agents ALTER COLUMN provider DROP DEFAULT;
ALTER TABLE agents ALTER COLUMN provider DROP NOT NULL;
ALTER TABLE agents ALTER COLUMN model DROP DEFAULT;
ALTER TABLE agents ALTER COLUMN model DROP NOT NULL;
