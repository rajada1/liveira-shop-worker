/* NOWPayments top-ups: hosted invoice (the customer picks coin + network on the NOWPayments page), signed IPN,
 * defense-in-depth status re-check, exactly-once crediting, cron fallback.
 * Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt
 *  - POST /v1/invoice            (x-api-key) { price_amount, price_currency, order_id, ipn_callback_url, success_url, … }
 *                                → { id (invoice id), invoice_url, … }
 *  - GET  /v1/payment/{id}       (x-api-key) → payment object (payment_id, invoice_id, order_id, payment_status, price_amount,
 *                                  price_currency, pay_amount, actually_paid, pay_currency, outcome_amount, outcome_currency, …)
 *  - GET  /v1/min-amount?currency_from=…&fiat_equivalent=usd → { min_amount, fiat_equivalent }
 *  - IPN: POST JSON (same shape as GET /payment), header x-nowpayments-sig =
 *         hex(HMAC-SHA512(JSON.stringify(body with keys sorted recursively), IPN secret)).
 *  - payment_status: waiting, confirming, confirmed, sending, partially_paid, finished, failed, refunded, expired.
 *
 * One invoice = one `payments` row (provider='nowpayments', id = our order_id 'np_…', track_id = 'np:<invoice id>').
 * One invoice can produce several NOWPayments payments (the customer switches coin, or pays twice): one `np_payments`
 * row per payment_id. Crediting is exactly-once per top-up (payments.credited 0→1 with a nonce, same batch pattern as
 * OxaPay); a second finished payment for an already credited top-up is never credited, only flagged to the admins.
 *
 * Amount credited: the top-up's USD amount (= invoice price_amount), only when NOWPayments reports `finished` AND
 * GET /v1/payment/{id} (API key) confirms finished, our order_id, price_currency=usd and the same price_amount, and
 * actually_paid ≥ 98 % of pay_amount. Overpayments credit the invoice amount (admins are told about the extra).
 * partially_paid → not credited, marked 'underpaid', customer + admins notified. failed/refunded → admins notified.
 */
import { nowIso, generateToken, money, audit, getSettings, setSetting, tgEsc as e } from "./util.js";
import { sendMessage, editOrSend, invoiceCard, HOME, kb } from "./ui.js";
import { hmacSha512Hex, notifyCredit, topupConfig, round2, expireStale, botUsername, PUBLIC_BASE_URL } from "./oxapay.js";

const DEFAULT_API = "https://api.nowpayments.io/v1";
export const NP_LIFETIME_H = 24; // our record of an unpaid invoice is closed after this (late payments still credit)
const FALLBACK_MIN = 15; // USD, used until the live minimum has been fetched
const MIN_REF_COINS = ["usdttrc20", "usdtbsc", "ltc", "trx"]; // popular coins; the shown minimum covers all of them
const MIN_MARGIN = 1.1; // +10 % so rate moves don't push a fresh invoice below the coin minimum
const MIN_TTL_MS = 6 * 3600 * 1000;
const UNDERPAY_TOLERANCE = 0.98;
const OVERPAY_NOTE = 1.02;
const POLL_AFTER_MS = 3 * 60 * 1000; // cron re-checks a payment with no news for 3 min
const POLL_BATCH = 5;
const POLL_MAX_AGE_MS = 3 * 86400 * 1000;
const POLL_MAX_ERRORS = 5;
const USER_CHECK_GAP_MS = 10 * 1000;
const MAX_OPEN_INVOICES = 5; // per user per hour (all invoice providers)
const MAX_BODY = 64 * 1024;
const enc = new TextEncoder();

export const NP_POLL_STATUSES = ["waiting", "confirming", "confirmed", "sending", "partially_paid", "finished"];
const RANK = { waiting: 1, confirming: 2, confirmed: 3, sending: 4, partially_paid: 5, expired: 8, finished: 9, failed: 9, refunded: 9 };
const RANK_SQL = `CASE status ${Object.entries(RANK).map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(" ")} ELSE 0 END`;

/* ─── config ─── */

function apiBase(env) {
  return String(env.NOWPAYMENTS_API_BASE || DEFAULT_API).replace(/\/+$/, "");
}
const apiKey = (env) => String(env.NOWPAYMENTS_API_KEY || "").trim();
const ipnSecret = (env) => String(env.NOWPAYMENTS_IPN_SECRET || "").trim();

export function npConfigured(env) {
  return !!(apiKey(env) && ipnSecret(env));
}

export function ipnUrl(env) {
  return `${String(env.PUBLIC_BASE_URL || PUBLIC_BASE_URL).replace(/\/+$/, "")}/nowpayments/ipn`;
}

/** { enabled, configured, available, min, max, presets, minSource, autoMin } — min = max(topup_min, manual or live min). */
export function npConfig(s, env) {
  const tc = topupConfig(s, env);
  const enabled = s.nowpayments_enabled === "1";
  const configured = npConfigured(env);
  const manual = Number(s.nowpayments_min);
  const auto = Number(s.nowpayments_min_auto);
  const hasManual = Number.isFinite(manual) && manual > 0;
  const hasAuto = Number.isFinite(auto) && auto > 0;
  const base = hasManual ? manual : hasAuto ? auto : FALLBACK_MIN;
  const min = round2(Math.max(tc.min, base));
  const max = tc.max;
  const presets = [];
  for (const a of [Math.ceil(min), ...tc.presets]) if (a >= min && a <= max && !presets.includes(a)) presets.push(a);
  presets.sort((a, b) => a - b);
  return {
    enabled,
    configured,
    available: enabled && configured && max >= min,
    min,
    max,
    presets: presets.slice(0, 4),
    minSource: hasManual ? "manual" : hasAuto ? "auto" : "fallback",
    autoMin: hasAuto ? auto : null,
  };
}

/* ─── API ─── */

async function npFetch(env, method, path, body) {
  let res;
  try {
    res = await fetch(`${apiBase(env)}${path}`, {
      method,
      headers: { "x-api-key": apiKey(env), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    console.error("NOWPayments fetch failed", method, path.split("?")[0], String(err).slice(0, 120));
    return { ok: false, http: 0, data: null };
  }
  const data = await res.json().catch(() => null);
  const ok = res.ok && !!data && typeof data === "object";
  if (!ok) console.error("NOWPayments API error", method, path.split("?")[0], res.status, data?.code, String(data?.message || "").slice(0, 160));
  return { ok, http: res.status, data };
}

export async function npApiStatus(env) {
  const r = await npFetch(env, "GET", "/status");
  return { ok: r.ok && String(r.data?.message || "").toUpperCase() === "OK", http: r.http };
}

// min-amount depends on the payout currency (the conversion leg); without currency_to NOWPayments answers ~$0.10, which is
// meaningless. The store payout is USDT TRC20 unless NOWPAYMENTS_PAYOUT_CURRENCY (plain var) says otherwise.
function payoutTo(env) {
  const v = String(env.NOWPAYMENTS_PAYOUT_CURRENCY || "").trim().toLowerCase();
  return /^[a-z0-9]{2,20}$/.test(v) ? v : "usdttrc20";
}

/** Live minimum (USD) over MIN_REF_COINS, +10 %, rounded up to whole dollars; cached in settings for 6 h. */
export async function refreshNpMin(env, s, { force = false } = {}) {
  if (!apiKey(env)) return { ok: false, reason: "unconfigured" };
  const at = Number(s.nowpayments_min_auto_at || 0);
  if (!force && Date.now() - at < MIN_TTL_MS) return { ok: true, cached: true, min: Number(s.nowpayments_min_auto) || null };
  await setSetting(env, "nowpayments_min_auto_at", String(Date.now())); // claim the slot first (no stampede)
  const rs = await Promise.all(MIN_REF_COINS.map((c) => npFetch(env, "GET", `/min-amount?currency_from=${c}&currency_to=${encodeURIComponent(payoutTo(env))}&fiat_equivalent=usd`)));
  const per = {};
  rs.forEach((r, i) => {
    const v = Number(r.data?.fiat_equivalent);
    if (r.ok && Number.isFinite(v) && v > 0 && v < 100000) per[MIN_REF_COINS[i]] = Math.round(v * 100) / 100;
  });
  const vals = Object.values(per);
  if (!vals.length) return { ok: false, reason: "api" };
  const raw = Math.max(...vals);
  const min = Math.ceil(raw * MIN_MARGIN);
  if (String(min) !== String(s.nowpayments_min_auto)) await setSetting(env, "nowpayments_min_auto", String(min));
  s.nowpayments_min_auto = String(min);
  return { ok: true, min, raw, per };
}

/* ─── IPN signature ─── */

export function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  }
  return v;
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

/**
 * x-nowpayments-sig = hex HMAC-SHA512 of JSON.stringify(keys sorted recursively). The older docs snippet
 * JSON.stringify(params, Object.keys(params).sort()) is accepted too (same secret; it only differs for nested objects).
 */
export async function verifyNpSignature(env, data, header) {
  const secret = ipnSecret(env);
  const got = String(header || "").trim().toLowerCase();
  if (!secret || !/^[0-9a-f]{128}$/.test(got) || !data || typeof data !== "object" || Array.isArray(data)) return false;
  if (constEq(await hmacSha512Hex(secret, JSON.stringify(sortDeep(data))), got)) return true;
  return constEq(await hmacSha512Hex(secret, JSON.stringify(data, Object.keys(data).sort())), got);
}

/* ─── invoices ─── */

function newOrderId() {
  return `np_${Date.now().toString(36)}_${generateToken().slice(0, 10).replace(/[^A-Za-z0-9]/g, "x")}`;
}

/** Create a NOWPayments invoice + pending payments row. → { ok, payment, reused? } | { ok:false, reason, min?, max? } */
export async function createNpInvoice(env, s, { userId, chatId, amount, resume }) {
  const npc = npConfig(s, env);
  if (!npc.available) return { ok: false, reason: "unconfigured" };
  if (!Number.isFinite(amount) || amount < npc.min) return { ok: false, reason: "min", min: npc.min };
  if (amount > npc.max) return { ok: false, reason: "max", max: npc.max };
  await expireStale(env);
  resume = /^[a-z0-9_-]{1,32}:\d{1,4}$/.test(String(resume || "")) ? String(resume) : null;
  const reuse = await env.DB.prepare(
    `SELECT * FROM payments p WHERE provider='nowpayments' AND telegram_user_id=? AND amount_usd=? AND status='pending' AND credited=0
       AND pay_link IS NOT NULL AND expires_at > ? AND NOT EXISTS (SELECT 1 FROM np_payments n WHERE n.order_id=p.id)
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(userId, amount, new Date(Date.now() + 3600 * 1000).toISOString())
    .first();
  if (reuse) {
    if (resume !== (reuse.resume || null)) {
      await env.DB.prepare("UPDATE payments SET resume=?, updated_at=? WHERE id=? AND credited=0").bind(resume, nowIso(), reuse.id).run();
      reuse.resume = resume;
    }
    return { ok: true, payment: reuse, reused: true };
  }
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM payments WHERE telegram_user_id=? AND status IN ('creating','pending') AND pay_link IS NOT NULL AND created_at >= ?"
  )
    .bind(userId, new Date(Date.now() - 3600 * 1000).toISOString())
    .first();
  if ((open?.n || 0) >= MAX_OPEN_INVOICES) return { ok: false, reason: "too_many" };

  const id = newOrderId();
  const at = nowIso();
  await env.DB.prepare(
    `INSERT INTO payments (id, provider, telegram_user_id, chat_id, amount_usd, status, created_at, updated_at, resume)
     VALUES (?, 'nowpayments', ?, ?, ?, 'creating', ?, ?, ?)`
  )
    .bind(id, userId, chatId ?? null, amount, at, at, resume)
    .run();
  const uname = await botUsername(env);
  const body = {
    price_amount: amount,
    price_currency: "usd",
    order_id: id,
    order_description: `${s.shop_name || "Liveira Shop"} balance top-up ${money(amount, "$")} (Telegram user ${userId})`.slice(0, 250),
    ipn_callback_url: ipnUrl(env),
    is_fixed_rate: false,
    is_fee_paid_by_user: false,
  };
  if (uname) {
    body.success_url = `https://t.me/${uname}?start=np_paid`;
    body.partially_paid_url = `https://t.me/${uname}?start=np_paid`;
    body.cancel_url = `https://t.me/${uname}?start=topup`;
  }
  const r = await npFetch(env, "POST", "/invoice", body);
  const invoiceId = r.data?.id != null ? String(r.data.id) : "";
  const url = String(r.data?.invoice_url || "");
  const urlOk = /^https:\/\/([a-z0-9-]+\.)*nowpayments\.io\//i.test(url);
  if (!r.ok || !/^\d{1,20}$/.test(invoiceId) || !urlOk || (r.data.order_id != null && String(r.data.order_id) !== id)) {
    const info = { http: r.http, code: r.data?.code ?? null, message: String(r.data?.message || "").slice(0, 200) };
    await env.DB.prepare("UPDATE payments SET status='error', last_status=?, updated_at=? WHERE id=?")
      .bind(JSON.stringify(info).slice(0, 1000), nowIso(), id)
      .run();
    await audit(env, `tg:${userId}`, "nowpayments_invoice_failed", { payment_id: id, amount, ...info });
    return { ok: false, reason: "api" };
  }
  const expires = new Date(Date.now() + NP_LIFETIME_H * 3600 * 1000).toISOString();
  await env.DB.prepare("UPDATE payments SET status='pending', track_id=?, pay_link=?, expires_at=?, last_status='invoice', updated_at=? WHERE id=?")
    .bind(`np:${invoiceId}`, url, expires, nowIso(), id)
    .run();
  await audit(env, `tg:${userId}`, "nowpayments_invoice_created", { payment_id: id, invoice_id: invoiceId, amount });
  return { ok: true, payment: await getNpPayment(env, id) };
}

export async function getNpPayment(env, id) {
  return env.DB.prepare("SELECT * FROM payments WHERE id=? AND provider='nowpayments'").bind(id).first();
}

/* ─── status processing (IPN, cron, user check, admin sync) ─── */

const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v, n = 64) => (v === null || v === undefined || v === "" ? null : String(v).slice(0, n));

/** Store/refresh the np_payments row. Returns { transition } — true when the status moved forward (first time seen). */
async function recordPayment(env, pay, p, { ipn = false } = {}) {
  const pid = String(p.payment_id);
  const st = String(p.payment_status || "").toLowerCase();
  const at = nowIso();
  const vals = [
    str(p.invoice_id),
    num(p.price_amount),
    str(p.price_currency, 10),
    num(p.pay_amount),
    num(p.actually_paid),
    str(p.pay_currency, 20),
    num(p.outcome_amount),
    str(p.outcome_currency, 20),
    str(p.parent_payment_id),
  ];
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO np_payments (payment_id, order_id, invoice_id, status, price_amount, price_currency, pay_amount, actually_paid,
       pay_currency, outcome_amount, outcome_currency, parent_payment_id, created_at, updated_at, ipn_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(pid, pay.id, vals[0], st, ...vals.slice(1), at, at, ipn ? 1 : 0)
    .run();
  if (ins.meta?.changes === 1) return { transition: true, owner: pay.id };
  const row = await env.DB.prepare("SELECT order_id FROM np_payments WHERE payment_id=?").bind(pid).first();
  if (row && row.order_id !== pay.id) return { transition: false, owner: row.order_id };
  const rank = RANK[st] || 0;
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE np_payments SET status=?, updated_at=? WHERE payment_id=? AND status<>? AND (${RANK_SQL}) <= ?`
    ).bind(st, at, pid, st, rank),
    env.DB.prepare(
      `UPDATE np_payments SET invoice_id=COALESCE(?, invoice_id), price_amount=COALESCE(?, price_amount), price_currency=COALESCE(?, price_currency),
         pay_amount=COALESCE(?, pay_amount), actually_paid=COALESCE(?, actually_paid), pay_currency=COALESCE(?, pay_currency),
         outcome_amount=COALESCE(?, outcome_amount), outcome_currency=COALESCE(?, outcome_currency), parent_payment_id=COALESCE(?, parent_payment_id),
         ipn_count=ipn_count+?, poll_errors=0 WHERE payment_id=?`
    ).bind(...vals, ipn ? 1 : 0, pid),
  ]);
  return { transition: res[0]?.meta?.changes === 1, owner: pay.id };
}

async function setPayStatus(env, pay, status, lastStatus, payload, fromStatuses) {
  const ph = fromStatuses.map(() => "?").join(",");
  const r = await env.DB.prepare(
    `UPDATE payments SET status=?, last_status=?, last_payload=COALESCE(?, last_payload), updated_at=?
      WHERE id=? AND credited=0 AND status IN (${ph})`
  )
    .bind(status, lastStatus, payload, nowIso(), pay.id, ...fromStatuses)
    .run();
  return r.meta?.changes === 1;
}

async function otherActive(env, pay, pid) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM np_payments WHERE order_id=? AND payment_id<>? AND status IN ('waiting','confirming','confirmed','sending','partially_paid','finished')`
  )
    .bind(pay.id, pid)
    .first();
  return (r?.n || 0) > 0;
}

async function flagOnce(env, pid, flag) {
  const r = await env.DB.prepare("UPDATE np_payments SET flag=? WHERE payment_id=? AND (flag IS NULL OR flag<>?)").bind(flag, pid, flag).run();
  return r.meta?.changes === 1;
}

function payloadOf(p) {
  const keep = ["payment_id", "invoice_id", "order_id", "payment_status", "price_amount", "price_currency", "pay_amount", "actually_paid",
    "pay_currency", "outcome_amount", "outcome_currency", "parent_payment_id", "updated_at"];
  const o = {};
  for (const k of keep) if (p[k] !== undefined) o[k] = p[k];
  return JSON.stringify(o).slice(0, 4000);
}

async function creditTopup(env, pay, p, source) {
  const DB = env.DB;
  const at = nowIso();
  const nonce = generateToken();
  const pid = String(p.payment_id);
  const res = await DB.batch([
    DB.prepare(
      `UPDATE payments SET status='paid', credited=1, credit_nonce=?, paid_at=?, updated_at=?, last_status='finished', last_payload=?
        WHERE id=? AND provider='nowpayments' AND credited=0 AND status NOT IN ('creating','error','review')`
    ).bind(nonce, at, at, payloadOf(p), pay.id),
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
       SELECT telegram_user_id, amount_usd, 'nowpayments', 'completed', ?, id FROM payments WHERE id=? AND credit_nonce=?`
    ).bind(at, pay.id, nonce),
    DB.prepare(
      "UPDATE np_payments SET credited=1 WHERE payment_id=? AND EXISTS (SELECT 1 FROM payments WHERE id=? AND credit_nonce=?)"
    ).bind(pid, pay.id, nonce),
    DB.prepare(
      `INSERT INTO audit_log (at, actor, action, details_json)
       SELECT ?, 'nowpayments', 'nowpayments_credit',
              json_object('payment_id', p.id, 'np_payment_id', ?, 'invoice_id', p.track_id, 'user_id', p.telegram_user_id,
                          'amount', p.amount_usd, 'new_balance', u.balance, 'source', ?, 'pay_currency', ?, 'pay_amount', ?,
                          'actually_paid', ?, 'outcome_amount', ?, 'outcome_currency', ?)
         FROM payments p LEFT JOIN users u ON u.user_id = p.telegram_user_id
        WHERE p.id=? AND p.credit_nonce=?`
    ).bind(at, pid, source, str(p.pay_currency, 20), num(p.pay_amount), num(p.actually_paid), num(p.outcome_amount), str(p.outcome_currency, 20), pay.id, nonce),
  ]);
  if (res[0]?.meta?.changes !== 1) return { won: false };
  const u = await DB.prepare("SELECT balance FROM users WHERE user_id=?").bind(pay.telegram_user_id).first();
  return { won: true, newBalance: Number(u?.balance || 0), amount: Number(pay.amount_usd) };
}

/**
 * Apply one NOWPayments payment object to our top-up.
 * `verified` = p came from GET /v1/payment/{id} with our API key (required for crediting).
 * → { action: credited|duplicate|extra|review|underpaid|failed|refunded|expired|paying|pending|noop|verify_failed|mismatch, … }
 */
export async function processNpPayment(env, s, pay, p, source, { verified = false, ipn = false } = {}) {
  const pid = p?.payment_id != null ? String(p.payment_id) : "";
  if (!/^\d{1,20}$/.test(pid)) return { action: "mismatch", reason: "payment_id" };
  if (p.order_id != null && String(p.order_id) !== pay.id) return { action: "mismatch", reason: "order_id" };
  if (p.invoice_id != null && pay.track_id && `np:${p.invoice_id}` !== pay.track_id) return { action: "mismatch", reason: "invoice_id" };
  const st = String(p.payment_status || "").toLowerCase();

  if (st === "finished" && !verified) {
    // Defense in depth: never credit on the IPN alone — ask NOWPayments with the API key.
    const r = await npFetch(env, "GET", `/payment/${encodeURIComponent(pid)}`);
    if (!r.ok || String(r.data?.payment_id) !== pid) {
      await recordPayment(env, pay, p, { ipn });
      await audit(env, "nowpayments", "nowpayments_verify_failed", { payment_id: pay.id, np_payment_id: pid, http: r.http, source });
      return { action: "verify_failed" };
    }
    if (String(r.data.payment_status || "").toLowerCase() !== "finished") {
      await audit(env, "nowpayments", "nowpayments_status_mismatch", { payment_id: pay.id, np_payment_id: pid, reported: st, api: r.data.payment_status, source });
    }
    if (ipn) await env.DB.prepare("UPDATE np_payments SET ipn_count=ipn_count+1 WHERE payment_id=?").bind(pid).run();
    return processNpPayment(env, s, pay, r.data, source, { verified: true, ipn: false });
  }

  const rec = await recordPayment(env, pay, p, { ipn });
  if (rec.owner !== pay.id) return { action: "mismatch", reason: "payment_owner" };
  const payload = payloadOf(p);

  if (st === "finished") {
    const priceOk = String(p.price_currency || "").toLowerCase() === "usd" && Math.abs(Number(p.price_amount) - Number(pay.amount_usd)) <= 0.01;
    const due = Number(p.pay_amount);
    const paid = Number(p.actually_paid);
    const short = due > 0 && Number.isFinite(paid) && paid > 0 && paid < due * UNDERPAY_TOLERANCE;
    if (pay.credited) {
      const np = await env.DB.prepare("SELECT credited FROM np_payments WHERE payment_id=?").bind(pid).first();
      if (np?.credited) return { action: "duplicate" };
      if (await flagOnce(env, pid, "extra")) {
        await audit(env, "nowpayments", "nowpayments_extra_payment", { payment_id: pay.id, np_payment_id: pid, pay_currency: p.pay_currency, actually_paid: p.actually_paid });
        await notifyAdminsNp(env, s, pay, "extra", p);
      }
      return { action: "extra" };
    }
    if (!priceOk || short) {
      const reason = !priceOk ? "price_mismatch" : "underpaid_finished";
      const first = await flagOnce(env, pid, reason); // also stops the cron from re-polling it
      await setPayStatus(env, pay, "review", reason, payload, ["pending", "paying", "expired", "canceled", "underpaid", "failed"]);
      if (first) {
        await audit(env, "nowpayments", "nowpayments_review", { payment_id: pay.id, np_payment_id: pid, reason, price_amount: p.price_amount, price_currency: p.price_currency, pay_amount: p.pay_amount, actually_paid: p.actually_paid });
        await notifyAdminsNp(env, s, pay, "review", p, { reason });
      }
      return { action: "review", reason };
    }
    const c = await creditTopup(env, pay, p, source);
    if (!c.won) {
      const fresh = await getNpPayment(env, pay.id);
      return { action: fresh?.credited ? "duplicate" : "noop" };
    }
    await notifyCredit(env, pay, c);
    await notifyAdminsNp(env, s, pay, "credited", p, { newBalance: c.newBalance, overpaid: due > 0 && paid > due * OVERPAY_NOTE });
    return { action: "credited", newBalance: c.newBalance, amount: c.amount };
  }

  if (pay.credited) return { action: "noop" };

  if (st === "partially_paid") {
    await setPayStatus(env, pay, "underpaid", st, payload, ["pending", "paying", "expired", "canceled", "failed"]);
    if (rec.transition) {
      await audit(env, "nowpayments", "nowpayments_partially_paid", { payment_id: pay.id, np_payment_id: pid, pay_currency: p.pay_currency, pay_amount: p.pay_amount, actually_paid: p.actually_paid });
      await notifyUserNp(env, s, pay, "underpaid", p);
      await notifyAdminsNp(env, s, pay, "partial", p);
    }
    return { action: "underpaid" };
  }
  if (st === "failed" || st === "refunded") {
    const other = st === "failed" && (await otherActive(env, pay, pid));
    if (!other) await setPayStatus(env, pay, st, st, payload, ["pending", "paying", "expired", "canceled", "underpaid"]);
    if (rec.transition) {
      await audit(env, "nowpayments", `nowpayments_${st}`, { payment_id: pay.id, np_payment_id: pid, pay_currency: p.pay_currency, actually_paid: p.actually_paid });
      if (!other) await notifyUserNp(env, s, pay, st, p);
      await notifyAdminsNp(env, s, pay, st, p);
    }
    return { action: st };
  }
  if (st === "expired") {
    if (!(await otherActive(env, pay, pid))) await setPayStatus(env, pay, "expired", st, payload, ["pending", "paying"]);
    return { action: "expired" };
  }
  if (["confirming", "confirmed", "sending"].includes(st)) {
    const ch = await setPayStatus(env, pay, "paying", st, payload, ["pending", "paying", "expired", "canceled"]);
    if (ch && pay.message_id && pay.status !== "paying") await refreshCard(env, s, pay.id);
    return { action: "paying" };
  }
  if (st === "waiting") {
    await env.DB.prepare("UPDATE payments SET last_status=?, updated_at=? WHERE id=? AND credited=0 AND status IN ('pending','expired')")
      .bind(st, nowIso(), pay.id)
      .run();
    return { action: "pending" };
  }
  await env.DB.prepare("UPDATE payments SET last_status=?, updated_at=? WHERE id=? AND credited=0").bind(st.slice(0, 32) || "unknown", nowIso(), pay.id).run();
  return { action: "noop" };
}

/** Re-check the payments NOWPayments created for this top-up (user "check" button, admin sync). */
export async function npCheck(env, s, pay, source, { force = false } = {}) {
  if (!npConfigured(env)) return { action: "unconfigured" };
  const { results } = await env.DB.prepare(
    "SELECT payment_id, status, checked_at FROM np_payments WHERE order_id=? ORDER BY created_at DESC LIMIT 3"
  )
    .bind(pay.id)
    .all();
  const rows = (results || []).filter((r) => NP_POLL_STATUSES.includes(r.status) || r.status === "expired");
  if (!rows.length) return { action: "no_payment" };
  let out = { action: "noop" };
  for (const row of rows) {
    if (!force && row.checked_at && Date.now() - Date.parse(row.checked_at) < USER_CHECK_GAP_MS) continue;
    const r = await pollOne(env, s, row.payment_id, source);
    if (r.action === "credited" || r.action === "duplicate") return r;
    if (r.action !== "noop") out = r;
  }
  return out;
}

async function pollOne(env, s, pid, source) {
  await env.DB.prepare("UPDATE np_payments SET checked_at=? WHERE payment_id=?").bind(nowIso(), pid).run();
  const r = await npFetch(env, "GET", `/payment/${encodeURIComponent(pid)}`);
  if (!r.ok || String(r.data?.payment_id) !== String(pid)) {
    await env.DB.prepare(
      `UPDATE np_payments SET poll_errors=poll_errors+1,
         status=CASE WHEN poll_errors+1 >= ? AND credited=0 AND status<>'finished' THEN 'unknown' ELSE status END WHERE payment_id=?`
    )
      .bind(POLL_MAX_ERRORS, pid)
      .run();
    return { action: "api_error", http: r.http };
  }
  const row = await env.DB.prepare("SELECT order_id FROM np_payments WHERE payment_id=?").bind(pid).first();
  const pay = row && (await getNpPayment(env, row.order_id));
  if (!pay) return { action: "mismatch" };
  return processNpPayment(env, s, pay, r.data, source, { verified: true });
}

/** Cron: live minimum (every 6 h), re-check payments with no news, close stale invoices. */
export async function npCron(env) {
  if (!npConfigured(env)) return;
  const s = await getSettings(env);
  if (s.nowpayments_enabled === "1") {
    try {
      await refreshNpMin(env, s);
    } catch (err) {
      console.error("NOWPayments min refresh failed", err);
    }
  }
  const now = Date.now();
  const cutoff = new Date(now - POLL_AFTER_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT n.payment_id FROM np_payments n JOIN payments p ON p.id=n.order_id
      WHERE p.provider='nowpayments' AND n.credited=0 AND n.flag IS NULL
        AND (p.credited=0 OR n.status='finished')
        AND n.status IN (${NP_POLL_STATUSES.map(() => "?").join(",")})
        AND n.updated_at < ? AND COALESCE(n.checked_at, '') < ? AND n.created_at > ?
      ORDER BY COALESCE(n.checked_at, '') LIMIT ${POLL_BATCH}`
  )
    .bind(...NP_POLL_STATUSES, cutoff, cutoff, new Date(now - POLL_MAX_AGE_MS).toISOString())
    .all();
  for (const r of results || []) {
    try {
      await pollOne(env, s, r.payment_id, "cron");
    } catch (err) {
      console.error("NOWPayments poll failed", err);
    }
  }
  await env.DB.prepare(
    `UPDATE payments SET status='expired', updated_at=? WHERE provider='nowpayments' AND credited=0 AND status IN ('pending','creating')
       AND expires_at IS NOT NULL AND expires_at < ?
       AND NOT EXISTS (SELECT 1 FROM np_payments n WHERE n.order_id=payments.id AND n.status IN ('confirming','confirmed','sending','finished'))`
  )
    .bind(nowIso(), nowIso())
    .run();
}

/* ─── POST /nowpayments/ipn ─── */

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function handleNpIpn(request, env, ctx) {
  if (!npConfigured(env)) return text("not configured", 503);
  if (Number(request.headers.get("Content-Length") || "0") > MAX_BODY) return text("too large", 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return text("too large", 413);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return text("invalid json", 400);
  }
  if (!(await verifyNpSignature(env, data, request.headers.get("x-nowpayments-sig")))) {
    console.warn("nowpayments ipn: invalid signature", request.headers.get("CF-Connecting-IP"));
    return text("invalid signature", 401);
  }
  const orderId = data.order_id != null ? String(data.order_id) : "";
  const invoiceId = data.invoice_id != null ? String(data.invoice_id) : "";
  const st = String(data.payment_status || "");
  let pay = /^np_[A-Za-z0-9_]{4,60}$/.test(orderId) ? await getNpPayment(env, orderId) : null;
  if (!pay && !orderId && /^\d{1,20}$/.test(invoiceId)) {
    pay = await env.DB.prepare("SELECT * FROM payments WHERE provider='nowpayments' AND track_id=?").bind(`np:${invoiceId}`).first();
  }
  if (pay && !pay.track_id && /^\d{1,20}$/.test(invoiceId)) {
    // The invoice-creation response was lost: adopt the invoice id from the signed IPN.
    await env.DB.prepare("UPDATE payments SET track_id=?, status=CASE WHEN status IN ('creating','error') THEN 'pending' ELSE status END, updated_at=? WHERE id=? AND track_id IS NULL")
      .bind(`np:${invoiceId}`, nowIso(), pay.id)
      .run();
    pay = await getNpPayment(env, pay.id);
  }
  if (!pay) {
    await audit(env, "nowpayments", "nowpayments_ipn_unmatched", { order_id: orderId.slice(0, 64), invoice_id: invoiceId.slice(0, 24), np_payment_id: String(data.payment_id ?? "").slice(0, 24), status: st.slice(0, 24) });
    return text("ok");
  }
  const s = await getSettings(env);
  const r = await processNpPayment(env, s, pay, data, "ipn", { ipn: true });
  if (r.action === "mismatch") {
    await audit(env, "nowpayments", "nowpayments_ipn_mismatch", { payment_id: pay.id, reason: r.reason, invoice_id: invoiceId.slice(0, 24), np_payment_id: String(data.payment_id ?? "").slice(0, 24) });
  }
  return text("ok");
}

/* ─── notifications ─── */

function supportLineFor(s) {
  return s.support_contact ? `💬 Support: ${e(s.support_contact)}` : "💬 Please contact the shop admin.";
}

async function refreshCard(env, s, id) {
  const pay = await getNpPayment(env, id);
  if (!pay?.message_id) return;
  const card = invoiceCard(pay, s, supportLineFor(s));
  await editOrSend(env, pay.chat_id || pay.telegram_user_id, pay.message_id, card.text, { reply_markup: card.reply_markup }, { fallback: false });
}

async function notifyUserNp(env, s, pay, kind, p) {
  const cur = s.currency_symbol || "$";
  await refreshCard(env, s, pay.id).catch(() => {});
  const amt = e(money(pay.amount_usd, cur));
  const coin = p.pay_currency ? ` ${e(String(p.pay_currency).toUpperCase())}` : "";
  const text = {
    underpaid: `⚠️ Your payment for the ${amt} top-up arrived only partially (${e(String(p.actually_paid ?? "?"))} of ${e(String(p.pay_amount ?? "?"))}${coin}), so it was not credited automatically.\n${supportLineFor(s)}`,
    failed: `❌ Your NOWPayments payment for the ${amt} top-up failed and was not credited.\n${supportLineFor(s)}`,
    refunded: `↩️ Your NOWPayments payment for the ${amt} top-up was refunded.\n${supportLineFor(s)}`,
  }[kind];
  if (!text) return;
  try {
    await sendMessage(env, pay.chat_id || pay.telegram_user_id, text, { reply_markup: kb([[HOME()]]) });
  } catch (err) {
    console.error("notify failed", err);
  }
}

function adminIdList(env) {
  return [...new Set(String(env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number))];
}

async function notifyAdminsNp(env, s, pay, kind, p, { newBalance, overpaid, reason } = {}) {
  const cur = s.currency_symbol || "$";
  const u = await env.DB.prepare("SELECT username FROM users WHERE user_id=?").bind(pay.telegram_user_id).first();
  const who = `${u?.username ? `@${e(u.username)} ` : ""}(<code>${pay.telegram_user_id}</code>)`;
  const head = {
    credited: "🪙 <b>NOWPayments top-up credited</b>",
    partial: "🟠 <b>NOWPayments: partially paid — not credited</b>",
    failed: "🔴 <b>NOWPayments payment failed</b>",
    refunded: "↩️ <b>NOWPayments payment refunded</b>",
    review: "🟠 <b>NOWPayments top-up needs review — not credited</b>",
    extra: "🟠 <b>NOWPayments: extra payment for an already credited top-up — not credited</b>",
  }[kind];
  const why = { price_mismatch: "the invoice price reported by NOWPayments differs from the top-up", underpaid_finished: "finished, but less than 98 % of the amount due arrived" }[reason];
  const paidLine = p.actually_paid != null || p.pay_amount != null
    ? `Paid: <b>${e(String(p.actually_paid ?? "?"))}</b> of ${e(String(p.pay_amount ?? "?"))} ${e(String(p.pay_currency || "").toUpperCase())}\n`
    : "";
  const text =
    `${head}\n\n` +
    `User: ${who}\n` +
    `Top-up: <b>${kind === "credited" ? "+" : ""}${e(money(pay.amount_usd, cur))}</b>\n` +
    paidLine +
    (p.outcome_amount != null ? `Received (after fees): ${e(String(p.outcome_amount))} ${e(String(p.outcome_currency || "").toUpperCase())}\n` : "") +
    (overpaid ? "Note: overpaid — only the invoice amount was credited.\n" : "") +
    (why ? `Reason: ${why}\n` : "") +
    (kind === "credited" && newBalance != null ? `New balance: ${e(money(newBalance, cur))}\n` : "") +
    (kind !== "credited" ? "Adjust the balance manually in the admin panel if needed.\n" : "") +
    `NOWPayments payment: <code>${e(String(p.payment_id))}</code>\n` +
    `Ref: <code>${e(pay.id)}</code>`;
  for (const id of adminIdList(env)) {
    try {
      await sendMessage(env, id, text);
    } catch (err) {
      console.error("admin notify failed", err);
    }
  }
}

/** Panel status card. */
export async function npStatus(env, s) {
  const npc = npConfig(s, env);
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM payments WHERE provider='nowpayments' AND credited=0 AND status IN ('pending','paying','underpaid','review')"
  ).first();
  return {
    configured: npc.configured,
    enabled: npc.enabled,
    available: npc.available,
    min: npc.min,
    min_source: npc.minSource,
    auto_min: npc.autoMin,
    auto_min_at: Number(s.nowpayments_min_auto_at) ? new Date(Number(s.nowpayments_min_auto_at)).toISOString() : null,
    ipn_url: ipnUrl(env),
    open: open?.n || 0,
  };
}
