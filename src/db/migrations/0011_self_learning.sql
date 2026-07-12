-- Per-org self-learning layer.
--
-- The flywheel: end users up-vote assistant answers → equivalent questions are
-- clustered into a candidate "learned answer" → once enough DISTINCT users endorse
-- it (org-configurable) it is auto-promoted, otherwise an operator approves it.
-- Promotion writes the Q&A into the agent's knowledge base so future retrieval
-- surfaces the vetted answer. Everything is org/agent-scoped — never cross-tenant.

-- Org-set auto-promotion threshold. 0 = operator approval only (no auto-promote).
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS learned_auto_promote_threshold integer NOT NULL DEFAULT 0
    CHECK (learned_auto_promote_threshold >= 0);

-- Promoted learned answers are stored as documents with source 'learned', so the
-- source CHECK must admit it (extends 'file' | 'text' from 0004).
ALTER TABLE documents DROP CONSTRAINT IF EXISTS chk_documents_source;
ALTER TABLE documents ADD CONSTRAINT chk_documents_source CHECK (source IN ('file', 'text', 'learned'));

-- Best retrieval similarity for a question at answer time. A low value means the
-- KB could not answer it — the raw signal for knowledge-gap reporting.
ALTER TABLE question_logs
  ADD COLUMN IF NOT EXISTS top_similarity real NOT NULL DEFAULT 0;

-- Candidate + promoted learned answers.
CREATE TABLE IF NOT EXISTS learned_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  embedding vector(__EMBED_DIM__) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  distinct_user_count integer NOT NULL DEFAULT 0 CHECK (distinct_user_count >= 0),
  -- The document created in the agent's KB when this answer was promoted.
  promoted_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_learned_answers_agent        ON learned_answers(agent_id);
CREATE INDEX IF NOT EXISTS idx_learned_answers_agent_status ON learned_answers(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_learned_answers_embedding    ON learned_answers USING hnsw (embedding vector_cosine_ops);

-- One row per (candidate, end user): the DB enforces that a single end user can
-- only ever contribute ONE endorsement, so distinct_user_count can't be inflated
-- by one actor voting repeatedly.
CREATE TABLE IF NOT EXISTS learned_answer_votes (
  learned_answer_id uuid NOT NULL REFERENCES learned_answers(id) ON DELETE CASCADE,
  end_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (learned_answer_id, end_user_id)
);
