-- Provider-neutral messaging channels. Telegram is the first adapter; every
-- channel feeds the same canonical chat, memory, analytics, and learning path.

CREATE TABLE agent_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('telegram')),
  display_name text NOT NULL,
  external_id text NOT NULL,
  external_username text,
  credential text NOT NULL,
  credential_encrypted boolean NOT NULL DEFAULT false,
  webhook_secret_hash text NOT NULL,
  status text NOT NULL DEFAULT 'connecting' CHECK (status IN ('connecting', 'active', 'error')),
  last_error text,
  last_received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_agent_channels_agent_org
    FOREIGN KEY (agent_id, org_id) REFERENCES agents(id, org_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_agent_channels_agent_provider ON agent_channels(agent_id, provider);
CREATE UNIQUE INDEX uq_agent_channels_provider_external ON agent_channels(provider, external_id);
CREATE INDEX idx_agent_channels_org ON agent_channels(org_id);

CREATE TABLE channel_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES agent_channels(id) ON DELETE CASCADE,
  external_chat_id text NOT NULL,
  external_user_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_channel_sessions_identity
  ON channel_sessions(channel_id, external_chat_id, external_user_id);
CREATE UNIQUE INDEX uq_channel_sessions_conversation ON channel_sessions(conversation_id);

CREATE TABLE channel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES agent_channels(id) ON DELETE CASCADE,
  provider_event_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'responding', 'processed', 'error')),
  response_text text,
  sent_part_count integer NOT NULL DEFAULT 0 CHECK (sent_part_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE UNIQUE INDEX uq_channel_events_provider_id ON channel_events(channel_id, provider_event_id);
CREATE INDEX idx_channel_events_status ON channel_events(status, created_at);
