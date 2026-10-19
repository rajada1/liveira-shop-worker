-- Pix top-ups via Mercado Pago (src/pix.js), same API as @LiveiraStore_bot (liveira-store/src/mercadopago.ts).
-- Top-ups live in `payments` (provider='mercadopago', id 'px_…' = external_reference, track_id 'mp:<payment id>').
-- The wallet stays in USD: the customer picks a USD amount, pays the BRL equivalent by Pix, and the USD amount is credited.
-- ALTER TABLE is not idempotent: run this file once.
ALTER TABLE payments ADD COLUMN amount_brl REAL NULL;     -- the exact BRL amount charged by Pix
ALTER TABLE payments ADD COLUMN fx_rate REAL NULL;        -- USD→BRL rate used (spread included)
ALTER TABLE payments ADD COLUMN pix_code TEXT NULL;       -- Pix copia-e-cola (point_of_interaction.transaction_data.qr_code)
ALTER TABLE payments ADD COLUMN checked_at TEXT NULL;     -- last GET /v1/payments/{id}
INSERT OR IGNORE INTO settings (key, value) VALUES ('pix_enabled', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('pix_min', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('pix_max', '500');
