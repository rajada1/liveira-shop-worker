/* Admin panel: auth, session, CSRF, JSON API, static assets */
import INDEX_HTML from "./admin/index.html";
import APP_JS from "./admin/app.js.txt";
import APP_CSS from "./admin/app.css.txt";
import {
  nowIso,
  b64url,
  b64urlDecode,
  generateToken,
  getSettings,
  setSetting,
  EDITABLE_SETTINGS,
  listProducts,
  getProduct,
  audit,
  tgApi,
  findUser,
  getBalance,
  changeBalance,
  parseCoinList,
  coinsLabel,
} from "./util.js";
import { topupConfig, syncPayment, expireStale, callbackUrl, round2, oxapayAcceptedCoins } from "./oxapay.js";

const COOKIE = "__Host-lv_admin";
const SESSION_TTL = 12 * 3600; // seconds
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FILE = 50 * 1024 * 1024; // Telegram bot upload limit
const PAGE = 50;
const SP_OFFSET_MS = -3 * 3600 * 1000; // America/Sao_Paulo (no DST)
const enc = new TextEncoder();

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function aj(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SEC_HEADERS, ...extra },
  });
}
const err = (msg, status = 400) => aj({ error: msg }, status);

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

/* ─── crypto ─── */

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function safeEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function passwordMatches(env, given) {
  const k = "pw-compare:" + (env.SESSION_SECRET || "");
  const [a, b] = await Promise.all([hmac(k, String(given)), hmac(k, String(env.ADMIN_PASSWORD))]);
  return safeEqual(a, b);
}

async function makeSession(env, epoch) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(enc.encode(JSON.stringify({ iat: now, exp: now + SESSION_TTL, ep: epoch, n: generateToken() })));
  const sig = b64url(await hmac(env.SESSION_SECRET, payload));
  return `${payload}.${sig}`;
}

function getCookie(request, name) {
  const h = request.headers.get("Cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

async function verifySession(env, request, settings) {
  const raw = getCookie(request, COOKIE);
  if (!raw || !env.SESSION_SECRET) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  let given;
  try {
    given = b64urlDecode(sig);
  } catch {
    return null;
  }
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (!safeEqual(given, expected)) return null;
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return null;
  }
  if (!data || typeof data.exp !== "number" || data.exp * 1000 <= Date.now()) return null;
  if (String(data.ep) !== String(settings.session_epoch)) return null;
  return data;
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

/* ─── input helpers ─── */

async function readJson(request, max = 65536) {
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, "Requisição muito grande");
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

function str(v, max, field, { required = false } = {}) {
  const s = v === undefined || v === null ? "" : String(v).trim();
  if (required && !s) throw new HttpError(400, `Campo obrigatório: ${field}`);
  if (s.length > max) throw new HttpError(400, `${field}: máximo ${max} caracteres`);
  return s;
}

function num(v, field, { min = -Infinity, max = Infinity, int = false } = {}) {
  const n = Number(v);
  if (v === "" || v === null || v === undefined || !Number.isFinite(n))
    throw new HttpError(400, `${field}: número inválido`);
  if (int && !Number.isInteger(n)) throw new HttpError(400, `${field}: deve ser inteiro`);
  if (n < min || n > max) throw new HttpError(400, `${field}: fora do intervalo (${min}–${max})`);
  return n;
}

function pageOf(url) {
  const p = Math.max(1, Math.min(10000, parseInt(url.searchParams.get("page") || "1", 10) || 1));
  return { limit: PAGE, offset: (p - 1) * PAGE, page: p };
}

function likeEsc(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}

const PRODUCT_ID_RE = /^[a-z0-9_-]{1,32}$/;

function slugify(name) {
  return (
    String(name)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 28) || "product"
  );
}

function validatePrices(list) {
  if (!Array.isArray(list)) throw new HttpError(400, "prices deve ser uma lista");
  if (list.length > 20) throw new HttpError(400, "Máximo de 20 opções de dias");
  const seen = new Set();
  return list.map((x, i) => {
    const days = num(x?.days, `Dias (linha ${i + 1})`, { min: 1, max: 3650, int: true });
    const price = num(x?.price, `Preço (linha ${i + 1})`, { min: 0, max: 1000000 });
    if (seen.has(days)) throw new HttpError(400, `Dias repetidos: ${days}`);
    seen.add(days);
    return { days, price: Math.round(price * 100) / 100 };
  });
}

function spDayStartIso(daysAgo = 0) {
  const d = new Date(Date.now() + SP_OFFSET_MS);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - SP_OFFSET_MS - daysAgo * 86400000).toISOString();
}

function spDateToIso(dateStr, addDays = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new HttpError(400, "Data inválida");
  const t = Date.parse(`${dateStr}T00:00:00-03:00`);
  if (Number.isNaN(t)) throw new HttpError(400, "Data inválida");
  return new Date(t + addDays * 86400000).toISOString();
}

function tokenStatus(row) {
  if (row.status === "revoked") return "revoked";
  if (row.status !== "active") return row.status || "expired";
  const t = Date.parse(row.expires_at);
  return Number.isNaN(t) || t <= Date.now() ? "expired" : "active";
}

function sanitizeFileName(name) {
  let n = String(name || "file")
    .replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, "_")
    .trim()
    .slice(0, 120);
  return n || "file";
}

/* ─── static ─── */

function serveAsset(path) {
  if (path === "/admin/app.js")
    return new Response(APP_JS, {
      headers: { "Content-Type": "application/javascript; charset=utf-8", ...SEC_HEADERS, "Cache-Control": "no-cache" },
    });
  if (path === "/admin/app.css")
    return new Response(APP_CSS, {
      headers: { "Content-Type": "text/css; charset=utf-8", ...SEC_HEADERS, "Cache-Control": "no-cache" },
    });
  if (path === "/admin")
    return new Response(INDEX_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", ...SEC_HEADERS, "Content-Security-Policy": CSP },
    });
  return null;
}

/* ─── main entry ─── */

export async function handleAdmin(request, env, url, path) {
  if (request.method === "OPTIONS") return new Response(null, { status: 403, headers: SEC_HEADERS });

  if (!path.startsWith("/admin/api")) {
    if (request.method !== "GET" && request.method !== "HEAD") return err("Método não permitido", 405);
    return serveAsset(path) || Response.redirect(`${url.origin}/admin`, 302);
  }

  const method = request.method;
  const mutating = !["GET", "HEAD"].includes(method);
  if (mutating) {
    // CSRF: custom header (forces CORS preflight cross-origin) + Origin check + SameSite=Strict cookie
    if (request.headers.get("X-Requested-With") !== "liveira-admin") return err("CSRF check failed", 403);
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return err("CSRF check failed", 403);
  }

  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return err("Painel não configurado", 503);

  const api = path.slice("/admin/api".length) || "/";
  try {
    const settings = await getSettings(env);

    if (api === "/login" && method === "POST") return await login(request, env, settings);
    if (api === "/logout" && method === "POST") {
      return aj({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
    }

    const session = await verifySession(env, request, settings);
    if (!session) return err("Não autenticado", 401);

    const ctx = { request, env, url, settings, session, actor: `panel:${clientIp(request)}` };
    const res = await route(ctx, method, api);
    return res || err("Não encontrado", 404);
  } catch (e) {
    if (e instanceof HttpError) return err(e.message, e.status);
    console.error("admin api error", e && e.stack ? e.stack : e);
    return err("Erro interno", 500);
  }
}

async function login(request, env, settings) {
  const ip = clientIp(request);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT * FROM login_attempts WHERE ip=?").bind(ip).first();
  if (row && row.locked_until > now) {
    const wait = Math.ceil((row.locked_until - now) / 1000);
    return aj({ error: `Muitas tentativas. Tente novamente em ${Math.ceil(wait / 60)} min.` }, 429, {
      "Retry-After": String(wait),
    });
  }
  const body = await readJson(request, 4096);
  const pw = typeof body.password === "string" ? body.password : "";
  const ok = pw.length > 0 && pw.length <= 256 && (await passwordMatches(env, pw));
  if (!ok) {
    let fails = 1;
    let first = now;
    if (row && now - row.first_at < FAIL_WINDOW_MS) {
      fails = row.fails + 1;
      first = row.first_at;
    }
    const locked = fails >= MAX_FAILS ? now + LOCK_MS : 0;
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, fails, first_at, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET fails=excluded.fails, first_at=excluded.first_at, locked_until=excluded.locked_until`
    )
      .bind(ip, fails, first, locked)
      .run();
    await audit(env, `panel:${ip}`, locked ? "login_locked" : "login_failed", { fails });
    await new Promise((r) => setTimeout(r, 1200)); // slow down brute force
    return err(
      locked ? "Muitas tentativas. Bloqueado por 15 min." : `Senha incorreta (${MAX_FAILS - fails} tentativa(s) restante(s))`,
      locked ? 429 : 401
    );
  }
  if (row) await env.DB.prepare("DELETE FROM login_attempts WHERE ip=?").bind(ip).run();
  // opportunistic cleanup
  await env.DB.prepare("DELETE FROM login_attempts WHERE first_at < ? AND locked_until < ?")
    .bind(now - 86400000, now)
    .run();
  const token = await makeSession(env, settings.session_epoch);
  await audit(env, `panel:${ip}`, "login", {});
  return aj({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, SESSION_TTL) });
}

/* ─── router ─── */

async function route(ctx, method, api) {
  const { env, url } = ctx;
  let m;

  if (api === "/me" && method === "GET") {
    return aj({
      ok: true,
      exp: ctx.session.exp,
      shop_name: ctx.settings.shop_name,
      currency_symbol: ctx.settings.currency_symbol,
      files_enabled: !!env.FILES,
    });
  }
  if (api === "/dashboard" && method === "GET") return dashboard(ctx);

  // Products
  if (api === "/products" && method === "GET") return aj({ products: await listProducts(env), files_enabled: !!env.FILES });
  if (api === "/products" && method === "POST") return createProduct(ctx);
  if (api === "/products/reorder" && method === "POST") return reorderProducts(ctx);
  if ((m = api.match(/^\/products\/([a-z0-9_-]{1,32})$/))) {
    if (method === "PUT") return updateProduct(ctx, m[1]);
    if (method === "DELETE") return deleteProduct(ctx, m[1]);
  }
  if ((m = api.match(/^\/products\/([a-z0-9_-]{1,32})\/file$/))) {
    if (method === "PUT") return uploadFile(ctx, m[1]);
    if (method === "DELETE") return deleteFile(ctx, m[1]);
    if (method === "GET") return downloadFile(ctx, m[1]);
  }

  // Users
  if (api === "/users" && method === "GET") return listUsers(ctx);
  if ((m = api.match(/^\/users\/(\d{1,20})$/)) && method === "GET") return userDetail(ctx, Number(m[1]));
  if ((m = api.match(/^\/users\/(\d{1,20})\/balance$/)) && method === "POST") return userBalance(ctx, Number(m[1]));

  // Orders
  if (api === "/orders" && method === "GET") return listOrders(ctx);

  // Crypto payments (OxaPay)
  if (api === "/payments" && method === "GET") return listPayments(ctx);
  if ((m = api.match(/^\/payments\/([A-Za-z0-9_-]{1,64})\/sync$/)) && method === "POST") return syncPaymentApi(ctx, m[1]);

  // Tokens
  if (api === "/tokens" && method === "GET") return listTokens(ctx);
  if (api === "/tokens" && method === "POST") return createTokenAdmin(ctx);
  if ((m = api.match(/^\/tokens\/(revoke|extend|reactivate)$/)) && method === "POST") return tokenAction(ctx, m[1]);

  // Settings / webhook / sessions
  if (api === "/settings" && method === "GET") return getSettingsApi(ctx);
  if (api === "/settings" && method === "PUT") return putSettings(ctx);
  if (api === "/webhook" && method === "GET") return webhookInfo(ctx);
  if (api === "/webhook/reset" && method === "POST") return webhookReset(ctx);
  if (api === "/bot/setup" && method === "POST") return botSetup(ctx);
  if (api === "/oxapay/accepted" && method === "GET") return oxapayAccepted(ctx);
  if (api === "/sessions/revoke-all" && method === "POST") {
    const next = String((parseInt(ctx.settings.session_epoch, 10) || 1) + 1);
    await setSetting(env, "session_epoch", next);
    await audit(env, ctx.actor, "sessions_revoked", {});
    return aj({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  // Audit
  if (api === "/audit" && method === "GET") return listAudit(ctx);

  // Broadcast
  if (api === "/broadcast/count" && method === "GET") {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    return aj({ users: r?.n || 0 });
  }
  if (api === "/broadcast" && method === "POST") return broadcast(ctx);

  return null;
}

/* ─── dashboard ─── */

async function dashboard({ env }) {
  const t0 = spDayStartIso(0);
  const t7 = spDayStartIso(6);
  const t30 = spDayStartIso(29);
  const t14 = spDayStartIso(13);
  const now = nowIso();
  const stats = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COALESCE(SUM(balance),0) FROM users) AS balances,
      (SELECT COUNT(*) FROM orders) AS orders_total,
      (SELECT COALESCE(SUM(price),0) FROM orders) AS revenue,
      (SELECT COUNT(*) FROM orders WHERE created_at >= ?1) AS today_n,
      (SELECT COALESCE(SUM(price),0) FROM orders WHERE created_at >= ?1) AS today_rev,
      (SELECT COUNT(*) FROM orders WHERE created_at >= ?2) AS d7_n,
      (SELECT COALESCE(SUM(price),0) FROM orders WHERE created_at >= ?2) AS d7_rev,
      (SELECT COUNT(*) FROM orders WHERE created_at >= ?3) AS d30_n,
      (SELECT COALESCE(SUM(price),0) FROM orders WHERE created_at >= ?3) AS d30_rev,
      (SELECT COUNT(*) FROM tokens WHERE status='active' AND expires_at > ?4) AS active_tokens,
      (SELECT COUNT(*) FROM products WHERE active=1) AS active_products,
      (SELECT COUNT(*) FROM users WHERE created_at >= ?2) AS new_users_7d,
      (SELECT COUNT(*) FROM payments WHERE credited=1 AND paid_at >= ?3) AS crypto_30d_n,
      (SELECT COALESCE(SUM(amount_usd),0) FROM payments WHERE credited=1 AND paid_at >= ?3) AS crypto_30d_sum`
  )
    .bind(t0, t7, t30, now)
    .first();
  const { results: recent } = await env.DB.prepare(
    `SELECT o.id, o.user_id, u.username, o.product_name, o.price, o.duration_days, o.created_at
       FROM orders o LEFT JOIN users u ON u.user_id=o.user_id ORDER BY o.id DESC LIMIT 10`
  ).all();
  const { results: daily } = await env.DB.prepare(
    `SELECT substr(datetime(created_at, '-3 hours'), 1, 10) AS d, COUNT(*) AS n, COALESCE(SUM(price),0) AS rev
       FROM orders WHERE created_at >= ? GROUP BY d ORDER BY d`
  )
    .bind(t14)
    .all();
  return aj({ stats, recent: recent || [], daily: daily || [], since: { today: t0, d7: t7, d30: t30, d14: t14 } });
}

/* ─── products ─── */

async function writePrices(env, pid, prices) {
  const stmts = [env.DB.prepare("DELETE FROM product_prices WHERE product_id=?").bind(pid)];
  for (const p of prices) {
    stmts.push(
      env.DB.prepare("INSERT INTO product_prices (product_id, days, price) VALUES (?, ?, ?)").bind(pid, p.days, p.price)
    );
  }
  return stmts;
}

async function createProduct({ request, env, actor }) {
  const b = await readJson(request);
  const name = str(b.name, 80, "Nome", { required: true });
  const description = str(b.description, 2000, "Descrição");
  const active = b.active === false || b.active === 0 ? 0 : 1;
  const prices = validatePrices(b.prices || []);
  let id = str(b.id, 32, "ID").toLowerCase();
  if (id) {
    if (!PRODUCT_ID_RE.test(id)) throw new HttpError(400, "ID: use apenas a-z, 0-9, _ e - (máx. 32)");
    if (await env.DB.prepare("SELECT 1 FROM products WHERE id=?").bind(id).first())
      throw new HttpError(409, "Já existe um produto com esse ID");
  } else {
    const base = slugify(name);
    id = base;
    for (let i = 2; await env.DB.prepare("SELECT 1 FROM products WHERE id=?").bind(id).first(); i++) {
      id = `${base}_${i}`;
    }
  }
  const mx = await env.DB.prepare("SELECT COALESCE(MAX(sort), -1) AS m FROM products").first();
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO products (id, name, description, active, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, name, description, active, (mx?.m ?? -1) + 1, at, at),
    ...(await writePrices(env, id, prices)),
  ]);
  await audit(env, actor, "product_create", { id, name, active, prices });
  return aj({ ok: true, product: await getProduct(env, id) });
}

async function updateProduct({ request, env, actor }, id) {
  const cur = await getProduct(env, id);
  if (!cur) throw new HttpError(404, "Produto não encontrado");
  const b = await readJson(request);
  const name = b.name !== undefined ? str(b.name, 80, "Nome", { required: true }) : cur.name;
  const description = b.description !== undefined ? str(b.description, 2000, "Descrição") : cur.description;
  const active = b.active !== undefined ? (b.active === true || b.active === 1 || b.active === "1" ? 1 : 0) : cur.active;
  const stmts = [
    env.DB.prepare("UPDATE products SET name=?, description=?, active=?, updated_at=? WHERE id=?").bind(
      name,
      description,
      active,
      nowIso(),
      id
    ),
  ];
  let prices;
  if (b.prices !== undefined) {
    prices = validatePrices(b.prices);
    stmts.push(...(await writePrices(env, id, prices)));
  }
  await env.DB.batch(stmts);
  const changes = {};
  if (name !== cur.name) changes.name = [cur.name, name];
  if (description !== cur.description) changes.description = "changed";
  if (active !== cur.active) changes.active = [cur.active, active];
  if (prices) changes.prices = { before: cur.prices, after: prices };
  await audit(env, actor, "product_update", { id, changes });
  return aj({ ok: true, product: await getProduct(env, id) });
}

async function deleteProduct({ env, actor }, id) {
  const cur = await getProduct(env, id);
  if (!cur) throw new HttpError(404, "Produto não encontrado");
  if (cur.file_key && env.FILES) {
    try {
      await env.FILES.delete(cur.file_key);
    } catch (e) {
      console.error("r2 delete failed", e);
    }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM product_prices WHERE product_id=?").bind(id),
    env.DB.prepare("DELETE FROM products WHERE id=?").bind(id),
  ]);
  await audit(env, actor, "product_delete", { id, name: cur.name, prices: cur.prices, had_file: !!cur.file_key });
  return aj({ ok: true });
}

async function reorderProducts({ request, env, actor }) {
  const b = await readJson(request);
  if (!Array.isArray(b.ids) || b.ids.length > 500) throw new HttpError(400, "ids inválido");
  const ids = b.ids.map((x) => String(x));
  if (!ids.every((x) => PRODUCT_ID_RE.test(x))) throw new HttpError(400, "ids inválido");
  if (ids.length) await env.DB.batch(ids.map((id, i) => env.DB.prepare("UPDATE products SET sort=? WHERE id=?").bind(i, id)));
  await audit(env, actor, "product_reorder", { ids });
  return aj({ ok: true });
}

async function uploadFile({ request, env, actor }, id) {
  if (!env.FILES) throw new HttpError(503, "Armazenamento de arquivos (R2) não está habilitado");
  const cur = await getProduct(env, id);
  if (!cur) throw new HttpError(404, "Produto não encontrado");
  const len = Number(request.headers.get("Content-Length") || "0");
  if (!len) throw new HttpError(411, "Arquivo vazio ou tamanho desconhecido");
  if (len > MAX_FILE) throw new HttpError(413, "Arquivo maior que 50 MB (limite do Telegram)");
  let name;
  try {
    name = decodeURIComponent(request.headers.get("X-File-Name") || "file");
  } catch {
    name = "file";
  }
  name = sanitizeFileName(name);
  const type = str(request.headers.get("Content-Type") || "application/octet-stream", 120, "Tipo").split(";")[0] ||
    "application/octet-stream";
  const key = `products/${id}/${Date.now()}-${generateToken().slice(0, 8)}`;
  const obj = await env.FILES.put(key, request.body, {
    httpMetadata: { contentType: type },
    customMetadata: { product_id: id, file_name: name },
  });
  const size = obj?.size ?? len;
  await env.DB.prepare(
    "UPDATE products SET file_key=?, file_name=?, file_size=?, file_type=?, file_tg_id=NULL, file_uploaded_at=?, updated_at=? WHERE id=?"
  )
    .bind(key, name, size, type, nowIso(), nowIso(), id)
    .run();
  if (cur.file_key && cur.file_key !== key) {
    try {
      await env.FILES.delete(cur.file_key);
    } catch (e) {
      console.error("r2 delete old failed", e);
    }
  }
  await audit(env, actor, cur.file_key ? "file_replace" : "file_upload", { id, file_name: name, size });
  return aj({ ok: true, product: await getProduct(env, id) });
}

async function deleteFile({ env, actor }, id) {
  const cur = await getProduct(env, id);
  if (!cur) throw new HttpError(404, "Produto não encontrado");
  if (!cur.file_key) return aj({ ok: true, product: cur });
  if (env.FILES) {
    try {
      await env.FILES.delete(cur.file_key);
    } catch (e) {
      console.error("r2 delete failed", e);
    }
  }
  await env.DB.prepare(
    "UPDATE products SET file_key=NULL, file_name=NULL, file_size=NULL, file_type=NULL, file_tg_id=NULL, file_uploaded_at=NULL, updated_at=? WHERE id=?"
  )
    .bind(nowIso(), id)
    .run();
  await audit(env, actor, "file_delete", { id, file_name: cur.file_name });
  return aj({ ok: true, product: await getProduct(env, id) });
}

async function downloadFile({ env }, id) {
  if (!env.FILES) throw new HttpError(503, "R2 não habilitado");
  const cur = await getProduct(env, id);
  if (!cur || !cur.file_key) throw new HttpError(404, "Sem arquivo");
  const obj = await env.FILES.get(cur.file_key);
  if (!obj) throw new HttpError(404, "Arquivo não encontrado no R2");
  const fname = cur.file_name || "file";
  return new Response(obj.body, {
    headers: {
      ...SEC_HEADERS,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename="${fname.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
    },
  });
}

/* ─── users ─── */

async function listUsers({ env, url }) {
  const { limit, offset, page } = pageOf(url);
  let q = (url.searchParams.get("q") || "").trim().slice(0, 64);
  if (q.startsWith("@")) q = q.slice(1);
  const like = `%${likeEsc(q.toLowerCase())}%`;
  const where = q ? "WHERE CAST(u.user_id AS TEXT) LIKE ?1 ESCAPE '\\' OR lower(COALESCE(u.username,'')) LIKE ?1 ESCAPE '\\'" : "";
  const binds = q ? [like] : [];
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).bind(...binds).first();
  const { results } = await env.DB.prepare(
    `SELECT u.user_id, u.username, u.balance, u.created_at,
       (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.user_id) AS orders_count,
       (SELECT COALESCE(SUM(price),0) FROM orders o WHERE o.user_id=u.user_id) AS spent
     FROM users u ${where} ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`
  )
    .bind(...binds)
    .all();
  return aj({ users: results || [], total: total?.n || 0, page, page_size: limit });
}

async function userDetail({ env }, id) {
  const user = await env.DB.prepare("SELECT * FROM users WHERE user_id=?").bind(id).first();
  if (!user) throw new HttpError(404, "Usuário não encontrado");
  const [orders, topups, tokens, sums] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 100").bind(id),
    env.DB.prepare("SELECT * FROM topups WHERE user_id=? ORDER BY id DESC LIMIT 100").bind(id),
    env.DB.prepare("SELECT * FROM tokens WHERE telegram_user_id=? ORDER BY created_at DESC LIMIT 100").bind(id),
    env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM orders WHERE user_id=?1) AS orders_count, (SELECT COALESCE(SUM(price),0) FROM orders WHERE user_id=?1) AS spent, (SELECT COALESCE(SUM(amount),0) FROM topups WHERE user_id=?1 AND amount>0) AS credited"
    ).bind(id),
  ]);
  return aj({
    user,
    orders: orders.results || [],
    topups: topups.results || [],
    tokens: (tokens.results || []).map((t) => ({ ...t, computed_status: tokenStatus(t) })),
    summary: sums.results?.[0] || {},
  });
}

async function userBalance({ request, env, actor }, id) {
  const user = await env.DB.prepare("SELECT * FROM users WHERE user_id=?").bind(id).first();
  if (!user) throw new HttpError(404, "Usuário não encontrado");
  const b = await readJson(request);
  const op = String(b.op || "");
  if (!["add", "sub", "set"].includes(op)) throw new HttpError(400, "Operação inválida");
  const amount = num(b.amount, "Valor", { min: 0, max: 10000000 });
  if (op !== "set" && amount <= 0) throw new HttpError(400, "Valor deve ser maior que zero");
  const note = str(b.note, 200, "Nota");
  const old = await getBalance(env, id);
  if (op === "sub" && old - amount < -1e-9) throw new HttpError(400, "Saldo ficaria negativo");
  const r = await changeBalance(env, id, op, Math.round(amount * 100) / 100, `panel_${op}`, actor, note);
  return aj({ ok: true, ...r });
}

/* ─── orders ─── */

async function listOrders({ env, url }) {
  const { limit, offset, page } = pageOf(url);
  const conds = [];
  const binds = [];
  const product = (url.searchParams.get("product") || "").trim();
  if (product) {
    conds.push("o.product_id = ?");
    binds.push(product.slice(0, 64));
  }
  let user = (url.searchParams.get("user") || "").trim().slice(0, 64);
  if (user) {
    if (/^\d+$/.test(user)) {
      conds.push("o.user_id = ?");
      binds.push(Number(user));
    } else {
      if (user.startsWith("@")) user = user.slice(1);
      conds.push("lower(u.username) = lower(?)");
      binds.push(user);
    }
  }
  const from = (url.searchParams.get("from") || "").trim();
  if (from) {
    conds.push("o.created_at >= ?");
    binds.push(spDateToIso(from));
  }
  const to = (url.searchParams.get("to") || "").trim();
  if (to) {
    conds.push("o.created_at < ?");
    binds.push(spDateToIso(to, 1));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const base = `FROM orders o LEFT JOIN users u ON u.user_id=o.user_id ${where}`;
  const agg = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(o.price),0) AS sum ${base}`).bind(...binds).first();
  const { results } = await env.DB.prepare(
    `SELECT o.*, u.username ${base} ORDER BY o.id DESC LIMIT ${limit} OFFSET ${offset}`
  )
    .bind(...binds)
    .all();
  return aj({ orders: results || [], total: agg?.n || 0, sum: agg?.sum || 0, page, page_size: limit });
}

/* ─── crypto payments (OxaPay) ─── */

const PAYMENT_STATUSES = ["creating", "pending", "paying", "paid", "underpaid", "expired", "canceled", "refunding", "refunded", "error"];

async function listPayments({ env, url }) {
  await expireStale(env);
  const { limit, offset, page } = pageOf(url);
  const conds = [];
  const binds = [];
  const status = (url.searchParams.get("status") || "").trim();
  if (status) {
    if (!PAYMENT_STATUSES.includes(status)) throw new HttpError(400, "Status inválido");
    conds.push("p.status = ?");
    binds.push(status);
  }
  let q = (url.searchParams.get("q") || "").trim().slice(0, 64);
  if (q) {
    if (/^\d+$/.test(q)) {
      conds.push("(p.telegram_user_id = ? OR p.track_id = ?)");
      binds.push(Number(q), q);
    } else if (q.startsWith("@")) {
      conds.push("lower(u.username) = lower(?)");
      binds.push(q.slice(1));
    } else {
      conds.push("(p.id = ? OR p.track_id = ? OR lower(COALESCE(u.username,'')) = lower(?))");
      binds.push(q, q, q);
    }
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const base = `FROM payments p LEFT JOIN users u ON u.user_id=p.telegram_user_id ${where}`;
  const agg = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN p.credited=1 THEN p.amount_usd ELSE 0 END),0) AS credited_sum ${base}`
  )
    .bind(...binds)
    .first();
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.telegram_user_id, u.username, p.amount_usd, p.track_id, p.status, p.last_status, p.pay_link,
            p.created_at, p.updated_at, p.expires_at, p.paid_at, p.credited ${base}
      ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`
  )
    .bind(...binds)
    .all();
  return aj({ payments: results || [], total: agg?.n || 0, credited_sum: agg?.credited_sum || 0, page, page_size: limit });
}

async function syncPaymentApi({ env, actor }, id) {
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(id).first();
  if (!pay) throw new HttpError(404, "Pagamento não encontrado");
  if (!env.OXAPAY_MERCHANT_KEY) throw new HttpError(503, "OXAPAY_MERCHANT_KEY não configurada");
  const r = await syncPayment(env, pay, "panel_sync");
  await audit(env, actor, "payment_sync", { payment_id: id, track_id: pay.track_id, result: r.action, remote_status: r.remoteStatus || null });
  const upd = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(id).first();
  return aj({ ok: true, result: r.action, remote_status: r.remoteStatus || null, payment: upd });
}

/* ─── tokens ─── */

async function listTokens({ env, url }) {
  const { limit, offset, page } = pageOf(url);
  const conds = [];
  const binds = [];
  const now = nowIso();
  let q = (url.searchParams.get("q") || "").trim().slice(0, 128);
  if (q) {
    if (q.startsWith("@")) {
      conds.push("lower(u.username) = lower(?)");
      binds.push(q.slice(1));
    } else if (/^\d+$/.test(q)) {
      conds.push("(t.telegram_user_id = ? OR t.token LIKE ? ESCAPE '\\')");
      binds.push(Number(q), `%${likeEsc(q)}%`);
    } else {
      conds.push("(t.token LIKE ? ESCAPE '\\' OR lower(COALESCE(u.username,'')) = lower(?))");
      binds.push(`%${likeEsc(q)}%`, q);
    }
  }
  const status = url.searchParams.get("status") || "";
  if (status === "active") {
    conds.push("t.status='active' AND t.expires_at > ?");
    binds.push(now);
  } else if (status === "expired") {
    conds.push("t.status='active' AND t.expires_at <= ?");
    binds.push(now);
  } else if (status === "revoked") {
    conds.push("t.status='revoked'");
  }
  const product = (url.searchParams.get("product") || "").trim();
  if (product) {
    conds.push("t.product_id = ?");
    binds.push(product.slice(0, 64));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const base = `FROM tokens t LEFT JOIN users u ON u.user_id=t.telegram_user_id ${where}`;
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n ${base}`).bind(...binds).first();
  const { results } = await env.DB.prepare(
    `SELECT t.*, u.username ${base} ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`
  )
    .bind(...binds)
    .all();
  return aj({
    tokens: (results || []).map((t) => ({ ...t, computed_status: tokenStatus(t) })),
    total: total?.n || 0,
    page,
    page_size: limit,
  });
}

async function createTokenAdmin({ request, env, actor }) {
  const b = await readJson(request);
  const pid = str(b.product_id, 32, "Produto", { required: true });
  const product = await getProduct(env, pid);
  if (!product) throw new HttpError(404, "Produto não encontrado");
  const days = num(b.days, "Dias", { min: 1, max: 3650, int: true });
  const uref = str(b.user, 64, "Usuário");
  let userId = null;
  if (uref) {
    const u = await findUser(env, uref);
    if (!u) throw new HttpError(404, "Usuário não encontrado (ele precisa dar /start no bot)");
    userId = u.user_id;
  }
  const created = new Date();
  const createdAt = created.toISOString();
  const expiresAt = new Date(created.getTime() + days * 86400000).toISOString();
  const token = generateToken();
  await env.DB.prepare(
    `INSERT INTO tokens (token, product_id, product_name, telegram_user_id, duration_days, created_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
  )
    .bind(token, product.id, product.name, userId, days, createdAt, expiresAt)
    .run();
  await audit(env, actor, "token_create", {
    token_prefix: token.slice(0, 6),
    product_id: product.id,
    user_id: userId,
    days,
  });
  return aj({ ok: true, token, product_id: product.id, user_id: userId, days, created_at: createdAt, expires_at: expiresAt });
}

async function tokenAction({ request, env, actor }, action) {
  const b = await readJson(request);
  const token = str(b.token, 128, "Token", { required: true });
  const row = await env.DB.prepare("SELECT * FROM tokens WHERE token=?").bind(token).first();
  if (!row) throw new HttpError(404, "Token não encontrado");
  const details = { token_prefix: token.slice(0, 6), user_id: row.telegram_user_id, product_id: row.product_id };
  if (action === "revoke") {
    await env.DB.prepare("UPDATE tokens SET status='revoked' WHERE token=?").bind(token).run();
    await audit(env, actor, "token_revoke", details);
  } else if (action === "reactivate") {
    await env.DB.prepare("UPDATE tokens SET status='active' WHERE token=?").bind(token).run();
    await audit(env, actor, "token_reactivate", details);
  } else {
    const days = num(b.days, "Dias", { min: -3650, max: 3650, int: true });
    if (days === 0) throw new HttpError(400, "Dias não pode ser 0");
    const curExp = Date.parse(row.expires_at);
    const base = days > 0 ? Math.max(Date.now(), Number.isNaN(curExp) ? 0 : curExp) : Number.isNaN(curExp) ? Date.now() : curExp;
    const newExp = new Date(base + days * 86400000).toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE tokens SET expires_at=? WHERE token=?").bind(newExp, token),
      env.DB.prepare("UPDATE orders SET expires_at=? WHERE token=?").bind(newExp, token),
    ]);
    await audit(env, actor, "token_extend", { ...details, days, old_expires_at: row.expires_at, new_expires_at: newExp });
  }
  const upd = await env.DB.prepare("SELECT * FROM tokens WHERE token=?").bind(token).first();
  return aj({ ok: true, token: { ...upd, computed_status: tokenStatus(upd) } });
}

/* ─── settings & webhook ─── */

function publicInfo(ctx) {
  const o = ctx.url.origin;
  return {
    webhook_url: `${o}/telegram`,
    validate_url: `${o}/v1/validate`,
    token_lookup_url: `${o}/v1/token/{token}`,
    health_url: `${o}/health`,
    files_enabled: !!ctx.env.FILES,
    webhook_secret_configured: !!ctx.env.WEBHOOK_SECRET,
    oxapay_configured: !!ctx.env.OXAPAY_MERCHANT_KEY,
    oxapay_callback_url: callbackUrl(ctx.env),
  };
}

async function getSettingsApi(ctx) {
  const out = {};
  for (const k of EDITABLE_SETTINGS) out[k] = ctx.settings[k];
  return aj({ settings: out, info: publicInfo(ctx) });
}

async function putSettings({ request, env, settings, actor }) {
  const b = await readJson(request);
  const limits = {
    shop_name: 64,
    welcome_text: 3000,
    support_contact: 200,
    currency_symbol: 5,
    maintenance_text: 500,
  };
  const changed = {};
  // Crypto top-up numbers: validate together (min ≤ presets ≤ max)
  const topup = {};
  if (b.topup_min !== undefined || b.topup_max !== undefined || b.topup_presets !== undefined) {
    const min = round2(num(b.topup_min ?? settings.topup_min, "Valor mínimo", { min: 0.5, max: 100000 }));
    const max = round2(num(b.topup_max ?? settings.topup_max, "Valor máximo", { min: 0.5, max: 100000 }));
    if (max < min) throw new HttpError(400, "Valor máximo deve ser maior ou igual ao mínimo");
    const rawP = String(b.topup_presets ?? settings.topup_presets).trim();
    const parts = rawP ? rawP.split(/[,;\s]+/).filter(Boolean) : [];
    if (parts.length > 8) throw new HttpError(400, "Máximo de 8 valores predefinidos");
    const presets = [];
    for (const x of parts) {
      const n = round2(num(x.replace(",", "."), `Valor predefinido "${x}"`, { min, max }));
      if (!presets.includes(n)) presets.push(n);
    }
    topup.topup_min = String(min);
    topup.topup_max = String(max);
    topup.topup_presets = presets.join(",");
  }
  for (const k of EDITABLE_SETTINGS) {
    if (b[k] === undefined) continue;
    let v;
    if (k in topup) {
      v = topup[k];
    } else if (k === "accepted_currencies") {
      const raw = String(b[k]).trim();
      const bad = raw.toUpperCase().split(/[\s,;/|]+/).filter((x) => x && !/^[A-Z0-9]{2,10}$/.test(x));
      if (bad.length) throw new HttpError(400, `Moedas aceitas: símbolo inválido "${bad[0].slice(0, 20)}"`);
      const list = parseCoinList(raw);
      if (!list.length) throw new HttpError(400, "Moedas aceitas: informe pelo menos uma moeda (ex.: USDT)");
      if (list.length > 12) throw new HttpError(400, "Moedas aceitas: máximo de 12 moedas");
      v = list.join(",");
    } else if (k === "maintenance_mode" || k === "crypto_topup_enabled") {
      v = b[k] === true || b[k] === "1" || b[k] === 1 ? "1" : "0";
    } else {
      v = String(b[k]).replace(/\r\n/g, "\n");
      v = k === "welcome_text" || k === "maintenance_text" ? v.trim() : v.trim();
      if (v.length > limits[k]) throw new HttpError(400, `${k}: máximo ${limits[k]} caracteres`);
      if ((k === "shop_name" || k === "currency_symbol") && !v) throw new HttpError(400, `${k} não pode ficar vazio`);
    }
    if (v !== settings[k]) {
      await setSetting(env, k, v);
      changed[k] = k === "welcome_text" || k === "maintenance_text" ? "changed" : [settings[k], v];
    }
  }
  if (Object.keys(changed).length) await audit(env, actor, "settings_update", changed);
  return aj({ ok: true, changed: Object.keys(changed) });
}

function sanitizeWebhookInfo(r) {
  const x = r?.result || {};
  return {
    ok: !!r?.ok,
    description: r?.ok ? undefined : r?.description,
    url: x.url || "",
    pending_update_count: x.pending_update_count ?? 0,
    last_error_date: x.last_error_date ? new Date(x.last_error_date * 1000).toISOString() : null,
    last_error_message: x.last_error_message || null,
    last_synchronization_error_date: x.last_synchronization_error_date
      ? new Date(x.last_synchronization_error_date * 1000).toISOString()
      : null,
    max_connections: x.max_connections ?? null,
    ip_address: x.ip_address || null,
    allowed_updates: x.allowed_updates || null,
    has_custom_certificate: !!x.has_custom_certificate,
  };
}

async function webhookInfo(ctx) {
  if (!ctx.env.BOT_TOKEN) throw new HttpError(503, "BOT_TOKEN não configurado");
  const r = await tgApi(ctx.env, "getWebhookInfo", {});
  return aj({ info: sanitizeWebhookInfo(r), expected: publicInfo(ctx) });
}

async function webhookReset(ctx) {
  const { env, actor } = ctx;
  if (!env.BOT_TOKEN) throw new HttpError(503, "BOT_TOKEN não configurado");
  const url = `${ctx.url.origin}/telegram`;
  const body = {
    url,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
    max_connections: 40,
  };
  if (env.WEBHOOK_SECRET) body.secret_token = env.WEBHOOK_SECRET;
  const r = await tgApi(env, "setWebhook", body);
  await audit(env, actor, "webhook_reset", { url, ok: !!r.ok, description: r.description || null, secret: !!env.WEBHOOK_SECRET });
  const info = await tgApi(env, "getWebhookInfo", {});
  return aj({ ok: !!r.ok, description: r.description || null, info: sanitizeWebhookInfo(info) });
}

/* ─── bot profile: commands, menu button, descriptions (Bot API setMy*) ─── */

const USER_COMMANDS = [
  { command: "start", description: "🏠 Home" },
  { command: "shop", description: "🛒 Browse products" },
  { command: "topup", description: "💰 Top up balance (crypto)" },
  { command: "licenses", description: "🔑 My licenses" },
  { command: "downloads", description: "📥 Downloads" },
  { command: "profile", description: "👤 Profile & history" },
  { command: "support", description: "💬 Help & support" },
];
const ADMIN_COMMANDS = [
  ...USER_COMMANDS,
  { command: "addbal", description: "Admin: add balance (@user amount)" },
  { command: "subbal", description: "Admin: subtract balance (@user amount)" },
  { command: "setbal", description: "Admin: set balance (@user amount)" },
  { command: "bal", description: "Admin: show balance (@user)" },
  { command: "whoami", description: "Show my Telegram ID" },
];

export function botProfileTexts(shopName, settings = {}) {
  const n = String(shopName || "Liveira Shop").slice(0, 60);
  const coins = coinsLabel(settings);
  return {
    description: (
      `🛒 ${n} — get your Liveira license in seconds.\n\n` +
      `💰 Top up your balance with ${coins} — credited automatically.\n` +
      "🔑 Receive your license key instantly and download the program.\n\n" +
      "Tap Start to begin."
    ).slice(0, 512),
    short_description: `${n}: Liveira licenses in seconds. Pay with ${coins}, credited automatically.`.slice(0, 120),
  };
}

async function oxapayAccepted({ env, settings }) {
  const setting = parseCoinList(settings.accepted_currencies);
  const r = await oxapayAcceptedCoins(env);
  if (!r.ok) return aj({ ok: false, reason: r.reason, setting });
  const same = r.list.length === setting.length && r.list.every((c) => setting.includes(c));
  return aj({ ok: true, oxapay: r.list, networks: r.networks, setting, match: same });
}

async function botSetup({ env, settings, actor }) {
  if (!env.BOT_TOKEN) throw new HttpError(503, "BOT_TOKEN não configurado");
  const t = botProfileTexts(settings.shop_name, settings);
  const results = {};
  const call = async (name, method, body) => {
    const r = await tgApi(env, method, body);
    results[name] = r.ok ? "ok" : r.description || "erro";
  };
  await call("commands", "setMyCommands", { commands: USER_COMMANDS, scope: { type: "default" } });
  await call("menu_button", "setChatMenuButton", { menu_button: { type: "commands" } });
  await call("description", "setMyDescription", { description: t.description });
  await call("short_description", "setMyShortDescription", { short_description: t.short_description });
  const ids = String(env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
  let adminOk = 0;
  for (const id of ids.slice(0, 10)) {
    const r = await tgApi(env, "setMyCommands", { commands: ADMIN_COMMANDS, scope: { type: "chat", chat_id: Number(id) } });
    if (r.ok) adminOk++;
  }
  results.admin_commands = `${adminOk}/${ids.length}`;
  await audit(env, actor, "bot_setup", results);
  return aj({ ok: Object.entries(results).every(([k, v]) => k === "admin_commands" || v === "ok"), results });
}

/* ─── audit ─── */

async function listAudit({ env, url }) {
  const { limit, offset, page } = pageOf(url);
  const action = (url.searchParams.get("action") || "").trim().slice(0, 64);
  const where = action ? "WHERE action LIKE ? ESCAPE '\\'" : "";
  const binds = action ? [`%${likeEsc(action)}%`] : [];
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).bind(...binds).first();
  const { results } = await env.DB.prepare(
    `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`
  )
    .bind(...binds)
    .all();
  return aj({ entries: results || [], total: total?.n || 0, page, page_size: limit });
}

/* ─── broadcast (batched: Workers free plan allows 50 subrequests per request) ─── */

const BROADCAST_BATCH = 25;

async function broadcast({ request, env, actor }) {
  const b = await readJson(request, 16384);
  const text = str(b.text, 4000, "Mensagem", { required: true });
  const offset = num(b.offset ?? 0, "offset", { min: 0, max: 10000000, int: true });
  if (!env.BOT_TOKEN) throw new HttpError(503, "BOT_TOKEN não configurado");
  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  const total = totalRow?.n || 0;
  const { results } = await env.DB.prepare(
    `SELECT user_id FROM users ORDER BY user_id LIMIT ${BROADCAST_BATCH} OFFSET ?`
  )
    .bind(offset)
    .all();
  let sent = 0;
  let failed = 0;
  for (const r of results || []) {
    const res = await tgApi(env, "sendMessage", { chat_id: r.user_id, text, link_preview_options: { is_disabled: true } });
    if (res.ok) sent++;
    else failed++;
  }
  const next = offset + (results || []).length;
  const done = next >= total || !(results || []).length;
  if (offset === 0) await audit(env, actor, "broadcast_start", { total, length: text.length });
  await audit(env, actor, "broadcast_batch", { offset, sent, failed, done });
  return aj({ ok: true, sent, failed, next_offset: next, total, done });
}
