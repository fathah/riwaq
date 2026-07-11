-- Durable learning jobs use the user message as their idempotency key.
-- One question may contribute to analytics at most once, even after retries.
CREATE UNIQUE INDEX IF NOT EXISTS uq_question_logs_message
  ON question_logs(message_id);
