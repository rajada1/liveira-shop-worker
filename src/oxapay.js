/* OxaPay crypto top-ups: invoice creation, callback (IPN) verification, idempotent crediting.
 * Docs (v1): https://docs.oxapay.com
 *  - POST https://api.oxapay.com/v1/payment/invoice   (header merchant_api_key)
 *  - GET  https://api.oxapay.com/v1/payment/{track_id}
 *  - Callback: POST JSON to callback_url, header HMAC = hex(HMAC-SHA512(raw body, MERCHANT_API_KEY)).
 *    Must answer HTTP 200 with body "ok" (retried up to 5 times otherwise).
 *  - Statuses: new, waiting, paying, paid, manual_accept, underpaid, refunding, refunded, expired
 *    (callbacks use capitalised forms, e.g. "Paying" / "Paid").
 */
import { nowIso, generateToken, money, audit, tgApi, getSettings, tgEsc } from "./util.js";

export const PUBLIC_BASE_URL = "https://liveira-shop.kelumayou.workers.dev";
const DEFAULT_API = "https://api.oxapay.com/v1";
export const INVOICE_LIFETIME_MIN = 60;
const MAX_OPEN_INVOICES = 5; // per user, per hour
const MAX_BODY = 64 * 1024;
const enc = new TextEncoder();

const CREDIT_STATUSES = new Set(["paid", "manual_accept"]);
const REFUND_STATUSES = new Set(["refunding", "refunded"]);

function apiBase(env) {
  return (env.OXAPAY_API_BASE || DEFAULT_API).replace(/\/+$/, "");
}
function merchantKey(env) {
  return String(env.OXAPAY_MERCHANT_KEY || "").trim();
}
export function callbackUrl(env) {
  return `${(env.PUBLIC_BASE_URL || PUBLIC_BASE_URL).replace(/\/+$/, "")}/oxapay/callback`;
}

/* ─── config (from settings) ─── */

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function topupConfig(s, env) {
  let min = Number(s.topup_min);
  if (!Number.isFinite(min) || min <= 0) min = 1;
  let max = Number(s.topup_max);
  if (!Number.isFinite(max) || max < min) max = Math.max(1000, min);
  const presets = [];
  for (const part of String(s.topup_presets || "").split(/[,;\s]+/)) {
    if (!part) continue;
    const n = round2(part);
    if (Number.isFinite(n) && n >= min && n <= max && !presets.includes(n)) presets.push(n);
  }
  const enabled = s.crypto_topup_enabled === "1";
  const configured = !!merchantKey(env);
  return { enabled, configured, available: enabled && configured, min, max, presets: presets.slice(0, 8) };
}

/** Parse a user-supplied amount ("12", "12.5", "$12,50"). Returns number or null. */
export function parseAmount(text) {
  const t = String(text || "").trim().replace(/^\$/, "").replace(/\s*(usd)?$/i, "").replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const n = round2(t);
  return Number.isFinite(n) ? n : null;
}

/* ─── time (BRT) ─── */

export function fmtBrt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  const b = new Date(d.getTime() - 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(b.getUTCDate())}/${pad(b.getUTCMonth() + 1)} ${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())} BRT`;
}

/* ─── HMAC ─── */

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha512Hex(key, raw) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, typeof raw === "string" ? enc.encode(raw) : raw));
}

function constEq(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export async function verifySignature(env, rawBytes, header) {
  const key = merchantKey(env);
  const got = String(header || "").trim().toLowerCase();
  if (!key || !/^[0-9a-f]{128}$/.test(got)) return false;
  const want = await hmacSha512Hex(key, rawBytes);
  return constEq(want, got);
}

/* ─── OxaPay API ─── */

async function oxapayFetch(env, method, path, body) {
  const res = await fetch(`${apiBase(env)}${path}`, {
    method,
    headers: { merchant_api_key: merchantKey(env), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  const ok = res.ok && Number(data.status) === 200 && data.data && typeof data.data === "object";
  if (!ok) {
    console.error("OxaPay API error", method, path, res.status, data?.status, data?.message, data?.error?.key);
  }
  return { ok, http: res.status, data };
}

let BOT_USERNAME = null;
async function botUsername(env) {
  if (BOT_USERNAME) return BOT_USERNAME;
  try {
    const r = await tgApi(env, "getMe", {});
    if (r.ok && r.result?.username) BOT_USERNAME = r.result.username;
  } catch {
    /* ignore */
  }
  return BOT_USERNAME;
}

function newPaymentId() {
  return `lv_${Date.now().toString(36)}_${generateToken().slice(0, 10)}`;
}

/** Mark invoices that are past their expiry (plus grace) as expired. OxaPay only calls back on paying/paid. */
export async function expireStale(env) {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  try {
    await env.DB.prepare(
      "UPDATE payments SET status='expired', updated_at=? WHERE credited=0 AND status IN ('pending','creating') AND expires_at IS NOT NULL AND expires_at < ?"
    )
      .bind(nowIso(), cutoff)
      .run();
  } catch (e) {
    console.error("expireStale failed", e);
  }
}

/**
 * Create an OxaPay invoice and a pending payments row.
 * Returns { ok, payment } or { ok:false, reason }.
 */
export async function createTopupInvoice(env, { userId, chatId, amount, shopName }) {
  if (!merchantKey(env)) return { ok: false, reason: "unconfigured" };
  await expireStale(env);
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM payments WHERE telegram_user_id=? AND status IN ('creating','pending') AND created_at >= ?"
  )
    .bind(userId, since)
    .first();
  if ((open?.n || 0) >= MAX_OPEN_INVOICES) return { ok: false, reason: "too_many" };

  const id = newPaymentId();
  const at = nowIso();
  await env.DB.prepare(
    `INSERT INTO payments (id, provider, telegram_user_id, chat_id, amount_usd, status, created_at, updated_at)
     VALUES (?, 'oxapay', ?, ?, ?, 'creating', ?, ?)`
  )
    .bind(id, userId, chatId ?? null, amount, at, at)
    .run();

  const uname = await botUsername(env);
  const body = {
    amount,
    currency: "USD",
    lifetime: INVOICE_LIFETIME_MIN,
    callback_url: callbackUrl(env),
    order_id: id,
    description: `${shopName || "Liveira Shop"} balance top-up ${money(amount, "$")} (Telegram user ${userId})`.slice(0, 250),
    thanks_message: "Thank you! Your balance will be credited automatically in the Telegram bot.",
    sandbox: false,
  };
  if (uname) body.return_url = `https://t.me/${uname}`;

  let r;
  try {
    r = await oxapayFetch(env, "POST", "/payment/invoice", body);
  } catch (e) {
    console.error("OxaPay invoice fetch failed", e);
    r = { ok: false, http: 0, data: {} };
  }
  const d = r.data?.data || {};
  if (!r.ok || !d.track_id || !d.payment_url) {
    const errInfo = { http: r.http, status: r.data?.status, message: r.data?.message, error: r.data?.error };
    await env.DB.prepare("UPDATE payments SET status='error', last_status=?, updated_at=? WHERE id=?")
      .bind(JSON.stringify(errInfo).slice(0, 1000), nowIso(), id)
      .run();
    await audit(env, `tg:${userId}`, "oxapay_invoice_failed", { payment_id: id, amount, ...errInfo });
    return { ok: false, reason: "api" };
  }
  const expiresAt = d.expired_at
    ? new Date(Number(d.expired_at) * 1000).toISOString()
    : new Date(Date.now() + INVOICE_LIFETIME_MIN * 60000).toISOString();
  await env.DB.prepare(
    "UPDATE payments SET status='pending', track_id=?, pay_link=?, expires_at=?, last_status='new', updated_at=? WHERE id=?"
  )
    .bind(String(d.track_id), String(d.payment_url), expiresAt, nowIso(), id)
    .run();
  await audit(env, `tg:${userId}`, "oxapay_invoice_created", { payment_id: id, track_id: String(d.track_id), amount });
  const payment = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(id).first();
  return { ok: true, payment };
}

/* ─── status processing (shared by callback, user "check" and admin sync) ─── */

async function notifyUser(env, chatId, text, extra = {}) {
  try {
    await tgApi(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  } catch (e) {
    console.error("notify failed", e);
  }
}

/**
 * Apply an OxaPay status to our payment row.
 * Crediting is exactly-once: the first statement flips credited 0→1 (and stamps a unique nonce);
 * every following statement in the same D1 batch (single transaction) only matches rows carrying that nonce,
 * so a duplicate / concurrent callback changes nothing.
 * Returns { action, payment, newBalance? }.
 */
export async function applyStatus(env, pay, rawStatus, payload, source) {
  const st = String(rawStatus || "").trim().toLowerCase();
  const at = nowIso();
  const payloadStr = payload ? JSON.stringify(payload).slice(0, 4000) : null;
  const DB = env.DB;

  if (CREDIT_STATUSES.has(st)) {
    const nonce = generateToken();
    const res = await DB.batch([
      DB.prepare(
        `UPDATE payments SET status='paid', credited=1, credit_nonce=?, paid_at=?, updated_at=?, last_status=?, last_payload=COALESCE(?, last_payload)
          WHERE id=? AND credited=0 AND status NOT IN ('creating','error')`
      ).bind(nonce, at, at, rawStatus, payloadStr, pay.id),
      DB.prepare(
        `INSERT OR IGNORE INTO users (user_id, username, balance, created_at)
         SELECT telegram_user_id, NULL, 0, ? FROM payments WHERE id=? AND credit_nonce=?`
      ).bind(at, pay.id, nonce),
      DB.prepare(
        `UPDATE users SET balance = ROUND(balance + (SELECT amount_usd FROM payments WHERE id=?1 AND credit_nonce=?2), 2)
          WHERE user_id = (SELECT telegram_user_id FROM payments WHERE id=?1 AND credit_nonce=?2)`
      ).bind(pay.id, nonce),
      DB.prepare(
        `INSERT INTO topups (user_id, amount, method, status, created_at, ref)
         SELECT telegram_user_id, amount_usd, 'oxapay', 'completed', ?, id FROM payments WHERE id=? AND credit_nonce=?`
      ).bind(at, pay.id, nonce),
      DB.prepare(
        `INSERT INTO audit_log (at, actor, action, details_json)
         SELECT ?, 'oxapay', 'oxapay_credit',
                json_object('payment_id', p.id, 'track_id', p.track_id, 'user_id', p.telegram_user_id,
                            'amount', p.amount_usd, 'new_balance', u.balance, 'status', ?, 'source', ?,
                            'paid_amount', ?, 'paid_currency', ?)
           FROM payments p LEFT JOIN users u ON u.user_id = p.telegram_user_id
          WHERE p.id=? AND p.credit_nonce=?`
      ).bind(
        at,
        String(rawStatus),
        source,
        payload?.amount != null ? String(payload.amount) : null,
        payload?.currency != null ? String(payload.currency) : null,
        pay.id,
        nonce
      ),
    ]);
    const won = res[0]?.meta?.changes === 1;
    if (!won) {
      // duplicate / already credited: just record the latest raw status
      await DB.prepare("UPDATE payments SET last_status=?, updated_at=? WHERE id=?").bind(rawStatus, at, pay.id).run();
      return { action: "duplicate" };
    }
    const u = await DB.prepare("SELECT balance FROM users WHERE user_id=?").bind(pay.telegram_user_id).first();
    const newBalance = Number(u?.balance || 0);
    return { action: "credited", newBalance, amount: Number(pay.amount_usd) };
  }

  if (REFUND_STATUSES.has(st)) {
    await DB.prepare(
      "UPDATE payments SET status=?, last_status=?, last_payload=COALESCE(?, last_payload), updated_at=? WHERE id=?"
    )
      .bind(st, rawStatus, payloadStr, at, pay.id)
      .run();
    await audit(env, "oxapay", pay.credited ? "oxapay_refund_after_credit" : "oxapay_refund", {
      payment_id: pay.id,
      track_id: pay.track_id,
      user_id: pay.telegram_user_id,
      amount: pay.amount_usd,
      status: rawStatus,
      source,
    });
    return { action: "refund" };
  }

  // Non-crediting statuses: only touch rows that were never credited.
  const map = { new: "pending", waiting: "pending", paying: "paying", underpaid: "underpaid", expired: "expired" };
  const next = map[st];
  if (next) {
    const r = await DB.prepare(
      `UPDATE payments SET status=?, last_status=?, last_payload=COALESCE(?, last_payload), updated_at=?
        WHERE id=? AND credited=0 AND status NOT IN ('creating','error')`
    )
      .bind(next, rawStatus, payloadStr, at, pay.id)
      .run();
    const changed = r.meta?.changes === 1 && pay.status !== next;
    if (changed && (next === "expired" || next === "underpaid")) {
      await audit(env, "oxapay", `oxapay_${next}`, { payment_id: pay.id, track_id: pay.track_id, user_id: pay.telegram_user_id, amount: pay.amount_usd, source });
    }
    return { action: changed ? next : "noop" };
  }
  await DB.prepare("UPDATE payments SET last_status=?, updated_at=? WHERE id=?").bind(String(rawStatus).slice(0, 64), at, pay.id).run();
  return { action: "unknown_status" };
}

export async function notifyCredit(env, pay, r) {
  const s = await getSettings(env);
  const cur = s.currency_symbol || "$";
  await notifyUser(
    env,
    pay.chat_id || pay.telegram_user_id,
    `✅ Payment confirmed, +${money(r.amount, cur)} added. New balance: ${money(r.newBalance, cur)}`,
    { reply_markup: { inline_keyboard: [[{ text: "Shop", callback_data: "shop" }], [{ text: "Menu", callback_data: "menu" }]] } }
  );
}

async function notifyUnderpaid(env, pay) {
  const s = await getSettings(env);
  const support = s.support_contact ? `Support: ${tgEsc(s.support_contact)}` : "Please contact the shop admin.";
  await notifyUser(
    env,
    pay.chat_id || pay.telegram_user_id,
    `⚠️ Your crypto payment for the ${money(pay.amount_usd, s.currency_symbol || "$")} top-up was underpaid, so it was not credited automatically.\n${support}`
  );
}

/** Query OxaPay for the current status of a payment and apply it (user "check" button / admin sync). */
export async function syncPayment(env, pay, source) {
  if (!pay.track_id) return { action: "no_track_id" };
  if (!merchantKey(env)) return { action: "unconfigured" };
  const r = await oxapayFetch(env, "GET", `/payment/${encodeURIComponent(pay.track_id)}`);
  if (!r.ok) return { action: "api_error" };
  const d = r.data.data;
  if (String(d.track_id) !== String(pay.track_id)) return { action: "mismatch" };
  if (d.order_id && String(d.order_id) !== pay.id) return { action: "mismatch" };
  const out = await applyStatus(env, pay, d.status, null, source);
  out.remoteStatus = d.status;
  if (out.action === "credited") await notifyCredit(env, pay, out);
  if (out.action === "underpaid") await notifyUnderpaid(env, pay);
  return out;
}

/* ─── POST /oxapay/callback ─── */

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function handleOxapayCallback(request, env, ctx) {
  if (!merchantKey(env)) return text("not configured", 503);
  const len = Number(request.headers.get("Content-Length") || "0");
  if (len > MAX_BODY) return text("too large", 413);
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY) return text("too large", 413);

  if (!(await verifySignature(env, raw, request.headers.get("HMAC")))) {
    console.warn("oxapay callback: invalid HMAC", request.headers.get("CF-Connecting-IP"));
    return text("Invalid HMAC signature", 401);
  }

  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return text("Invalid JSON", 400);
  }
  if (!data || typeof data !== "object") return text("Invalid JSON", 400);

  const trackId = data.track_id != null ? String(data.track_id) : "";
  const orderId = data.order_id != null ? String(data.order_id) : "";
  const type = String(data.type || "").toLowerCase();
  const rawStatus = String(data.status || "");

  if (type && type !== "invoice") {
    await audit(env, "oxapay", "oxapay_callback_ignored", { reason: "type", type, track_id: trackId, status: rawStatus });
    return text("ok");
  }

  // Match strictly on our record: track_id must match, and order_id (when present) must be our id.
  let pay = trackId ? await env.DB.prepare("SELECT * FROM payments WHERE track_id=?").bind(trackId).first() : null;
  if (!pay && orderId) {
    // Invoice-creation response may have been lost: accept by order_id only if we never stored a track_id.
    const byOrder = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(orderId).first();
    if (byOrder && !byOrder.track_id && trackId) {
      await env.DB.prepare("UPDATE payments SET track_id=?, status='pending', updated_at=? WHERE id=? AND track_id IS NULL")
        .bind(trackId, nowIso(), orderId)
        .run();
      pay = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(orderId).first();
    }
  }
  if (!pay || (orderId && orderId !== pay.id)) {
    await audit(env, "oxapay", "oxapay_callback_unmatched", {
      track_id: trackId,
      order_id: orderId,
      status: rawStatus,
      amount: data.amount,
      reason: pay ? "order_id_mismatch" : "unknown_track_id",
    });
    return text("ok");
  }

  const r = await applyStatus(env, pay, rawStatus, data, "callback");
  if (r.action === "credited") {
    const p = notifyCredit(env, pay, r);
    if (ctx?.waitUntil) ctx.waitUntil(p);
    else await p;
  } else if (r.action === "underpaid") {
    const p = notifyUnderpaid(env, pay);
    if (ctx?.waitUntil) ctx.waitUntil(p);
    else await p;
  }
  return text("ok");
}
