-- NOWPayments top-ups (hosted invoice; src/nowpayments.js). Idempotent: safe to run more than once.
-- Top-ups live in `payments` (provider='nowpayments', id = our order_id 'np_…', track_id = 'np:<invoice id>').
-- One invoice can lead to several NOWPayments payments (coin switched, paid twice): one row per payment_id here.
INSERT OR IGNORE INTO settings (key, value) VALUES ('nowpayments_enabled', '1');

CREATE TABLE IF NOT EXISTS np_payments (
  payment_id TEXT PRIMARY KEY,        -- NOWPayments payment_id
  order_id TEXT NOT NULL,             -- payments.id (our order_id)
  invoice_id TEXT NULL,
  status TEXT NOT NULL,               -- waiting, confirming, confirmed, sending, partially_paid, finished, failed, refunded, expired, unknown
  price_amount REAL NULL,             -- invoice price (USD)
  price_currency TEXT NULL,
  pay_amount REAL NULL,               -- amount due in pay_currency
  actually_paid REAL NULL,
  pay_currency TEXT NULL,
  outcome_amount REAL NULL,           -- received after fees, in outcome_currency
  outcome_currency TEXT NULL,
  parent_payment_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,           -- last status/amount change
  checked_at TEXT NULL,               -- last GET /v1/payment/{id}
  ipn_count INTEGER NOT NULL DEFAULT 0,
  poll_errors INTEGER NOT NULL DEFAULT 0,
  credited INTEGER NOT NULL DEFAULT 0, -- 1 = this payment credited the top-up
  flag TEXT NULL                      -- admin notice sent once: extra / price_mismatch / underpaid_finished
);
CREATE INDEX IF NOT EXISTS idx_np_payments_order ON np_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_np_payments_poll ON np_payments(status, checked_at);
