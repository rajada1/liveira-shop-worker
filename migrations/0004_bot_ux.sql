-- Bot UX redesign. Applied 2026-09-29 via Cloudflare D1 API.
-- Invoice card message (edited in place when the payment is confirmed) and "continue purchase" context.
ALTER TABLE payments ADD COLUMN message_id INTEGER NULL;
ALTER TABLE payments ADD COLUMN resume TEXT NULL;   -- "<product_id>:<days>"
-- New default welcome text (only if the owner never customised the old default).
UPDATE settings SET value = 'Get your Liveira license in seconds.' || char(10) || 'Top up with crypto — your balance is credited automatically.'
 WHERE key = 'welcome_text'
   AND value = 'Buy products with your balance and receive a time-limited access token.' || char(10) || 'Use your token to unlock access in the Liveira program.' || char(10) || 'Balance is credited by the shop admin.';
