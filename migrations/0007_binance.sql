-- Binance Pay top-ups (customer pastes the transaction ID, the Worker verifies it in the shop's Binance Pay history).
-- Idempotent: safe to run more than once. Claims live in `payments` (provider='binance', track_id='binance:<txid>').
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('binance_enabled', '1'),
  ('binance_pay_id', '290455535'),
  ('binance_currencies', 'USDT'),
  ('binance_max', '1000');

-- Cache of the shop's Binance Pay history (GET /sapi/v1/pay/transactions is weight 3000): refreshed at most every ~45 s.
CREATE TABLE IF NOT EXISTS binance_tx (
  transaction_id TEXT PRIMARY KEY,   -- exact Binance transactionId (case-sensitive)
  order_type TEXT NULL,              -- C2C, PAY, CRYPTO_BOX, PAYOUT, ...
  amount TEXT NOT NULL,              -- decimal string as returned (positive = income)
  currency TEXT NULL,
  tx_time INTEGER NULL,              -- ms since epoch
  payer_id TEXT NULL,                -- payerInfo.binanceId (UID)
  receiver_id TEXT NULL,             -- receiverInfo.binanceId (UID)
  receiver_account TEXT NULL,        -- receiverInfo.accountId (Binance Pay ID)
  seen_at TEXT NOT NULL
);

-- Fetch throttle / backoff state: fetch_at (ms of the last fetch claim), backoff_until (ms), last_ok_at, last_error.
CREATE TABLE IF NOT EXISTS binance_state (k TEXT PRIMARY KEY, v TEXT);

-- Per-user verification rate limit (1 check / 20 s, 10 / hour).
CREATE TABLE IF NOT EXISTS binance_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  at INTEGER NOT NULL                -- ms since epoch
);
CREATE INDEX IF NOT EXISTS idx_binance_checks_user ON binance_checks(user_id, at);
CREATE INDEX IF NOT EXISTS idx_payments_provider_status ON payments(provider, status);
