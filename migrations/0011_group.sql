-- Community group (src/group.js): membership cache for the "join the group" requirement. Idempotent: safe to run again.
-- Settings live in `settings` with code defaults (group_chat_id empty = feature off; group_gate / feed_purchases = 1),
-- edited in the admin panel (Configurações → "Grupo da comunidade (Telegram)"). Nothing is seeded here.
CREATE TABLE IF NOT EXISTS group_members (
  chat_id INTEGER NOT NULL,             -- group chat id (negative)
  user_id INTEGER NOT NULL,             -- Telegram user id
  member INTEGER NOT NULL,              -- 1 = in the group, 0 = not
  expires_at INTEGER NOT NULL,          -- epoch ms: 10 min for members, 30 s for non-members
  PRIMARY KEY (chat_id, user_id)
);
