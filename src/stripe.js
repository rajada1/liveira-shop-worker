/* Stripe card top-ups: hosted Checkout Session (card only, USD), signed webhook, session re-fetch before crediting,
 * exactly-once crediting, cron fallback, refund / dispute handling.
 * Docs: https://docs.stripe.com/api/checkout/sessions · https://docs.stripe.com/webhooks#verify-manually
 *  - POST /v1/checkout/sessions (form-encoded, Bearer secret key, Idempotency-Key) → { id: cs_…, url, amount_total, currency, expires_at, … }
 *  - GET  /v1/checkout/sessions/{id}?expand[]=payment_intent → status open|complete|expired, payment_status paid|unpaid|no_payment_required
 *  - POST /v1/checkout/sessions/{id}/expire (only while open)
 *  - Webhook: header Stripe-Signature "t=<unix>,v1=<hex>[,v1=…]" = HMAC-SHA256(endpoint secret, "<t>.<raw body>"), 5 min tolerance.
 *
 * One top-up = one `payments` row (provider='stripe', id 'sp_…' = client_reference_id = metadata.topup_id,
 * track_id 'stripe:<cs id>') + one `stripe_sessions` row. Webhook events are recorded once in `stripe_events`.
 * Crediting: only when GET /v1/checkout/sessions/{id} (our secret key) says status=complete AND payment_status=paid, our
 * client_reference_id, currency usd and amount_total = the top-up amount in cents → credit the top-up amount (USD), once
 * (payments.credited 0→1 with a nonce, same batch pattern as OxaPay / NOWPayments).
 * Refund / dispute: admins are always told (prominently). The refunded / disputed USD amount (capped at the top-up) is
 * debited from the wallet only if the balance covers it in full; otherwise nothing is debited and the shortfall is
 * flagged ("unrecovered") for the admins to decide — the customer may already have spent the balance.
 */
import { nowIso, generateToken, money, audit, getSettings, tgEsc as e } from "./util.js";
import { sendMessage, editOrSend, invoiceCard, HOME, kb } from "./ui.js";
import { notifyCredit, topupConfig, round2, expireStale, botUsername, PUBLIC_BASE_URL } from "./oxapay.js";

const DEFAULT_API = "https://api.stripe.com/v1";
export const STRIPE_API_VERSION = "2024-06-20"; // pinned for requests; the webhook endpoint is created with the same version
export const SP_LIFETIME_MIN = 60; // Checkout Session expires_at (Stripe allows 30 min … 24 h)
const DEFAULT_MIN = 5;
const DEFAULT_MAX = 500;
const SIG_TOLERANCE_S = 300;
const POLL_AFTER_MS = 2 * 60 * 1000; // cron re-checks a session with no news for 2 min
const POLL_BATCH = 5;
const POLL_MAX_AGE_MS = 2 * 86400 * 1000;
const POLL_MAX_ERRORS = 5;
const USER_CHECK_GAP_MS = 10 * 1000;
const MAX_OPEN_INVOICES = 5; // per user per hour (all invoice providers)
const MAX_BODY = 512 * 1024;
const IN_PROGRESS_MS = 2 * 60 * 1000;
const enc = new TextEncoder();

export const STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  "charge.dispute.created",
];

/* ─── config ─── */

const apiBase = (env) => String(env.STRIPE_API_BASE || DEFAULT_API).replace(/\/+$/, "");
const secretKey = (env) => String(env.STRIPE_SECRET_KEY || "").trim();
const whSecret = (env) => String(env.STRIPE_WEBHOOK_SECRET || "").trim();

export function spConfigured(env) {
  return !!(secretKey(env) && whSecret(env));
}

export function webhookUrl(env) {
  return `${String(env.PUBLIC_BASE_URL || PUBLIC_BASE_URL).replace(/\/+$/, "")}/stripe/webhook`;
}

export const cents = (usd) => Math.round(Number(usd) * 100);

/** { enabled, configured, available, min, max, presets } — min = max(topup_min, stripe_min), max = min(topup_max, stripe_max). */
export function spConfig(s, env) {
  const tc = topupConfig(s, env);
  const enabled = s.stripe_enabled === "1";
  const configured = spConfigured(env);
  let smin = Number(s.stripe_min);
  if (!Number.isFinite(smin) || smin < 1) smin = DEFAULT_MIN;
  let smax = Number(s.stripe_max);
  if (!Number.isFinite(smax) || smax <= 0) smax = DEFAULT_MAX;
  const min = round2(Math.max(tc.min, smin));
  const max = round2(Math.min(tc.max, smax));
  const presets = [];
  for (const a of [Math.ceil(min), ...tc.presets]) if (a >= min && a <= max && !presets.includes(a)) presets.push(a);
  presets.sort((a, b) => a - b);
  return { enabled, configured, available: enabled && configured && max >= min, min, max, presets: presets.slice(0, 4) };
}

/* ─── API ─── */

/** Stripe form encoding: nested objects → a[b][c]=v, arrays → a[0]=v. */
export function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (x !== null && typeof x === "object") formEncode(x, `${key}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`);
      });
    } else if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function spFetch(env, method, path, params, { idem } = {}) {
  let res;
  const body = params && method !== "GET" ? formEncode(params).join("&") : undefined;
  try {
    res = await fetch(`${apiBase(env)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey(env)}`,
        "Stripe-Version": STRIPE_API_VERSION,
        ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idem ? { "Idempotency-Key": idem } : {}),
      },
      body,
    });
  } catch (err) {
    console.error("Stripe fetch failed", method, path.split("?")[0], String(err).slice(0, 120));
    return { ok: false, http: 0, data: null, error: { type: "network" } };
  }
  const data = await res.json().catch(() => null);
  const ok = res.ok && !!data && typeof data === "object" && !data.error;
  const error = ok ? null : { type: data?.error?.type || null, code: data?.error?.code || null, param: data?.error?.param || null, message: String(data?.error?.message || "").slice(0, 300) };
  if (!ok) console.error("Stripe API error", method, path.split("?")[0], res.status, error?.type, error?.code, error?.message?.slice(0, 160));
  return { ok, http: res.status, data, error };
}

/** Account check for the panel (no secrets returned). */
export async function spAccount(env) {
  const r = await spFetch(env, "GET", "/account");
  if (!r.ok) return { ok: false, http: r.http, error: r.error };
  const a = r.data;
  return {
    ok: true,
    http: r.http,
    id: a.id,
    country: a.country,
    default_currency: a.default_currency,
    charges_enabled: !!a.charges_enabled,
    payouts_enabled: !!a.payouts_enabled,
    card_payments: a.capabilities?.card_payments || null,
    billing_name: a.settings?.payments?.statement_descriptor || null,
    livemode: secretKey(env).startsWith("sk_live_"),
  };
}

/** The configured webhook endpoint (settings.stripe_webhook_id): url, status, events — never the secret. */
export async function spWebhookEndpoint(env, id) {
  if (!/^we_[A-Za-z0-9]{6,100}$/.test(String(id || ""))) return { error: "no_id" };
  const r = await spFetch(env, "GET", `/webhook_endpoints/${encodeURIComponent(id)}`);
  if (!r.ok) return { error: r.error?.code || r.error?.type || "api", http: r.http };
  const w = r.data;
  const missing = STRIPE_EVENTS.filter((x) => !(w.enabled_events || []).includes(x) && !(w.enabled_events || []).includes("*"));
  return { id: w.id, url: w.url, status: w.status, api_version: w.api_version || null, events: w.enabled_events, missing_events: missing, url_ok: w.url === webhookUrl(env) };
}

/* ─── webhook signature ─── */

async function hmacSha256Hex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

/** Stripe-Signature: t=<unix>,v1=<hex>… ; any v1 must equal HMAC-SHA256(secret, `${t}.${raw}`), |now - t| ≤ 300 s. */
export async function verifyStripeSignature(secret, raw, header, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return { ok: false, reason: "missing" };
  let t = null;
  const v1 = [];
  for (const part of String(header).split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (!t || !/^\d{1,12}$/.test(t) || !v1.length) return { ok: false, reason: "malformed" };
  if (Math.abs(nowSec - Number(t)) > SIG_TOLERANCE_S) return { ok: false, reason: "timestamp" };
  const want = await hmacSha256Hex(secret, `${t}.${raw}`);
  return v1.some((x) => constEq(x, want)) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/* ─── sessions ─── */

function newTopupId() {
  return `sp_${Date.now().toString(36)}_${generateToken().slice(0, 10).replace(/[^A-Za-z0-9]/g, "x")}`;
}

export async function getSpPayment(env, id) {
  return env.DB.prepare("SELECT * FROM payments WHERE id=? AND provider='stripe'").bind(id).first();
}

/** Create a Checkout Session + pending payments row. → { ok, payment, reused? } | { ok:false, reason, min?, max?, error? } */
export async function createSpSession(env, s, { userId, chatId, amount, resume }) {
  const spc = spConfig(s, env);
  if (!spc.available) return { ok: false, reason: "unconfigured" };
  if (!Number.isFinite(amount) || amount < spc.min) return { ok: false, reason: "min", min: spc.min };
  if (amount > spc.max) return { ok: false, reason: "max", max: spc.max };
  amount = round2(amount);
  await expireStale(env);
  resume = /^[a-z0-9_-]{1,32}:\d{1,4}$/.test(String(resume || "")) ? String(resume) : null;
  const reuse = await env.DB.prepare(
    `SELECT * FROM payments WHERE provider='stripe' AND telegram_user_id=? AND amount_usd=? AND status='pending' AND credited=0
       AND pay_link IS NOT NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(userId, amount, new Date(Date.now() + 15 * 60 * 1000).toISOString())
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

  const id = newTopupId();
  const at = nowIso();
  await env.DB.prepare(
    `INSERT INTO payments (id, provider, telegram_user_id, chat_id, amount_usd, status, created_at, updated_at, resume)
     VALUES (?, 'stripe', ?, ?, ?, 'creating', ?, ?, ?)`
  )
    .bind(id, userId, chatId ?? null, amount, at, at, resume)
    .run();
  const uname = await botUsername(env);
  const back = uname ? `https://t.me/${uname}` : "https://t.me/";
  const shop = s.shop_name || "Liveira Shop";
  const meta = { topup_id: id, telegram_user_id: String(userId), source: "liveira-shop" };
  const params = {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        quantity: 1,
        price_data: { currency: "usd", unit_amount: cents(amount), product_data: { name: "Wallet top-up", description: `${shop} balance top-up ${money(amount, "$")}` } },
      },
    ],
    client_reference_id: id,
    metadata: meta,
    payment_intent_data: { metadata: meta, description: `${shop} wallet top-up ${id}`.slice(0, 200) },
    submit_type: "pay",
    success_url: uname ? `${back}?start=sp_paid` : back,
    cancel_url: uname ? `${back}?start=topup` : back,
    expires_at: Math.floor(Date.now() / 1000) + SP_LIFETIME_MIN * 60,
  };
  const r = await spFetch(env, "POST", "/checkout/sessions", params, { idem: `liveira-${id}` });
  const sid = String(r.data?.id || "");
  const url = String(r.data?.url || "");
  const ok =
    r.ok &&
    /^cs_(live|test)_[A-Za-z0-9]{10,200}$/.test(sid) &&
    /^https:\/\/checkout\.stripe\.com\//.test(url) &&
    r.data.amount_total === cents(amount) &&
    String(r.data.currency || "").toLowerCase() === "usd" &&
    String(r.data.client_reference_id || "") === id;
  if (!ok) {
    const info = { http: r.http, ...(r.error || { type: "unexpected_response" }) };
    await env.DB.prepare("UPDATE payments SET status='error', last_status=?, updated_at=? WHERE id=?")
      .bind(JSON.stringify(info).slice(0, 1000), nowIso(), id)
      .run();
    await audit(env, `tg:${userId}`, "stripe_session_failed", { payment_id: id, amount, ...info });
    return { ok: false, reason: "api", error: info };
  }
  const expires = Number(r.data.expires_at) ? new Date(Number(r.data.expires_at) * 1000).toISOString() : new Date(Date.now() + SP_LIFETIME_MIN * 60000).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE payments SET status='pending', track_id=?, pay_link=?, expires_at=?, last_status='open', updated_at=? WHERE id=?").bind(
      `stripe:${sid}`, url, expires, nowIso(), id
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO stripe_sessions (session_id, payment_id, status, payment_status, amount_total, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(sid, id, String(r.data.status || "open"), String(r.data.payment_status || "unpaid"), r.data.amount_total, "usd", nowIso(), nowIso()),
  ]);
  await audit(env, `tg:${userId}`, "stripe_session_created", { payment_id: id, session_id: sid, amount });
  return { ok: true, payment: await getSpPayment(env, id) };
}

/** Close an open session at Stripe (user cancel / admin test). → { ok, status } */
export async function expireSpSession(env, sid) {
  const r = await spFetch(env, "POST", `/checkout/sessions/${encodeURIComponent(sid)}/expire`, {});
  return { ok: r.ok && r.data?.status === "expired", http: r.http, status: r.data?.status || null, error: r.error };
}

/* ─── status processing (webhook, cron, user check, admin sync) ─── */

async function setPayStatus(env, pay, status, lastStatus, fromStatuses) {
  const ph = fromStatuses.map(() => "?").join(",");
  const r = await env.DB.prepare(`UPDATE payments SET status=?, last_status=?, updated_at=? WHERE id=? AND credited=0 AND status IN (${ph})`)
    .bind(status, lastStatus, nowIso(), pay.id, ...fromStatuses)
    .run();
  return r.meta?.changes === 1;
}

async function flagOnce(env, sid, flag) {
  const r = await env.DB.prepare("UPDATE stripe_sessions SET flag=? WHERE session_id=? AND (flag IS NULL OR flag<>?)").bind(flag, sid, flag).run();
  return r.meta?.changes === 1;
}

function payloadOf(sess) {
  const pi = sess.payment_intent;
  return JSON.stringify({
    id: sess.id,
    status: sess.status,
    payment_status: sess.payment_status,
    amount_total: sess.amount_total,
    currency: sess.currency,
    client_reference_id: sess.client_reference_id,
    payment_intent: typeof pi === "object" && pi ? pi.id : pi || null,
    charge: typeof pi === "object" && pi ? (typeof pi.latest_charge === "object" ? pi.latest_charge?.id : pi.latest_charge) || null : null,
  }).slice(0, 2000);
}

async function creditTopup(env, pay, sess, source) {
  const DB = env.DB;
  const at = nowIso();
  const nonce = generateToken();
  const res = await DB.batch([
    DB.prepare(
      `UPDATE payments SET status='paid', credited=1, credit_nonce=?, paid_at=?, updated_at=?, last_status='paid', last_payload=?
        WHERE id=? AND provider='stripe' AND credited=0 AND status NOT IN ('creating','error','review')`
    ).bind(nonce, at, at, payloadOf(sess), pay.id),
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
       SELECT telegram_user_id, amount_usd, 'stripe', 'completed', ?, id FROM payments WHERE id=? AND credit_nonce=?`
    ).bind(at, pay.id, nonce),
    DB.prepare("UPDATE stripe_sessions SET credited=1 WHERE session_id=? AND EXISTS (SELECT 1 FROM payments WHERE id=? AND credit_nonce=?)").bind(
      sess.id, pay.id, nonce
    ),
    DB.prepare(
      `INSERT INTO audit_log (at, actor, action, details_json)
       SELECT ?, 'stripe', 'stripe_credit',
              json_object('payment_id', p.id, 'session_id', ?, 'user_id', p.telegram_user_id, 'amount', p.amount_usd,
                          'new_balance', u.balance, 'source', ?, 'amount_total', ?, 'currency', ?)
         FROM payments p LEFT JOIN users u ON u.user_id = p.telegram_user_id
        WHERE p.id=? AND p.credit_nonce=?`
    ).bind(at, sess.id, source, sess.amount_total ?? null, String(sess.currency || ""), pay.id, nonce),
  ]);
  if (res[0]?.meta?.changes !== 1) return { won: false };
  const u = await DB.prepare("SELECT balance FROM users WHERE user_id=?").bind(pay.telegram_user_id).first();
  return { won: true, newBalance: Number(u?.balance || 0), amount: Number(pay.amount_usd) };
}

async function fetchSession(env, sid) {
  return spFetch(env, "GET", `/checkout/sessions/${encodeURIComponent(sid)}?expand[]=payment_intent`);
}

/**
 * Re-fetch the session with the secret key and apply it. Nothing from a webhook body is trusted for crediting.
 * → { action: credited|duplicate|review|paying|pending|expired|failed|noop|api_error|mismatch, … }
 */
export async function syncSpSession(env, s, pay, source, { event = null } = {}) {
  const sid = String(pay.track_id || "").replace(/^stripe:/, "");
  if (!/^cs_(live|test)_[A-Za-z0-9]{10,200}$/.test(sid)) return { action: "mismatch", reason: "no_session" };
  await env.DB.prepare("UPDATE stripe_sessions SET checked_at=? WHERE session_id=?").bind(nowIso(), sid).run();
  const r = await fetchSession(env, sid);
  if (!r.ok || r.data?.id !== sid) {
    await env.DB.prepare("UPDATE stripe_sessions SET poll_errors=poll_errors+1 WHERE session_id=?").bind(sid).run();
    if (source !== "cron") await audit(env, "stripe", "stripe_verify_failed", { payment_id: pay.id, session_id: sid, http: r.http, source });
    return { action: "api_error", http: r.http };
  }
  return applySession(env, s, pay, r.data, source, { event });
}

async function applySession(env, s, pay, sess, source, { event = null } = {}) {
  if (sess.client_reference_id != null && String(sess.client_reference_id) !== pay.id) return { action: "mismatch", reason: "client_reference_id" };
  if (sess.metadata?.topup_id != null && String(sess.metadata.topup_id) !== pay.id) return { action: "mismatch", reason: "metadata" };
  const pi = sess.payment_intent && typeof sess.payment_intent === "object" ? sess.payment_intent : null;
  const piId = pi ? pi.id : typeof sess.payment_intent === "string" ? sess.payment_intent : null;
  const chargeId = pi ? (typeof pi.latest_charge === "object" ? pi.latest_charge?.id : pi.latest_charge) || null : null;
  const st = String(sess.status || "");
  const ps = String(sess.payment_status || "");
  await env.DB.prepare(
    `INSERT INTO stripe_sessions (session_id, payment_id, status, payment_status, amount_total, currency, payment_intent, charge_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT(session_id) DO UPDATE SET
       updated_at = CASE WHEN stripe_sessions.status IS NOT excluded.status OR stripe_sessions.payment_status IS NOT excluded.payment_status THEN ?9 ELSE stripe_sessions.updated_at END,
       status=excluded.status, payment_status=excluded.payment_status, amount_total=excluded.amount_total, currency=excluded.currency,
       payment_intent=COALESCE(excluded.payment_intent, stripe_sessions.payment_intent), charge_id=COALESCE(excluded.charge_id, stripe_sessions.charge_id),
       poll_errors=0`
  )
    .bind(sess.id, pay.id, st, ps, Number.isFinite(sess.amount_total) ? sess.amount_total : null, String(sess.currency || "").toLowerCase() || null, piId, chargeId, nowIso())
    .run();

  if (st === "complete" && ps === "paid") {
    if (pay.credited) return { action: "duplicate" };
    const amountOk = String(sess.currency || "").toLowerCase() === "usd" && sess.amount_total === cents(pay.amount_usd);
    if (!amountOk) {
      const first = await flagOnce(env, sess.id, "amount_mismatch");
      await setPayStatus(env, pay, "review", "amount_mismatch", ["creating", "error", "pending", "paying", "expired", "canceled", "failed"]);
      if (first) {
        await audit(env, "stripe", "stripe_review", { payment_id: pay.id, session_id: sess.id, amount_total: sess.amount_total, currency: sess.currency });
        await notifyAdminsSp(env, s, pay, "review", { sess, reason: "amount_mismatch" });
      }
      return { action: "review", reason: "amount_mismatch" };
    }
    if (pay.status === "creating" || pay.status === "error") {
      // The creation response was lost but the session was paid: adopt it.
      await env.DB.prepare("UPDATE payments SET status='pending', updated_at=? WHERE id=? AND credited=0 AND status IN ('creating','error')").bind(nowIso(), pay.id).run();
    }
    const c = await creditTopup(env, pay, sess, source);
    if (!c.won) {
      const fresh = await getSpPayment(env, pay.id);
      return { action: fresh?.credited ? "duplicate" : "noop" };
    }
    await notifyCredit(env, pay, c);
    await notifyAdminsSp(env, s, pay, "credited", { sess, newBalance: c.newBalance });
    return { action: "credited", newBalance: c.newBalance, amount: c.amount };
  }
  if (pay.credited) return { action: "noop" };
  if (st === "complete" && ps === "unpaid") {
    // Delayed payment methods only (cards settle synchronously); failure arrives as async_payment_failed.
    if (event === "checkout.session.async_payment_failed") {
      const ch = await setPayStatus(env, pay, "failed", "async_payment_failed", ["pending", "paying", "expired", "canceled"]);
      if (ch) {
        await audit(env, "stripe", "stripe_failed", { payment_id: pay.id, session_id: sess.id });
        await notifyUserSp(env, s, pay, "failed");
        await notifyAdminsSp(env, s, pay, "failed", { sess });
      }
      return { action: "failed" };
    }
    const ch = await setPayStatus(env, pay, "paying", "processing", ["pending", "expired", "canceled"]);
    if (ch && pay.message_id) await refreshCard(env, s, pay.id);
    return { action: "paying" };
  }
  if (st === "expired") {
    await setPayStatus(env, pay, "expired", "expired", ["pending", "paying", "creating"]);
    return { action: "expired" };
  }
  await env.DB.prepare("UPDATE payments SET last_status=?, updated_at=? WHERE id=? AND credited=0 AND last_status IS NOT ?").bind(st || "open", nowIso(), pay.id, st || "open").run();
  return { action: "pending" };
}

/** User "check status" button / admin sync. */
export async function spCheck(env, s, pay, source, { force = false } = {}) {
  if (!spConfigured(env)) return { action: "unconfigured" };
  if (!force) {
    const row = await env.DB.prepare("SELECT checked_at FROM stripe_sessions WHERE payment_id=?").bind(pay.id).first();
    if (row?.checked_at && Date.now() - Date.parse(row.checked_at) < USER_CHECK_GAP_MS) return { action: "noop", throttled: true };
  }
  return syncSpSession(env, s, pay, source);
}

/** User cancels: close the session at Stripe first (so it can't be paid any more), then mark it canceled. */
export async function spCancel(env, s, pay, userId) {
  if (!pay || pay.provider !== "stripe" || pay.telegram_user_id !== userId || pay.credited || pay.status !== "pending") return { ok: false };
  const sid = String(pay.track_id || "").replace(/^stripe:/, "");
  const x = await expireSpSession(env, sid);
  if (!x.ok) {
    // Already paid / processing / expired at Stripe → apply the real state instead.
    const r = await syncSpSession(env, s, pay, "user_cancel");
    return { ok: false, action: r.action };
  }
  await env.DB.prepare("UPDATE stripe_sessions SET status='expired', updated_at=? WHERE session_id=?").bind(nowIso(), sid).run();
  const r = await env.DB.prepare("UPDATE payments SET status='canceled', last_status='expired', updated_at=? WHERE id=? AND credited=0 AND status='pending'")
    .bind(nowIso(), pay.id)
    .run();
  if (r.meta?.changes === 1) await audit(env, `tg:${userId}`, "stripe_session_canceled", { payment_id: pay.id, session_id: sid });
  return { ok: r.meta?.changes === 1 };
}

/** Cron: re-check sessions with no news (missed webhooks), they close at Stripe after SP_LIFETIME_MIN. */
export async function spCron(env) {
  if (!spConfigured(env)) return;
  const now = Date.now();
  const cutoff = new Date(now - POLL_AFTER_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT p.* FROM stripe_sessions ss JOIN payments p ON p.id = ss.payment_id
      WHERE p.provider='stripe' AND p.credited=0 AND ss.credited=0 AND ss.flag IS NULL
        AND ss.status IN ('open','complete') AND ss.poll_errors < ?
        AND ss.updated_at < ? AND COALESCE(ss.checked_at, '') < ? AND ss.created_at > ?
        AND p.status NOT IN ('review','failed')
      ORDER BY COALESCE(ss.checked_at, '') LIMIT ${POLL_BATCH}`
  )
    .bind(POLL_MAX_ERRORS, cutoff, cutoff, new Date(now - POLL_MAX_AGE_MS).toISOString())
    .all();
  if (!results?.length) return;
  const s = await getSettings(env);
  for (const pay of results) {
    try {
      await syncSpSession(env, s, pay, "cron");
    } catch (err) {
      console.error("Stripe poll failed", err);
    }
  }
}

/* ─── refunds / disputes ─── */

async function findByCharge(env, piId, chargeId) {
  const row = await env.DB.prepare("SELECT * FROM stripe_sessions WHERE (payment_intent=? AND ? IS NOT NULL) OR (charge_id=? AND ? IS NOT NULL) LIMIT 1")
    .bind(piId, piId, chargeId, chargeId)
    .first();
  if (row) return row;
  if (!piId) return null;
  // Not linked yet (e.g. the completion was never synced): the PaymentIntent carries our metadata.
  const r = await spFetch(env, "GET", `/payment_intents/${encodeURIComponent(piId)}`);
  const tid = r.ok ? String(r.data?.metadata?.topup_id || "") : "";
  if (!r.ok || r.data?.metadata?.source !== "liveira-shop" || !/^sp_[A-Za-z0-9_]{4,60}$/.test(tid)) return null;
  const ss = await env.DB.prepare("SELECT * FROM stripe_sessions WHERE payment_id=?").bind(tid).first();
  if (ss) await env.DB.prepare("UPDATE stripe_sessions SET payment_intent=COALESCE(payment_intent, ?), charge_id=COALESCE(charge_id, ?) WHERE session_id=?").bind(piId, chargeId, ss.session_id).run();
  return ss ? { ...ss, payment_intent: ss.payment_intent || piId, charge_id: ss.charge_id || chargeId } : null;
}

/**
 * Debit what was refunded / disputed (capped at the top-up) if the balance covers it in full; otherwise flag the
 * shortfall as unrecovered. State-based, so repeated events never debit twice. → { debited, unrecovered, balance }
 */
async function recoverFunds(env, pay, sid) {
  const DB = env.DB;
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await DB.prepare("SELECT * FROM stripe_sessions WHERE session_id=?").bind(sid).first();
    if (!row) return { debited: 0, unrecovered: 0 };
    const total = round2(Math.min(Number(pay.amount_usd), (Number(row.refunded_cents) + Number(row.dispute_cents)) / 100));
    const delta = round2(total - Number(row.debited_usd) - Number(row.unrecovered_usd));
    if (delta < 0.01) return { debited: 0, unrecovered: 0 };
    const nonce = generateToken();
    const at = nowIso();
    const res = await DB.batch([
      DB.prepare(
        `UPDATE stripe_sessions SET debited_usd=ROUND(debited_usd + ?, 2), debit_nonce=?
          WHERE session_id=? AND debited_usd=? AND unrecovered_usd=? AND COALESCE((SELECT balance FROM users WHERE user_id=?), 0) >= ?`
      ).bind(delta, nonce, sid, row.debited_usd, row.unrecovered_usd, pay.telegram_user_id, delta),
      DB.prepare(
        "UPDATE users SET balance = ROUND(balance - ?, 2) WHERE user_id=? AND EXISTS (SELECT 1 FROM stripe_sessions WHERE session_id=? AND debit_nonce=?)"
      ).bind(delta, pay.telegram_user_id, sid, nonce),
      DB.prepare(
        `INSERT INTO topups (user_id, amount, method, status, created_at, ref)
         SELECT ?, ?, 'stripe_refund', 'completed', ?, ? WHERE EXISTS (SELECT 1 FROM stripe_sessions WHERE session_id=? AND debit_nonce=?)`
      ).bind(pay.telegram_user_id, -delta, at, pay.id, sid, nonce),
      DB.prepare(
        `INSERT INTO audit_log (at, actor, action, details_json)
         SELECT ?, 'stripe', 'stripe_debit', json_object('payment_id', ?, 'session_id', ?, 'user_id', ?, 'amount', ?,
                'new_balance', (SELECT balance FROM users WHERE user_id=?))
          WHERE EXISTS (SELECT 1 FROM stripe_sessions WHERE session_id=? AND debit_nonce=?)`
      ).bind(at, pay.id, sid, pay.telegram_user_id, delta, pay.telegram_user_id, sid, nonce),
    ]);
    const bal = Number((await DB.prepare("SELECT balance FROM users WHERE user_id=?").bind(pay.telegram_user_id).first())?.balance || 0);
    if (res[0]?.meta?.changes === 1) return { debited: delta, unrecovered: 0, balance: bal };
    const now = await DB.prepare("SELECT debited_usd, unrecovered_usd FROM stripe_sessions WHERE session_id=?").bind(sid).first();
    if (now && (now.debited_usd !== row.debited_usd || now.unrecovered_usd !== row.unrecovered_usd)) continue; // concurrent event
    const f = await DB.prepare("UPDATE stripe_sessions SET unrecovered_usd=ROUND(unrecovered_usd + ?, 2) WHERE session_id=? AND debited_usd=? AND unrecovered_usd=?")
      .bind(delta, sid, row.debited_usd, row.unrecovered_usd)
      .run();
    if (f.meta?.changes === 1) {
      await audit(env, "stripe", "stripe_unrecovered", { payment_id: pay.id, session_id: sid, amount: delta, balance: bal });
      return { debited: 0, unrecovered: delta, balance: bal };
    }
  }
  return { debited: 0, unrecovered: 0 };
}

async function handleChargeEvent(env, s, kind, obj) {
  const piId = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id || null;
  const chargeId = kind === "refund" ? obj.id : typeof obj.charge === "string" ? obj.charge : obj.charge?.id || null;
  const row = await findByCharge(env, piId, chargeId);
  if (!row) return { action: "unmatched" };
  const pay = await getSpPayment(env, row.payment_id);
  if (!pay) return { action: "unmatched" };
  let info = {};
  if (kind === "refund") {
    // Defense in depth: read the charge with our key; fall back to the (signed) event object.
    const r = chargeId ? await spFetch(env, "GET", `/charges/${encodeURIComponent(chargeId)}`) : { ok: false };
    const ch = r.ok && r.data?.id === chargeId ? r.data : obj;
    const refunded = Math.max(0, Math.round(Number(ch.amount_refunded) || 0));
    const cur = String(ch.currency || "").toLowerCase();
    await env.DB.prepare("UPDATE stripe_sessions SET refunded_cents=MAX(refunded_cents, ?), charge_id=COALESCE(charge_id, ?), updated_at=? WHERE session_id=?")
      .bind(cur === "usd" ? refunded : 0, chargeId, nowIso(), row.session_id)
      .run();
    info = { refunded_cents: refunded, currency: cur, full: !!ch.refunded, verified: r.ok };
    await env.DB.prepare("UPDATE payments SET last_status=?, updated_at=? WHERE id=?").bind(ch.refunded ? "refunded" : "partially_refunded", nowIso(), pay.id).run();
  } else {
    const amt = Math.max(0, Math.round(Number(obj.amount) || 0));
    const cur = String(obj.currency || "").toLowerCase();
    await env.DB.prepare(
      `UPDATE stripe_sessions SET dispute_id=?, dispute_cents=CASE WHEN dispute_id IS NULL OR dispute_id=? THEN MAX(dispute_cents, ?) ELSE dispute_cents + ? END,
         dispute_status=?, dispute_reason=?, updated_at=? WHERE session_id=?`
    )
      .bind(String(obj.id || "").slice(0, 64), String(obj.id || ""), cur === "usd" ? amt : 0, cur === "usd" ? amt : 0, String(obj.status || "").slice(0, 40), String(obj.reason || "").slice(0, 60), nowIso(), row.session_id)
      .run();
    info = { dispute_id: obj.id, amount_cents: amt, currency: cur, reason: obj.reason || null, status: obj.status || null, due_by: obj.evidence_details?.due_by || null };
    await env.DB.prepare("UPDATE payments SET last_status='disputed', updated_at=? WHERE id=?").bind(nowIso(), pay.id).run();
  }
  const rec = pay.credited ? await recoverFunds(env, pay, row.session_id) : { debited: 0, unrecovered: 0, notCredited: true };
  await audit(env, "stripe", kind === "refund" ? "stripe_refund" : "stripe_dispute", { payment_id: pay.id, session_id: row.session_id, ...info, debited: rec.debited, unrecovered: rec.unrecovered });
  await notifyAdminsSp(env, s, pay, kind, { info, rec });
  if (kind === "refund" && rec.debited > 0) await notifyUserSp(env, s, pay, "refunded", { debited: rec.debited, balance: rec.balance });
  return { action: kind, ...rec };
}

/* ─── POST /stripe/webhook ─── */

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

async function findSessionPayment(env, sess) {
  const sid = String(sess?.id || "");
  if (!/^cs_(live|test)_[A-Za-z0-9]{10,200}$/.test(sid)) return null;
  const ref = String(sess.client_reference_id || sess.metadata?.topup_id || "");
  let pay = /^sp_[A-Za-z0-9_]{4,60}$/.test(ref) ? await getSpPayment(env, ref) : null;
  if (pay && pay.track_id && pay.track_id !== `stripe:${sid}`) return null; // someone else's session id for our ref
  if (!pay) pay = await env.DB.prepare("SELECT * FROM payments WHERE provider='stripe' AND track_id=?").bind(`stripe:${sid}`).first();
  if (pay && !pay.track_id) {
    // The creation response was lost: adopt the session id from the signed event (it's re-fetched before crediting).
    await env.DB.prepare("UPDATE payments SET track_id=?, updated_at=? WHERE id=? AND track_id IS NULL").bind(`stripe:${sid}`, nowIso(), pay.id).run();
    pay = await getSpPayment(env, pay.id);
  }
  return pay;
}

export async function handleStripeWebhook(request, env) {
  if (!spConfigured(env)) return text("not configured", 503);
  if (Number(request.headers.get("Content-Length") || "0") > MAX_BODY) return text("too large", 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return text("too large", 413);
  const v = await verifyStripeSignature(whSecret(env), raw, request.headers.get("Stripe-Signature"));
  if (!v.ok) {
    console.warn("stripe webhook: invalid signature", v.reason, request.headers.get("CF-Connecting-IP"));
    return text("invalid signature", 400);
  }
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return text("invalid json", 400);
  }
  const id = String(evt?.id || "");
  const type = String(evt?.type || "");
  const obj = evt?.data?.object;
  if (!/^evt_[A-Za-z0-9]{6,100}$/.test(id) || !obj || typeof obj !== "object") return text("invalid event", 400);
  if (secretKey(env).startsWith("sk_live_") && evt.livemode === false) return text("ok (test event ignored)");
  if (!STRIPE_EVENTS.includes(type)) return text("ok (ignored)");

  const at = nowIso();
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, object_id, received_at) VALUES (?, ?, ?, ?)")
    .bind(id, type, String(obj.id || "").slice(0, 100), at)
    .run();
  if (ins.meta?.changes !== 1) {
    const prev = await env.DB.prepare("SELECT processed_at, received_at FROM stripe_events WHERE id=?").bind(id).first();
    if (prev?.processed_at) return text("ok (duplicate)");
    if (prev && Date.now() - Date.parse(prev.received_at) < IN_PROGRESS_MS) return text("in progress", 409); // Stripe retries
    await env.DB.prepare("UPDATE stripe_events SET received_at=? WHERE id=?").bind(at, id).run();
  }
  let result;
  try {
    const s = await getSettings(env);
    if (type.startsWith("checkout.session.")) {
      const pay = await findSessionPayment(env, obj);
      if (!pay) {
        // Sessions of other integrations on the same Stripe account land here too — ignore quietly.
        result = { action: "unmatched" };
      } else {
        await env.DB.prepare("UPDATE stripe_sessions SET event_count=event_count+1 WHERE session_id=?").bind(String(obj.id)).run();
        result = await syncSpSession(env, s, pay, "webhook", { event: type });
        if (result.action === "api_error") throw new Error(`stripe session re-fetch failed (${result.http})`); // 500 → Stripe retries
      }
    } else if (type === "charge.refunded") {
      result = await handleChargeEvent(env, s, "refund", obj);
    } else if (type === "charge.dispute.created") {
      result = await handleChargeEvent(env, s, "dispute", obj);
    }
  } catch (err) {
    await env.DB.prepare("DELETE FROM stripe_events WHERE id=? AND processed_at IS NULL").bind(id).run();
    throw err;
  }
  await env.DB.prepare("UPDATE stripe_events SET processed_at=?, result=? WHERE id=?").bind(nowIso(), String(result?.action || "noop").slice(0, 40), id).run();
  if (result?.action === "unmatched") {
    await audit(env, "stripe", "stripe_event_unmatched", { event_id: id, type, object_id: String(obj.id || "").slice(0, 100) });
  }
  return text("ok");
}

/* ─── notifications ─── */

function supportLineFor(s) {
  return s.support_contact ? `💬 Support: ${e(s.support_contact)}` : "💬 Please contact the shop admin.";
}

async function refreshCard(env, s, id) {
  const pay = await getSpPayment(env, id);
  if (!pay?.message_id) return;
  const card = invoiceCard(pay, s, supportLineFor(s));
  await editOrSend(env, pay.chat_id || pay.telegram_user_id, pay.message_id, card.text, { reply_markup: card.reply_markup }, { fallback: false });
}

async function notifyUserSp(env, s, pay, kind, { debited, balance } = {}) {
  const cur = s.currency_symbol || "$";
  if (kind === "failed") await refreshCard(env, s, pay.id).catch(() => {});
  const amt = e(money(pay.amount_usd, cur));
  const text = {
    failed: `❌ Your card payment for the ${amt} top-up failed and was not credited.\n${supportLineFor(s)}`,
    refunded: `↩️ Your card payment for the ${amt} top-up was refunded, so ${e(money(debited, cur))} was deducted from your balance. New balance: ${e(money(balance, cur))}.\n${supportLineFor(s)}`,
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

function fmtUnix(t) {
  if (!Number(t)) return null;
  return new Date(Number(t) * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) + " BRT";
}

async function notifyAdminsSp(env, s, pay, kind, { sess, newBalance, reason, info, rec } = {}) {
  const cur = s.currency_symbol || "$";
  const u = await env.DB.prepare("SELECT username, balance FROM users WHERE user_id=?").bind(pay.telegram_user_id).first();
  const who = `${u?.username ? `@${e(u.username)} ` : ""}(<code>${pay.telegram_user_id}</code>)`;
  const head = {
    credited: "💳 <b>Card top-up credited (Stripe)</b>",
    review: "🟠 <b>Stripe card top-up needs review — not credited</b>",
    failed: "🔴 <b>Stripe card payment failed</b>",
    refund: "🚨 <b>STRIPE REFUND</b> 🚨",
    dispute: "🚨🚨 <b>STRIPE DISPUTE (chargeback)</b> 🚨🚨",
  }[kind];
  let body = `User: ${who}\nTop-up: <b>${kind === "credited" ? "+" : ""}${e(money(pay.amount_usd, cur))}</b>\n`;
  if (kind === "credited" && newBalance != null) body += `New balance: ${e(money(newBalance, cur))}\n`;
  if (kind === "review") body += `Reason: ${reason === "amount_mismatch" ? `Stripe amount ${e(String(sess?.amount_total ?? "?"))} ${e(String(sess?.currency || "").toUpperCase())} (cents) differs from the top-up` : e(String(reason))}\nAdjust the balance manually in the admin panel if needed.\n`;
  if (kind === "refund") {
    body += `Refunded so far: <b>${e(money((info?.refunded_cents || 0) / 100, "$"))}</b> ${e(String(info?.currency || "").toUpperCase())}${info?.full ? " (full refund)" : ""}\n`;
  }
  if (kind === "dispute") {
    body += `Disputed: <b>${e(money((info?.amount_cents || 0) / 100, "$"))}</b> ${e(String(info?.currency || "").toUpperCase())} · reason: ${e(String(info?.reason || "?"))} · status: ${e(String(info?.status || "?"))}\n`;
    if (info?.due_by) body += `⏰ Evidence due by: <b>${e(fmtUnix(info.due_by))}</b> — respond in the Stripe dashboard (Payments → Disputes).\n`;
    body += "Stripe already withdrew the disputed amount plus the dispute fee.\n";
  }
  if (kind === "refund" || kind === "dispute") {
    if (rec?.notCredited) body += "The top-up was never credited — nothing to deduct.\n";
    else if (rec?.debited > 0) body += `✅ Deducted from the wallet: <b>${e(money(rec.debited, cur))}</b> (balance now ${e(money(rec.balance, cur))}).\n`;
    else if (rec?.unrecovered > 0)
      body += `⚠️ <b>NOT deducted</b>: the customer's balance (${e(money(rec.balance, cur))}) is lower than ${e(money(rec.unrecovered, cur))} — they probably spent it already. Decide manually (panel → user balance / tokens).\n`;
    else body += "Already accounted for — nothing more deducted.\n";
  }
  body += `Session: <code>${e(String(pay.track_id || "").replace(/^stripe:/, ""))}</code>\nRef: <code>${e(pay.id)}</code>`;
  const text = `${head}\n\n${body}`;
  for (const id of adminIdList(env)) {
    try {
      await sendMessage(env, id, text);
    } catch (err) {
      console.error("admin notify failed", err);
    }
  }
}

/** Panel status card. */
export async function spStatus(env, s) {
  const spc = spConfig(s, env);
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE provider='stripe' AND credited=0 AND status IN ('pending','paying','review')").first();
  const flags = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM stripe_sessions WHERE unrecovered_usd > 0 OR dispute_id IS NOT NULL OR refunded_cents > 0"
  ).first();
  return {
    configured: spc.configured,
    key_set: !!secretKey(env),
    webhook_secret_set: !!whSecret(env),
    livemode: secretKey(env).startsWith("sk_live_"),
    enabled: spc.enabled,
    available: spc.available,
    min: spc.min,
    max: spc.max,
    webhook_url: webhookUrl(env),
    webhook_id: s.stripe_webhook_id || null,
    open: open?.n || 0,
    refunds_disputes: flags?.n || 0,
  };
}
