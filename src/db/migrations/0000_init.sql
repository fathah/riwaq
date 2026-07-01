-- Riwaq initial schema. Idempotent: safe to run on every boot.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  api_key    text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  system_prompt text NOT NULL DEFAULT '',
  model         text NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_knowledge_bases (
  agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, knowledge_base_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  name              text NOT NULL,
  source            text NOT NULL DEFAULT 'text',
  status            text NOT NULL DEFAULT 'processing',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  content           text NOT NULL,
  embedding         vector(__EMBED_DIM__) NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  end_user_id text NOT NULL,
  summary     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  used_chunk_ids  uuid[] NOT NULL DEFAULT '{}',
  feedback        text,
  tokens          integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  end_user_id text,
  fact        text NOT NULL,
  embedding   vector(__EMBED_DIM__) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topics (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id  uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label     text NOT NULL,
  centroid  vector(__EMBED_DIM__) NOT NULL,
  count     integer NOT NULL DEFAULT 0,
  last_seen timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS question_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  topic_id   uuid REFERENCES topics(id) ON DELETE SET NULL,
  embedding  vector(__EMBED_DIM__) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Relational indexes
CREATE INDEX IF NOT EXISTS idx_agents_org          ON agents(org_id);
CREATE INDEX IF NOT EXISTS idx_kb_org              ON knowledge_bases(org_id);
CREATE INDEX IF NOT EXISTS idx_akb_agent           ON agent_knowledge_bases(agent_id);
CREATE INDEX IF NOT EXISTS idx_akb_kb              ON agent_knowledge_bases(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_documents_kb        ON documents(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_chunks_kb           ON chunks(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc          ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv       ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_memories_agent      ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_topics_agent        ON topics(agent_id);
CREATE INDEX IF NOT EXISTS idx_qlogs_agent         ON question_logs(agent_id);

-- Vector indexes (HNSW, cosine)
CREATE INDEX IF NOT EXISTS idx_chunks_embedding   ON chunks   USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_topics_centroid    ON topics   USING hnsw (centroid vector_cosine_ops);
