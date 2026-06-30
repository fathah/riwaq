-- Per-agent inference backend: 'anthropic' or 'openai' (any OpenAI-compatible endpoint).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'anthropic';
