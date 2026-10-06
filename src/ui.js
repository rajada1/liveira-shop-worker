/* Shared Telegram UI building blocks (HTML parse mode, inline keyboards, BRT time). */
import { tgEsc as e, money, tgApi, acceptedCoins, coinsLabel } from "./util.js";
import { t, DICT } from "./i18n.js";

/* ─── buttons ─── */

export function btn(text, data, style) {
  const b = { text, callback_data: data };
  if (style) b.style = style; // Bot API: "primary" | "success" | "danger"
  return b;
}
export function urlBtn(text, url, style) {
  const b = { text, url };
  if (style) b.style = style;
  return b;
}
export function copyBtn(text, copy) {
  return { text, copy_text: { text: String(copy).slice(0, 256) } };
}
export const HOME = (L = "en") => btn(t(L, "btn.home"), "home");
export function navRow(back, L = "en") {
  return back && back !== "home" ? [btn(t(L, "btn.back"), back), HOME(L)] : [HOME(L)];
}
export function kb(rows) {
  return { inline_keyboard: rows.filter((r) => r && r.length) };
}
export function grid(buttons, perRow) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}

/* ─── time (America/Sao_Paulo, UTC-3, no DST) ─── */

function brtParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const b = new Date(d.getTime() - 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    dd: pad(b.getUTCDate()),
    mm: pad(b.getUTCMonth() + 1),
    yyyy: b.getUTCFullYear(),
    HH: pad(b.getUTCHours()),
    MM: pad(b.getUTCMinutes()),
  };
}
export function fmtDateTimeBrt(iso) {
  const p = brtParts(iso);
  return p ? `${p.dd}/${p.mm}/${p.yyyy} ${p.HH}:${p.MM} BRT` : String(iso || "—");
}
export function fmtShortBrt(iso) {
  const p = brtParts(iso);
  return p ? `${p.dd}/${p.mm} ${p.HH}:${p.MM}` : "—";
}
export function fmtTimeBrt(iso) {
  const p = brtParts(iso);
  return p ? `${p.HH}:${p.MM} BRT` : "—";
}
/** Telegram date-time entity: clients render a live relative time ("in 45 minutes"); fallback text otherwise. */
export function tgRelTime(iso, fallback) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return e(fallback || "");
  return `<tg-time unix="${Math.floor(t / 1000)}" format="r">${e(fallback || fmtTimeBrt(iso))}</tg-time>`;
}

export function daysLeftLabel(expiresAt, L = "en") {
  const ms = Date.parse(expiresAt) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return t(L, "left.expired");
  const h = ms / 3600000;
  if (h < 24) return t(L, "left.hours", { n: Math.max(1, Math.ceil(h)) });
  const d = Math.ceil(h / 24);
  return d === 1 ? t(L, "left.one_day") : t(L, "left.days", { n: d });
}

export function formatDuration(days, L = "en") {
  return Number(days) === 1 ? t(L, "dur.one") : t(L, "dur.many", { n: days });
}

/* ─── messaging ─── */

export const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

export async function sendMessage(env, chatId, text, extra = {}) {
  return tgApi(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...NO_PREVIEW, ...extra });
}

/**
 * Edit a message in place; "message is not modified" counts as success.
 * If the message can't be edited (deleted, a document, too old…), send a new one.
 * Returns { ok, message_id }.
 */
export async function editOrSend(env, chatId, messageId, text, extra = {}, { fallback = true } = {}) {
  if (messageId) {
    const r = await tgApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      ...NO_PREVIEW,
      ...extra,
    });
    if (r.ok) return { ok: true, message_id: r.result?.message_id || messageId, edited: true };
    if (/not modified/i.test(r.description || "")) return { ok: true, message_id: messageId, edited: true };
    if (!fallback) return { ok: false };
  }
  const s = await sendMessage(env, chatId, text, extra);
  return { ok: !!s.ok, message_id: s.result?.message_id || null, edited: false };
}

/* ─── invoice cards (used by the bot and by the OxaPay callback) ─── */

const STATUS_KEYS = ["creating", "pending", "paying", "underpaid", "expired", "canceled", "refunding", "refunded", "error", "failed", "review"];
const SP_STATUS_KEYS = ["pending", "paying", "expired"];
function statusLine(st, sp, L) {
  if (sp && SP_STATUS_KEYS.includes(st)) return t(L, `card.sp.${st}`);
  return STATUS_KEYS.includes(st) ? t(L, `card.st.${st}`) : e(st);
}

/** Short network hint for the accepted coins ("" if nothing useful to add). */
export function networkHint(s, L = "en") {
  return acceptedCoins(s).includes("USDT") ? t(L, "card.net_hint") : "";
}

/** "How it works" hint; texts adapt to the accepted_currencies setting. */
export function howItWorks(s, { pickAmount = false } = {}, L = "en") {
  const vars = { coins: coinsLabel(s, { bold: true, lang: L }), net: networkHint(s, L) };
  return t(L, "how.title") + t(L, pickAmount ? "how.ox1_pick" : "how.ox1", vars) + t(L, "how.ox2") + t(L, "how.ox3");
}

/** "How it works" for Stripe card payments (hosted Checkout page). */
export function howItWorksSp(L = "en") {
  return t(L, "how.title") + t(L, "how.sp1") + t(L, "how.sp2") + t(L, "how.sp3");
}

/** "How it works" for NOWPayments invoices (the customer chooses coin and network on the hosted page). */
export function howItWorksNp(L = "en") {
  return t(L, "how.title") + t(L, "how.np1") + t(L, "how.np2") + t(L, "how.np3");
}

export function resumeParts(resume) {
  const m = /^([a-z0-9_-]{1,32}):(\d{1,4})$/.exec(String(resume || ""));
  return m ? { pid: m[1], days: Number(m[2]) } : null;
}

export function invoiceCard(pay, s, supportLine, L = "en") {
  const cur = s.currency_symbol || "$";
  const st = pay.status;
  const open = st === "pending" || st === "paying";
  const np = pay.provider === "nowpayments";
  const sp = pay.provider === "stripe";
  let text = t(L, "card.title", { amt: e(money(pay.amount_usd, cur)), sfx: np ? " · NOWPayments" : sp ? t(L, "card.sfx_sp") : "" });
  text += t(L, "card.status", { st: statusLine(st, sp, L) });
  if (open && pay.expires_at) {
    const at = e(fmtTimeBrt(pay.expires_at));
    text += np
      ? t(L, "card.np_open", { at, rel: tgRelTime(pay.expires_at, "24 h") })
      : t(L, sp ? "card.sp_open" : "card.ox_open", { at, rel: tgRelTime(pay.expires_at, "60 min") });
  }
  text += "\n";
  if (open) text += (np ? howItWorksNp(L) : sp ? howItWorksSp(L) : howItWorks(s, {}, L)) + "\n";
  if (st === "canceled") text += t(L, sp ? "card.sp_canceled" : "card.canceled");
  if (["underpaid", "refunding", "refunded", "failed", "review"].includes(st)) text += `${supportLine}\n\n`;
  text += `Ref: <code>${e(pay.id)}</code>`;
  const rows = [];
  if (open && pay.pay_link) rows.push([urlBtn(t(L, sp ? "btn.pay_card" : "btn.pay_now"), pay.pay_link, "success")]);
  if (open || (st === "canceled" && !sp)) rows.push([btn(t(L, "btn.check"), `tuchk:${pay.id}`, "primary")]);
  if (st === "pending") rows.push([btn(t(L, "btn.cancel"), `tux:${pay.id}`, "danger")]);
  if (["expired", "canceled", "error", "failed"].includes(st)) rows.push([btn(t(L, "btn.new_topup"), "topup", "success")]);
  rows.push([HOME(L)]);
  return { text, reply_markup: kb(rows) };
}

export function paidCard(pay, s, newBalance, L = "en") {
  const cur = s.currency_symbol || "$";
  const text = t(L, "paid.text", { amt: e(money(pay.amount_usd, cur)), bal: e(money(newBalance, cur)), ref: e(pay.id) });
  const rows = [];
  const r = resumeParts(pay.resume);
  if (r) rows.push([btn(t(L, "btn.continue_purchase"), `days:${r.pid}:${r.days}`, "success")]);
  rows.push([btn(t(L, "btn.shop"), "shop"), btn(t(L, "btn.profile"), "profile")]);
  rows.push([HOME(L)]);
  return { text, reply_markup: kb(rows) };
}

/* ─── persistent reply keyboard (ReplyKeyboardMarkup) ─── */

/** Bump when the layout changes: chats with an older version get the new keyboard on their next message.
 * The stored chat_nav.kb_version also encodes the language (kbVersion), so switching language refreshes it. */
export const REPLY_KB_VERSION = 2;
export function kbVersion(L = "en") {
  return REPLY_KB_VERSION * 10 + (L === "pt" ? 1 : 0); // 20 = English, 21 = Português
}

/** [label key, route target, style] — same sections as the inline home grid. */
export const REPLY_KB_SECTIONS = [
  ["btn.shop", "shop", "primary"],
  ["btn.topup", "topup", "success"],
  ["btn.licenses", "licenses"],
  ["btn.downloads", "downloads"],
  ["btn.profile", "profile"],
  ["btn.support", "support"],
];

export function replyKeyboardText(L = "en") {
  return t(L, "kb.text");
}

export function replyKeyboard(L = "en") {
  const buttons = REPLY_KB_SECTIONS.map(([key, , style]) => (style ? { text: t(L, key), style } : { text: t(L, key) }));
  return {
    keyboard: grid(buttons, 2),
    is_persistent: true,
    resize_keyboard: true,
    input_field_placeholder: t(L, "kb.placeholder"),
  };
}

const normLabel = (x) =>
  String(x || "")
    .replace(/[\uFE0E\uFE0F\u200D]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

// Labels of BOTH languages are recognised: a chat may still show the keyboard of the previous language.
const KB_LOOKUP = new Map();
for (const dict of Object.values(DICT)) {
  for (const [key, target] of REPLY_KB_SECTIONS) {
    const text = dict[key];
    KB_LOOKUP.set(normLabel(text), target); // exact button text
    KB_LOOKUP.set(normLabel(text.replace(/^\S+\s+/, "")), target); // same label typed without the emoji
  }
}
KB_LOOKUP.set("licenses", "licenses");
KB_LOOKUP.set("licenças", "licenses");
KB_LOOKUP.set("top-up", "topup");
KB_LOOKUP.set("topup", "topup");

/** Route target for a reply-keyboard button text (or the same label typed by hand), else null. */
export function keyboardTarget(text) {
  return KB_LOOKUP.get(normLabel(text)) || null;
}

/** deleteMessage, ignoring every error (e.g. messages older than 48 h can't be deleted). */
export async function deleteMessageQuiet(env, chatId, messageId) {
  if (!chatId || !messageId) return false;
  try {
    const r = await tgApi(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
    return !!r?.ok;
  } catch {
    return false;
  }
}
