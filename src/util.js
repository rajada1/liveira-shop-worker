/* Shared helpers: responses, time, settings, products, audit */

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const exp = Date.parse(expiresAt);
  if (Number.isNaN(exp)) return true;
  return exp <= Date.now();
}

/** Telegram HTML-mode escaping */
export function tgEsc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function generateToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

export function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  str = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ─── Settings ─── */

export const SETTING_DEFAULTS = {
  shop_name: "Liveira Shop",
  welcome_text:
    "Buy products with your balance and receive a time-limited access token.\n" +
    "Use your token to unlock access in the Liveira program.\n" +
    "Balance is credited by the shop admin.",
  support_contact: "",
  currency_symbol: "$",
  maintenance_mode: "0",
  maintenance_text: "The shop is under maintenance. Please try again later.",
  session_epoch: "1",
};

export const EDITABLE_SETTINGS = [
  "shop_name",
  "welcome_text",
  "support_contact",
  "currency_symbol",
  "maintenance_mode",
  "maintenance_text",
];

export async function getSettings(env) {
  const out = { ...SETTING_DEFAULTS };
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
    for (const r of results || []) {
      if (r.key in out && r.value !== null) out[r.key] = String(r.value);
    }
  } catch (e) {
    console.error("settings load failed", e);
  }
  return out;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  )
    .bind(key, String(value))
    .run();
}

export function money(v, cur = "$") {
  return `${cur}${Number(v || 0).toFixed(2)}`;
}

/* ─── Products ─── */

export async function listProducts(env, { activeOnly = false } = {}) {
  const where = activeOnly ? "WHERE active=1" : "";
  const { results: prods } = await env.DB.prepare(
    `SELECT * FROM products ${where} ORDER BY sort ASC, created_at ASC`
  ).all();
  const { results: prices } = await env.DB.prepare(
    "SELECT product_id, days, price FROM product_prices ORDER BY days ASC"
  ).all();
  const byId = new Map();
  for (const p of prods || []) {
    p.prices = [];
    byId.set(p.id, p);
  }
  for (const r of prices || []) {
    const p = byId.get(r.product_id);
    if (p) p.prices.push({ days: Number(r.days), price: Number(r.price) });
  }
  return prods || [];
}

export async function getProduct(env, id) {
  const p = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(id).first();
  if (!p) return null;
  const { results } = await env.DB.prepare(
    "SELECT days, price FROM product_prices WHERE product_id=? ORDER BY days ASC"
  )
    .bind(id)
    .all();
  p.prices = (results || []).map((r) => ({ days: Number(r.days), price: Number(r.price) }));
  return p;
}

/* ─── Audit ─── */

export async function audit(env, actor, action, details) {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (at, actor, action, details_json) VALUES (?, ?, ?, ?)"
    )
      .bind(nowIso(), String(actor), String(action), JSON.stringify(details ?? {}))
      .run();
  } catch (e) {
    console.error("audit failed", e);
  }
}

/* ─── Telegram API ─── */

export async function tgApi(env, method, body) {
  const token = env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN missing");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error("Telegram API error", method, data?.error_code, data?.description);
  }
  return data;
}

export async function tgApiForm(env, method, form) {
  const token = env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN missing");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error("Telegram API error", method, data?.error_code, data?.description);
  }
  return data;
}

/* ─── Balance ─── */

export async function getBalance(env, userId) {
  const row = await env.DB.prepare("SELECT balance FROM users WHERE user_id=?")
    .bind(userId)
    .first();
  return row ? Number(row.balance) : 0;
}

export async function findUser(env, ref) {
  ref = String(ref || "").trim();
  if (!ref) return null;
  if (/^\d+$/.test(ref)) {
    return env.DB.prepare("SELECT * FROM users WHERE user_id=?").bind(Number(ref)).first();
  }
  const uname = ref.startsWith("@") ? ref.slice(1) : ref;
  return env.DB.prepare("SELECT * FROM users WHERE lower(username)=lower(?)")
    .bind(uname)
    .first();
}

/**
 * op: add | sub | set. Returns { old, balance, delta }.
 * Writes topups row (method) and audit_log row.
 */
export async function changeBalance(env, userId, op, amount, method, actor, note) {
  const old = await getBalance(env, userId);
  let delta;
  if (op === "add") delta = amount;
  else if (op === "sub") delta = -amount;
  else if (op === "set") delta = amount - old;
  else throw new Error("invalid op");
  const at = nowIso();
  const stmts = [];
  if (op === "set") {
    stmts.push(env.DB.prepare("UPDATE users SET balance=? WHERE user_id=?").bind(amount, userId));
  } else {
    stmts.push(
      env.DB.prepare("UPDATE users SET balance = balance + ? WHERE user_id=?").bind(delta, userId)
    );
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO topups (user_id, amount, method, status, created_at) VALUES (?, ?, ?, 'completed', ?)`
    ).bind(userId, delta, method, at)
  );
  await env.DB.batch(stmts);
  const balance = await getBalance(env, userId);
  await audit(env, actor, `balance_${op}`, {
    user_id: userId,
    amount,
    delta,
    old_balance: old,
    new_balance: balance,
    note: note || undefined,
  });
  return { old, balance, delta };
}
