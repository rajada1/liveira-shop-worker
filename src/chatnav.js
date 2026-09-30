/* Per-chat navigation state (table chat_nav, migration 0006).
 *  - menu_msg_id: the current navigation menu message (edited in place while it is the latest message,
 *    otherwise moved: re-sent at the bottom and the old one deleted).
 *  - last_msg_id: highest message id seen in the chat, incoming or outgoing. Message ids in a private chat
 *    are sequential for both sides, so the menu is "the latest message" iff menu_msg_id >= last_msg_id.
 *  - kb_msg_id / kb_version: the message that carries the persistent reply keyboard.
 * Every function degrades gracefully when the table does not exist yet (migration not applied): callers
 * then fall back to the previous edit-in-place behaviour. No imports from util.js (util calls noteMessage). */

const nowIso = () => new Date().toISOString();

/** Record a message id seen in a private chat (bot send or incoming user message). Never throws. */
export async function noteMessage(env, chatId, messageId) {
  const c = Number(chatId), m = Number(messageId);
  if (!env?.DB || !(c > 0) || !(m > 0)) return;
  try {
    await env.DB.prepare(
      `INSERT INTO chat_nav (chat_id, last_msg_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET last_msg_id = MAX(last_msg_id, excluded.last_msg_id), updated_at = excluded.updated_at`
    )
      .bind(c, m, nowIso())
      .run();
  } catch {
    /* table missing (migration 0006 not applied) — ignore */
  }
}

/** Returns { available, row } — available=false when the table is missing. */
export async function getNav(env, chatId) {
  try {
    const row = await env.DB.prepare("SELECT * FROM chat_nav WHERE chat_id=?").bind(Number(chatId)).first();
    return { available: true, row: row || null };
  } catch {
    return { available: false, row: null };
  }
}

/** Set (or clear with null) the current menu message. */
export async function setMenu(env, chatId, messageId) {
  const m = messageId ? Number(messageId) : null;
  try {
    await env.DB.prepare(
      `INSERT INTO chat_nav (chat_id, menu_msg_id, last_msg_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET menu_msg_id = excluded.menu_msg_id,
         last_msg_id = MAX(last_msg_id, excluded.last_msg_id), updated_at = excluded.updated_at`
    )
      .bind(Number(chatId), m, m || 0, nowIso())
      .run();
  } catch {
    /* ignore */
  }
}

export async function setKeyboardMessage(env, chatId, messageId, version) {
  try {
    await env.DB.prepare(
      `INSERT INTO chat_nav (chat_id, kb_msg_id, kb_version, last_msg_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET kb_msg_id = excluded.kb_msg_id, kb_version = excluded.kb_version,
         last_msg_id = MAX(last_msg_id, excluded.last_msg_id), updated_at = excluded.updated_at`
    )
      .bind(Number(chatId), Number(messageId), Number(version), Number(messageId), nowIso())
      .run();
  } catch {
    /* ignore */
  }
}
