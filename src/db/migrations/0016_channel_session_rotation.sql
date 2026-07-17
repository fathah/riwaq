-- Bound messaging-channel sessions without deleting their transcript. A channel
-- session points at the active conversation; rotation simply points it at a new
-- conversation while old messages remain available for audit/history.
ALTER TABLE channel_sessions
  ADD COLUMN IF NOT EXISTS turn_count integer NOT NULL DEFAULT 0;

ALTER TABLE channel_sessions
  DROP CONSTRAINT IF EXISTS chk_channel_sessions_turn_count;
ALTER TABLE channel_sessions
  ADD CONSTRAINT chk_channel_sessions_turn_count CHECK (turn_count >= 0);

-- Preserve a reasonable turn count for already-running sessions. Their existing
-- updated_at value becomes the inactivity reference and naturally rotates stale
-- sessions the next time a message arrives.
UPDATE channel_sessions session
SET turn_count = counts.turn_count
FROM (
  SELECT session_inner.id, count(message.id)::integer AS turn_count
  FROM channel_sessions session_inner
  JOIN messages message ON message.conversation_id = session_inner.conversation_id
  WHERE message.role = 'user'
  GROUP BY session_inner.id
) counts
WHERE session.id = counts.id AND session.turn_count = 0;
