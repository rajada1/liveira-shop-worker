-- Applied 2026-09-29 via Cloudflare D1 API (idempotent)
CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, file_key TEXT NULL, file_name TEXT NULL, file_size INTEGER NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS product_prices (product_id TEXT NOT NULL, days INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY (product_id, days));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, details_json TEXT);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_topups_user ON topups(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
INSERT OR IGNORE INTO products (id, name, description, active, sort, created_at, updated_at) VALUES ('liveira_access','Liveira Access','Access license for the Liveira program. Pick how many days you need.',1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO product_prices (product_id, days, price) VALUES ('liveira_access',3,5.0),('liveira_access',7,10.0),('liveira_access',30,25.0);
INSERT OR IGNORE INTO settings (key, value) VALUES ('shop_name','Liveira Shop'),('support_contact',''),('currency_symbol','$'),('maintenance_mode','0'),('maintenance_text','The shop is under maintenance. Please try again later.');
-- welcome_text seeded separately (multi-line)
ALTER TABLE products ADD COLUMN file_tg_id TEXT NULL;
ALTER TABLE products ADD COLUMN file_type TEXT NULL;
ALTER TABLE products ADD COLUMN file_uploaded_at TEXT NULL;
