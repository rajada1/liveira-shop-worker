-- Binance Pay: also cache orderId. Live shape check (2026-10-04): transactionId is an 18-char alphanumeric string with an
-- underscore (e.g. "A_A99…"), orderId is a different 18-digit number; the Binance app shows the Order ID, so customers
-- may paste either. Claims are re-keyed to the canonical transactionId before crediting (track_id stays UNIQUE).
-- Not idempotent (ALTER TABLE): run once.
ALTER TABLE binance_tx ADD COLUMN order_id TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_binance_tx_order ON binance_tx(order_id);
