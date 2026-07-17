-- Telegram now uses outbound long polling and no longer needs an inbound
-- webhook secret. Keep the legacy column nullable for a non-destructive upgrade.
ALTER TABLE agent_channels
  ALTER COLUMN webhook_secret_hash DROP NOT NULL;
