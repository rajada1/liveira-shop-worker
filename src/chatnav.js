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

/**
 * Record many sent messages with ONE D1 query (admin broadcast: a per-recipient noteMessage would exceed
 * D1's per-request query limit). entries: [{ chatId, messageId }]. Chunked to stay under D1's 100 bound
 * parameters per statement. Never throws.
 */
export async function noteMessages(env, entries) {
  const list = (entries || [])
    .map((x) => [Number(x?.chatId), Number(x?.messageId)])
    .filter(([c, m]) => c > 0 && m > 0);
  if (!env?.DB || !list.length) return;
  const at = nowIso();
  for (let i = 0; i < list.length; i += 30) {
    const chunk = list.slice(i, i + 30);
    try {
      await env.DB.prepare(
        `INSERT INTO chat_nav (chat_id, last_msg_id, updated_at) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}
         ON CONFLICT(chat_id) DO UPDATE SET last_msg_id = MAX(last_msg_id, excluded.last_msg_id), updated_at = excluded.updated_at`
      )
        .bind(...chunk.flatMap(([c, m]) => [c, m, at]))
        .run();
    } catch {
      /* table missing (migration 0006 not applied) — ignore */
    }
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

/**
 * Compare-and-set the current menu: only succeeds while menu_msg_id still equals `expected` (null = none).
 * Guards against rapid double taps: two requests that read the same old menu both send a new screen, but
 * only one of them can claim it; the other sees false and resolves the conflict (see show() in bot.js).
 * Returns true (claimed), false (another request changed the menu first) or null (table missing / error).
 */
export async function claimMenu(env, chatId, expected, messageId) {
  const m = messageId ? Number(messageId) : null;
  const exp = expected ? Number(expected) : null;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO chat_nav (chat_id, menu_msg_id, last_msg_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET menu_msg_id = excluded.menu_msg_id,
         last_msg_id = MAX(last_msg_id, excluded.last_msg_id), updated_at = excluded.updated_at
       WHERE chat_nav.menu_msg_id IS ?`
    )
      .bind(Number(chatId), m, m || 0, nowIso(), exp)
      .run();
    return (r?.meta?.changes || 0) > 0;
  } catch {
    return null;
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
