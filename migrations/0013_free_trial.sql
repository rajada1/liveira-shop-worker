-- Free trial (src/freetrial.js): ONE free claim per Telegram user id, forever, for any one eligible product.
-- Idempotent: safe to run again. Rows are NEVER deleted (leaving/rejoining the group or changing the username
-- does not give a second claim). The row is inserted in the same D1 batch (one transaction) as the $0 order and
-- the license token, and the order/token inserts only happen when this row was inserted by that same batch.
-- Settings (code defaults, edited in the panel): free_trial_enabled = 1, free_trial_days = 1, free_trial_products = ''
-- (empty = every active product with a price).
CREATE TABLE IF NOT EXISTS free_claims (
  telegram_user_id INTEGER PRIMARY KEY,   -- one claim per Telegram account, ever
  product_id TEXT NOT NULL,
  product_name TEXT,
  token TEXT NOT NULL,                    -- license key issued (also in tokens / orders)
  days INTEGER NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reminder_sent_at TEXT                   -- "your free trial ended" DM sent (cron, once)
);
CREATE INDEX IF NOT EXISTS idx_free_claims_reminder ON free_claims (reminder_sent_at, expires_at);
