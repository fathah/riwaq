-- Scheduled reminders: agents remember dates (renewals, follow-ups) and fire a
-- signed webhook to the org's backend at due time. Org/agent/end-user scoped.

-- Per-org webhook the scheduler posts fired reminders to. The secret signs the
-- payload (HMAC) so the org can verify authenticity; stored encrypted at rest.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS webhook_url text,
  ADD COLUMN IF NOT EXISTS webhook_secret text,
  ADD COLUMN IF NOT EXISTS webhook_secret_encrypted boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  end_user_id text,                       -- optional: who the reminder is about
  title text NOT NULL,
  message text,                           -- static body, OR
  prompt text,                            -- prompt the agent composes at fire time
  due_at timestamptz NOT NULL,
  recurrence text,                        -- null | daily | weekly | monthly | yearly
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'firing', 'completed', 'error', 'cancelled')),
  source text NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'auto')),
  next_fire_at timestamptz NOT NULL,      -- the working column the scheduler polls
  attempt_count integer NOT NULL DEFAULT 0,
  fire_count integer NOT NULL DEFAULT 0,
  last_fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_reminder_body CHECK (message IS NOT NULL OR prompt IS NOT NULL),
  CONSTRAINT chk_reminder_recurrence
    CHECK (recurrence IS NULL OR recurrence IN ('daily', 'weekly', 'monthly', 'yearly'))
);
-- The scheduler's hot path: due, still-scheduled rows in fire order.
CREATE INDEX IF NOT EXISTS idx_reminders_due          ON reminders(status, next_fire_at);
CREATE INDEX IF NOT EXISTS idx_reminders_agent        ON reminders(agent_id);
CREATE INDEX IF NOT EXISTS idx_reminders_agent_user   ON reminders(agent_id, end_user_id);

CREATE TABLE IF NOT EXISTS reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  status text NOT NULL,                   -- ok | failed | skipped
  response_code integer,
  error text,
  message text,                           -- the body that was (or would be) sent
  fired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_reminder ON reminder_deliveries(reminder_id, fired_at);
