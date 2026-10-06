-- Per-user language (src/i18n.js) + order kind (free trial). NOT idempotent (ALTER TABLE ADD COLUMN): run ONCE.
-- Running it again fails on the first ALTER ("duplicate column name") and changes nothing.
--  users.lang         'pt' | 'en' — bot language for this user
--  users.lang_chosen  0 = never picked (first contact shows the bilingual picker before anything else), 1 = picked
--  orders.kind        'paid' (balance purchase) | 'free_trial' ($0 order created by the free trial)
-- Existing users already used the bot in English: backfill them as English + picked, so nothing changes for them
-- (they can switch with 🌐 / /idioma / /language).
ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'pt';
ALTER TABLE users ADD COLUMN lang_chosen INTEGER NOT NULL DEFAULT 0;
UPDATE users SET lang = 'en', lang_chosen = 1;
ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'paid';
