/* Pix top-ups via Mercado Pago — ported from @LiveiraStore_bot (liveira-store/src/mercadopago.ts + services/deposits.ts).
 * Docs: https://www.mercadopago.com.br/developers/pt/reference/payments/_payments/post
 *  - POST /v1/payments (Bearer MERCADOPAGO_ACCESS_TOKEN, X-Idempotency-Key) payment_method_id=pix → point_of_interaction.transaction_data
 *    { qr_code (copia e cola), qr_code_base64, ticket_url }
 *  - GET  /v1/payments/{id} → status pending|approved|rejected|cancelled|refunded|charged_back…
 *  - PUT  /v1/payments/{id} {status:"cancelled"} (user cancels a pending Pix)
 *  - Webhook POST /mercadopago/webhook (?type=payment&data.id=…). Optional x-signature check with MERCADOPAGO_WEBHOOK_SECRET.
 *    Nothing in the webhook body is trusted: the payment is always re-read with the access token before crediting.
 *
 * The wallet is in USD. The customer picks a USD amount; we charge amount × USD/BRL rate (+ optional spread %) in BRL and,
 * once Mercado Pago says approved with the same external_reference, BRL amount and payment id, credit the USD amount once
 * (payments.credited 0→1 with a nonce, same batch pattern as Stripe / NOWPayments).
 */
import { nowIso, generateToken, money, audit, getSettings, tgEsc as e } from "./util.js";
import { sendMessage } from "./ui.js";
import { notifyCredit, topupConfig, round2, expireStale } from "./oxapay.js";

const DEFAULT_API = "https://api.mercadopago.com";
export const PIX_LIFETIME_MIN = 30;
const DEFAULT_MIN = 1;
const DEFAULT_MAX = 500;
const POLL_AFTER_MS = 60 * 1000;
const POLL_BATCH = 5;
const USER_CHECK_GAP_MS = 5 * 1000;
const MAX_OPEN_INVOICES = 5;
const FX_TTL_MS = 30 * 60 * 1000;
const enc = new TextEncoder();

const apiBase = (env) => String(env.MERCADOPAGO_API_BASE || DEFAULT_API).replace(/\/+$/, "");
const token = (env) => String(env.MERCADOPAGO_ACCESS_TOKEN || "").trim();

export function pixConfigured(env) {
  return !!token(env);
}

export function pixWebhookUrl(env) {
  return `${String(env.PUBLIC_BASE_URL || "https://liveira-shop.kelumayou.workers.dev").replace(/\/+$/, "")}/mercadopago/webhook`;
}

/** { enabled, configured, available, min, max, presets } in USD. */
export function pixConfig(s, env) {
  const tc = topupConfig(s, env);
  const enabled = s.pix_enabled === "1";
  const configured = pixConfigured(env);
  let pmin = Number(s.pix_min);
  if (!Number.isFinite(pmin) || pmin < 1) pmin = DEFAULT_MIN;
  let pmax = Number(s.pix_max);
  if (!Number.isFinite(pmax) || pmax <= 0) pmax = DEFAULT_MAX;
  const min = round2(Math.max(tc.min, pmin));
  const max = round2(Math.min(tc.max, pmax));
  const presets = [];
  for (const a of [Math.ceil(min), ...tc.presets]) if (a >= min && a <= max && !presets.includes(a)) presets.push(a);
  presets.sort((a, b) => a - b);
  return { enabled, configured, available: enabled && configured && max >= min, min, max, presets: presets.slice(0, 4) };
}

/* ─── USD → BRL ─── */

const saneRate = (n) => Number.isFinite(n) && n > 2 && n < 20;
let fxMemo = null;

async function fetchRate() {
  const sources = [
    ["AwesomeAPI", "https://economia.awesomeapi.com.br/json/last/USD-BRL", (d) => Number(d?.USDBRL?.ask)],
    ["open.er-api", "https://open.er-api.com/v6/latest/USD", (d) => (d?.result === "success" ? Number(d?.rates?.BRL) : NaN)],
  ];
  for (const [name, url, pick] of sources) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const v = pick(await r.json());
      if (saneRate(v)) return { rate: v, source: name };
    } catch (err) {
      console.warn("pix fx source failed", name, String(err).slice(0, 120));
    }
  }
  return null;
}

/** Base USD/BRL rate: env PIX_FX_RATE (tests) → settings.pix_usd_brl (fixed by the admin) → live (cached 30 min) → last saved. */
export async function usdBrl(env, s) {
  const fixedEnv = Number(env.PIX_FX_RATE);
  if (saneRate(fixedEnv)) return { rate: fixedEnv, source: "env" };
  const fixed = Number(String(s.pix_usd_brl || "").replace(",", "."));
  if (saneRate(fixed)) return { rate: fixed, source: "fixed" };
  if (fxMemo && fxMemo.until > Date.now()) return fxMemo.value;
  let cached = null;
  try {
    cached = JSON.parse(s.pix_fx_cache || "null");
  } catch {}
  if (cached && saneRate(cached.rate) && Date.now() - cached.at < FX_TTL_MS) {
    fxMemo = { value: { rate: cached.rate, source: cached.source }, until: Date.now() + 60000 };
    return fxMemo.value;
  }
  const live = await fetchRate();
  if (live) {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pix_fx_cache', ?)")
      .bind(JSON.stringify({ ...live, at: Date.now() }))
      .run()
      .catch(() => {});
    fxMemo = { value: live, until: Date.now() + 60000 };
    return live;
  }
  if (cached && saneRate(cached.rate)) return { rate: cached.rate, source: `${cached.source} (stale)` };
  return null;
}

/** BRL charge for a USD amount: rate × (1 + spread%), rounded up to the cent. → { brl, rate } | null */
export async function quoteBrl(env, s, usd) {
  const fx = await usdBrl(env, s);
  if (!fx) return null;
  let spread = Number(String(s.pix_fx_spread || "0").replace(",", "."));
  if (!Number.isFinite(spread) || spread < 0 || spread > 50) spread = 0;
  const rate = Math.round(fx.rate * (1 + spread / 100) * 10000) / 10000;
  return { brl: Math.ceil(Math.round(usd * rate * 1000) / 10) / 100, rate, source: fx.source };
}

/* ─── API ─── */

async function mpFetch(env, method, path, body, { idem } = {}) {
  let res;
  try {
    res = await fetch(`${apiBase(env)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token(env)}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(idem ? { "X-Idempotency-Key": idem } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error("Mercado Pago fetch failed", method, path, String(err).slice(0, 120));
    return { ok: false, http: 0, data: null };
  }
  const data = await res.json().catch(() => null);
  const ok = res.ok && !!data && typeof data === "object" && data.id != null;
  if (!ok) console.error("Mercado Pago API error", method, path, res.status, String(data?.message || "").slice(0, 160));
  return { ok, http: res.status, data };
}

/** São Paulo ISO with offset, as Mercado Pago expects for date_of_expiration (yyyy-MM-ddTHH:mm:ss.SSS-03:00). */
export function isoSaoPaulo(ms) {
  return new Date(ms - 3 * 3600 * 1000).toISOString().replace("Z", "-03:00");
}

/** Optional x-signature check: HMAC-SHA256(secret, "id:<data.id>;request-id:<x-request-id>;ts:<ts>;") == v1. */
export async function verifyMpSignature(secret, xSignature, xRequestId, dataId) {
  if (!secret || !xSignature) return false;
  const parts = {};
  for (const p of String(xSignature).split(",")) {
    const i = p.indexOf("=");
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  if (!parts.ts || !parts.v1) return false;
  let manifest = `id:${String(dataId).toLowerCase()};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${parts.ts};`;
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(manifest)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== parts.v1.length) return false;
  let d = 0;
  for (let i = 0; i < hex.length; i++) d |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return d === 0;
}

/* ─── create ─── */

function newId() {
  return `px_${Date.now().toString(36)}_${generateToken().slice(0, 10).replace(/[^A-Za-z0-9]/g, "x")}`;
}

export async function getPixPayment(env, id) {
  return env.DB.prepare("SELECT * FROM payments WHERE id=? AND provider='mercadopago'").bind(id).first();
}

/** Create a Pix charge + pending payments row. → { ok, payment, reused? } | { ok:false, reason, min?, max? } */
export async function createPix(env, s, { userId, chatId, amount, resume }) {
  const pc = pixConfig(s, env);
  if (!pc.available) return { ok: false, reason: "unconfigured" };
  if (!Number.isFinite(amount) || amount < pc.min) return { ok: false, reason: "min", min: pc.min };
  if (amount > pc.max) return { ok: false, reason: "max", max: pc.max };
  amount = round2(amount);
  await expireStale(env);
  resume = /^[a-z0-9_-]{1,32}:\d{1,4}$/.test(String(resume || "")) ? String(resume) : null;
  const reuse = await env.DB.prepare(
    `SELECT * FROM payments WHERE provider='mercadopago' AND telegram_user_id=? AND amount_usd=? AND status='pending' AND credited=0
       AND pix_code IS NOT NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(userId, amount, new Date(Date.now() + 10 * 60 * 1000).toISOString())
    .first();
  if (reuse) {
    if (resume !== (reuse.resume || null)) {
      await env.DB.prepare("UPDATE payments SET resume=?, updated_at=? WHERE id=? AND credited=0").bind(resume, nowIso(), reuse.id).run();
      reuse.resume = resume;
    }
    return { ok: true, payment: reuse, reused: true };
  }
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM payments WHERE telegram_user_id=? AND status IN ('creating','pending') AND (pay_link IS NOT NULL OR pix_code IS NOT NULL) AND created_at >= ?"
  )
    .bind(userId, new Date(Date.now() - 3600 * 1000).toISOString())
    .first();
  if ((open?.n || 0) >= MAX_OPEN_INVOICES) return { ok: false, reason: "too_many" };
  const q = await quoteBrl(env, s, amount);
  if (!q) return { ok: false, reason: "fx" };

  const id = newId();
  const at = nowIso();
  const expMs = Date.now() + PIX_LIFETIME_MIN * 60000;
  await env.DB.prepare(
    `INSERT INTO payments (id, provider, telegram_user_id, chat_id, amount_usd, amount_brl, fx_rate, status, created_at, updated_at, resume)
     VALUES (?, 'mercadopago', ?, ?, ?, ?, ?, 'creating', ?, ?, ?)`
  )
    .bind(id, userId, chatId ?? null, amount, q.brl, q.rate, at, at, resume)
    .run();
  const shop = s.shop_name || "Liveira Shop";
  const body = {
    transaction_amount: q.brl,
    description: `${shop} - recarga ${money(amount, "$")}`.slice(0, 200),
    payment_method_id: "pix",
    external_reference: id,
    date_of_expiration: isoSaoPaulo(expMs),
    payer: { email: `tg${userId}@liveira-shop.com` },
    notification_url: pixWebhookUrl(env),
    metadata: { topup_id: id, telegram_user_id: String(userId), amount_usd: amount },
  };
  const r = await mpFetch(env, "POST", "/v1/payments", body, { idem: `liveira-shop-${id}` });
  const tx = r.data?.point_of_interaction?.transaction_data || {};
  const ok =
    r.ok &&
    /^\d{1,20}$/.test(String(r.data.id)) &&
    String(r.data.external_reference || "") === id &&
    Math.abs(Number(r.data.transaction_amount) - q.brl) < 0.005 &&
    typeof tx.qr_code === "string" &&
    tx.qr_code.length > 20;
  if (!ok) {
    const info = { http: r.http, message: String(r.data?.message || "unexpected_response").slice(0, 200) };
    await env.DB.prepare("UPDATE payments SET status='error', last_status=?, updated_at=? WHERE id=?").bind(JSON.stringify(info), nowIso(), id).run();
    await audit(env, `tg:${userId}`, "pix_create_failed", { payment_id: id, amount, brl: q.brl, ...info });
    return { ok: false, reason: "api" };
  }
  const link = /^https:\/\//.test(String(tx.ticket_url || "")) ? String(tx.ticket_url) : null;
  await env.DB.prepare(
    "UPDATE payments SET status='pending', track_id=?, pix_code=?, pay_link=?, expires_at=?, last_status=?, updated_at=? WHERE id=?"
  )
    .bind(`mp:${r.data.id}`, tx.qr_code, link, new Date(expMs).toISOString(), String(r.data.status || "pending"), nowIso(), id)
    .run();
  await audit(env, `tg:${userId}`, "pix_created", { payment_id: id, mp_id: String(r.data.id), amount, brl: q.brl, rate: q.rate });
  return { ok: true, payment: await getPixPayment(env, id) };
}

/* ─── status ─── */

async function creditPix(env, pay, p, source) {
  const DB = env.DB;
  const at = nowIso();
  const nonce = generateToken();
  const payload = JSON.stringify({ id: p.id, status: p.status, amount: p.transaction_amount, currency: p.currency_id, ref: p.external_reference }).slice(0, 1000);
  const res = await DB.batch([
    DB.prepare(
      `UPDATE payments SET status='paid', credited=1, credit_nonce=?, paid_at=?, updated_at=?, last_status='approved', last_payload=?
        WHERE id=? AND provider='mercadopago' AND credited=0 AND status NOT IN ('creating','error','review')`
    ).bind(nonce, at, at, payload, pay.id),
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
       SELECT telegram_user_id, amount_usd, 'pix', 'completed', ?, id FROM payments WHERE id=? AND credit_nonce=?`
    ).bind(at, pay.id, nonce),
    DB.prepare(
      `INSERT INTO audit_log (at, actor, action, details_json)
       SELECT ?, 'mercadopago', 'pix_credit',
              json_object('payment_id', p.id, 'mp_id', ?, 'user_id', p.telegram_user_id, 'amount', p.amount_usd, 'brl', p.amount_brl,
                          'new_balance', u.balance, 'source', ?)
         FROM payments p LEFT JOIN users u ON u.user_id = p.telegram_user_id
        WHERE p.id=? AND p.credit_nonce=?`
    ).bind(at, String(p.id), source, pay.id, nonce),
  ]);
  if (res[0]?.meta?.changes !== 1) return { won: false };
  const u = await DB.prepare("SELECT balance FROM users WHERE user_id=?").bind(pay.telegram_user_id).first();
  return { won: true, newBalance: Number(u?.balance || 0), amount: Number(pay.amount_usd) };
}

async function setStatus(env, pay, status, lastStatus, from) {
  const ph = from.map(() => "?").join(",");
  const r = await env.DB.prepare(`UPDATE payments SET status=?, last_status=?, updated_at=? WHERE id=? AND credited=0 AND status IN (${ph})`)
    .bind(status, lastStatus, nowIso(), pay.id, ...from)
    .run();
  return r.meta?.changes === 1;
}

/** Apply a payment re-read from the API (never a webhook body). → { action: credited|duplicate|review|pending|expired|canceled|failed|mismatch } */
export async function applyMpPayment(env, s, pay, p, source) {
  const mpId = String(pay.track_id || "").replace(/^mp:/, "");
  if (String(p.external_reference || "") !== pay.id || (mpId && String(p.id) !== mpId)) return { action: "mismatch" };
  const st = String(p.status || "");
  if (st === "approved") {
    if (pay.credited) return { action: "duplicate" };
    const amountOk =
      String(p.currency_id || "BRL").toUpperCase() === "BRL" &&
      String(p.payment_method_id || "pix") === "pix" &&
      Math.abs(Number(p.transaction_amount) - Number(pay.amount_brl)) < 0.005;
    if (!amountOk) {
      if (await setStatus(env, pay, "review", "amount_mismatch", ["creating", "error", "pending", "paying", "expired", "canceled", "failed"])) {
        await audit(env, "mercadopago", "pix_review", { payment_id: pay.id, mp_id: String(p.id), amount: p.transaction_amount, currency: p.currency_id });
        await notifyAdminsPix(env, s, pay, `⚠️ Pix <code>${e(pay.id)}</code> aprovado com valor/moeda diferente (${e(String(p.transaction_amount))} ${e(String(p.currency_id || ""))}). Não creditado — revisar.`);
      }
      return { action: "review" };
    }
    if (pay.status === "creating" || pay.status === "error") {
      await env.DB.prepare("UPDATE payments SET status='pending', updated_at=? WHERE id=? AND credited=0 AND status IN ('creating','error')").bind(nowIso(), pay.id).run();
    }
    const c = await creditPix(env, pay, p, source);
    if (!c.won) {
      const fresh = await getPixPayment(env, pay.id);
      return { action: fresh?.credited ? "duplicate" : "noop" };
    }
    await notifyCredit(env, pay, c);
    const cur = s.currency_symbol || "$";
    await notifyAdminsPix(
      env,
      s,
      pay,
      `💠 <b>Recarga Pix creditada</b>\nUsuário: <code>${pay.telegram_user_id}</code>\nValor: <b>${e(money(pay.amount_usd, cur))}</b> (R$ ${Number(pay.amount_brl).toFixed(2)})\nNovo saldo: ${e(money(c.newBalance, cur))}\nRef: <code>${e(pay.id)}</code>`
    );
    return { action: "credited", newBalance: c.newBalance, amount: c.amount };
  }
  if (pay.credited) return { action: "noop" };
  if (st === "cancelled" || st === "expired") {
    const expired = pay.expires_at && Date.parse(pay.expires_at) <= Date.now();
    await setStatus(env, pay, expired ? "expired" : "canceled", st, ["pending", "paying", "creating"]);
    return { action: expired ? "expired" : "canceled" };
  }
  if (st === "rejected" || st === "refunded" || st === "charged_back") {
    await setStatus(env, pay, "failed", st, ["pending", "paying", "creating", "expired"]);
    return { action: "failed" };
  }
  if (st === "in_process" || st === "authorized" || st === "in_mediation") {
    await setStatus(env, pay, "paying", st, ["pending"]);
    return { action: "paying" };
  }
  if (pay.expires_at && Date.parse(pay.expires_at) + 5 * 60000 < Date.now()) {
    await setStatus(env, pay, "expired", st || "pending", ["pending"]);
    return { action: "expired" };
  }
  return { action: "pending" };
}

export async function syncPix(env, s, pay, source) {
  const mpId = String(pay.track_id || "").replace(/^mp:/, "");
  if (!/^\d{1,20}$/.test(mpId)) return { action: "mismatch", reason: "no_payment" };
  await env.DB.prepare("UPDATE payments SET checked_at=? WHERE id=?").bind(nowIso(), pay.id).run();
  const r = await mpFetch(env, "GET", `/v1/payments/${mpId}`);
  if (!r.ok || String(r.data.id) !== mpId) return { action: "api_error", http: r.http };
  return applyMpPayment(env, s, pay, r.data, source);
}

/** User "check status" button. */
export async function pixCheck(env, s, pay, source) {
  if (!pixConfigured(env)) return { action: "unconfigured" };
  if (pay.checked_at && Date.now() - Date.parse(pay.checked_at) < USER_CHECK_GAP_MS) return { action: "pending", throttled: true };
  return syncPix(env, s, pay, source);
}

/** User cancels: cancel at Mercado Pago first (so it can't be paid any more), then mark it canceled. */
export async function pixCancel(env, s, pay, userId) {
  if (!pay || pay.provider !== "mercadopago" || pay.telegram_user_id !== userId || pay.credited || pay.status !== "pending") return { ok: false };
  const mpId = String(pay.track_id || "").replace(/^mp:/, "");
  const x = await mpFetch(env, "PUT", `/v1/payments/${mpId}`, { status: "cancelled" });
  if (!x.ok || x.data.status !== "cancelled") {
    const r = await syncPix(env, s, pay, "user_cancel"); // already paid → credit instead
    return { ok: false, action: r.action };
  }
  const r = await env.DB.prepare("UPDATE payments SET status='canceled', last_status='cancelled', updated_at=? WHERE id=? AND credited=0 AND status='pending'")
    .bind(nowIso(), pay.id)
    .run();
  if (r.meta?.changes === 1) await audit(env, `tg:${userId}`, "pix_canceled", { payment_id: pay.id, mp_id: mpId });
  return { ok: r.meta?.changes === 1 };
}

/** Cron: re-check open Pix charges (missed webhooks). */
export async function pixCron(env) {
  if (!pixConfigured(env)) return;
  const cutoff = new Date(Date.now() - POLL_AFTER_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT * FROM payments WHERE provider='mercadopago' AND credited=0 AND status IN ('pending','paying') AND track_id IS NOT NULL
        AND created_at < ? AND COALESCE(checked_at, '') < ? AND created_at > ?
      ORDER BY COALESCE(checked_at, '') LIMIT ${POLL_BATCH}`
  )
    .bind(cutoff, cutoff, new Date(Date.now() - 86400 * 1000).toISOString())
    .all();
  if (!results?.length) return;
  const s = await getSettings(env);
  for (const pay of results) {
    try {
      await syncPix(env, s, pay, "cron");
    } catch (err) {
      console.error("Pix poll failed", err);
    }
  }
}

/* ─── webhook ─── */

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

export async function handleMpWebhook(request, env) {
  if (!pixConfigured(env)) return text("not configured", 200);
  const url = new URL(request.url);
  let body = {};
  try {
    body = JSON.parse((await request.text()).slice(0, 65536) || "{}");
  } catch {
    body = {};
  }
  const type = String(body?.type || body?.topic || url.searchParams.get("type") || url.searchParams.get("topic") || "");
  const id = String(body?.data?.id ?? url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? (type === "payment" ? body?.resource ?? "" : "")).replace(/^.*\//, "");
  if (type !== "payment" && !String(body?.action || "").startsWith("payment.")) return text("ignored");
  if (!/^\d{1,20}$/.test(id)) return text("ignored");
  if (env.MERCADOPAGO_WEBHOOK_SECRET) {
    const valid = await verifyMpSignature(env.MERCADOPAGO_WEBHOOK_SECRET, request.headers.get("x-signature"), request.headers.get("x-request-id"), url.searchParams.get("data.id") || id);
    if (!valid) console.warn("mp webhook: invalid/missing signature", id); // not fatal: the payment is re-read with the token
  }
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE provider='mercadopago' AND track_id=?").bind(`mp:${id}`).first();
  if (!pay) return text("unknown"); // another app on the same Mercado Pago account
  const s = await getSettings(env);
  const r = await syncPix(env, s, pay, "webhook");
  if (r.action === "api_error") return text("retry", 500); // Mercado Pago retries; the cron also re-checks
  return text("ok");
}

/* ─── notices ─── */

async function notifyAdminsPix(env, s, pay, html) {
  const ids = String(env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number);
  for (const id of [...new Set(ids)]) {
    try {
      await sendMessage(env, id, html);
    } catch (err) {
      console.error("pix admin notify failed", err);
    }
  }
}

export async function pixStatus(env, s) {
  const pc = pixConfig(s, env);
  return { ...pc, webhook_url: pixWebhookUrl(env), webhook_secret: !!env.MERCADOPAGO_WEBHOOK_SECRET };
}
