-- #5: stop storing organization API keys in plaintext. Keep only a SHA-256 hash
-- (used for the auth lookup) plus a short non-secret prefix for display/support.
-- The raw key is shown to the caller exactly once, at creation.
--
-- The key is 192 bits of CSPRNG output, so a single fast hash is sufficient for
-- lookup — an attacker cannot brute-force the preimage, and a plain digest keeps
-- authentication O(1) via a unique index (unlike a per-row slow KDF).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS api_key_hash text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS api_key_prefix text;

-- Backfill hashes from any existing plaintext keys before dropping the column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'api_key'
  ) THEN
    UPDATE organizations
    SET api_key_hash = encode(digest(api_key, 'sha256'), 'hex'),
        api_key_prefix = left(api_key, 12)
    WHERE api_key_hash IS NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_org_api_key_hash ON organizations(api_key_hash);

-- Now that hashes are populated, require them and drop the plaintext column.
ALTER TABLE organizations ALTER COLUMN api_key_hash SET NOT NULL;
ALTER TABLE organizations DROP COLUMN IF EXISTS api_key;
