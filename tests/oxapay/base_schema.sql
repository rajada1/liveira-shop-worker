CREATE TABLE users (user_id INTEGER PRIMARY KEY, username TEXT, balance REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL, price REAL NOT NULL, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT, duration_days INTEGER);
CREATE TABLE topups (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount REAL NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE tokens (token TEXT PRIMARY KEY, product_id TEXT NOT NULL, product_name TEXT NOT NULL, telegram_user_id INTEGER, duration_days INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
CREATE TABLE token_machines (token TEXT PRIMARY KEY, machine_id TEXT NOT NULL, bound_at TEXT NOT NULL);
