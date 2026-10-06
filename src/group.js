/* Community group (Telegram): mandatory membership ("gate") + live purchase feed.
 * Mirrors @LiveiraStore_bot (src/services/group.ts there):
 *  - settings: group_chat_id, group_invite_link, group_title, group_gate (default on), feed_purchases (default on);
 *    nothing is required while group_chat_id is empty;
 *  - gate: getChatMember (member / administrator / creator, or restricted with is_member) cached in D1
 *    (table group_members, migration 0011): 10 min when in the group, 30 s when not; refreshed by chat_member updates;
 *    admins are never blocked; unexpected Telegram errors let the user through (fail-open, sales never stop);
 *  - feed: "🛍 New purchase!" posted silently in the group — buyer shown only as a masked Telegram id (555***02),
 *    never the license key, price, balance, username, payment or order ids.
 * The bot must be an ADMIN of the group: Telegram only guarantees getChatMember for other users to admins, and only
 * admins receive chat_member updates. */
import { tgEsc as e, tgApi, setSetting, audit } from "./util.js";
import { btn, urlBtn, kb, formatDuration, sendMessage } from "./ui.js";
import { botUsername } from "./oxapay.js";
import { t } from "./i18n.js";

export const MEMBER_TTL_MS = 10 * 60_000;
export const NON_MEMBER_TTL_MS = 30_000;

/** Group settings → { chatId (number|null), inviteLink, title, gate, feedPurchases } */
export function groupConfig(s) {
  const raw = String(s?.group_chat_id ?? "").trim();
  const id = Number(raw);
  return {
    chatId: /^-?\d{5,20}$/.test(raw) && Number.isSafeInteger(id) && id !== 0 ? id : null,
    inviteLink: validInviteLink(s?.group_invite_link) ? String(s.group_invite_link).trim() : null,
    title: String(s?.group_title || "").trim() || null,
    gate: String(s?.group_gate ?? "1") === "1",
    feedPurchases: String(s?.feed_purchases ?? "1") === "1",
  };
}

export function validInviteLink(v) {
  return /^https:\/\/(t\.me|telegram\.me)\/[A-Za-z0-9_+\/-]{2,100}$/.test(String(v ?? "").trim());
}

export function gateActive(s) {
  const c = groupConfig(s);
  return c.chatId !== null && c.gate;
}

/** 721345616 → "721***16" (first 3 + *** + last 2). Short ids show less. Same rule as @LiveiraStore_bot. */
export function maskId(id) {
  const d = String(id ?? "").replace(/\D/g, "");
  if (d.length >= 6) return `${d.slice(0, 3)}***${d.slice(-2)}`;
  if (d.length >= 2) return `${d[0]}***${d.slice(-1)}`;
  return "***";
}

/** getChatMember / chat_member statuses that count as "in the group". */
export function isMemberStatus(m) {
  if (!m) return false;
  if (m.status === "creator" || m.status === "administrator" || m.status === "member") return true;
  if (m.status === "restricted") return m.is_member === true;
  return false;
}

async function cacheMember(env, chatId, userId, member) {
  try {
    await env.DB.prepare(
      `INSERT INTO group_members (chat_id, user_id, member, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET member=excluded.member, expires_at=excluded.expires_at`
    )
      .bind(chatId, userId, member ? 1 : 0, Date.now() + (member ? MEMBER_TTL_MS : NON_MEMBER_TTL_MS))
      .run();
  } catch (err) {
    console.error("group cache write failed (migration 0011 applied?)", err?.message || err);
  }
}

async function cachedMember(env, chatId, userId) {
  try {
    const r = await env.DB.prepare("SELECT member FROM group_members WHERE chat_id=? AND user_id=? AND expires_at > ?")
      .bind(chatId, userId, Date.now())
      .first();
    return r ? Number(r.member) === 1 : null;
  } catch {
    return null; // table missing → no cache, ask Telegram
  }
}

/** Basic group became a supergroup: switch the saved chat id (only if it is the configured group). */
export async function migrateGroup(env, s, fromId, toId) {
  const cfg = groupConfig(s);
  toId = Number(toId);
  if (cfg.chatId === null || cfg.chatId !== Number(fromId) || !Number.isSafeInteger(toId) || toId === 0) return false;
  await setSetting(env, "group_chat_id", String(toId));
  s.group_chat_id = String(toId);
  await audit(env, "system", "group_migrated", { from: fromId, to: toId });
  console.log("group migrated to supergroup", fromId, "→", toId);
  return true;
}

const NOT_IN_GROUP = /user not found|participant_id_invalid|member not found|user_id_invalid|user_not_participant/i;

/**
 * May this user use the shop? true when no group is configured, the gate is off, the user is an admin
 * (opts.admin) or is in the group. Cached (10 min positive / 30 s negative). opts.fresh skips the cache
 * ("✅ I've joined", free trial claim). opts.ignoreGate: check membership even when group_gate is off (free trial).
 * Unexpected Telegram errors → true (fail-open), not cached.
 */
export async function canUseShop(env, s, userId, opts = {}) {
  if (opts.admin) return true;
  const cfg = groupConfig(s);
  if (cfg.chatId === null || (!cfg.gate && !opts.ignoreGate)) return true;
  const chatId = cfg.chatId;
  if (!opts.fresh) {
    const c = await cachedMember(env, chatId, userId);
    if (c !== null) return c;
  }
  let r;
  try {
    r = await tgApi(env, "getChatMember", { chat_id: chatId, user_id: Number(userId) });
  } catch (err) {
    console.error("gate: getChatMember failed, letting the user in", err?.message || err);
    return true;
  }
  let member;
  if (r?.ok) member = isMemberStatus(r.result);
  else if (r?.parameters?.migrate_to_chat_id && !opts._migrated && (await migrateGroup(env, s, chatId, r.parameters.migrate_to_chat_id))) {
    return canUseShop(env, s, userId, { ...opts, _migrated: true });
  } else if (r?.error_code === 400 && NOT_IN_GROUP.test(r.description || "")) member = false;
  else {
    console.error("gate: getChatMember error, letting the user in", r?.error_code, r?.description);
    return true;
  }
  await cacheMember(env, chatId, userId, member);
  return member;
}

/** chat_member update for the configured group: joined → cache "member", left/kicked → drop the cache row. */
export async function onChatMemberUpdate(env, s, upd) {
  const cfg = groupConfig(s);
  if (cfg.chatId === null || Number(upd?.chat?.id) !== cfg.chatId) return;
  const user = upd.new_chat_member?.user;
  if (!user?.id || user.is_bot) return;
  if (isMemberStatus(upd.new_chat_member)) await cacheMember(env, cfg.chatId, user.id, true);
  else {
    try {
      await env.DB.prepare("DELETE FROM group_members WHERE chat_id=? AND user_id=?").bind(cfg.chatId, user.id).run();
    } catch {
      /* table missing */
    }
  }
}

function adminIdList(env) {
  return [...new Set(String(env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number))];
}

/** my_chat_member for the configured group: tell the admins when the bot is removed or loses admin rights. */
export async function onMyChatMember(env, s, upd) {
  const cfg = groupConfig(s);
  if (cfg.chatId === null || Number(upd?.chat?.id) !== cfg.chatId) return;
  const st = upd.new_chat_member?.status;
  const name = e(cfg.title || upd.chat?.title || "group");
  let text = null;
  if (st === "left" || st === "kicked") {
    text = `⚠️ The bot was removed from the community group <b>${name}</b>. Until it is added back as an admin, the group requirement is not enforced (everyone gets in) and purchases are not posted.`;
  } else if (st === "member" || (st === "restricted" && upd.old_chat_member?.status === "administrator")) {
    text = `⚠️ The bot is no longer an admin in the community group <b>${name}</b>. Without admin rights Telegram may not tell it who is in the group. Promote it again.`;
  }
  if (!text) return;
  for (const id of adminIdList(env)) await sendMessage(env, id, text).catch(() => {});
}

/* ─── gate screen ─── */

export const gateNotYet = (L = "en") => t(L, "gate.not_yet");
export const gateOk = (L = "en") => t(L, "gate.ok");

/** Deep-link payload kept through the gate (/start <payload> → jg:<payload>); [a-z0-9_], ≤ 40 chars. */
export function safePayload(p) {
  const x = String(p || "").trim().toLowerCase();
  return /^[a-z0-9_]{1,40}$/.test(x) ? x : "";
}

export function joinPromptScreen(s, payload = "", L = "en") {
  const cfg = groupConfig(s);
  const p = safePayload(payload);
  const rows = [];
  if (cfg.inviteLink) rows.push([urlBtn(t(L, "gate.btn_join"), cfg.inviteLink, "primary")]);
  rows.push([btn(t(L, "gate.btn_joined"), p ? `jg:${p}` : "jg", "success")]);
  return {
    text: t(L, "gate.title") + t(L, cfg.inviteLink ? "gate.with_link" : "gate.no_link"),
    reply_markup: kb(rows),
  };
}

/* ─── purchase feed ─── */

/** Text of the "New purchase!" post — never the license key, price, balance, username or ids (buyer id masked). */
export function purchaseFeedText({ productName, days, userId, total }) {
  return (
    "<blockquote><b>🛍 New purchase!</b>\n\n" +
    `🔑 <b>Product:</b> ${e(productName)}\n` +
    `⏳ <b>Plan:</b> ${e(formatDuration(Number(days) || 0))}\n` +
    `👤 <b>By:</b> <code>${maskId(userId)}</code>\n` +
    `📈 <b>Total purchases:</b> ${Number(total || 0).toLocaleString("en-US")}</blockquote>`
  );
}

/**
 * Post the purchase in the group (silent). Never throws: a failure is logged + audited and the purchase is
 * unaffected. Returns true when posted.
 */
export async function postPurchaseFeed(env, s, p) {
  try {
    const cfg = groupConfig(s);
    if (cfg.chatId === null || !cfg.feedPurchases) return false;
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders").first();
    const text = purchaseFeedText({ productName: p.productName, days: p.days, userId: p.userId, total: row?.n || 0 });
    const uname = await botUsername(env);
    const extra = { disable_notification: true };
    if (uname) extra.reply_markup = kb([[urlBtn("🛒 Open shop", `https://t.me/${uname}?start=shop`)]]);
    let r = await sendMessage(env, cfg.chatId, text, extra);
    if (!r?.ok && r?.parameters?.migrate_to_chat_id && (await migrateGroup(env, s, cfg.chatId, r.parameters.migrate_to_chat_id))) {
      r = await sendMessage(env, Number(r.parameters.migrate_to_chat_id), text, extra);
    }
    if (!r?.ok) {
      await audit(env, "system", "group_feed_failed", { error_code: r?.error_code ?? null, description: String(r?.description || "").slice(0, 200) });
      return false;
    }
    return true;
  } catch (err) {
    console.error("group feed failed", err?.message || err);
    await audit(env, "system", "group_feed_failed", { error: String(err?.message || err).slice(0, 200) });
    return false;
  }
}

/* ─── admin panel: check the configured group ─── */

export async function checkGroup(env, s) {
  const cfg = groupConfig(s);
  if (cfg.chatId === null) return { ok: false, reason: "unset" };
  const chat = await tgApi(env, "getChat", { chat_id: cfg.chatId });
  if (!chat.ok) {
    if (chat.parameters?.migrate_to_chat_id) await migrateGroup(env, s, cfg.chatId, chat.parameters.migrate_to_chat_id);
    return { ok: false, reason: "chat", description: chat.description || null, migrated_to: chat.parameters?.migrate_to_chat_id || null };
  }
  const c = chat.result || {};
  const botId = Number(String(env.BOT_TOKEN || "").split(":")[0]) || 0;
  const me = await tgApi(env, "getChatMember", { chat_id: cfg.chatId, user_id: botId });
  const m = me.ok ? me.result || {} : {};
  const status = m.status || "unknown";
  const admin = status === "administrator" || status === "creator";
  const basic = c.type === "group"; // in basic groups every admin has every right
  const right = (k) => admin && (basic || status === "creator" || m[k] !== false);
  const title = String(c.title || "").slice(0, 128);
  if (title && title !== (s.group_title || "")) await setSetting(env, "group_title", title);
  const warnings = [];
  if (!admin) warnings.push("O bot precisa ser ADMINISTRADOR do grupo (para conferir quem participa e ver quem entra/sai).");
  if (status === "left" || status === "kicked" || status === "unknown") warnings.push("O bot não está no grupo: adicione-o.");
  if (!cfg.inviteLink) warnings.push("Sem link de convite: o cliente não terá o botão \"Entrar no grupo\" (\"Join the group\").");
  return {
    ok: true,
    id: cfg.chatId,
    title,
    type: c.type || null,
    username: c.username || null,
    bot_status: status,
    is_admin: admin,
    can_invite: right("can_invite_users"),
    can_send: admin || status === "member" || (status === "restricted" && m.can_send_messages !== false),
    warnings,
  };
}
