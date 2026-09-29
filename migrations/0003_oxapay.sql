-- OxaPay crypto balance top-ups. Applied 2026-09-29 via Cloudflare D1 API.
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,                       -- our order_id sent to OxaPay
  provider TEXT NOT NULL DEFAULT 'oxapay',
  telegram_user_id INTEGER NOT NULL,
  chat_id INTEGER NULL,
  amount_usd REAL NOT NULL,                  -- the amount we invoiced (what gets credited)
  track_id TEXT NULL UNIQUE,                 -- OxaPay track_id
  status TEXT NOT NULL DEFAULT 'pending',    -- creating|pending|paying|paid|underpaid|expired|refunding|refunded|error
  pay_link TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NULL,
  expires_at TEXT NULL,
  paid_at TEXT NULL,
  last_status TEXT NULL,                     -- raw last OxaPay status
  last_payload TEXT NULL,                    -- raw last callback JSON (truncated)
  credited INTEGER NOT NULL DEFAULT 0,       -- 1 once the balance was credited (exactly once)
  credit_nonce TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
ALTER TABLE topups ADD COLUMN ref TEXT NULL;
INSERT OR IGNORE INTO settings (key, value) VALUES ('crypto_topup_enabled','1'),('topup_presets','5,10,25,50'),('topup_min','1'),('topup_max','1000');
