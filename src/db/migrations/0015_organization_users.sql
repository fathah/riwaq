-- Canonical, organization-owned users and their external platform identities.
-- The canonical id is supplied by the business, making an existing customer id
-- usable directly by chat, memory, reminders, and future commerce tools.
CREATE TABLE IF NOT EXISTS end_users (
  org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id           text        NOT NULL,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT chk_end_users_id_length CHECK (char_length(id) BETWEEN 1 AND 500)
);

CREATE TABLE IF NOT EXISTS end_user_identities (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL,
  end_user_id      text        NOT NULL,
  provider         text        NOT NULL,
  namespace        text        NOT NULL DEFAULT 'default',
  external_user_id text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, end_user_id) REFERENCES end_users(org_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_end_user_identity_provider CHECK (char_length(provider) BETWEEN 1 AND 100),
  CONSTRAINT chk_end_user_identity_namespace CHECK (char_length(namespace) BETWEEN 1 AND 200),
  CONSTRAINT chk_end_user_identity_external CHECK (char_length(external_user_id) BETWEEN 1 AND 500),
  UNIQUE (org_id, provider, namespace, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_end_user_identities_user
  ON end_user_identities(org_id, end_user_id);

-- Register every legacy identity already referenced by durable state. Keeping
-- the same text id makes this upgrade non-destructive and preserves isolation.
INSERT INTO end_users (org_id, id)
SELECT DISTINCT org_id, end_user_id
FROM (
  SELECT a.org_id, c.end_user_id
  FROM conversations c JOIN agents a ON a.id = c.agent_id
  UNION ALL
  SELECT a.org_id, m.end_user_id
  FROM memories m JOIN agents a ON a.id = m.agent_id
  WHERE m.end_user_id IS NOT NULL
  UNION ALL
  SELECT r.org_id, r.end_user_id
  FROM reminders r
  WHERE r.end_user_id IS NOT NULL
  UNION ALL
  SELECT la.org_id, lav.end_user_id
  FROM learned_answer_votes lav JOIN learned_answers la ON la.id = lav.learned_answer_id
) legacy
WHERE end_user_id IS NOT NULL AND end_user_id <> ''
ON CONFLICT (org_id, id) DO NOTHING;

-- Existing Telegram-derived ids become real platform links immediately.
INSERT INTO end_user_identities (org_id, end_user_id, provider, namespace, external_user_id)
SELECT org_id, id, 'telegram', 'default', substring(id FROM char_length('telegram:') + 1)
FROM end_users
WHERE id LIKE 'telegram:%' AND char_length(id) > char_length('telegram:')
ON CONFLICT (org_id, provider, namespace, external_user_id) DO NOTHING;
