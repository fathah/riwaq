CREATE TABLE IF NOT EXISTS organization_usage (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  chat_requests integer NOT NULL DEFAULT 0 CHECK (chat_requests >= 0),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  estimated_cost_micros integer NOT NULL DEFAULT 0 CHECK (estimated_cost_micros >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
