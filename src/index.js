/**
 * Liveira Shop — Cloudflare Worker
 * - Token validation API (D1)
 * - Telegram bot webhook (POST /telegram, /webhook)
 * - Admin panel (/admin, /admin/api/*)
 * - OxaPay payment callback (POST /oxapay/callback)
 * - NOWPayments IPN (POST /nowpayments/ipn, HMAC-SHA512 with the IPN secret; src/nowpayments.js)
 * - Cron (every minute): re-check pending Binance Pay claims (src/binance.js) and NOWPayments payments
 */
import { CORS_HEADERS, json } from "./util.js";
import { handleTelegramUpdate } from "./bot.js";
import { handleAdmin } from "./admin.js";
import { handleOxapayCallback } from "./oxapay.js";
import { binanceCron } from "./binance.js";
import { handleNpIpn, npCron } from "./nowpayments.js";

function unauthorized() {
  return json({ error: "Unauthorized" }, 401);
}

function requireApiKey(request, env) {
  const expected = env.TOKEN_API_KEY;
  if (!expected) return false;
  const got = request.headers.get("X-API-Key");
  return !!got && got === expected;
}

function rowPayload(row, valid, status) {
  return {
    valid,
    status,
    product_id: row.product_id,
    product_name: row.product_name,
    duration_days: row.duration_days,
    created_at: row.created_at,
    expires_at: row.expires_at,
    token: row.token,
  };
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const exp = Date.parse(expiresAt);
  if (Number.isNaN(exp)) return true;
  return exp <= Date.now();
}

async function lookupToken(env, token) {
  token = (token || "").trim();
  if (!token) return { valid: false, status: "not_found" };
  const row = await env.DB.prepare(
    `SELECT token, product_id, product_name, duration_days, created_at, expires_at, status
     FROM tokens WHERE token = ?`
  )
    .bind(token)
    .first();
  if (!row) return { valid: false, status: "not_found" };
  const expired = isExpired(row.expires_at) || row.status !== "active";
  if (expired) return rowPayload(row, false, "expired");
  return rowPayload(row, true, "active");
}

/**
 * Validate + bind token to a machine (first successful validation binds it).
 * Ported verbatim from the deployed Worker (was not in git yet).
 */
async function validateWithMachine(env, token, machineId) {
  const id = String(machineId || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) return json({ valid: false, error: "machine_required" }, 400);
  const result = await lookupToken(env, token);
  if (!result.valid) return json(result);
  const bound = await env.DB.prepare("SELECT machine_id FROM token_machines WHERE token = ?")
    .bind(result.token)
    .first();
  if (!bound) {
    await env.DB.prepare(
      "INSERT INTO token_machines (token, machine_id, bound_at) VALUES (?, ?, ?) ON CONFLICT(token) DO NOTHING"
    )
      .bind(result.token, id, new Date().toISOString())
      .run();
    const won = await env.DB.prepare("SELECT machine_id FROM token_machines WHERE token = ?")
      .bind(result.token)
      .first();
    if (!won || won.machine_id !== id) return json({ valid: false, error: "machine_mismatch" }, 403);
    return json(result);
  }
  if (bound.machine_id !== id) return json({ valid: false, error: "machine_mismatch" }, 403);
  return json(result);
}

async function createToken(env, body) {
  const token = String(body.token || "").trim();
  const product_id = String(body.product_id || "").trim();
  const product_name = String(body.product_name || "").trim();
  const duration_days = Number(body.duration_days);
  const created_at = String(body.created_at || "").trim();
  const expires_at = String(body.expires_at || "").trim();
  const telegram_user_id =
    body.telegram_user_id === undefined || body.telegram_user_id === null ? null : Number(body.telegram_user_id);

  if (!token || !product_id || !product_name || !Number.isFinite(duration_days) || !created_at || !expires_at) {
    return json(
      { error: "Missing required fields: token, product_id, product_name, duration_days, created_at, expires_at" },
      400
    );
  }
  await env.DB.prepare(
    `INSERT OR REPLACE INTO tokens (token, product_id, product_name, telegram_user_id, duration_days, created_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
  )
    .bind(token, product_id, product_name, telegram_user_id, duration_days, created_at, expires_at)
    .run();
  return json({
    ok: true,
    token,
    product_id,
    product_name,
    telegram_user_id,
    duration_days,
    created_at,
    expires_at,
    status: "active",
  });
}

function webhookSecretOk(request, env) {
  if (!env.WEBHOOK_SECRET) return true; // not configured → accept (legacy)
  const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (got.length !== env.WEBHOOK_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < got.length; i++) d |= got.charCodeAt(i) ^ env.WEBHOOK_SECRET.charCodeAt(i);
  return d === 0;
}

export default {
  async scheduled(event, env, ctx) {
    try {
      await binanceCron(env);
    } catch (err) {
      console.error("binance cron error", err && err.stack ? err.stack : err);
    }
    try {
      await npCron(env);
    } catch (err) {
      console.error("nowpayments cron error", err && err.stack ? err.stack : err);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/admin" || path.startsWith("/admin/")) {
      return handleAdmin(request, env, url, path);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && path === "/health") {
      return json({ ok: true });
    }

    // Telegram webhook
    if (request.method === "POST" && (path === "/telegram" || path === "/webhook")) {
      if (!webhookSecretOk(request, env)) return json({ error: "Forbidden" }, 401);
      let update;
      try {
        update = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      await handleTelegramUpdate(env, update);
      return json({ ok: true });
    }

    // OxaPay payment callback (HMAC-SHA512 signed with the merchant API key)
    if (path === "/oxapay/callback") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      try {
        return await handleOxapayCallback(request, env, ctx);
      } catch (err) {
        console.error("oxapay callback error", err && err.stack ? err.stack : err);
        return new Response("error", { status: 500 }); // non-200 → OxaPay retries
      }
    }

    // NOWPayments IPN (x-nowpayments-sig = HMAC-SHA512 of the key-sorted JSON body, IPN secret)
    if (path === "/nowpayments/ipn") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      try {
        return await handleNpIpn(request, env, ctx);
      } catch (err) {
        console.error("nowpayments ipn error", err && err.stack ? err.stack : err);
        return new Response("error", { status: 500 }); // non-200 → NOWPayments may resend; the cron also re-checks
      }
    }

    // Protected routes
    const needsKey =
      (request.method === "GET" && path.startsWith("/v1/token/")) ||
      (request.method === "POST" && path === "/v1/validate") ||
      (request.method === "POST" && path === "/v1/tokens");

    if (needsKey && !requireApiKey(request, env)) return unauthorized();

    if (request.method === "GET" && path.startsWith("/v1/token/")) {
      let token;
      try {
        token = decodeURIComponent(path.slice("/v1/token/".length));
      } catch {
        return json({ error: "Bad token encoding" }, 400);
      }
      return json(await lookupToken(env, token));
    }

    if (request.method === "POST" && path === "/v1/validate") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      return validateWithMachine(env, body?.token, body?.machine_id);
    }

    if (request.method === "POST" && path === "/v1/tokens") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      return createToken(env, body || {});
    }

    return json({ error: "Not found" }, 404);
  },
};
