-- Persistent reply keyboard + "active screen follows the user" (bot navigation state per private chat).
-- Not applied automatically: see DEPLOY_NOTES.md. The bot falls back to edit-in-place while this table is missing.
CREATE TABLE IF NOT EXISTS chat_nav (
  chat_id INTEGER PRIMARY KEY,          -- private chat id (= Telegram user id)
  menu_msg_id INTEGER NULL,             -- current navigation menu message (moved to the bottom when not latest)
  last_msg_id INTEGER NOT NULL DEFAULT 0, -- highest message id seen in the chat (incoming or outgoing)
  kb_msg_id INTEGER NULL,               -- message carrying the persistent reply keyboard
  kb_version INTEGER NOT NULL DEFAULT 0, -- reply keyboard layout version last sent
  updated_at TEXT NULL
);
