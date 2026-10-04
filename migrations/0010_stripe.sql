-- Stripe card top-ups (Checkout Session, card only, USD; src/stripe.js). Idempotent: safe to run more than once.
-- Top-ups live in `payments` (provider='stripe', id 'sp_…' = client_reference_id, track_id = 'stripe:<cs id>').
INSERT OR IGNORE INTO settings (key, value) VALUES ('stripe_enabled', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('stripe_min', '5');
INSERT OR IGNORE INTO settings (key, value) VALUES ('stripe_max', '500');

CREATE TABLE IF NOT EXISTS stripe_sessions (
  session_id TEXT PRIMARY KEY,          -- cs_live_… / cs_test_…
  payment_id TEXT NOT NULL,             -- payments.id
  status TEXT NULL,                     -- open, complete, expired
  payment_status TEXT NULL,             -- unpaid, paid, no_payment_required
  amount_total INTEGER NULL,            -- cents
  currency TEXT NULL,
  payment_intent TEXT NULL,
  charge_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,             -- last status change
  checked_at TEXT NULL,                 -- last GET /v1/checkout/sessions/{id}
  poll_errors INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  credited INTEGER NOT NULL DEFAULT 0,
  flag TEXT NULL,                       -- admin notice sent once: amount_mismatch
  refunded_cents INTEGER NOT NULL DEFAULT 0,  -- charge.amount_refunded (USD cents)
  dispute_id TEXT NULL,
  dispute_cents INTEGER NOT NULL DEFAULT 0,
  dispute_status TEXT NULL,
  dispute_reason TEXT NULL,
  debited_usd REAL NOT NULL DEFAULT 0,        -- taken back from the wallet after refund/dispute
  unrecovered_usd REAL NOT NULL DEFAULT 0,    -- refund/dispute not covered by the balance (flagged to admins)
  debit_nonce TEXT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_sessions_payment ON stripe_sessions(payment_id);
CREATE INDEX IF NOT EXISTS idx_stripe_sessions_pi ON stripe_sessions(payment_intent);
CREATE INDEX IF NOT EXISTS idx_stripe_sessions_charge ON stripe_sessions(charge_id);
CREATE INDEX IF NOT EXISTS idx_stripe_sessions_poll ON stripe_sessions(status, checked_at);

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,                  -- evt_…
  type TEXT NOT NULL,
  object_id TEXT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT NULL,
  result TEXT NULL
);
