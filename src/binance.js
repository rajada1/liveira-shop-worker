/* Binance Pay top-ups, verified automatically.
 * The customer sends USDT via Binance Pay to the shop's Pay ID and pastes the transaction ID in the chat. We look the ID
 * up in the shop's own Binance Pay history with a READ-ONLY API key:
 *   GET https://api.binance.com/sapi/v1/pay/transactions   (USER_DATA: HMAC-SHA256 signature, header X-MBX-APIKEY, weight 3000)
 *   → { code:"000000", message:"success", success:true, data:[{ orderType, transactionId, transactionTime,
 *        amount (positive = income, negative = expense), currency, payerInfo{ binanceId }, receiverInfo{ binanceId (UID), accountId (Pay ID) } }] }
 * - The history is cached in D1 (binance_tx) and fetched at most once per BINANCE_CACHE_TTL_SEC (default 45 s) for the whole
 *   Worker (compare-and-set on binance_state.fetch_at). 451/429/418/403/5xx/auth errors set a backoff instead of retrying.
 * - One payments row per transaction: provider='binance', track_id='binance:<txid>' (UNIQUE) → a transaction can be
 *   claimed by one account only; crediting is exactly-once with the same nonce batch as OxaPay (applyStatus).
 * - Claims not found yet stay 'pending' and are re-checked by the cron (scheduled()) for CLAIM_WINDOW_MIN minutes.
 * - Without BINANCE_API_KEY / BINANCE_API_SECRET the option is hidden in the bot.
 */
import { nowIso, generateToken, money, audit, tgEsc as e, parseCoinList, getSettings } from "./util.js";
import { btn, copyBtn, kb, HOME, editOrSend, sendMessage } from "./ui.js";

const DEFAULT_API = "https://api.binance.com";
const HISTORY_PATH = "/sapi/v1/pay/transactions";
export const CLAIM_WINDOW_MIN = 30;
const LOOKBACK_DAYS = 7; // history window searched (the API allows up to 90 days per query)
const RECENT_HOURS = 24; // second query when the 7-day page is full, so the newest transfers are always covered
const PAGE = 100; // API maximum
const RATE_GAP_MS = 20 * 1000; // per user: one verification every 20 s …
const RATE_HOUR = 10; // … and at most 10 per hour
const MAX_OPEN_CLAIMS = 5; // pending claims per user
const ORDER_TYPES = new Set(["C2C", "PAY"]); // transfers / payments to us (not red packets, refunds, payouts)
const TXID_RE = /^[A-Za-z0-9_-]{6,64}$/;
export const BINANCE_PROMPT = "🟡 Paste your Binance Pay transaction ID below:";
const enc = new TextEncoder();

/* ─── config ─── */

/**
 * Kill switch: wrangler.toml [vars] BINANCE_DISABLED = "1" (2026-10-05). Binance Pay moved to @LiveiraStore_bot, which now
 * auto-verifies the same Binance account; only ONE bot may verify it (duplicate protection is per database).
 * When on, everything behaves as "unconfigured": option hidden, claims refused, cron/recheck/panel never call Binance.
 * Code is kept — set BINANCE_DISABLED = "0" (and turn auto-verify off in the Store) to bring it back.
 */
export function binanceDisabled(env) {
  return String(env.BINANCE_DISABLED || "").trim() === "1";
}

export function binanceConfigured(env) {
  if (binanceDisabled(env)) return false;
  return !!(String(env.BINANCE_API_KEY || "").trim() && String(env.BINANCE_API_SECRET || "").trim());
}

export function binanceConfig(s, env) {
  const enabled = s.binance_enabled === "1";
  const configured = binanceConfigured(env);
  const payId = String(s.binance_pay_id || "").trim();
  const coins = parseCoinList(s.binance_currencies);
  let max = Number(s.binance_max);
  if (!Number.isFinite(max) || max <= 0) max = 1000;
  const validId = /^\d{4,20}$/.test(payId);
  return { enabled, configured, payId, validId, currencies: coins.length ? coins : ["USDT"], max, available: enabled && configured && validId };
}

function coinsOf(s) {
  const c = parseCoinList(s.binance_currencies);
  return { currencies: c.length ? c : ["USDT"] };
}

export function binanceCoinsLabel(bc, { bold = false } = {}) {
  const l = bc.currencies.map((c) => (bold ? `<b>${c}</b>` : c));
  return l.length === 1 ? l[0] : `${l.slice(0, -1).join(", ")} or ${l[l.length - 1]}`;
}

function cacheTtlMs(env) {
  const n = Number(env.BINANCE_CACHE_TTL_SEC);
  return (Number.isFinite(n) && n >= 1 && n <= 600 ? n : 45) * 1000;
}

/** Trim and validate a pasted transaction ID (exact match later, so no case change). */
export function normalizeTxId(raw) {
  const t = String(raw || "").trim().replace(/^#/, "");
  return TXID_RE.test(t) ? t : null;
}

export const trackOf = (txid) => `binance:${txid}`;
export const txidOf = (pay) => String(pay?.track_id || "").replace(/^binance:/, "");

function floor2(n) {
  return Math.floor(Number(n) * 100 + 1e-6) / 100;
}

/* ─── Binance API (signed) ─── */

async function hmacSha256Hex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Query string with recvWindow + timestamp, signature appended last (HMAC-SHA256 hex of the exact query string). */
export async function signedQuery(env, params) {
  const qs = new URLSearchParams({ ...params, recvWindow: "10000", timestamp: String(Date.now()) }).toString();
  return `${qs}&signature=${await hmacSha256Hex(String(env.BINANCE_API_SECRET).trim(), qs)}`;
}

const BACKOFF_MS = { region: 10 * 60000, blocked: 5 * 60000, rate: 60000, banned: 5 * 60000, auth: 5 * 60000, clock: 30000, unavailable: 30000, network: 30000, api: 60000 };

/** fetch() towards Binance. In production the request leaves through the BINANCE_EGRESS service binding (a small Worker
 * pinned near Binance's API region, egress/), because Binance answers 451 to Cloudflare data centers in restricted
 * countries (e.g. the US). A custom BINANCE_API_BASE (tests) or a missing binding → direct fetch. */
function binanceFetch(env, url, init) {
  if (env.BINANCE_EGRESS && !env.BINANCE_API_BASE) return env.BINANCE_EGRESS.fetch(new Request(url, init));
  return fetch(url, init);
}

async function binanceGet(env, params, path = HISTORY_PATH) {
  const base = String(env.BINANCE_API_BASE || DEFAULT_API).replace(/\/+$/, "");
  let res;
  try {
    res = await binanceFetch(env, `${base}${path}?${await signedQuery(env, params)}`, {
      headers: { "X-MBX-APIKEY": String(env.BINANCE_API_KEY).trim() },
    });
  } catch (err) {
    console.error("Binance fetch failed", err);
    return { ok: false, reason: "network" };
  }
  const data = await res.json().catch(() => null);
  const retryAfter = Number(res.headers.get("Retry-After")) || 0;
  if (!res.ok) {
    const code = Number(data?.code);
    let reason = "api";
    if (res.status === 451) reason = "region"; // restricted location
    else if (res.status === 429) reason = "rate";
    else if (res.status === 418) reason = "banned"; // IP auto-banned after ignoring 429s
    else if (res.status === 403) reason = "blocked"; // WAF limit
    else if (res.status >= 500) reason = "unavailable";
    else if (code === -1021) reason = "clock";
    else if (res.status === 401 || [-2014, -2015, -1022, -2008, -1002].includes(code)) reason = "auth";
    console.error("Binance API error", res.status, data?.code, String(data?.msg || "").slice(0, 120));
    return { ok: false, reason, http: res.status, code: data?.code ?? null, retryAfter };
  }
  if (path !== HISTORY_PATH) return data && typeof data === "object" ? { ok: true, data } : { ok: false, reason: "api", http: res.status };
  if (!data || data.success === false || (data.code != null && String(data.code) !== "000000") || !Array.isArray(data.data)) {
    console.error("Binance API unexpected body", res.status, data?.code, String(data?.message || "").slice(0, 120));
    return { ok: false, reason: "api", http: res.status, code: data?.code ?? null };
  }
  return { ok: true, list: data.data };
}

/** Where Binance requests leave from: { via: 'egress'|'direct', colo, loc } (no secrets involved). */
async function egressWhere(env) {
  try {
    if (env.BINANCE_EGRESS && !env.BINANCE_API_BASE) {
      const r = await env.BINANCE_EGRESS.fetch("https://egress.internal/__egress");
      return { via: "egress", ...(await r.json()) };
    }
    const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    const m = (k) => (t.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1] || null;
    return { via: "direct", colo: m("colo"), loc: m("loc") };
  } catch {
    return { via: env.BINANCE_EGRESS ? "egress" : "direct", colo: null, loc: null };
  }
}

/** Shape of a value without its content: "string(18,digits)", "number(+)", "object", … */
function shapeOf(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "number") return `number(${v > 0 ? "+" : v < 0 ? "-" : "0"})`;
  if (typeof v === "string") {
    const kind = /^\d+$/.test(v) ? "digits" : /^-?\d+(\.\d+)?$/.test(v) ? (v.startsWith("-") ? "decimal-" : "decimal+") : "text";
    return `string(${v.length},${kind})`;
  }
  return Array.isArray(v) ? "array" : typeof v;
}

/**
 * Admin diagnostics, privacy-safe: egress location, API key restrictions (booleans only) and the SHAPE of the recent
 * Pay history (field names, value kinds, counts; where the configured Pay ID appears). No names, ids or amounts of payers.
 */
export async function binanceDiag(env, settings) {
  const out = { egress: await egressWhere(env) };
  if (!env.BINANCE_API_BASE) {
    // Would a direct request from this data center work? (unsigned, public endpoint)
    try {
      const t = await fetch("https://api-gcp.binance.com/api/v3/time");
      out.direct = { colo: out.egress.via === "direct" ? out.egress.colo : null, binanceTime: t.status };
    } catch {
      out.direct = { binanceTime: "error" };
    }
  }
  if (!binanceConfigured(env)) return { ...out, ok: false, reason: "unconfigured" };
  const bc = binanceConfig(settings, env);
  const rr = await binanceGet(env, {}, "/sapi/v1/account/apiRestrictions");
  if (!rr.ok) return { ...out, ok: false, reason: rr.reason, http: rr.http ?? null, code: rr.code ?? null };
  const restr = {};
  for (const [k, v] of Object.entries(rr.data)) if (typeof v === "boolean") restr[k] = v;
  out.apiRestrictions = restr;
  out.ipRestrict = rr.data.ipRestrict ?? null;
  const now = Date.now();
  const h = await binanceGet(env, { startTime: String(now - 89 * 86400000), endTime: String(now), limit: "20" });
  if (!h.ok) return { ...out, ok: false, reason: h.reason, http: h.http ?? null, code: h.code ?? null };
  const fields = {};
  const count = (o, k) => (o[k] = (o[k] || 0) + 1);
  const st = { total: h.list.length, orderType: {}, currency: {}, amountSign: {}, payIdAt: {}, incomingWithPayIdAsReceiver: 0, txidShape: {}, txidMask: {}, txidVsOrderId: {}, receiverAccountVsBinanceId: {} };
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix + k;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, key + ".");
      else count((fields[key] ||= {}), shapeOf(v));
      if (bc.validId && String(v) === bc.payId) count(st.payIdAt, key);
    }
  };
  for (const x of h.list) {
    walk(x, "");
    count(st.orderType, String(x.orderType));
    count(st.currency, String(x.currency));
    const a = Number(x.amount);
    count(st.amountSign, a > 0 ? "positive" : a < 0 ? "negative" : "zero/NaN");
    count(st.txidShape, shapeOf(x.transactionId));
    const tid = String(x.transactionId ?? ""), oid = String(x.orderId ?? "");
    count(st.txidMask, tid.replace(/[0-9]/g, "9").replace(/[A-Za-z]/g, "A"));
    count(st.txidVsOrderId, !oid ? "no orderId" : tid === oid ? "equal" : tid.includes(oid) ? "txid contains orderId" : "different");
    count(st.receiverAccountVsBinanceId, String(x.receiverInfo?.accountId ?? "") === String(x.receiverInfo?.binanceId ?? "") ? "equal" : "different");
    if (a > 0 && [x.receiverInfo?.accountId, x.receiverInfo?.binanceId].map(String).includes(bc.payId)) st.incomingWithPayIdAsReceiver++;
  }
  return { ...out, ok: true, history: st, fields };
}

/* ─── cache + throttle ─── */

async function getState(env) {
  const { results } = await env.DB.prepare("SELECT k, v FROM binance_state").all();
  const out = {};
  for (const r of results || []) out[r.k] = r.v;
  return out;
}

function setStateStmts(env, kv) {
  return Object.entries(kv).map(([k, v]) =>
    env.DB.prepare("INSERT INTO binance_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v))
  );
}

function slim(x) {
  const id = x?.transactionId != null ? String(x.transactionId) : "";
  if (!id) return null;
  const s = (v) => (v === undefined || v === null || v === "" ? null : String(v));
  return {
    t: id,
    o: s(x.orderType),
    a: s(x.amount) ?? "0",
    c: s(x.currency),
    tt: Number(x.transactionTime) || null,
    p: s(x.payerInfo?.binanceId),
    r: s(x.receiverInfo?.binanceId),
    ra: s(x.receiverInfo?.accountId),
    oi: s(x.orderId),
  };
}

/**
 * Refresh the cached Pay history if it is older than the TTL. Only one request per TTL wins the fetch slot;
 * the others return { ok:true, fresh:false } (the cache is as current as it gets). Errors set a backoff.
 */
export async function refreshHistory(env, { force = false } = {}) {
  if (!binanceConfigured(env)) return { ok: false, reason: "unconfigured" };
  const now = Date.now();
  const st = await getState(env);
  if (!force && Number(st.backoff_until || 0) > now) return { ok: false, reason: st.last_error || "backoff", backoff: true };
  const claim = await env.DB.prepare(
    `INSERT INTO binance_state (k, v) VALUES ('fetch_at', ?1)
     ON CONFLICT(k) DO UPDATE SET v=excluded.v WHERE CAST(binance_state.v AS INTEGER) <= ?2`
  )
    .bind(String(now), now - cacheTtlMs(env))
    .run();
  if (claim.meta?.changes !== 1) return { ok: true, fresh: false };

  let r = await binanceGet(env, { startTime: String(now - LOOKBACK_DAYS * 86400000), endTime: String(now), limit: String(PAGE) });
  let list = r.ok ? r.list : [];
  if (r.ok && list.length >= PAGE) {
    const r2 = await binanceGet(env, { startTime: String(now - RECENT_HOURS * 3600000), endTime: String(now), limit: String(PAGE) });
    if (r2.ok) list = list.concat(r2.list);
  }
  if (!r.ok) {
    const wait = r.retryAfter ? Math.min(r.retryAfter * 1000, 30 * 60000) : BACKOFF_MS[r.reason] || 60000;
    await env.DB.batch(setStateStmts(env, { backoff_until: now + wait, last_error: r.reason, last_error_at: now, last_http: r.http ?? 0 }));
    await audit(env, "binance", "binance_api_error", { reason: r.reason, http: r.http ?? null, code: r.code ?? null, backoff_s: Math.round(wait / 1000) });
    return { ok: false, reason: r.reason };
  }
  const rows = list.map(slim).filter(Boolean);
  const at = nowIso();
  const stmts = setStateStmts(env, { last_ok_at: now, last_error: "", last_count: rows.length });
  if (rows.length) {
    stmts.unshift(
      env.DB.prepare(
        `INSERT INTO binance_tx (transaction_id, order_type, amount, currency, tx_time, payer_id, receiver_id, receiver_account, order_id, seen_at)
         SELECT json_extract(value,'$.t'), json_extract(value,'$.o'), json_extract(value,'$.a'), json_extract(value,'$.c'),
                json_extract(value,'$.tt'), json_extract(value,'$.p'), json_extract(value,'$.r'), json_extract(value,'$.ra'),
                json_extract(value,'$.oi'), ?2
           FROM json_each(?1) WHERE json_extract(value,'$.t') IS NOT NULL
         ON CONFLICT(transaction_id) DO UPDATE SET order_type=excluded.order_type, amount=excluded.amount, currency=excluded.currency,
           tx_time=excluded.tx_time, payer_id=excluded.payer_id, receiver_id=excluded.receiver_id, receiver_account=excluded.receiver_account,
           order_id=excluded.order_id`
      ).bind(JSON.stringify(rows), at)
    );
  }
  await env.DB.batch(stmts);
  return { ok: true, fresh: true, count: rows.length };
}

/** By transactionId or by orderId (the Binance app shows the Order ID). transaction_id is the canonical key. */
export async function lookupTx(env, txid) {
  return env.DB.prepare("SELECT * FROM binance_tx WHERE transaction_id=?1 OR order_id=?1 ORDER BY transaction_id=?1 DESC LIMIT 1")
    .bind(txid)
    .first();
}

/**
 * A claim made with the Order ID (before the transaction was cached) is re-keyed to the canonical transactionId, so the
 * UNIQUE track_id also covers "same transfer, other ID form". false → another claim already holds the transaction.
 */
async function canonicalize(env, pay, tx) {
  const canon = trackOf(tx.transaction_id);
  if (pay.track_id === canon) return true;
  try {
    const r = await env.DB.prepare("UPDATE payments SET track_id=?, updated_at=? WHERE id=? AND credited=0").bind(canon, nowIso(), pay.id).run();
    if (r.meta?.changes === 1) pay.track_id = canon;
    return r.meta?.changes === 1;
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message || err))) return false;
    throw err;
  }
}

async function findTransaction(env, txid) {
  let tx = await lookupTx(env, txid);
  if (tx) return { tx };
  const r = await refreshHistory(env);
  if (!r.ok) return { tx: null, apiError: r.reason };
  if (!r.fresh) return { tx: null };
  tx = await lookupTx(env, txid);
  return { tx };
}

/* ─── rules ─── */

/** Decide what a found transaction is worth. { ok, credit } | { ok:false, reason, review? } */
export function evaluateTx(tx, bc) {
  const amount = Number(tx.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "outgoing" };
  if (tx.order_type && !ORDER_TYPES.has(String(tx.order_type).toUpperCase())) return { ok: false, reason: "type" };
  const cur = String(tx.currency || "").toUpperCase();
  if (!bc.currencies.includes(cur)) return { ok: false, reason: "currency", currency: cur };
  const credit = floor2(amount);
  if (credit < 0.01) return { ok: false, reason: "too_small" };
  // Income in our own history is ours; if Binance reports receiver ids, one of them must be the configured Pay ID / UID.
  // A mismatch (e.g. Pay ID configured wrong) is not credited automatically but sent to the admin for review.
  const ids = [tx.receiver_account, tx.receiver_id].filter((x) => x !== null && x !== undefined && String(x) !== "").map(String);
  if (ids.length && !ids.includes(bc.payId)) return { ok: false, review: true, reason: "receiver", credit };
  if (credit > bc.max) return { ok: false, review: true, reason: "over_max", credit };
  return { ok: true, credit, currency: cur };
}

function txPayload(tx, extra = {}) {
  return JSON.stringify({
    transaction_id: tx.transaction_id,
    order_type: tx.order_type,
    amount: tx.amount,
    currency: tx.currency,
    tx_time: tx.tx_time,
    payer_binance_id: tx.payer_id,
    receiver_binance_id: tx.receiver_id,
    receiver_pay_id: tx.receiver_account,
    ...extra,
  }).slice(0, 4000);
}

export function claimDetails(pay) {
  try {
    return JSON.parse(pay?.last_payload || "{}") || {};
  } catch {
    return {};
  }
}

/* ─── claims ─── */

export async function getClaim(env, id) {
  return env.DB.prepare("SELECT * FROM payments WHERE id=? AND provider='binance'").bind(id).first();
}

/** Per-user rate limit, atomic: the check row is only inserted if the user is within both limits. */
export async function rateLimit(env, userId) {
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO binance_checks (user_id, at)
     SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM binance_checks WHERE user_id=?1 AND at > ?3)
       AND (SELECT COUNT(*) FROM binance_checks WHERE user_id=?1 AND at > ?4) < ?5`
  )
    .bind(userId, now, now - RATE_GAP_MS, now - 3600000, RATE_HOUR)
    .run();
  if (r.meta?.changes === 1) return { ok: true };
  const last = await env.DB.prepare("SELECT MAX(at) AS last FROM binance_checks WHERE user_id=?").bind(userId).first();
  const gap = now - Number(last?.last || 0);
  if (gap < RATE_GAP_MS) return { ok: false, wait: Math.max(1, Math.ceil((RATE_GAP_MS - gap) / 1000)) };
  return { ok: false, hourly: true };
}

function newPaymentId() {
  return `bn_${Date.now().toString(36)}_${generateToken().slice(0, 10)}`;
}

/**
 * A pasted transaction ID → { kind, payment? , wait? }.
 * kind: 'own' (this user already claimed it — payment returned), 'other' (claimed by another account),
 *       'rate' (wait / hourly), 'too_many' (open claims), 'new' (row created — verify next).
 */
export async function openClaim(env, { userId, chatId, txid }) {
  const cached = await lookupTx(env, txid);
  if (cached) txid = cached.transaction_id; // Order ID pasted → canonical transactionId
  const track = trackOf(txid);
  const existing = await env.DB.prepare("SELECT * FROM payments WHERE track_id=?").bind(track).first();
  if (existing && Number(existing.telegram_user_id) === Number(userId)) return { kind: "own", payment: existing };
  const rl = await rateLimit(env, userId);
  if (existing) {
    await audit(env, `tg:${userId}`, "binance_claim_conflict", { txid, payment_id: existing.id, owner: existing.telegram_user_id });
    return { kind: "other" };
  }
  if (!rl.ok) return { kind: "rate", ...rl };
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM payments WHERE provider='binance' AND telegram_user_id=? AND status='pending' AND credited=0"
  )
    .bind(userId)
    .first();
  if ((open?.n || 0) >= MAX_OPEN_CLAIMS) return { kind: "too_many" };
  const id = newPaymentId();
  const at = nowIso();
  const exp = new Date(Date.now() + CLAIM_WINDOW_MIN * 60000).toISOString();
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO payments (id, provider, telegram_user_id, chat_id, amount_usd, track_id, status, created_at, updated_at, expires_at, last_status)
     VALUES (?, 'binance', ?, ?, 0, ?, 'pending', ?, ?, ?, 'submitted')`
  )
    .bind(id, userId, chatId ?? null, track, at, at, exp)
    .run();
  if (ins.meta?.changes !== 1) {
    // Lost a race for the same transaction ID.
    const won = await env.DB.prepare("SELECT * FROM payments WHERE track_id=?").bind(track).first();
    if (won && Number(won.telegram_user_id) === Number(userId)) return { kind: "own", payment: won };
    await audit(env, `tg:${userId}`, "binance_claim_conflict", { txid, payment_id: won?.id || null, owner: won?.telegram_user_id ?? null, race: true });
    return { kind: "other" };
  }
  await audit(env, `tg:${userId}`, "binance_claim", { payment_id: id, txid });
  return { kind: "new", payment: await getClaim(env, id) };
}

/** Re-open an expired claim for another 30-minute window (the user asked to check again / pasted it again). */
export async function reopenClaim(env, pay) {
  if (pay.credited || !["expired", "canceled"].includes(pay.status)) return pay;
  const exp = new Date(Date.now() + CLAIM_WINDOW_MIN * 60000).toISOString();
  await env.DB.prepare("UPDATE payments SET status='pending', expires_at=?, updated_at=? WHERE id=? AND status IN ('expired','canceled') AND credited=0")
    .bind(exp, nowIso(), pay.id)
    .run();
  return getClaim(env, pay.id);
}

/**
 * Exactly-once credit (same pattern as OxaPay applyStatus): the first statement flips credited 0→1 with a unique nonce and
 * sets the received amount; every other statement of the batch (one transaction) only matches rows carrying that nonce.
 */
async function creditClaim(env, pay, credit, tx, { source, actor = "binance", fromStatuses = ["pending", "expired"] }) {
  const DB = env.DB;
  const nonce = generateToken();
  const at = nowIso();
  const st = fromStatuses.map((x) => `'${x.replace(/[^a-z]/g, "")}'`).join(",");
  const res = await DB.batch([
    DB.prepare(
      `UPDATE payments SET status='paid', credited=1, credit_nonce=?, amount_usd=?, paid_at=?, updated_at=?, last_status='credited', last_payload=?
        WHERE id=? AND provider='binance' AND credited=0 AND status IN (${st})`
    ).bind(nonce, credit, at, at, txPayload(tx, { source, credited_usd: credit }), pay.id),
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
       SELECT telegram_user_id, amount_usd, 'binance', 'completed', ?, id FROM payments WHERE id=? AND credit_nonce=?`
    ).bind(at, pay.id, nonce),
    DB.prepare(
      `INSERT INTO audit_log (at, actor, action, details_json)
       SELECT ?, ?, 'binance_credit',
              json_object('payment_id', p.id, 'txid', ?, 'user_id', p.telegram_user_id, 'amount', p.amount_usd,
                          'received', ?, 'currency', ?, 'payer_binance_id', ?, 'new_balance', u.balance, 'source', ?)
         FROM payments p LEFT JOIN users u ON u.user_id = p.telegram_user_id
        WHERE p.id=? AND p.credit_nonce=?`
    ).bind(at, actor, tx.transaction_id, String(tx.amount), tx.currency, tx.payer_id, source, pay.id, nonce),
  ]);
  const won = res[0]?.meta?.changes === 1;
  if (!won) return { won: false };
  const u = await DB.prepare("SELECT balance FROM users WHERE user_id=?").bind(pay.telegram_user_id).first();
  return { won: true, newBalance: Number(u?.balance || 0) };
}

async function markClaim(env, pay, status, reason, tx, amountUsd) {
  await env.DB.prepare(
    `UPDATE payments SET status=?, last_status=?, last_payload=?, amount_usd=?, updated_at=?
      WHERE id=? AND provider='binance' AND credited=0 AND status IN ('pending','expired')`
  )
    .bind(status, reason, txPayload(tx), amountUsd || 0, nowIso(), pay.id)
    .run();
}

/**
 * Look the claim's transaction up and apply the rules.
 * → { action: 'credited'|'pending'|'rejected'|'review'|'already'|'final'|'unconfigured', payment, apiError?, reason?, newBalance? }
 */
export async function verifyClaim(env, s, pay, source) {
  const bc = binanceConfig(s, env);
  if (!bc.configured) return { action: "unconfigured", payment: pay };
  if (pay.credited) return { action: "already", payment: pay };
  if (!["pending", "expired"].includes(pay.status)) return { action: "final", payment: pay };
  const txid = txidOf(pay);
  const f = await findTransaction(env, txid);
  if (!f.tx) {
    if (f.apiError) await env.DB.prepare("UPDATE payments SET last_status=?, updated_at=? WHERE id=? AND credited=0").bind(`api:${f.apiError}`, nowIso(), pay.id).run();
    return { action: "pending", apiError: f.apiError || null, payment: (await getClaim(env, pay.id)) || pay };
  }
  if (!(await canonicalize(env, pay, f.tx))) {
    await markClaim(env, pay, "rejected", "duplicate", f.tx, 0);
    await audit(env, "binance", "binance_claim_conflict", { payment_id: pay.id, txid: f.tx.transaction_id, user_id: pay.telegram_user_id, rekey: true });
    return { action: "rejected", reason: "duplicate", payment: (await getClaim(env, pay.id)) || pay, tx: f.tx };
  }
  const ev = evaluateTx(f.tx, bc);
  if (ev.ok) {
    const r = await creditClaim(env, pay, ev.credit, f.tx, { source });
    const fresh = await getClaim(env, pay.id);
    if (!r.won) return { action: fresh?.credited ? "already" : "final", payment: fresh || pay };
    await notifyAdmins(env, s, fresh, "credited", { tx: f.tx, newBalance: r.newBalance });
    return { action: "credited", payment: fresh, newBalance: r.newBalance, amount: ev.credit, tx: f.tx };
  }
  const status = ev.review ? "review" : "rejected";
  await markClaim(env, pay, status, ev.reason, f.tx, ev.review ? ev.credit : 0);
  await audit(env, "binance", `binance_${status}`, { payment_id: pay.id, txid, user_id: pay.telegram_user_id, reason: ev.reason, amount: f.tx.amount, currency: f.tx.currency, source });
  const fresh = await getClaim(env, pay.id);
  if (status === "review") await notifyAdmins(env, s, fresh, "review", { tx: f.tx, reason: ev.reason });
  return { action: status, reason: ev.reason, payment: fresh || pay, tx: f.tx };
}

/** Admin approval of a claim under review: credits the amount received (rules other than max/receiver still apply). */
export async function approveClaim(env, s, pay, actor) {
  if (!pay || pay.provider !== "binance") return { ok: false, error: "not_binance" };
  if (pay.credited) return { ok: false, error: "already" };
  if (pay.status !== "review") return { ok: false, error: "not_review" };
  const tx = await lookupTx(env, txidOf(pay));
  if (!tx) return { ok: false, error: "tx_missing" };
  const bc = binanceConfig(s, env);
  const ev = evaluateTx(tx, { ...bc, max: Infinity, payId: tx.receiver_account || tx.receiver_id || bc.payId });
  if (!ev.ok) return { ok: false, error: ev.reason };
  const r = await creditClaim(env, pay, ev.credit, tx, { source: "panel_approve", actor, fromStatuses: ["review"] });
  if (!r.won) return { ok: false, error: "already" };
  const fresh = await getClaim(env, pay.id);
  return { ok: true, payment: fresh, newBalance: r.newBalance, amount: ev.credit };
}

/* ─── texts ─── */

function supportLineFor(s) {
  return s.support_contact ? `💬 Support: ${e(s.support_contact)}` : "💬 Contact the shop admin.";
}

const REJECT_TEXT = {
  outgoing: "This transaction is not an incoming payment to the shop.",
  type: "This type of Binance Pay transaction can't be used for top-ups.",
  too_small: "The amount is too small to be credited.",
  duplicate: "This transaction was already submitted from another account.",
};

export function binanceScreen(s, bc) {
  const cur = s.currency_symbol || "$";
  const coins = binanceCoinsLabel(bc, { bold: true });
  const text =
    "🟡 <b>Binance Pay</b>\n\n" +
    `Send any amount of ${coins} via Binance Pay to this Pay ID, then paste the transaction ID here.\n\n` +
    `Pay ID: <code>${e(bc.payId)}</code>\n\n` +
    "<blockquote><b>How it works</b>\n" +
    "1. Binance app → <b>Pay</b> → <b>Send</b> → enter the Pay ID above.\n" +
    `2. Send ${coins} — any amount (1 ${bc.currencies[0]} = ${e(money(1, cur))}).\n` +
    "3. Open the transfer details, copy the <b>transaction ID</b> (Order ID) and paste it in this chat.\n" +
    "4. Your balance is credited automatically with the amount received.</blockquote>";
  return {
    text,
    reply_markup: kb([
      [copyBtn("📋 Copy Pay ID", bc.payId)],
      [btn("✏️ Enter transaction ID", "bnp", "success")],
      [btn("⬅️ Back", "topup"), HOME()],
    ]),
  };
}

export function binanceUnavailable(s) {
  return {
    text: `🟡 <b>Binance Pay</b>\n\nBinance Pay top-ups are currently unavailable.\n\n${supportLineFor(s)}`,
    reply_markup: kb([[btn("⬅️ Back", "topup"), HOME()]]),
  };
}

export function binanceNotice(s, kind, extra = {}) {
  const rows = [];
  let text = "🟡 <b>Binance Pay</b>\n\n";
  if (kind === "invalid") {
    text += "⚠️ That doesn't look like a Binance Pay transaction ID.\n\nOpen the transfer in Binance (Pay → transaction details), copy the <b>transaction ID</b> and paste it here.";
    rows.push([btn("✏️ Enter transaction ID", "bnp", "success")]);
  } else if (kind === "other") {
    text += `⚠️ This transaction ID was already submitted from another account.\n\nIf it's yours, please contact support.\n${supportLineFor(s)}`;
  } else if (kind === "rate") {
    text += extra.hourly ? "⏳ Too many checks in the last hour. Please try again later." : `⏳ Please wait ${extra.wait || 20} s before checking another transaction.`;
    rows.push([btn("✏️ Enter transaction ID", "bnp")]);
  } else if (kind === "too_many") {
    text += "⏳ You already have several transactions waiting to be found. Please wait until they are processed.";
  }
  rows.push([btn("⬅️ Back", "bn"), HOME()]);
  return { text, reply_markup: kb(rows) };
}

/** The claim card (a record: never deleted or reused as the menu). */
export function claimCard(pay, s, { apiError = null, newBalance = null } = {}) {
  const cur = s.currency_symbol || "$";
  const d = claimDetails(pay);
  const txid = txidOf(pay);
  const idLine = `Transaction ID: <code>${e(txid)}</code>`;
  const rows = [];
  let text;
  if (pay.credited) {
    text =
      "✅ <b>Binance Pay top-up received!</b>\n\n" +
      `+<b>${e(money(pay.amount_usd, cur))}</b> added to your balance` +
      (d.amount && d.currency ? ` (${e(String(d.amount))} ${e(String(d.currency))})` : "") +
      ".\n" +
      (newBalance !== null ? `💰 New balance: <b>${e(money(newBalance, cur))}</b>\n` : "") +
      `\n${idLine}`;
    rows.push([btn("🛒 Shop", "shop", "primary"), btn("👤 Profile", "profile")]);
  } else if (pay.status === "pending") {
    text =
      "🟡 <b>Binance Pay · checking</b>\n\n" +
      `${idLine}\nStatus: <b>⏳ Not found yet</b>\n\n` +
      `Binance can take a minute to show a new transfer. We'll keep checking automatically for ${CLAIM_WINDOW_MIN} minutes and message you as soon as it's credited.` +
      (apiError ? "\n\n<i>Binance is not reachable right now — we'll retry automatically.</i>" : "");
    rows.push([btn("🔄 Check again", `bnchk:${pay.id}`, "primary")]);
  } else if (pay.status === "expired" || pay.status === "canceled") {
    text =
      "⌛ <b>Binance Pay · not found</b>\n\n" +
      `${idLine}\n\nWe couldn't find this transaction in the shop's Binance Pay history. Double-check the ID (Binance → Pay → transaction details) and try again.\n\n${supportLineFor(s)}`;
    rows.push([btn("🔄 Check again", `bnchk:${pay.id}`, "primary")], [btn("✏️ Enter another ID", "bnp")]);
  } else if (pay.status === "review") {
    text =
      "🟠 <b>Binance Pay · under review</b>\n\n" +
      `${idLine}\n` +
      (d.amount && d.currency ? `Received: <b>${e(String(d.amount))} ${e(String(d.currency))}</b>\n` : "") +
      "\nYour transfer needs a quick manual review by the shop. You'll be notified as soon as it's credited.";
  } else {
    const reason = pay.last_status;
    const msg =
      reason === "currency"
        ? `This transfer was made in <b>${e(String(d.currency || "?"))}</b>. Only ${binanceCoinsLabel(coinsOf(s), { bold: true })} can be credited automatically.`
        : REJECT_TEXT[reason] || "This transaction can't be credited.";
    text = `❌ <b>Binance Pay · not credited</b>\n\n${idLine}\n\n${msg}\n\n${supportLineFor(s)}`;
    rows.push([btn("🟡 Binance Pay", "bn")]);
  }
  text += `\nRef: <code>${e(pay.id)}</code>`;
  rows.push([HOME()]);
  return { text, reply_markup: kb(rows) };
}

/* ─── notifications ─── */

function adminIdList(env) {
  return [...new Set(String(env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number))];
}

async function notifyAdmins(env, s, pay, kind, { tx, newBalance, reason } = {}) {
  const cur = s.currency_symbol || "$";
  const u = await env.DB.prepare("SELECT username FROM users WHERE user_id=?").bind(pay.telegram_user_id).first();
  const who = `${u?.username ? `@${e(u.username)} ` : ""}(<code>${pay.telegram_user_id}</code>)`;
  const head = kind === "credited" ? "🟡 <b>Binance Pay top-up credited</b>" : "🟠 <b>Binance Pay top-up needs review</b>";
  const why = { over_max: `above the automatic limit (${e(money(binanceConfig(s, env).max, cur))})`, receiver: "receiver does not match the configured Pay ID" }[reason];
  const text =
    `${head}\n\n` +
    `User: ${who}\n` +
    (kind === "credited" ? `Amount: <b>+${e(money(pay.amount_usd, cur))}</b> (${e(String(tx?.amount))} ${e(String(tx?.currency))})\n` : `Received: <b>${e(String(tx?.amount))} ${e(String(tx?.currency))}</b>\n`) +
    `Transaction: <code>${e(txidOf(pay))}</code>\n` +
    (tx?.payer_id ? `Payer Binance ID: <code>${e(String(tx.payer_id))}</code>\n` : "") +
    (kind === "credited" && newBalance !== null && newBalance !== undefined ? `New balance: ${e(money(newBalance, cur))}\n` : "") +
    (why ? `Reason: ${why}\nApprove it in the admin panel → Pagamentos.\n` : "") +
    `Ref: <code>${e(pay.id)}</code>`;
  for (const id of adminIdList(env)) {
    try {
      await sendMessage(env, id, text);
    } catch (err) {
      console.error("admin notify failed", err);
    }
  }
}

/** Card update + short message to the customer after a background change (cron, admin panel). */
export async function notifyClaim(env, s, pay, r) {
  const cur = s.currency_symbol || "$";
  const chatId = pay.chat_id || pay.telegram_user_id;
  const card = claimCard(pay, s, { newBalance: r.newBalance ?? null });
  let edited = false;
  if (pay.message_id) {
    const res = await editOrSend(env, chatId, pay.message_id, card.text, { reply_markup: card.reply_markup }, { fallback: false });
    edited = !!res.ok;
  }
  const line = {
    credited: `✅ Binance Pay top-up confirmed, +${money(pay.amount_usd, cur)} added. New balance: ${money(r.newBalance ?? 0, cur)}`,
    rejected: "❌ Your Binance Pay transaction could not be credited automatically — see the details above.",
    review: "🟠 Your Binance Pay transfer was found and is under review by the shop.",
    expired: `⌛ We couldn't find your Binance Pay transaction ${txidOf(pay)} yet. Double-check the ID or contact support.`,
  }[r.action];
  if (!line) return;
  try {
    await sendMessage(
      env,
      chatId,
      e(line),
      edited ? { reply_parameters: { message_id: pay.message_id, allow_sending_without_reply: true } } : { reply_markup: card.reply_markup }
    );
  } catch (err) {
    console.error("notify failed", err);
  }
}

/* ─── cron (every minute) ─── */

export async function binanceCron(env) {
  if (!binanceConfigured(env)) return { skipped: "unconfigured" };
  const { results } = await env.DB.prepare(
    "SELECT * FROM payments WHERE provider='binance' AND status='pending' AND credited=0 ORDER BY created_at ASC LIMIT 25"
  ).all();
  const open = results || [];
  const out = { checked: 0, credited: 0, expired: 0 };
  if (!open.length) {
    if (new Date().getUTCMinutes() === 0) await housekeeping(env);
    return out;
  }
  const s = await getSettings(env);
  for (const pay of open) {
    const r = await verifyClaim(env, s, pay, "cron");
    out.checked++;
    if (r.action === "credited") out.credited++;
    if (["credited", "rejected", "review"].includes(r.action)) await notifyClaim(env, s, r.payment, r);
    if (r.action === "pending" && pay.expires_at && pay.expires_at <= nowIso()) {
      const x = await env.DB.prepare("UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='pending' AND credited=0")
        .bind(nowIso(), pay.id)
        .run();
      if (x.meta?.changes === 1) {
        out.expired++;
        await audit(env, "binance", "binance_expired", { payment_id: pay.id, txid: txidOf(pay), user_id: pay.telegram_user_id });
        await notifyClaim(env, s, await getClaim(env, pay.id), { action: "expired" });
      }
    }
  }
  return out;
}

/** Hourly: drop old rate-limit rows and cached history older than 120 days. */
async function housekeeping(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM binance_checks WHERE at < ?").bind(Date.now() - 86400000),
    env.DB.prepare("DELETE FROM binance_tx WHERE tx_time IS NOT NULL AND tx_time < ?").bind(Date.now() - 120 * 86400000),
  ]);
}

/** Admin panel status (no secrets). */
export async function binanceStatus(env, s) {
  const bc = binanceConfig(s, env);
  let state = {};
  let cached = 0;
  let pending = 0;
  try {
    state = await getState(env);
    cached = (await env.DB.prepare("SELECT COUNT(*) AS n FROM binance_tx").first())?.n || 0;
    pending = (await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE provider='binance' AND status IN ('pending','review') AND credited=0").first())?.n || 0;
  } catch (err) {
    return { ok: false, error: "migration_missing", configured: bc.configured, enabled: bc.enabled, pay_id: bc.payId };
  }
  const n = (k) => (state[k] ? Number(state[k]) : null);
  return {
    ok: true,
    configured: bc.configured,
    enabled: bc.enabled,
    available: bc.available,
    pay_id: bc.payId,
    currencies: bc.currencies,
    max: bc.max,
    last_fetch_at: n("fetch_at") ? new Date(n("fetch_at")).toISOString() : null,
    last_ok_at: n("last_ok_at") ? new Date(n("last_ok_at")).toISOString() : null,
    last_error: state.last_error || null,
    backoff_until: n("backoff_until") && n("backoff_until") > Date.now() ? new Date(n("backoff_until")).toISOString() : null,
    cached_transactions: cached,
    open_claims: pending,
  };
}
