-- Lifetime usage counters were int4 (~2.1B cap). A busy tenant can cross 2^31
-- tokens or cost-micros, after which every increment would overflow and fail the
-- turn AFTER the model already answered. Widen to bigint. CHECK (>= 0) is retained.
ALTER TABLE organization_usage
  ALTER COLUMN chat_requests         TYPE bigint,
  ALTER COLUMN input_tokens          TYPE bigint,
  ALTER COLUMN output_tokens         TYPE bigint,
  ALTER COLUMN estimated_cost_micros TYPE bigint;
