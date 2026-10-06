/* Free trial: every Telegram account can claim ONE free license (any one eligible product), once, forever.
 *  - Settings (src/util.js defaults, panel "Teste grátis"): free_trial_enabled (1), free_trial_days (1),
 *    free_trial_products ("" = every active product with a price; else comma-separated product ids).
 *  - Table free_claims (migration 0013), PRIMARY KEY telegram_user_id. The claim row, the $0 order (orders.kind =
 *    'free_trial') and the license token are written in ONE D1 batch (a single transaction): the order/token inserts
 *    only fire when the claim row carrying this batch's fresh token exists, so a concurrent double tap, a retry or a
 *    second product can never yield a second key. Rows are never deleted: leaving / rejoining the group or changing the
 *    username does not reset the claim.
 *  - When a community group is configured (group_chat_id), membership is checked live (getChatMember, no cache) at
 *    claim time — even when the general gate (group_gate) is off. Admins are exempt (like the gate).
 *  - Cron (scheduled, every minute): "your free trial ended" DM in the user's language with a button to the
 *    product's 3-day plan, sent once (reminder_sent_at claimed with a conditional UPDATE before sending). */
import { nowIso, generateToken, listProducts, getProduct, money, audit, tgEsc as e, getSettings } from "./util.js";
import { btn, kb, HOME, sendMessage, formatDuration } from "./ui.js";
import { t, langOf } from "./i18n.js";

export const UPSELL_DAYS = 3; // reminder button: this plan of the same product (else its shortest plan)
const REMINDER_BATCH = 20;

export function freeTrialConfig(s) {
  const days = Number.parseInt(String(s?.free_trial_days ?? "1"), 10);
  const ids = String(s?.free_trial_products ?? "")
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[a-z0-9_-]{1,32}$/.test(x));
  return {
    enabled: String(s?.free_trial_enabled ?? "1") === "1",
    days: Number.isFinite(days) && days >= 1 && days <= 30 ? days : 1,
    products: ids.length ? ids : null, // null = every active product with a price
  };
}

/** Active products (with at least one price) that can be claimed for free, in shop order. */
export async function eligibleProducts(env, s) {
  const cfg = freeTrialConfig(s);
  const all = (await listProducts(env, { activeOnly: true })).filter((p) => p.prices.length);
  return cfg.products ? all.filter((p) => cfg.products.includes(p.id)) : all;
}

export function isEligible(s, product) {
  const cfg = freeTrialConfig(s);
  return !!product && Number(product.active) === 1 && product.prices.length > 0 && (!cfg.products || cfg.products.includes(product.id));
}

/** The user's claim row, or null (also null when the table is missing — migration 0013 not applied). */
export async function getFreeClaim(env, userId) {
  try {
    return (await env.DB.prepare("SELECT * FROM free_claims WHERE telegram_user_id=?").bind(Number(userId)).first()) || null;
  } catch {
    return null;
  }
}

/**
 * Claim the free trial for `product` (already checked: enabled, eligible, group membership).
 * Returns { kind: "claimed", token, createdAt, expiresAt, days } | { kind: "already", claim } | { kind: "error" }.
 */
export async function claimFreeTrial(env, s, userId, product) {
  const days = freeTrialConfig(s).days;
  const created = new Date();
  const createdAt = created.toISOString();
  const expiresAt = new Date(created.getTime() + days * 86400000).toISOString();
  const token = generateToken();
  const uid = Number(userId);
  const mine = "EXISTS (SELECT 1 FROM free_claims WHERE telegram_user_id=? AND token=?)";
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO free_claims (telegram_user_id, product_id, product_name, token, days, claimed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(telegram_user_id) DO NOTHING`
      ).bind(uid, product.id, product.name, token, days, createdAt, expiresAt),
      env.DB.prepare(
        `INSERT INTO orders (user_id, product_id, product_name, price, token, created_at, expires_at, duration_days, kind)
         SELECT ?, ?, ?, 0, ?, ?, ?, ?, 'free_trial' WHERE ${mine}`
      ).bind(uid, product.id, product.name, token, createdAt, expiresAt, days, uid, token),
      env.DB.prepare(
        `INSERT INTO tokens (token, product_id, product_name, telegram_user_id, duration_days, created_at, expires_at, status)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'active' WHERE ${mine}`
      ).bind(token, product.id, product.name, uid, days, createdAt, expiresAt, uid, token),
    ]);
  } catch (err) {
    console.error("free trial claim failed", err?.message || err);
    return { kind: "error" };
  }
  if (res?.[0]?.meta?.changes !== 1) return { kind: "already", claim: await getFreeClaim(env, uid) };
  await audit(env, `tg:${uid}`, "free_trial_claimed", { product_id: product.id, days, expires_at: expiresAt });
  return { kind: "claimed", token, createdAt, expiresAt, days };
}

/** Plan offered when the trial ends: the 3-day plan, else the shortest one. null when the product can't be bought. */
export function upsellPlan(product) {
  if (!product || Number(product.active) !== 1 || !product.prices.length) return null;
  return product.prices.find((p) => p.days === UPSELL_DAYS) || product.prices[0];
}

/** "Your free trial ended" message (customer language L). */
export function trialEndedMessage(s, claim, product, L) {
  const cur = s.currency_symbol || "$";
  const name = e(product?.name || claim.product_name || claim.product_id);
  const dur = formatDuration(claim.days, L);
  const plan = upsellPlan(product);
  if (!plan) {
    return {
      text: t(L, "free.ended_noplan", { dur, name }),
      reply_markup: kb([[btn(t(L, "btn.shop"), "shop", "success")], [HOME(L)]]),
    };
  }
  const planLabel = formatDuration(plan.days, L);
  return {
    text: t(L, "free.ended", { dur, name, plan: planLabel, price: e(money(plan.price, cur)) }),
    reply_markup: kb([
      [btn(t(L, "free.btn_buy", { plan: planLabel, price: money(plan.price, cur) }), `days:${product.id}:${plan.days}`, "success")],
      [btn(t(L, "btn.shop"), "shop"), HOME(L)],
    ]),
  };
}

/** Cron: DM every user whose free trial ended, once. */
export async function freeTrialCron(env) {
  const now = nowIso();
  const due = (cols, join) =>
    env.DB.prepare(
      `SELECT c.*${cols} FROM free_claims c ${join}
        WHERE c.reminder_sent_at IS NULL AND c.expires_at <= ? ORDER BY c.expires_at LIMIT ${REMINDER_BATCH}`
    )
      .bind(now)
      .all();
  let rows;
  try {
    ({ results: rows } = await due(", u.lang AS lang", "LEFT JOIN users u ON u.user_id = c.telegram_user_id"));
  } catch {
    try {
      ({ results: rows } = await due("", "")); // users.lang missing (migration 0012 not applied) → English
    } catch {
      return { skipped: "no_table" }; // migration 0013 not applied
    }
  }
  if (!rows?.length) return { sent: 0 };
  const s = await getSettings(env);
  let sent = 0;
  for (const c of rows) {
    // Claim the reminder first: two overlapping cron runs can't both send it.
    const r = await env.DB.prepare("UPDATE free_claims SET reminder_sent_at=? WHERE telegram_user_id=? AND reminder_sent_at IS NULL")
      .bind(now, c.telegram_user_id)
      .run();
    if (r?.meta?.changes !== 1) continue;
    try {
      const product = await getProduct(env, c.product_id);
      const msg = trialEndedMessage(s, c, product, langOf(c));
      const res = await sendMessage(env, c.telegram_user_id, msg.text, { reply_markup: msg.reply_markup });
      if (res?.ok) sent++;
      else await audit(env, "system", "free_trial_reminder_failed", { user_id: c.telegram_user_id, error: String(res?.description || "").slice(0, 200) });
    } catch (err) {
      console.error("free trial reminder failed", err?.message || err);
    }
  }
  return { sent };
}
