/* Shared Telegram UI building blocks (HTML parse mode, inline keyboards, BRT time). */
import { tgEsc as e, money, tgApi, acceptedCoins, coinsLabel } from "./util.js";

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
export const HOME = () => btn("🏠 Home", "home");
export function navRow(back) {
  return back && back !== "home" ? [btn("⬅️ Back", back), HOME()] : [HOME()];
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

export function daysLeftLabel(expiresAt) {
  const ms = Date.parse(expiresAt) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "expired";
  const h = ms / 3600000;
  if (h < 24) return `${Math.max(1, Math.ceil(h))} h left`;
  const d = Math.ceil(h / 24);
  return d === 1 ? "1 day left" : `${d} days left`;
}

export function formatDuration(days) {
  return Number(days) === 1 ? "1 day" : `${days} days`;
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

const STATUS_LINE = {
  creating: "⏳ Creating invoice…",
  pending: "🟡 Waiting for payment",
  paying: "🔵 Payment detected — waiting for blockchain confirmation",
  underpaid: "🟠 Underpaid — not credited automatically",
  expired: "⌛ Expired",
  canceled: "❌ Canceled",
  refunding: "↩️ Being refunded",
  refunded: "↩️ Refunded",
  error: "⚠️ Could not be created",
  failed: "❌ Payment failed",
  review: "🟠 Under review by the shop — not credited automatically",
};

const SP_STATUS_LINE = {
  pending: "🟡 Waiting for card payment",
  paying: "🔵 Payment processing",
  expired: "⌛ Payment link expired — your card was not charged",
};

/** Short network hint for the accepted coins ("" if nothing useful to add). */
export function networkHint(s) {
  return acceptedCoins(s).includes("USDT") ? " — pick your network on the page (e.g. TRC20 or BEP20)" : "";
}

/** "How it works" hint; texts adapt to the accepted_currencies setting. */
export function howItWorks(s, { pickAmount = false } = {}) {
  return (
    "<blockquote><b>How it works</b>\n" +
    `1. ${pickAmount ? "Pick an amount, tap" : "Tap"} <b>💳 Pay now</b> and pay with ${coinsLabel(s, { bold: true })}${networkHint(s)}.\n` +
    "2. Send the exact amount shown on the secure OxaPay page.\n" +
    "3. Your balance is credited automatically — usually within a few minutes.</blockquote>"
  );
}

/** "How it works" for Stripe card payments (hosted Checkout page). */
export function howItWorksSp() {
  return (
    "<blockquote><b>How it works</b>\n" +
    "1. Tap <b>💳 Pay by card</b> and enter your card on the secure Stripe page.\n" +
    "2. Your balance is credited automatically right after the payment is approved.\n" +
    "<i>Charged in US dollars — your bank may add a foreign-currency fee.</i></blockquote>"
  );
}

/** "How it works" for NOWPayments invoices (the customer chooses coin and network on the hosted page). */
export function howItWorksNp() {
  return (
    "<blockquote><b>How it works</b>\n" +
    "1. Tap <b>💳 Pay now</b> and choose any coin and network on the secure NOWPayments page.\n" +
    "2. Send the exact amount shown there.\n" +
    "3. Your balance is credited automatically once the network confirms the payment.</blockquote>"
  );
}

export function resumeParts(resume) {
  const m = /^([a-z0-9_-]{1,32}):(\d{1,4})$/.exec(String(resume || ""));
  return m ? { pid: m[1], days: Number(m[2]) } : null;
}

export function invoiceCard(pay, s, supportLine) {
  const cur = s.currency_symbol || "$";
  const st = pay.status;
  const open = st === "pending" || st === "paying";
  const np = pay.provider === "nowpayments";
  const sp = pay.provider === "stripe";
  let text = `🧾 <b>Top-up invoice · ${e(money(pay.amount_usd, cur))}</b>${np ? " · NOWPayments" : sp ? " · Card (Stripe)" : ""}\n\n`;
  text += `Status: <b>${(sp && SP_STATUS_LINE[st]) || STATUS_LINE[st] || e(st)}</b>\n`;
  if (open && pay.expires_at) {
    text += np
      ? `⏳ Open until <b>${e(fmtTimeBrt(pay.expires_at))}</b> (${tgRelTime(pay.expires_at, "24 h")})\n`
      : `⏳ ${sp ? "Payment link valid until" : "Expires at"} <b>${e(fmtTimeBrt(pay.expires_at))}</b> (${tgRelTime(pay.expires_at, "60 min")})\n`;
  }
  text += "\n";
  if (open) text += (np ? howItWorksNp() : sp ? howItWorksSp() : howItWorks(s)) + "\n";
  if (st === "canceled") text += sp ? "<i>The payment link was closed — your card was not charged.</i>\n\n" : "<i>If you already sent a payment, it will still be credited automatically.</i>\n\n";
  if (["underpaid", "refunding", "refunded", "failed", "review"].includes(st)) text += `${supportLine}\n\n`;
  text += `Ref: <code>${e(pay.id)}</code>`;
  const rows = [];
  if (open && pay.pay_link) rows.push([urlBtn(sp ? "💳 Pay by card" : "💳 Pay now", pay.pay_link, "success")]);
  if (open || (st === "canceled" && !sp)) rows.push([btn("🔄 I've paid · Check status", `tuchk:${pay.id}`, "primary")]);
  if (st === "pending") rows.push([btn("❌ Cancel", `tux:${pay.id}`, "danger")]);
  if (["expired", "canceled", "error", "failed"].includes(st)) rows.push([btn("💰 New top-up", "topup", "success")]);
  rows.push([HOME()]);
  return { text, reply_markup: kb(rows) };
}

export function paidCard(pay, s, newBalance) {
  const cur = s.currency_symbol || "$";
  const text =
    "✅ <b>Payment received!</b>\n\n" +
    `+<b>${e(money(pay.amount_usd, cur))}</b> added to your balance.\n` +
    `💰 New balance: <b>${e(money(newBalance, cur))}</b>\n\n` +
    `Ref: <code>${e(pay.id)}</code>`;
  const rows = [];
  const r = resumeParts(pay.resume);
  if (r) rows.push([btn("🛒 Continue purchase", `days:${r.pid}:${r.days}`, "success")]);
  rows.push([btn("🛒 Shop", "shop"), btn("👤 Profile", "profile")]);
  rows.push([HOME()]);
  return { text, reply_markup: kb(rows) };
}

/* ─── persistent reply keyboard (ReplyKeyboardMarkup) ─── */

/** Bump when the layout changes: chats with an older version get the new keyboard on their next message. */
export const REPLY_KB_VERSION = 1;

/** [label, route target, style] — same sections as the inline home grid. */
export const REPLY_KB_SECTIONS = [
  ["🛒 Shop", "shop", "primary"],
  ["💰 Top up", "topup", "success"],
  ["🔑 My licenses", "licenses"],
  ["📥 Downloads", "downloads"],
  ["👤 Profile", "profile"],
  ["💬 Support", "support"],
];

export const REPLY_KB_TEXT = "⌨️ Your menu is pinned below the chat — tap a section anytime.";

export function replyKeyboard() {
  const buttons = REPLY_KB_SECTIONS.map(([text, , style]) => (style ? { text, style } : { text }));
  return {
    keyboard: grid(buttons, 2),
    is_persistent: true,
    resize_keyboard: true,
    input_field_placeholder: "Pick a section or type an amount",
  };
}

const normLabel = (t) =>
  String(t || "")
    .replace(/[\uFE0E\uFE0F\u200D]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const KB_LOOKUP = new Map();
for (const [text, target] of REPLY_KB_SECTIONS) {
  KB_LOOKUP.set(normLabel(text), target); // exact button text
  KB_LOOKUP.set(normLabel(text.replace(/^\S+\s+/, "")), target); // same label typed without the emoji
}
KB_LOOKUP.set("licenses", "licenses");
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
