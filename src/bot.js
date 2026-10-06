/* Telegram bot — button-driven UI (HTML parse mode). Products/prices/settings come from D1.
 * Navigation: the current menu is edited in place while it is the latest message in the chat; otherwise the
 * screen is sent at the bottom and the old menu deleted (see show()). Main sections are also on a persistent
 * reply keyboard (ensureKeyboard). Per-chat state: table chat_nav (src/chatnav.js).
 */
import {
  nowIso,
  tgEsc as e,
  generateToken,
  getSettings,
  listProducts,
  getProduct,
  money,
  audit,
  tgApi,
  tgApiForm,
  getBalance,
  findUser,
  changeBalance,
  coinsLabel,
  fillCoins,
} from "./util.js";
import {
  topupConfig,
  parseAmount,
  createTopupInvoice,
  syncPayment,
  setPaymentMessage,
  cancelPayment,
  round2,
  INVOICE_LIFETIME_MIN,
} from "./oxapay.js";
import {
  btn,
  urlBtn,
  copyBtn,
  HOME,
  navRow,
  kb,
  grid,
  fmtDateTimeBrt,
  fmtShortBrt,
  daysLeftLabel,
  formatDuration,
  sendMessage,
  editOrSend,
  invoiceCard,
  paidCard,
  howItWorks,
  howItWorksNp,
  howItWorksSp,
  networkHint,
  replyKeyboard,
  keyboardTarget,
  deleteMessageQuiet,
  kbVersion,
  replyKeyboardText,
} from "./ui.js";
import { getNav, claimMenu, setKeyboardMessage, noteMessage } from "./chatnav.js";
import { npConfig, createNpInvoice, npCheck } from "./nowpayments.js";
import { spConfig, createSpSession, spCheck, spCancel } from "./stripe.js";
import {
  binanceConfig,
  binanceConfigured,
  binanceScreen,
  binanceUnavailable,
  binanceNotice,
  claimCard,
  getClaim,
  normalizeTxId,
  openClaim,
  rateLimit,
  reopenClaim,
  verifyClaim,
  BINANCE_PROMPTS,
} from "./binance.js";
import {
  canUseShop,
  gateActive,
  joinPromptScreen,
  safePayload,
  postPurchaseFeed,
  onChatMemberUpdate,
  onMyChatMember,
  migrateGroup,
  groupConfig,
  gateNotYet,
  gateOk,
} from "./group.js";
import { t, langOf, langLabel, normalizeLang, setUserLang } from "./i18n.js";
import { freeTrialConfig, eligibleProducts, isEligible, getFreeClaim, claimFreeTrial } from "./freetrial.js";

const TG_UPLOAD_LIMIT = 50 * 1024 * 1024; // Bot API sendDocument upload limit
const TOPUP_PROMPT = "Enter the top-up amount in USD"; // legacy ForceReply prompt (old messages)
const KEYPAD_MAX_DIGITS = 6;

function adminIds(env) {
  return new Set(
    String(env.ADMIN_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => Number(s))
  );
}

export function isAdmin(env, userId) {
  return adminIds(env).has(Number(userId));
}

function formatSize(n) {
  n = Number(n || 0);
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function priceRangeLabel(product, cur, L) {
  const vals = product.prices.map((p) => p.price);
  if (!vals.length) return t(L, "price.na");
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (lo === hi) return money(lo, cur);
  return t(L, "price.from", { price: money(lo, cur) });
}

function supportLine(s, L = "en") {
  return s.support_contact ? t(L, "support.line", { contact: e(s.support_contact) }) : t(L, "support.none");
}

/** "@user", "user" or "https://t.me/user" → t.me URL (else null) */
function supportUrl(s) {
  const c = String(s.support_contact || "").trim();
  let m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(c);
  if (m) return `https://t.me/${m[1]}`;
  m = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_+/-]{2,64})$/.exec(c);
  if (m) return `https://t.me/${m[1]}`;
  if (/^https:\/\/[^\s<>"]{4,200}$/.test(c)) return c;
  return null;
}

/**
 * Create / refresh the user row and load the bot language onto the Telegram user object:
 * user.lang ("pt" | "en") and user.langChosen (false → first contact: show the bilingual picker).
 * Without migration 0012 (no lang columns) every user is English + picked (the previous behaviour).
 */
async function ensureUser(env, user) {
  try {
    const r = await env.DB.prepare(
      `INSERT INTO users (user_id, username, balance, created_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET username=excluded.username
       RETURNING lang, lang_chosen`
    )
      .bind(user.id, user.username || null, nowIso())
      .first();
    user.lang = langOf(r);
    user.langChosen = Number(r?.lang_chosen) === 1;
  } catch (err) {
    if (!/lang/i.test(String(err?.message || err))) throw err;
    await env.DB.prepare(
      `INSERT INTO users (user_id, username, balance, created_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET username=excluded.username`
    )
      .bind(user.id, user.username || null, nowIso())
      .run();
    user.lang = "en";
    user.langChosen = true;
  }
  return user;
}

function parseArgs(text) {
  return String(text || "").trim().split(/\s+/).slice(1);
}

async function activeLicenseCount(env, userId) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tokens WHERE telegram_user_id=? AND status='active' AND expires_at > ?"
  )
    .bind(userId, nowIso())
    .first();
  return r?.n || 0;
}

function maintenanceText(s, L = "en") {
  return t(L, "maint", { text: e(s.maintenance_text) });
}

/** Welcome text for the user's language: welcome_text_pt for Portuguese (falls back to welcome_text when empty). */
function welcomeText(s, L) {
  const pt = String(s.welcome_text_pt || "").trim();
  return L === "pt" && pt ? s.welcome_text_pt : s.welcome_text;
}

/* ─── language ─── */

/** First contact: bilingual picker, shown before anything else (even the group gate). The /start payload rides along. */
function firstLangScreen(payload = "") {
  const p = safePayload(payload);
  const sfx = p ? `:${p}` : "";
  return {
    text: t("pt", "lang.first"),
    reply_markup: kb([[btn(t("pt", "lang.pt"), `lg:pt${sfx}`, "primary"), btn(t("en", "lang.en"), `lg:en${sfx}`, "primary")]]),
  };
}

/** 🌐 Language screen (home / profile button, /language, /idioma). */
function languageScreen(L) {
  return {
    text: t(L, "lang.title", { current: langLabel(L) }),
    reply_markup: kb([
      [btn(t(L, "lang.pt"), "lgs:pt", L === "pt" ? "success" : undefined), btn(t(L, "lang.en"), "lgs:en", L === "en" ? "success" : undefined)],
      navRow("home", L),
    ]),
  };
}

/* ───────────────────────── screens ─────────────────────────
 * Each screen returns { text, reply_markup }. `nav` = { chatId, messageId } decides edit vs. send.
 */

/** "🎁 Free 1-day trial" button label (free_trial_days aware). */
function freeTrialLabel(s, L) {
  const days = freeTrialConfig(s).days;
  return days === 1 ? t(L, "btn.free_one") : t(L, "btn.free_many", { n: days });
}

async function screenHome(env, s, user) {
  const L = user.lang;
  const ft = freeTrialConfig(s);
  const [bal, active, claim] = await Promise.all([
    getBalance(env, user.id),
    activeLicenseCount(env, user.id),
    ft.enabled ? getFreeClaim(env, user.id) : null,
  ]);
  const cur = s.currency_symbol;
  const first = user.first_name || user.username || t(L, "home.there");
  const tc = topupConfig(s, env);
  const welcome = welcomeText(s, L);
  let text = t(L, "home.hi", { name: e(first), shop: e(s.shop_name) });
  if (String(welcome || "").trim()) text += `<blockquote>${e(fillCoins(welcome, s, L))}</blockquote>\n\n`;
  text += t(L, "home.balance", { bal: e(money(bal, cur)) });
  text += t(L, "home.active", { n: active });
  if (bal <= 0 && tc.available) text += t(L, "home.tip", { coins: coinsLabel(s, { lang: L }) });
  return {
    text,
    reply_markup: kb([
      [btn(t(L, "btn.shop"), "shop", "primary"), btn(t(L, "btn.topup"), "topup", "success")],
      // Free trial: shown until the user has claimed it (once per account, ever).
      ft.enabled && !claim ? [btn(freeTrialLabel(s, L), "free", "success")] : null,
      [btn(t(L, "btn.licenses"), "licenses"), btn(t(L, "btn.downloads"), "downloads")],
      [btn(t(L, "btn.profile"), "profile"), btn(t(L, "btn.support"), "support")],
      [btn(t(L, "btn.language"), "lang")],
    ]),
  };
}

async function screenShop(env, s, L) {
  const cur = s.currency_symbol;
  const products = (await listProducts(env, { activeOnly: true })).filter((p) => p.prices.length);
  if (!products.length) {
    return {
      text: t(L, "shop.empty"),
      reply_markup: kb([navRow("home", L)]),
    };
  }
  const lines = [t(L, "shop.title"), t(L, "shop.pick")];
  const rows = [];
  for (const p of products) {
    const label = priceRangeLabel(p, cur, L);
    lines.push(`🔹 <b>${e(p.name)}</b> — ${e(label)}`);
    rows.push([btn(`🔹 ${p.name} · ${label}`.slice(0, 64), `buy:${p.id}`)]);
  }
  rows.push(navRow("home", L));
  return { text: lines.join("\n"), reply_markup: kb(rows) };
}

async function screenProduct(env, s, user, pid) {
  const L = user.lang;
  const cur = s.currency_symbol;
  const product = await getProduct(env, pid);
  if (!product || !product.active || !product.prices.length) {
    return { text: t(L, "product.gone"), reply_markup: kb([navRow("shop", L)]) };
  }
  const bal = await getBalance(env, user.id);
  const text =
    `🔹 <b>${e(product.name)}</b>\n\n` +
    (product.description ? `<blockquote expandable>${e(product.description)}</blockquote>\n\n` : "") +
    t(L, "product.balance", { bal: e(money(bal, cur)) }) +
    t(L, "product.choose");
  const buttons = product.prices.map((pr) =>
    btn(`${formatDuration(pr.days, L)} · ${money(pr.price, cur)}`, `days:${pid}:${pr.days}`)
  );
  return { text, reply_markup: kb([...grid(buttons, 2), navRow("shop", L)]) };
}

/** Amount to top up for a shortfall: exact missing amount (rounded up to cents), at least the minimum. */
function shortfallAmount(missing, tc) {
  const up = Math.ceil(round2(missing) * 100 - 1e-6) / 100;
  return Math.min(tc.max, Math.max(tc.min, up));
}

function shortfallBlock(s, env, bal, price, pid, days, L) {
  const cur = s.currency_symbol;
  const missing = round2(price - bal);
  const tc = topupConfig(s, env);
  let text = t(L, "sf.not_enough", { bal: e(money(bal, cur)), missing: e(money(missing, cur)) });
  const rows = [];
  if (tc.available) {
    const amt = shortfallAmount(missing, tc);
    rows.push([btn(t(L, "sf.btn_topup", { amt: money(amt, cur) }), `tuc:${amt}:${pid}:${days}`, "success")]);
    rows.push([btn(t(L, "sf.btn_other"), "topup")]);
    text += t(L, "sf.oxapay", { coins: coinsLabel(s, { lang: L }) });
  } else if (npConfig(s, env).available) {
    const npc = npConfig(s, env);
    const amt = shortfallAmount(missing, npc);
    rows.push([btn(t(L, "sf.btn_np", { amt: money(amt, cur) }), `npc:${amt}:${pid}:${days}`, "success")]);
    rows.push([btn(t(L, "sf.btn_other"), "topup")]);
    text += t(L, "sf.np", { min: e(money(npc.min, cur)) });
  }
  const spc = spConfig(s, env);
  if (spc.available) {
    const amt = shortfallAmount(missing, spc);
    const cardRow = [btn(t(L, "sf.btn_card", { amt: money(amt, cur) }), `spc:${amt}:${pid}:${days}`, rows.length ? undefined : "success")];
    if (rows.length) rows.splice(rows.length - 1, 0, cardRow);
    else {
      rows.push(cardRow, [btn(t(L, "sf.btn_other"), "topup")]);
      text += t(L, "sf.card", { min: e(money(spc.min, cur)) });
    }
  }
  if (!rows.length) text += `\n${supportLine(s, L)}`;
  return { text, rows };
}

async function screenConfirmPurchase(env, s, user, pid, days) {
  const L = user.lang;
  const cur = s.currency_symbol;
  const product = await getProduct(env, pid);
  if (!product || !product.active) return { text: t(L, "product.gone"), reply_markup: kb([navRow("shop", L)]) };
  const pr = product.prices.find((x) => x.days === days);
  if (!pr) return { text: t(L, "duration.gone"), reply_markup: kb([navRow(`buy:${pid}`, L)]) };
  const bal = await getBalance(env, user.id);
  let text =
    t(L, "confirm.title") +
    t(L, "confirm.product", { name: e(product.name) }) +
    t(L, "confirm.duration", { d: formatDuration(days, L) }) +
    t(L, "confirm.price", { price: e(money(pr.price, cur)) }) +
    t(L, "confirm.balance", { bal: e(money(bal, cur)) });
  const rows = [];
  if (bal + 1e-9 >= pr.price) {
    text += t(L, "confirm.after", { bal: e(money(round2(bal - pr.price), cur)) });
    rows.push([btn(t(L, "confirm.btn", { price: money(pr.price, cur) }), `confirm:${pid}:${days}`, "success")]);
  } else {
    const sf = shortfallBlock(s, env, bal, pr.price, pid, days, L);
    text += sf.text;
    rows.push(...sf.rows);
  }
  rows.push(navRow(`buy:${pid}`, L));
  return { text, reply_markup: kb(rows) };
}

/** Receipt buttons (paid purchase and free trial): copy key, download (product with a file), licenses, home. */
function receiptRows(env, product, token, L) {
  const rows = [[copyBtn(t(L, "btn.copy_key"), token)]];
  const second = [];
  if (product.file_key && env.FILES) second.push(btn(t(L, "btn.download"), `dl:${product.id}`, "primary"));
  second.push(btn(t(L, "btn.licenses"), "licenses"));
  rows.push(second);
  rows.push([HOME(L)]);
  return rows;
}

async function doPurchase(env, s, user, pid, days) {
  const L = user.lang;
  const cur = s.currency_symbol;
  const product = await getProduct(env, pid);
  if (!product || !product.active) return { text: t(L, "product.gone"), reply_markup: kb([navRow("shop", L)]) };
  const pr = product.prices.find((x) => x.days === days);
  if (!pr) return { text: t(L, "duration.gone"), reply_markup: kb([navRow(`buy:${pid}`, L)]) };
  const price = pr.price;

  // Atomic conditional debit (prevents overspending on double taps).
  const debit = await env.DB.prepare("UPDATE users SET balance = balance - ? WHERE user_id=? AND balance >= ?")
    .bind(price, user.id, price)
    .run();
  if (!debit.meta || debit.meta.changes !== 1) {
    const bal = await getBalance(env, user.id);
    const sf = shortfallBlock(s, env, bal, price, pid, days, L);
    return {
      text: `🧾 <b>${e(product.name)}</b> · ${formatDuration(days, L)} · ${e(money(price, cur))}` + sf.text,
      reply_markup: kb([...sf.rows, navRow(`buy:${pid}`, L)]),
    };
  }

  const created = new Date();
  const expires = new Date(created.getTime() + days * 86400000);
  const createdAt = created.toISOString();
  const expiresAt = expires.toISOString();
  const token = generateToken();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO orders (user_id, product_id, product_name, price, token, created_at, expires_at, duration_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(user.id, product.id, product.name, price, token, createdAt, expiresAt, days),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tokens (token, product_id, product_name, telegram_user_id, duration_days, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
      ).bind(token, product.id, product.name, user.id, days, createdAt, expiresAt),
    ]);
  } catch (err) {
    console.error("order insert failed, refunding", err);
    await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE user_id=?").bind(price, user.id).run();
    return { text: t(L, "purchase.error"), reply_markup: kb([navRow("shop", L)]) };
  }

  const newBal = await getBalance(env, user.id);
  return {
    text:
      t(L, "receipt.title") +
      t(L, "confirm.product", { name: e(product.name) }) +
      t(L, "confirm.duration", { d: formatDuration(days, L) }) +
      t(L, "receipt.expires", { at: e(fmtDateTimeBrt(expiresAt)) }) +
      t(L, "receipt.key", { token: e(token) }) +
      t(L, "receipt.balance", { bal: e(money(newBal, cur)) }) +
      t(L, "receipt.hint"),
    reply_markup: kb(receiptRows(env, product, token, L)),
    toast: t(L, "toast.purchased"),
    record: true, // kept in the chat as a receipt: never deleted or reused as the menu
    // Community group post (src/group.js): masked buyer id + product + plan only — never the key, price or balance.
    feed: { userId: user.id, productName: product.name, days },
  };
}

/* ─── free trial (src/freetrial.js): one free license per Telegram account, ever ─── */

function freeDisabledScreen(L) {
  return { text: t(L, "free.disabled"), reply_markup: kb([[btn(t(L, "btn.shop"), "shop", "primary")], navRow("home", L)]) };
}

async function freeAlreadyScreen(env, claim, L) {
  const rows = [[btn(t(L, "btn.shop"), "shop", "primary")]];
  if (await hasActiveToken(env, claim.telegram_user_id, claim.product_id)) rows.push([btn(t(L, "btn.licenses"), "licenses")]);
  rows.push(navRow("home", L));
  return {
    text: t(L, "free.already", {
      name: e(claim.product_name || claim.product_id),
      dur: formatDuration(claim.days, L),
      at: e(fmtDateTimeBrt(claim.claimed_at)),
    }),
    reply_markup: kb(rows),
  };
}

/** 🎁 Free trial: pick one of the eligible products (or "already used"). */
async function screenFree(env, s, user) {
  const L = user.lang;
  const cfg = freeTrialConfig(s);
  const claim = await getFreeClaim(env, user.id);
  if (claim) return freeAlreadyScreen(env, claim, L);
  if (!cfg.enabled) return freeDisabledScreen(L);
  const products = await eligibleProducts(env, s);
  if (!products.length) return freeDisabledScreen(L);
  const dur = formatDuration(cfg.days, L);
  const rows = products.map((p) => [btn(t(L, "free.pick_btn", { name: p.name }).slice(0, 64), `ft:${p.id}`, "primary")]);
  rows.push(navRow("home", L));
  return { text: t(L, "free.title", { dur }) + t(L, "free.intro", { dur }), reply_markup: kb(rows) };
}

/** Confirm step: the choice is final (one claim per account). */
async function screenFreeConfirm(env, s, user, pid) {
  const L = user.lang;
  const cfg = freeTrialConfig(s);
  const claim = await getFreeClaim(env, user.id);
  if (claim) return freeAlreadyScreen(env, claim, L);
  if (!cfg.enabled) return freeDisabledScreen(L);
  const product = await getProduct(env, pid);
  if (!isEligible(s, product)) return { text: t(L, "free.not_eligible"), reply_markup: kb([navRow("free", L)]) };
  return {
    text: t(L, "free.confirm", { name: e(product.name), dur: formatDuration(cfg.days, L) }),
    reply_markup: kb([[btn(t(L, "free.btn_claim"), `ftok:${pid}`, "success")], navRow("free", L)]),
  };
}

/** Group required for the free trial: invitation + "✅ I've joined" that retries the claim (fresh check again). */
function freeGroupScreen(s, pid, L) {
  const cfg = groupConfig(s);
  const rows = [];
  if (cfg.inviteLink) rows.push([urlBtn(t(L, "gate.btn_join"), cfg.inviteLink, "primary")]);
  rows.push([btn(t(L, "gate.btn_joined"), `ftok:${pid}`, "success")]);
  rows.push(navRow("free", L));
  return { text: t(L, "free.group") + t(L, cfg.inviteLink ? "free.group_link" : "free.group_nolink"), reply_markup: kb(rows) };
}

/** Claim (ftok:<pid>): checks → live group membership → atomic claim → receipt (+ group feed after the answer). */
async function freeClaimFlow(env, s, user, nav, pid) {
  const L = user.lang;
  const cfg = freeTrialConfig(s);
  let claim = await getFreeClaim(env, user.id);
  if (claim) return { ...(await show(env, nav, await freeAlreadyScreen(env, claim, L))), toast: t(L, "free.already_toast") };
  if (!cfg.enabled) return show(env, nav, freeDisabledScreen(L));
  const product = await getProduct(env, pid);
  if (!isEligible(s, product)) return show(env, nav, { text: t(L, "free.not_eligible"), reply_markup: kb([navRow("free", L)]) });
  // Community group configured → must be a member right now (live getChatMember, no cache; even with the gate off).
  if (groupConfig(s).chatId !== null && !(await canUseShop(env, s, user.id, { admin: isAdmin(env, user.id), fresh: true, ignoreGate: true }))) {
    return { ...(await show(env, nav, freeGroupScreen(s, pid, L))), toast: t(L, "free.group_toast") };
  }
  const r = await claimFreeTrial(env, s, user.id, product);
  if (r.kind === "error") return show(env, nav, { text: t(L, "free.error"), reply_markup: kb([navRow("free", L)]) });
  if (r.kind === "already") {
    claim = r.claim;
    // Lost a double-tap race against our own claim a moment ago: the winner's receipt is on its way — just a toast.
    if (claim && Date.now() - Date.parse(claim.claimed_at) < 30_000) return { toast: t(L, "free.already_toast") };
    if (!claim) return show(env, nav, { text: t(L, "free.error"), reply_markup: kb([navRow("free", L)]) });
    return { ...(await show(env, nav, await freeAlreadyScreen(env, claim, L))), toast: t(L, "free.already_toast") };
  }
  const res = await show(env, nav, {
    text: t(L, "free.receipt", {
      name: e(product.name),
      dur: formatDuration(r.days, L),
      at: e(fmtDateTimeBrt(r.expiresAt)),
      token: e(r.token),
    }),
    reply_markup: kb(receiptRows(env, product, r.token, L)),
    toast: t(L, "free.toast"),
    record: true, // a receipt, like a purchase
  });
  // Same "🛍 New purchase!" post as a paid purchase (masked id, product, plan); never breaks the claim.
  after(nav, () => postPurchaseFeed(env, s, { userId: user.id, productName: product.name, days: r.days }));
  return res;
}

async function screenLicenses(env, s, user) {
  const L = user.lang;
  const { results } = await env.DB.prepare(
    `SELECT product_name, token, expires_at, status FROM tokens
      WHERE telegram_user_id=? ORDER BY created_at DESC LIMIT 20`
  )
    .bind(user.id)
    .all();
  const list = results || [];
  if (!list.length) {
    return {
      text: t(L, "lic.empty"),
      reply_markup: kb([[btn(t(L, "btn.shop"), "shop", "primary")], navRow("home", L)]),
    };
  }
  const now = Date.now();
  const state = (r) =>
    r.status === "revoked" ? "revoked" : r.status !== "active" || !(Date.parse(r.expires_at) > now) ? "expired" : "active";
  list.sort((a, b) => (state(b) === "active") - (state(a) === "active")); // active first, stable
  const lines = [t(L, "lic.title")];
  const copyRows = [];
  for (const r of list) {
    const st = state(r);
    const emoji = st === "active" ? "🟢" : st === "revoked" ? "⛔" : "🔴";
    const info =
      st === "active"
        ? t(L, "lic.until", { left: daysLeftLabel(r.expires_at, L), at: fmtShortBrt(r.expires_at) })
        : st === "revoked"
          ? t(L, "lic.revoked")
          : t(L, "lic.expired", { at: fmtShortBrt(r.expires_at) });
    lines.push(`${emoji} <b>${e(r.product_name)}</b> — ${e(info)}\n<code>${e(r.token)}</code>\n`);
    if (st === "active" && copyRows.length < 3) {
      copyRows.push([copyBtn(t(L, "lic.copy", { name: r.product_name, tail: String(r.token).slice(-4) }).slice(0, 64), r.token)]);
    }
  }
  lines.push(t(L, "lic.footer"));
  return {
    text: lines.join("\n"),
    reply_markup: kb([...copyRows, [btn(t(L, "btn.downloads"), "downloads"), btn(t(L, "btn.shop"), "shop")], navRow("home", L)]),
  };
}

async function activeDownloads(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.file_name, p.file_size, p.sort, MAX(t.expires_at) AS exp
       FROM tokens t JOIN products p ON p.id = t.product_id
      WHERE t.telegram_user_id = ? AND t.status = 'active' AND t.expires_at > ?
        AND p.file_key IS NOT NULL
      GROUP BY p.id ORDER BY p.sort ASC`
  )
    .bind(userId, nowIso())
    .all();
  return results || [];
}

async function hasActiveToken(env, userId, productId) {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM tokens WHERE telegram_user_id=? AND product_id=? AND status='active' AND expires_at > ? LIMIT 1`
  )
    .bind(userId, productId, nowIso())
    .first();
  return !!row;
}

async function screenDownloads(env, s, user) {
  const L = user.lang;
  if (!env.FILES) {
    return {
      text: t(L, "dl.unavailable") + supportLine(s, L),
      reply_markup: kb([navRow("home", L)]),
    };
  }
  const items = await activeDownloads(env, user.id);
  if (!items.length) {
    return {
      text: t(L, "dl.empty"),
      reply_markup: kb([[btn(t(L, "btn.shop"), "shop", "primary"), btn(t(L, "btn.licenses"), "licenses")], navRow("home", L)]),
    };
  }
  const rows = items.map((it) => [
    btn(`📥 ${it.name}${it.file_size ? ` · ${formatSize(it.file_size)}` : ""}`.slice(0, 64), `dl:${it.id}`, "primary"),
  ]);
  rows.push([btn(t(L, "btn.licenses"), "licenses")], navRow("home", L));
  return { text: t(L, "dl.pick"), reply_markup: kb(rows) };
}

const METHOD_KEY = {
  oxapay: "method.oxapay",
  binance: "method.binance",
  nowpayments: "method.nowpayments",
  stripe: "method.stripe",
  stripe_refund: "method.stripe_refund",
  admin_add: "method.credit",
  panel_add: "method.credit",
  admin_sub: "method.adjustment",
  panel_sub: "method.adjustment",
  admin_set: "method.adjustment",
  panel_set: "method.adjustment",
};

async function screenProfile(env, s, user) {
  const L = user.lang;
  const cur = s.currency_symbol;
  const [u, tops, ords, active] = await Promise.all([
    env.DB.prepare("SELECT balance, created_at FROM users WHERE user_id=?").bind(user.id).first(),
    env.DB.prepare("SELECT amount, method, created_at FROM topups WHERE user_id=? ORDER BY id DESC LIMIT 5").bind(user.id).all(),
    env.DB.prepare("SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 5")
      .bind(user.id)
      .all(),
    activeLicenseCount(env, user.id),
  ]);
  let text =
    t(L, "profile.title") +
    `ID: <code>${user.id}</code>${user.username ? ` · @${e(user.username)}` : ""}\n` +
    t(L, "profile.balance", { bal: e(money(u?.balance || 0, cur)) }) +
    t(L, "profile.active", { n: active }) +
    t(L, "profile.lang", { lang: langLabel(L) });
  const tp = tops.results || [];
  text += t(L, "profile.tops");
  text += tp.length
    ? tp
        .map((x) => `• ${fmtShortBrt(x.created_at)} · ${x.amount >= 0 ? "+" : "−"}${e(money(Math.abs(x.amount), cur))} · ${e(METHOD_KEY[x.method] ? t(L, METHOD_KEY[x.method]) : x.method)}`)
        .join("\n")
    : t(L, "profile.no_tops");
  const o = ords.results || [];
  text += t(L, "profile.ords");
  text += o.length
    ? o
        .map(
          (x) =>
            `• ${fmtShortBrt(x.created_at)} · ${e(x.product_name)} · ${formatDuration(x.duration_days || 0, L)} · ${
              x.kind === "free_trial" ? t(L, "profile.free") : e(money(x.price, cur))
            }`
        )
        .join("\n")
    : t(L, "profile.no_ords");
  text += t(L, "profile.times");
  return {
    text,
    reply_markup: kb([
      [btn(t(L, "btn.topup"), "topup", "success"), btn(t(L, "btn.licenses"), "licenses")],
      [btn(t(L, "btn.language"), "lang")],
      navRow("home", L),
    ]),
  };
}

async function screenSupport(env, s, L) {
  const url = supportUrl(s);
  const tc = topupConfig(s, env);
  let text = t(L, "support.title");
  text += s.support_contact ? t(L, "support.contact", { contact: e(s.support_contact) }) : t(L, "support.nocontact");
  text +=
    t(L, "support.guide") +
    (tc.available ? t(L, "support.g1_topup", { coins: coinsLabel(s, { lang: L }) }) : t(L, "support.g1_admin")) +
    t(L, "support.g2") +
    t(L, "support.g3") +
    t(L, "support.g4");
  const rows = [];
  if (url) rows.push([urlBtn(t(L, "btn.msg_support"), url, "primary")]);
  rows.push(navRow("home", L));
  return { text, reply_markup: kb(rows) };
}

/* ─── top-up screens ─── */

function unavailableTopup(s, L = "en") {
  return {
    text: t(L, "topup.unavailable", { support: supportLine(s, L) }),
    reply_markup: kb([navRow("home", L)]),
  };
}

async function screenTopup(env, s, user) {
  const L = user.lang;
  const tc = topupConfig(s, env);
  const bc = binanceConfig(s, env);
  const npc = npConfig(s, env);
  const spc = spConfig(s, env);
  if (!tc.available && !bc.available && !npc.available && !spc.available) return unavailableTopup(s, L);
  const cur = s.currency_symbol;
  const bal = await getBalance(env, user.id);
  const binanceLine = t(L, "topup.binance_line");
  const npLine = t(L, "topup.np_line", { min: e(money(npc.min, cur)) });
  const npRow = npc.available ? [btn(t(L, "btn.np"), "np", tc.available ? undefined : "primary")] : null;
  const spLine = t(L, "topup.sp_line", { min: e(money(spc.min, cur)) });
  const spRow = spc.available ? [btn(t(L, "btn.sp"), "sp", tc.available || npc.available ? undefined : "primary")] : null;
  if (!tc.available) {
    const lines = [npc.available ? npLine : "", spc.available ? spLine : "", bc.available ? binanceLine : ""].filter(Boolean);
    return {
      text:
        t(L, "topup.title") +
        t(L, "topup.current", { bal: e(money(bal, cur)) }) +
        (npc.available || spc.available ? "" : t(L, "topup.ox_unavail")) +
        lines.join("\n\n"),
      reply_markup: kb([npRow, spRow, bc.available ? [btn(t(L, "btn.binance"), "bn", npc.available || spc.available ? undefined : "primary")] : null, navRow("home", L)]),
    };
  }
  const presetBtns = tc.presets.map((a) => btn(money(a, cur).replace(/\.00$/, ""), `tuc:${a}`, "primary"));
  const otherRow = [btn(t(L, "btn.other"), "kp:")];
  if (bc.available) otherRow.push(btn(t(L, "btn.binance"), "bn"));
  return {
    text:
      t(L, "topup.title") +
      t(L, "topup.current", { bal: e(money(bal, cur)) }) +
      t(L, "topup.choose", { min: e(money(tc.min, cur)), max: e(money(tc.max, cur)) }) +
      t(L, "topup.accept", { coins: coinsLabel(s, { bold: true, lang: L }) }) +
      howItWorks(s, { pickAmount: true }, L) +
      (npc.available ? `\n${npLine}` : "") +
      (spc.available ? `\n${spLine}` : "") +
      (bc.available ? `\n${binanceLine}` : ""),
    reply_markup: kb([...grid(presetBtns, presetBtns.length === 4 ? 2 : 3), otherRow, npRow, spRow, navRow("home", L)]),
  };
}

function screenKeypad(s, env, digits, note, mode = "kp", L = "en") {
  const np = mode === "np";
  const sp = mode === "sp";
  const tc = np ? npConfig(s, env) : sp ? spConfig(s, env) : topupConfig(s, env);
  if (!tc.available) return np ? npUnavailable(s, L) : sp ? spUnavailable(s, L) : unavailableTopup(s, L);
  const cur = s.currency_symbol;
  const P = np ? "nk" : sp ? "sk" : "kp";
  const shown = digits ? Number(digits).toLocaleString("en-US") : "0";
  const valid = digits && Number(digits) >= tc.min && Number(digits) <= tc.max;
  const text =
    t(L, "kp.title", { sfx: np ? " · NOWPayments" : sp ? t(L, "kp.sfx_card") : "" }) +
    `<b>💵 ${e(cur)} ${e(shown)}</b>${digits ? "" : " ▏"}\n\n` +
    t(L, "kp.minmax", { min: e(money(tc.min, cur)), max: e(money(tc.max, cur)) }) +
    (np ? t(L, "kp.np_note") : "") +
    (note ? `\n⚠️ ${e(note)}\n` : "") +
    t(L, "kp.hint");
  const d = (n) => btn(String(n), `${P}:${digits}${n}`);
  return {
    text,
    reply_markup: kb([
      [d(1), d(2), d(3)],
      [d(4), d(5), d(6)],
      [d(7), d(8), d(9)],
      [btn("⌫", `${P}:${digits.slice(0, -1)}`), d(0), btn("✅", `${P}ok:${digits}`, valid ? "success" : undefined)],
      navRow(np ? "np" : sp ? "sp" : "topup", L),
    ]),
  };
}

function screenConfirmTopup(s, env, amount, resume, L = "en") {
  const tc = topupConfig(s, env);
  if (!tc.available) return unavailableTopup(s, L);
  const cur = s.currency_symbol;
  const suffix = resume ? `:${resume.pid}:${resume.days}` : "";
  return {
    text:
      t(L, "ctu.title") +
      t(L, "ctu.amount", { amt: e(money(amount, cur)) }) +
      t(L, "ctu.paywith", { coins: coinsLabel(s, { bold: true, lang: L }), net: networkHint(s, L) ? t(L, "ctu.net") : "" }) +
      t(L, "ctu.valid", { n: INVOICE_LIFETIME_MIN }) +
      (resume ? t(L, "ctu.resume") : "") +
      t(L, "ctu.auto"),
    reply_markup: kb([
      [btn(t(L, "btn.create_invoice", { amt: money(amount, cur) }), `tun:${amount}${suffix}`, "success")],
      npAltRow(s, env, amount, suffix, L),
      spAltRow(s, env, amount, suffix, L),
      [btn(t(L, "btn.change_amount"), "topup")],
      [HOME(L)],
    ]),
  };
}

/** "Other coins" shortcut on the OxaPay confirm screen when the amount is within the NOWPayments limits. */
function npAltRow(s, env, amount, suffix, L) {
  const npc = npConfig(s, env);
  if (!npc.available || amount < npc.min || amount > npc.max) return null;
  return [btn(t(L, "btn.np_alt"), `npn:${amount}${suffix}`)];
}

/** "Pay by card" shortcut on the OxaPay confirm screen when the amount is within the Stripe limits. */
function spAltRow(s, env, amount, suffix, L) {
  const spc = spConfig(s, env);
  if (!spc.available || amount < spc.min || amount > spc.max) return null;
  return [btn(t(L, "btn.sp_alt"), `spn:${amount}${suffix}`)];
}

/* ─── Stripe (hosted Checkout: credit / debit card, USD) ─── */

function spUnavailable(s, L = "en") {
  return {
    text: t(L, "sp.unavailable", { support: supportLine(s, L) }),
    reply_markup: kb([navRow("topup", L)]),
  };
}

function screenSp(s, env, L = "en") {
  const spc = spConfig(s, env);
  if (!spc.available) return spUnavailable(s, L);
  const cur = s.currency_symbol;
  const presetBtns = spc.presets.map((a) => btn(money(a, cur).replace(/\.00$/, ""), `spc:${a}`, "primary"));
  return {
    text:
      t(L, "sp.title") +
      t(L, "sp.intro") +
      t(L, "sp.minmax", { min: e(money(spc.min, cur)), max: e(money(spc.max, cur)) }) +
      t(L, "common.choose_amount") +
      howItWorksSp(L),
    reply_markup: kb([...grid(presetBtns, presetBtns.length === 4 ? 2 : 3), [btn(t(L, "btn.other"), "sk:")], navRow("topup", L)]),
  };
}

function screenConfirmSp(s, env, amount, resume, L = "en") {
  const spc = spConfig(s, env);
  if (!spc.available) return spUnavailable(s, L);
  const cur = s.currency_symbol;
  const suffix = resume ? `:${resume.pid}:${resume.days}` : "";
  return {
    text:
      t(L, "spc.title") +
      t(L, "spc.amount", { amt: e(money(amount, cur)) }) +
      t(L, "spc.paywith") +
      (resume ? t(L, "spc.resume") : "") +
      t(L, "spc.auto"),
    reply_markup: kb([
      [btn(t(L, "btn.continue_pay", { amt: money(amount, cur) }), `spn:${amount}${suffix}`, "success")],
      [btn(t(L, "btn.change_amount"), "sp")],
      [HOME(L)],
    ]),
  };
}

function spAmountError(spc, amount, cur, L = "en") {
  if (amount === null || !Number.isFinite(amount)) return t(L, "err.amount");
  if (amount < spc.min) return t(L, "err.sp_min", { min: money(spc.min, cur) });
  if (amount > spc.max) return t(L, "err.sp_max", { max: money(spc.max, cur) });
  return null;
}

async function createSpFlow(env, s, user, nav, amount, resume) {
  const L = user.lang;
  const spc = spConfig(s, env);
  if (!spc.available) return show(env, nav, spUnavailable(s, L));
  const errMsg = spAmountError(spc, amount, s.currency_symbol, L);
  if (errMsg) return show(env, nav, screenKeypad(s, env, "", errMsg, "sp", L));
  const r = await createSpSession(env, s, { userId: user.id, chatId: nav.chatId, amount, resume: resume ? `${resume.pid}:${resume.days}` : null });
  if (!r.ok) {
    const msg = t(L, r.reason === "too_many" ? "sp.too_many" : r.reason === "unconfigured" ? "sp.unconf" : "sp.fail");
    return show(env, nav, { text: t(L, "sp.head", { msg, support: supportLine(s, L) }), reply_markup: kb([navRow("sp", L)]) });
  }
  const card = invoiceCard(r.payment, s, supportLine(s, L), L);
  if (r.reused && nav.messageId && r.payment.message_id === nav.messageId) nav.inPlace = true;
  const res = await show(env, nav, { ...card, record: true });
  if (res?.message_id) await setPaymentMessage(env, r.payment.id, nav.chatId, res.message_id);
  return { ...res, toast: t(L, r.reused ? "toast.sp_reused" : "toast.sp_ready") };
}

/** Return from the Stripe page (success_url deep link): show the latest card top-up. */
async function spLatestFlow(env, s, user, nav) {
  const pay = await env.DB.prepare(
    "SELECT id FROM payments WHERE provider='stripe' AND telegram_user_id=? AND status<>'error' ORDER BY created_at DESC LIMIT 1"
  )
    .bind(user.id)
    .first();
  if (!pay) return show(env, nav, await screenTopup(env, s, user));
  return checkStatusFlow(env, s, user, nav, pay.id);
}

function spTypedAmount(env, s, nav, amount, L = "en") {
  const err = spAmountError(spConfig(s, env), amount, s.currency_symbol, L);
  if (err) return show(env, nav, screenKeypad(s, env, "", err, "sp", L));
  return show(env, nav, screenConfirmSp(s, env, amount, null, L));
}

/* ─── NOWPayments (hosted invoice: any coin / network) ─── */

function npUnavailable(s, L = "en") {
  return {
    text: t(L, "np.unavailable", { support: supportLine(s, L) }),
    reply_markup: kb([navRow("topup", L)]),
  };
}

function npMinNote(npc, cur, L) {
  return t(L, "np.min_note", { min: e(money(npc.min, cur)) });
}

function screenNp(s, env, L = "en") {
  const npc = npConfig(s, env);
  if (!npc.available) return npUnavailable(s, L);
  const cur = s.currency_symbol;
  const presetBtns = npc.presets.map((a) => btn(money(a, cur).replace(/\.00$/, ""), `npc:${a}`, "primary"));
  return {
    text:
      t(L, "np.title") +
      t(L, "np.intro") +
      `${npMinNote(npc, cur, L)}\n` +
      t(L, "np.max", { max: e(money(npc.max, cur)) }) +
      t(L, "common.choose_amount") +
      howItWorksNp(L),
    reply_markup: kb([...grid(presetBtns, presetBtns.length === 4 ? 2 : 3), [btn(t(L, "btn.other"), "nk:")], navRow("topup", L)]),
  };
}

function screenConfirmNp(s, env, amount, resume, L = "en") {
  const npc = npConfig(s, env);
  if (!npc.available) return npUnavailable(s, L);
  const cur = s.currency_symbol;
  const suffix = resume ? `:${resume.pid}:${resume.days}` : "";
  return {
    text:
      t(L, "npc.title") +
      t(L, "ctu.amount", { amt: e(money(amount, cur)) }) +
      t(L, "npc.paywith") +
      (resume ? t(L, "ctu.resume") : "") +
      t(L, "ctu.auto"),
    reply_markup: kb([
      [btn(t(L, "btn.create_invoice", { amt: money(amount, cur) }), `npn:${amount}${suffix}`, "success")],
      [btn(t(L, "btn.change_amount"), "np")],
      [HOME(L)],
    ]),
  };
}

function npAmountError(npc, amount, cur, L = "en") {
  if (amount === null || !Number.isFinite(amount)) return t(L, "err.amount");
  if (amount < npc.min) return t(L, "err.np_min", { min: money(npc.min, cur) });
  if (amount > npc.max) return t(L, "err.max", { max: money(npc.max, cur) });
  return null;
}

async function createNpFlow(env, s, user, nav, amount, resume) {
  const L = user.lang;
  const npc = npConfig(s, env);
  if (!npc.available) return show(env, nav, npUnavailable(s, L));
  const errMsg = npAmountError(npc, amount, s.currency_symbol, L);
  if (errMsg) return show(env, nav, screenKeypad(s, env, "", errMsg, "np", L));
  const r = await createNpInvoice(env, s, { userId: user.id, chatId: nav.chatId, amount, resume: resume ? `${resume.pid}:${resume.days}` : null });
  if (!r.ok) {
    const msg = t(L, r.reason === "too_many" ? "np.too_many" : r.reason === "unconfigured" ? "np.unconf" : "np.fail");
    return show(env, nav, { text: t(L, "np.head", { msg, support: supportLine(s, L) }), reply_markup: kb([navRow("np", L)]) });
  }
  const card = invoiceCard(r.payment, s, supportLine(s, L), L);
  if (r.reused && nav.messageId && r.payment.message_id === nav.messageId) nav.inPlace = true;
  const res = await show(env, nav, { ...card, record: true });
  if (res?.message_id) await setPaymentMessage(env, r.payment.id, nav.chatId, res.message_id);
  return { ...res, toast: t(L, r.reused ? "toast.inv_reused" : "toast.inv_created") };
}

/** Return from the NOWPayments page (success_url deep link): show the latest NOWPayments top-up. */
async function npLatestFlow(env, s, user, nav) {
  const pay = await env.DB.prepare(
    "SELECT id FROM payments WHERE provider='nowpayments' AND telegram_user_id=? AND status<>'error' ORDER BY created_at DESC LIMIT 1"
  )
    .bind(user.id)
    .first();
  if (!pay) return show(env, nav, await screenTopup(env, s, user));
  return checkStatusFlow(env, s, user, nav, pay.id);
}

function parseTopupData(rest) {
  // "<amount>" or "<amount>:<pid>:<days>"
  const m = /^(\d{1,7}(?:\.\d{1,2})?)(?::([a-z0-9_-]{1,32}):(\d{1,4}))?$/.exec(rest);
  if (!m) return null;
  return { amount: round2(m[1]), resume: m[2] ? { pid: m[2], days: Number(m[3]) } : null };
}

function amountError(tc, amount, cur, L = "en") {
  if (amount === null || !Number.isFinite(amount)) return t(L, "err.amount");
  if (amount < tc.min) return t(L, "err.min", { min: money(tc.min, cur) });
  if (amount > tc.max) return t(L, "err.max", { max: money(tc.max, cur) });
  return null;
}

async function createInvoiceFlow(env, s, user, nav, amount, resume) {
  const L = user.lang;
  const tc = topupConfig(s, env);
  if (!tc.available) return show(env, nav, unavailableTopup(s, L));
  const errMsg = amountError(tc, amount, s.currency_symbol, L);
  if (errMsg) return show(env, nav, screenKeypad(s, env, "", errMsg, "kp", L));
  const r = await createTopupInvoice(env, {
    userId: user.id,
    chatId: nav.chatId,
    amount,
    shopName: s.shop_name,
    resume: resume ? `${resume.pid}:${resume.days}` : null,
  });
  if (!r.ok) {
    const msg = t(L, r.reason === "too_many" ? "ox.too_many" : r.reason === "unconfigured" ? "ox.unconf" : "ox.fail");
    return show(env, nav, { text: t(L, "ox.head", { msg, support: supportLine(s, L) }), reply_markup: kb([navRow("topup", L)]) });
  }
  const card = invoiceCard(r.payment, s, supportLine(s, L), L);
  // Double tap on "Create invoice" arrives from the message that already became this card: refresh it in place.
  if (r.reused && nav.messageId && r.payment.message_id === nav.messageId) nav.inPlace = true;
  const res = await show(env, nav, { ...card, record: true });
  if (res?.message_id) await setPaymentMessage(env, r.payment.id, nav.chatId, res.message_id);
  return { ...res, toast: t(L, r.reused ? "toast.inv_reused" : "toast.inv_created") };
}

const STATUS_TOAST = ["pending", "paying", "expired", "canceled", "underpaid", "failed", "review"];

async function checkStatusFlow(env, s, user, nav, id) {
  const L = user.lang;
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE id=? AND telegram_user_id=?").bind(id, user.id).first();
  if (!pay) return show(env, nav, { text: t(L, "pay.not_found"), reply_markup: kb([navRow("home", L)]) });
  if (pay.provider === "binance") return binanceRecheckFlow(env, s, user, nav, id);
  if (nav.messageId && pay.message_id !== nav.messageId) await setPaymentMessage(env, pay.id, nav.chatId, nav.messageId);
  if (pay.credited) {
    const bal = await getBalance(env, user.id);
    await show(env, nav, paidCard(pay, s, bal, L));
    return { toast: t(L, "toast.already_paid") };
  }
  let toast = null;
  if (pay.provider === "stripe") {
    const r = await spCheck(env, s, { ...pay, message_id: nav.messageId || pay.message_id }, "user_check");
    if (r.action === "credited") return { toast: t(L, "toast.confirmed") };
    if (r.action === "duplicate") return { toast: t(L, "toast.already_paid") };
    if (r.action === "api_error") toast = t(L, "toast.api_err");
    if ((r.action === "pending" || r.throttled) && pay.status === "pending") toast = t(L, "toast.sp_nopay");
  } else if (pay.provider === "nowpayments") {
    const r = await npCheck(env, s, { ...pay, message_id: nav.messageId || pay.message_id }, "user_check");
    if (r.action === "credited") return { toast: t(L, "toast.confirmed") };
    if (r.action === "duplicate") return { toast: t(L, "toast.already_paid") };
    if (r.action === "api_error") toast = t(L, "toast.api_err");
    if (r.action === "no_payment" && pay.status === "pending") toast = t(L, "toast.np_nopay");
  } else if (pay.track_id && !["error", "refunded"].includes(pay.status)) {
    const r = await syncPayment(env, { ...pay, message_id: nav.messageId || pay.message_id }, "user_check");
    if (r.action === "credited") return { toast: t(L, "toast.confirmed") };
    if (r.action === "duplicate") return { toast: t(L, "toast.already_paid") };
    if (r.action === "api_error") toast = t(L, "toast.api_err");
  }
  const fresh = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(id).first();
  await show(env, nav, invoiceCard(fresh, s, supportLine(s, L), L));
  return { toast: toast || (STATUS_TOAST.includes(fresh.status) ? t(L, `st.${fresh.status}`) : t(L, "toast.status", { st: fresh.status })) };
}

/* ─── Binance Pay (paste the transaction ID; verified in the shop's Binance Pay history) ─── */

async function screenBinance(env, s, L = "en") {
  const bc = binanceConfig(s, env);
  return bc.available ? binanceScreen(s, bc, L) : binanceUnavailable(s, L);
}

const BINANCE_TOAST_KEYS = {
  credited: "bn.t_credited",
  already: "bn.t_already",
  pending: "bn.t_pending",
  rejected: "bn.t_rejected",
  review: "bn.t_review",
};

function claimToast(pay, L) {
  if (pay.credited) return t(L, "bn.t_already");
  const k = { pending: "bn.t_pending", review: "bn.t_review", rejected: "bn.t_rejected", expired: "bn.t_expired" }[pay.status];
  return k ? t(L, k) : null;
}

async function binanceClaimFlow(env, s, user, nav, raw) {
  const L = user.lang;
  const bc = binanceConfig(s, env);
  if (!bc.available) return show(env, nav, binanceUnavailable(s, L));
  const txid = normalizeTxId(raw);
  if (!txid) return show(env, nav, binanceNotice(s, "invalid", {}, L));
  const o = await openClaim(env, { userId: user.id, chatId: nav.chatId, txid });
  if (o.kind !== "new" && o.kind !== "own") return show(env, nav, binanceNotice(s, o.kind, o, L));
  let pay = o.payment;
  let r = { action: o.kind === "own" ? "show" : "pending", payment: pay };
  if (o.kind === "new") {
    r = await verifyClaim(env, s, pay, "user_submit");
  } else if (!pay.credited && ["pending", "expired", "canceled"].includes(pay.status)) {
    // Pasted again: check again (rate limited), re-opening an expired claim for another window.
    if ((await rateLimit(env, user.id)).ok) {
      pay = await reopenClaim(env, pay);
      r = await verifyClaim(env, s, pay, "user_resubmit");
    }
  }
  pay = r.payment || pay;
  const card = claimCard(pay, s, { apiError: r.apiError || null, newBalance: r.action === "credited" ? r.newBalance : null }, L);
  const res = await show(env, nav, { ...card, record: true });
  if (res?.message_id) await setPaymentMessage(env, pay.id, nav.chatId, res.message_id);
  return res;
}

async function binanceRecheckFlow(env, s, user, nav, id) {
  const L = user.lang;
  nav.inPlace = true; // actions on the claim card (a record) update that card itself
  let pay = await getClaim(env, id);
  if (!pay || Number(pay.telegram_user_id) !== Number(user.id)) return { toast: t(L, "bn.tx_not_found") };
  if (nav.messageId && pay.message_id !== nav.messageId) await setPaymentMessage(env, pay.id, nav.chatId, nav.messageId);
  let r = { action: "show", payment: pay };
  let toast = null;
  if (!pay.credited && ["pending", "expired", "canceled"].includes(pay.status)) {
    if (!binanceConfigured(env)) {
      toast = t(L, "bn.unavail_toast");
    } else {
      const rl = await rateLimit(env, user.id);
      if (!rl.ok) toast = rl.hourly ? t(L, "bn.too_many_checks") : t(L, "bn.wait", { s: rl.wait });
      else {
        pay = await reopenClaim(env, pay);
        r = await verifyClaim(env, s, pay, "user_check");
        pay = r.payment || pay;
      }
    }
  }
  await show(env, nav, claimCard(pay, s, { apiError: r.apiError || null, newBalance: r.action === "credited" ? r.newBalance : null }, L));
  return { toast: toast || (BINANCE_TOAST_KEYS[r.action] ? t(L, BINANCE_TOAST_KEYS[r.action]) : null) || claimToast(pay, L) };
}

/* ─── routing helpers ─── */

async function navState(env, nav) {
  if (!nav.state) nav.state = await getNav(env, nav.chatId);
  return nav.state;
}

/**
 * Show a screen — the active screen follows the user:
 *  - tapped message is the current menu AND still the latest message in the chat → edit it in place;
 *  - otherwise (older message tapped, reply keyboard, command, typed text) → send the screen fresh at the
 *    bottom, then delete the previous menu message (errors ignored: >48 h old messages can't be deleted).
 * screen.record: the message becomes a record (invoice card, purchase receipt) — it is never deleted and
 *   never reused as the menu. nav.inPlace: edit the tapped message itself (actions on a record).
 * Without the chat_nav table (migration 0006 not applied) the previous edit-in-place behaviour is used.
 */
async function show(env, nav, screen) {
  const extra = { reply_markup: screen.reply_markup };
  const plain = async () => {
    const res = await editOrSend(env, nav.chatId, nav.messageId, screen.text, extra);
    return { message_id: res.message_id, toast: screen.toast };
  };
  if (nav.inPlace && nav.messageId) return plain();
  const st = await navState(env, nav);
  if (!st.available) return plain();
  const row = st.row || {};
  const menuId = row.menu_msg_id ? Number(row.menu_msg_id) : null;
  const latest = !!nav.messageId && menuId === nav.messageId && nav.messageId >= Number(row.last_msg_id || 0);
  const res = await editOrSend(env, nav.chatId, latest ? nav.messageId : null, screen.text, extra);
  if (res.message_id) {
    const newMenu = screen.record ? null : res.message_id;
    let current = newMenu;
    // Compare-and-set: rapid double taps read the same old menu and both send a screen. Only one claims it;
    // the other (a freshly sent screen) takes over and deletes the winner's screen, so exactly one menu is
    // left at the bottom. An in-place edit or a record (invoice card, receipt) that loses leaves the winner alone.
    if ((await claimMenu(env, nav.chatId, menuId, newMenu)) === false) {
      const other = (await getNav(env, nav.chatId)).row?.menu_msg_id;
      const otherId = other ? Number(other) : null;
      current = otherId;
      if (newMenu && !res.edited) {
        if (otherId !== newMenu && (await claimMenu(env, nav.chatId, otherId, newMenu))) {
          current = newMenu;
          if (otherId) await deleteMessageQuiet(env, nav.chatId, otherId);
        } else {
          await deleteMessageQuiet(env, nav.chatId, newMenu); // a third request won: drop our duplicate
        }
      }
    }
    st.row = { ...row, menu_msg_id: current, last_msg_id: Math.max(Number(row.last_msg_id || 0), res.message_id) };
  }
  if (res.ok && menuId && menuId !== res.message_id) await deleteMessageQuiet(env, nav.chatId, menuId);
  return { message_id: res.message_id, toast: screen.toast };
}

/**
 * Attach the persistent reply keyboard (a message can carry only one reply_markup, so it rides on a short
 * message of its own). force: always (re)send — /start, /menu, unrecognised text, language change. Otherwise only
 * when this chat never got it, got an older layout or the other language (kbVersion encodes both).
 * The previous keyboard message is deleted after the new one. Language: nav.lang.
 */
async function ensureKeyboard(env, nav, { force = false } = {}) {
  if (!(Number(nav.chatId) > 0)) return;
  const L = nav.lang || "en";
  const want = kbVersion(L);
  const st = await navState(env, nav);
  const row = st.row || {};
  if (!force && (!st.available || (row.kb_msg_id && Number(row.kb_version) === want))) return;
  const r = await sendMessage(env, nav.chatId, replyKeyboardText(L), { reply_markup: replyKeyboard(L) });
  const mid = r?.ok ? r.result?.message_id : null;
  if (!mid || !st.available) return;
  await setKeyboardMessage(env, nav.chatId, mid, want);
  st.row = { ...row, kb_msg_id: mid, kb_version: want, last_msg_id: Math.max(Number(row.last_msg_id || 0), mid) };
  if (row.kb_msg_id && Number(row.kb_msg_id) !== mid) await deleteMessageQuiet(env, nav.chatId, row.kb_msg_id);
}

async function answerCallback(env, id, text, alert) {
  const body = { callback_query_id: id, text: text ? String(text).slice(0, 200) : undefined, show_alert: alert || undefined };
  // One retry on a network-level failure so the button spinner never hangs.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await tgApi(env, "answerCallbackQuery", body);
    } catch (err) {
      console.error(`answerCallbackQuery failed (attempt ${attempt})`, err);
    }
  }
}

async function sendProductFile(env, chatId, product) {
  const caption = `${product.name}${product.file_name ? ` — ${product.file_name}` : ""}`.slice(0, 1000);
  // Re-use Telegram's cached file_id when we have one (no re-upload).
  if (product.file_tg_id) {
    const r = await tgApi(env, "sendDocument", {
      chat_id: chatId,
      document: product.file_tg_id,
      caption,
    });
    if (r.ok) return { ok: true };
  }
  const obj = await env.FILES.get(product.file_key);
  if (!obj) return { ok: false, reason: "missing" };
  if (obj.size > TG_UPLOAD_LIMIT) return { ok: false, reason: "too_big" };
  const buf = await obj.arrayBuffer();
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append(
    "document",
    new Blob([buf], { type: product.file_type || obj.httpMetadata?.contentType || "application/octet-stream" }),
    product.file_name || "file"
  );
  const r = await tgApiForm(env, "sendDocument", form);
  if (!r.ok) return { ok: false, reason: "telegram" };
  const fileId = r.result?.document?.file_id;
  if (fileId) {
    await env.DB.prepare("UPDATE products SET file_tg_id=? WHERE id=? AND file_key=?")
      .bind(fileId, product.id, product.file_key)
      .run();
  }
  return { ok: true };
}

/** Work to do once the user already has the answer (group post after a purchase). Never throws. */
function after(nav, fn) {
  (nav.after ||= []).push(fn);
}

async function runAfter(nav) {
  for (const fn of nav.after || []) {
    try {
      await fn();
    } catch (err) {
      console.error("after-task failed", err && err.stack ? err.stack : err);
    }
  }
  nav.after = [];
}

/** /start <payload> targets (also used after "✅ I've joined" and the first-contact language picker):
 * topup_<amount>, buy_<product>_<days> (purchase confirm), DEEP_LINKS (incl. free), else home. */
async function startRoute(env, s, user, nav, payload) {
  let m;
  if ((m = /^topup_(\d{1,7})$/.exec(payload || ""))) return route(env, s, user, nav, `tuc:${m[1]}`);
  if ((m = /^buy_([a-z0-9_-]{1,32})_(\d{1,4})$/.exec(payload || ""))) return route(env, s, user, nav, `days:${m[1]}:${m[2]}`);
  if (DEEP_LINKS.has(payload)) return route(env, s, user, nav, payload);
  return show(env, nav, await screenHome(env, s, user));
}

/** "✅ I've joined": check again without the cache, then continue to the deep-link target (or home). */
async function joinedFlow(env, s, user, nav, payload) {
  const L = user.lang;
  if (!(await canUseShop(env, s, user.id, { admin: isAdmin(env, user.id), fresh: true }))) return { toast: gateNotYet(L), alert: true };
  await answerCallback(env, nav.queryId, gateOk(L));
  nav.answered = true;
  await ensureKeyboard(env, nav);
  return startRoute(env, s, user, nav, safePayload(payload));
}

/**
 * Language chosen: lg:<pt|en>[:<payload>] (first-contact picker → then the group gate, then the /start deep link)
 * or lgs:<pt|en> (🌐 screen → home). The reply keyboard is re-sent in the new language.
 */
async function langSetFlow(env, s, user, nav, lang, payload, first) {
  const L = normalizeLang(lang) || "en";
  await setUserLang(env, user.id, L);
  user.lang = L;
  user.langChosen = true;
  nav.lang = L;
  if (!(await canUseShop(env, s, user.id, { admin: isAdmin(env, user.id) }))) {
    // Community group required: the invitation (now in the chosen language) keeps the deep link.
    await show(env, nav, joinPromptScreen(s, first ? payload : "", L));
    return { toast: t(L, "lang.changed") };
  }
  await answerCallback(env, nav.queryId, t(L, "lang.changed"));
  nav.answered = true;
  await ensureKeyboard(env, nav, { force: true });
  if (first) return startRoute(env, s, user, nav, safePayload(payload));
  return show(env, nav, await screenHome(env, s, user));
}

/** Callbacks that work without being in the group: actions on payment records the user already has, language, and the
 * free-trial claim (it checks membership itself, live — so "✅ I've joined" on its screen isn't stopped by a stale cache). */
function gateFree(data) {
  return data === "noop" || data.startsWith("tuchk:") || data.startsWith("tux:") || data.startsWith("bnchk:") || data === "lang" || data.startsWith("ftok:");
}

/** Route a navigation target (callback data, deep link or command) to a screen. Returns { toast?, alert? }. */
async function route(env, s, user, nav, data) {
  const L = user.lang;
  if (data === "noop") return {};
  if (data === "home" || data === "menu") return show(env, nav, await screenHome(env, s, user));
  if (data === "shop") return show(env, nav, await screenShop(env, s, L));
  if (data === "licenses" || data === "tokens") return show(env, nav, await screenLicenses(env, s, user));
  if (data === "downloads") return show(env, nav, await screenDownloads(env, s, user));
  if (data === "profile" || data === "balance") return show(env, nav, await screenProfile(env, s, user));
  if (data === "support" || data === "help") return show(env, nav, await screenSupport(env, s, L));
  if (data === "lang" || data === "language" || data === "idioma") return show(env, nav, languageScreen(L));
  if (data === "free") return show(env, nav, await screenFree(env, s, user));
  if (data === "topup") return show(env, nav, await screenTopup(env, s, user));
  if (data === "bn" || data === "binance") return show(env, nav, await screenBinance(env, s, L));
  if (data === "np" || data === "nowpayments") return show(env, nav, screenNp(s, env, L));
  if (data === "np_paid") return npLatestFlow(env, s, user, nav);
  if (data === "sp" || data === "stripe") return show(env, nav, screenSp(s, env, L));
  if (data === "sp_paid") return spLatestFlow(env, s, user, nav);
  if (data === "bnp") {
    if (!binanceConfig(s, env).available) return show(env, nav, binanceUnavailable(s, L));
    await sendMessage(env, nav.chatId, e(t(L, "bn.prompt")), { reply_markup: { force_reply: true, input_field_placeholder: t(L, "bn.placeholder") } });
    return { toast: t(L, "bn.prompt_toast") };
  }
  if (data.startsWith("bnchk:")) return binanceRecheckFlow(env, s, user, nav, data.slice(6));

  if (data.startsWith("buy:")) return show(env, nav, await screenProduct(env, s, user, data.slice(4)));

  let m;
  // Free trial: ft:<pid> (confirm the choice), ftok:<pid> (claim)
  if ((m = /^ft:([a-z0-9_-]{1,32})$/.exec(data))) return show(env, nav, await screenFreeConfirm(env, s, user, m[1]));
  if ((m = /^ftok:([a-z0-9_-]{1,32})$/.exec(data))) return freeClaimFlow(env, s, user, nav, m[1]);

  if ((m = /^(days|confirm):([a-z0-9_-]{1,32}):(\d{1,4})$/.exec(data))) {
    const days = Number(m[3]);
    if (m[1] === "days") return show(env, nav, await screenConfirmPurchase(env, s, user, m[2], days));
    const screen = await doPurchase(env, s, user, m[2], days);
    const res = await show(env, nav, screen);
    // Group "New purchase!" post: after the receipt and after the button is answered; failures never touch the purchase.
    if (screen.feed) after(nav, () => postPurchaseFeed(env, s, screen.feed));
    return res;
  }

  // keypad: kp:<digits> (live edit), kpok:<digits> (confirm)
  if ((m = /^kp:(\d{0,12})$/.exec(data))) {
    const tc = topupConfig(s, env);
    let digits = m[1].replace(/^0+/, "");
    if (digits.length > KEYPAD_MAX_DIGITS || (digits && Number(digits) > tc.max)) {
      return { toast: t(L, "toast.max", { max: money(tc.max, s.currency_symbol) }) };
    }
    return show(env, nav, screenKeypad(s, env, digits, null, "kp", L));
  }
  if ((m = /^kpok:(\d{0,12})$/.exec(data))) {
    const tc = topupConfig(s, env);
    const amount = m[1] ? Number(m[1]) : 0;
    const err = amountError(tc, amount, s.currency_symbol, L);
    if (err) return { toast: err };
    return show(env, nav, screenConfirmTopup(s, env, amount, null, L));
  }

  // Stripe keypad (sk:/skok:), confirm (spc) and create (spn)
  if ((m = /^sk:(\d{0,12})$/.exec(data))) {
    const spc = spConfig(s, env);
    const digits = m[1].replace(/^0+/, "");
    if (digits.length > KEYPAD_MAX_DIGITS || (digits && Number(digits) > spc.max)) return { toast: t(L, "toast.max", { max: money(spc.max, s.currency_symbol) }) };
    return show(env, nav, screenKeypad(s, env, digits, null, "sp", L));
  }
  if ((m = /^skok:(\d{0,12})$/.exec(data))) {
    const err = spAmountError(spConfig(s, env), m[1] ? Number(m[1]) : 0, s.currency_symbol, L);
    if (err) return { toast: err.slice(0, 190) };
    return show(env, nav, screenConfirmSp(s, env, Number(m[1]), null, L));
  }
  if ((m = /^(spc|spn):(.+)$/.exec(data))) {
    const p = parseTopupData(m[2]);
    const spc = spConfig(s, env);
    if (!spc.available) return show(env, nav, spUnavailable(s, L));
    if (!p) return { toast: t(L, "toast.invalid_amount") };
    const err = spAmountError(spc, p.amount, s.currency_symbol, L);
    if (err) return show(env, nav, screenKeypad(s, env, "", err, "sp", L));
    if (m[1] === "spn") return createSpFlow(env, s, user, nav, p.amount, p.resume);
    return show(env, nav, screenConfirmSp(s, env, p.amount, p.resume, L));
  }

  // NOWPayments keypad (nk:/nkok:), confirm (npc) and create (npn)
  if ((m = /^nk:(\d{0,12})$/.exec(data))) {
    const npc = npConfig(s, env);
    const digits = m[1].replace(/^0+/, "");
    if (digits.length > KEYPAD_MAX_DIGITS || (digits && Number(digits) > npc.max)) return { toast: t(L, "toast.max", { max: money(npc.max, s.currency_symbol) }) };
    return show(env, nav, screenKeypad(s, env, digits, null, "np", L));
  }
  if ((m = /^nkok:(\d{0,12})$/.exec(data))) {
    const err = npAmountError(npConfig(s, env), m[1] ? Number(m[1]) : 0, s.currency_symbol, L);
    if (err) return { toast: err.slice(0, 190) };
    return show(env, nav, screenConfirmNp(s, env, Number(m[1]), null, L));
  }
  if ((m = /^(npc|npn):(.+)$/.exec(data))) {
    const p = parseTopupData(m[2]);
    const npc = npConfig(s, env);
    if (!npc.available) return show(env, nav, npUnavailable(s, L));
    if (!p) return { toast: t(L, "toast.invalid_amount") };
    const err = npAmountError(npc, p.amount, s.currency_symbol, L);
    if (err) return show(env, nav, screenKeypad(s, env, "", err, "np", L));
    if (m[1] === "npn") return createNpFlow(env, s, user, nav, p.amount, p.resume);
    return show(env, nav, screenConfirmNp(s, env, p.amount, p.resume, L));
  }

  // top-up confirm (tuc) / create invoice (tun); legacy "tu:<amount>" / "tu:custom"
  if (data === "tu:custom") return show(env, nav, screenKeypad(s, env, "", null, "kp", L));
  if ((m = /^(tuc|tun|tu):(.+)$/.exec(data))) {
    const p = parseTopupData(m[2]);
    const tc = topupConfig(s, env);
    if (!tc.available && p && npConfig(s, env).available) return route(env, s, user, nav, `npc:${m[2]}`); // OxaPay off → NOWPayments
    if (!tc.available && p && spConfig(s, env).available) return route(env, s, user, nav, `spc:${m[2]}`); // … or card
    if (!tc.available) return show(env, nav, unavailableTopup(s, L));
    if (!p) return { toast: t(L, "toast.invalid_amount") };
    const err = amountError(tc, p.amount, s.currency_symbol, L);
    if (err) return show(env, nav, screenKeypad(s, env, "", err, "kp", L));
    if (m[1] === "tun") return createInvoiceFlow(env, s, user, nav, p.amount, p.resume);
    return show(env, nav, screenConfirmTopup(s, env, p.amount, p.resume, L));
  }
  if (data.startsWith("tuchk:")) {
    nav.inPlace = true; // actions on the invoice card (a record) update that card itself
    return checkStatusFlow(env, s, user, nav, data.slice(6));
  }
  if (data.startsWith("tux:")) {
    nav.inPlace = true;
    const id = data.slice(4);
    const before = await env.DB.prepare("SELECT * FROM payments WHERE id=? AND telegram_user_id=?").bind(id, user.id).first();
    let ok;
    if (before?.provider === "stripe") {
      const r = await spCancel(env, s, before, user.id);
      if (r.action === "credited" || r.action === "duplicate") return { toast: t(L, "toast.already_completed") };
      ok = r.ok;
    } else ok = await cancelPayment(env, id, user.id);
    const pay = await env.DB.prepare("SELECT * FROM payments WHERE id=? AND telegram_user_id=?").bind(id, user.id).first();
    if (pay) await show(env, nav, invoiceCard(pay, s, supportLine(s, L), L));
    return { toast: ok ? t(L, "toast.canceled") : pay ? t(L, "toast.cant_cancel", { st: pay.status }) : t(L, "toast.pay_not_found") };
  }

  if (data.startsWith("dl:")) {
    const pid = data.slice(3);
    if (!env.FILES) return { toast: t(L, "dl.off_toast"), alert: true };
    const product = await getProduct(env, pid);
    if (!product || !product.file_key) return { toast: t(L, "dl.no_file"), alert: true };
    if (!(await hasActiveToken(env, user.id, pid))) return { toast: t(L, "dl.need_license"), alert: true };
    await answerCallback(env, nav.queryId, t(L, "dl.sending"));
    nav.answered = true;
    const r = await sendProductFile(env, nav.chatId, product);
    if (!r.ok) {
      await sendMessage(env, nav.chatId, t(L, "dl.failed", { support: supportLine(s, L) }), { reply_markup: kb([[HOME(L)]]) });
      await audit(env, `tg:${user.id}`, "download_failed", { product_id: pid, reason: r.reason });
    }
    return {};
  }

  return show(env, nav, await screenHome(env, s, user));
}

/* ───────────────────────── updates ───────────────────────── */

const LANG_CB = /^(lgs?):(pt|en)(?::([a-z0-9_]{1,40}))?$/;

async function handleCallback(env, query, s) {
  const data = query.data || "";
  const user = query.from;
  const chatId = query.message?.chat?.id;
  const nav = { chatId, messageId: query.message?.message_id, queryId: query.id, answered: false };
  let out = {};
  try {
    if (!chatId) return;
    await ensureUser(env, user);
    const L = user.lang;
    nav.lang = L;
    if (s.maintenance_mode === "1" && !isAdmin(env, user.id)) {
      out = { toast: `🛠 ${String(s.maintenance_text)}`.slice(0, 190), alert: true };
      return;
    }
    const priv = query.message?.chat?.type === "private";
    let m;
    if (priv && (m = LANG_CB.exec(data))) {
      // Language picked (first-contact picker or 🌐 screen) — allowed before the gate.
      out = (await langSetFlow(env, s, user, nav, m[2], m[3] || "", m[1] === "lg")) || {};
    } else if (priv && !user.langChosen) {
      // First contact: the bilingual language picker comes before everything else.
      await show(env, nav, firstLangScreen(DEEP_LINKS.has(data) ? data : ""));
    } else if (priv && (data === "jg" || data.startsWith("jg:"))) {
      out = (await joinedFlow(env, s, user, nav, data.slice(3))) || {};
    } else if (priv && !gateFree(data) && !(await canUseShop(env, s, user.id, { admin: isAdmin(env, user.id) }))) {
      // Community group required (src/group.js): show the invitation instead of the screen.
      await show(env, nav, joinPromptScreen(s, "", L));
      out = { toast: t(L, "gate.toast") };
    } else {
      out = (await route(env, s, user, nav, data)) || {};
    }
  } catch (err) {
    console.error("callback error", err && err.stack ? err.stack : err);
    out = { toast: t(user?.lang, "err.generic"), alert: true };
  } finally {
    // Always answer so the button spinner never hangs.
    if (!nav.answered) await answerCallback(env, query.id, out.toast, out.alert);
    await runAfter(nav);
  }
}

const DEEP_LINKS = new Set(["shop", "topup", "binance", "nowpayments", "np_paid", "stripe", "sp_paid", "licenses", "downloads", "profile", "support", "help", "home", "menu", "free", "lang"]);
const ADMIN_CMDS = ["/addbal", "/subbal", "/setbal", "/bal"];

async function handleCommand(env, message, s) {
  const text = message.text || "";
  const chatId = message.chat.id;
  const user = message.from;
  const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const admin = isAdmin(env, user.id);
  const nav = { chatId, messageId: null };
  // Persistent reply keyboard buttons send their label as text ("🛒 Shop" / "🛒 Loja"…). Matched exactly, so typed
  // amounts ("25") and the keypad flow are never confused with them.
  const kbTarget = !cmd.startsWith("/") && message.chat?.type === "private" ? keyboardTarget(text) : null;

  // The bot only talks in private chats. Once it is in the community group, commands sent there (e.g. /start@bot)
  // must not post menus, balances or licenses in the group.
  if (message.chat?.type !== "private") return;

  await ensureUser(env, user);
  const L = user.lang;
  nav.lang = L;

  if (s.maintenance_mode === "1" && !admin && cmd !== "/whoami") {
    if (cmd.startsWith("/") || kbTarget) await sendMessage(env, chatId, maintenanceText(s, L));
    return;
  }

  // First contact: bilingual language picker before anything else (even the group gate); the /start payload is kept
  // in the buttons and continued after the choice. /whoami and admin commands skip it.
  if (!user.langChosen && cmd !== "/whoami" && !ADMIN_CMDS.includes(cmd)) {
    await show(env, nav, firstLangScreen(cmd === "/start" ? (parseArgs(text)[0] || "").toLowerCase() : ""));
    if (kbTarget) await deleteMessageQuiet(env, chatId, message.message_id);
    return;
  }

  // 🌐 Language: available even before joining the group (the invitation then shows in the new language).
  if (cmd === "/language" || cmd === "/idioma" || cmd === "/lang") {
    await show(env, nav, languageScreen(L));
    return;
  }

  // Community group required (src/group.js): anything (even /start) shows the invitation until the user joins.
  // Admins are never blocked; /whoami stays available.
  if (cmd !== "/whoami" && gateActive(s) && !(await canUseShop(env, s, user.id, { admin }))) {
    await show(env, nav, joinPromptScreen(s, cmd === "/start" ? parseArgs(text)[0] || "" : "", L));
    if (kbTarget) await deleteMessageQuiet(env, chatId, message.message_id);
    return;
  }

  if (kbTarget) {
    await ensureKeyboard(env, nav);
    await route(env, s, user, nav, kbTarget);
    // Keep the chat clean: remove the button press itself ("🛒 Shop") now that its screen is below it.
    // Best effort — errors ignored (e.g. >48 h old, already deleted).
    await deleteMessageQuiet(env, chatId, message.message_id);
    return;
  }

  if (cmd === "/start") {
    await ensureKeyboard(env, nav, { force: true });
    // Deep links: t.me/<bot>?start=topup | shop | licenses | profile | support | free | topup_25 | buy_<pid>_<days>
    const payload = (parseArgs(text)[0] || "").toLowerCase();
    await startRoute(env, s, user, nav, payload);
    return;
  }

  if (cmd === "/menu" || cmd === "/home") {
    await ensureKeyboard(env, nav, { force: true });
    await show(env, nav, await screenHome(env, s, user));
    return;
  }

  if (["/shop", "/licenses", "/profile", "/support", "/help", "/downloads", "/free"].includes(cmd)) {
    await ensureKeyboard(env, nav);
    await route(env, s, user, nav, cmd.slice(1));
    return;
  }

  if (cmd === "/topup") {
    await ensureKeyboard(env, nav);
    const args = parseArgs(text);
    if (args.length) {
      const tc = topupConfig(s, env);
      const amount = parseAmount(args.join(" "));
      if (!tc.available && npConfig(s, env).available) return npTypedAmount(env, s, nav, amount, L);
      if (!tc.available && spConfig(s, env).available) return spTypedAmount(env, s, nav, amount, L);
      if (!tc.available) return show(env, nav, unavailableTopup(s, L));
      const err = amountError(tc, amount, s.currency_symbol, L);
      if (err) return show(env, nav, screenKeypad(s, env, "", err, "kp", L));
      return show(env, nav, screenConfirmTopup(s, env, amount, null, L));
    }
    await show(env, nav, await screenTopup(env, s, user));
    return;
  }

  if (cmd === "/binance") {
    await ensureKeyboard(env, nav);
    const args = parseArgs(text);
    if (args.length) return binanceClaimFlow(env, s, user, nav, args.join(""));
    await show(env, nav, await screenBinance(env, s, L));
    return;
  }

  if (cmd === "/whoami") {
    await sendMessage(env, chatId, t(L, "whoami", { id: user.id, username: e(user.username || "—") }));
    return;
  }

  // Admin commands (pt/en untouched: admin-only) — silent deny for non-admins
  if (ADMIN_CMDS.includes(cmd)) {
    if (!admin) return;
    const cur = s.currency_symbol;
    const args = parseArgs(text);

    if (cmd === "/bal") {
      if (!args.length) {
        await sendMessage(env, chatId, "Usage: /bal @username|user_id");
        return;
      }
      const row = await findUser(env, args[0]);
      if (!row) {
        await sendMessage(env, chatId, "User not found.");
        return;
      }
      await sendMessage(
        env,
        chatId,
        `@${e(row.username || "—")} (<code>${row.user_id}</code>)\nBalance: ${e(money(row.balance, cur))}`
      );
      return;
    }

    if (args.length < 2) {
      const usage =
        cmd === "/addbal"
          ? "Usage: /addbal @username|user_id amount\nExample: /addbal @user 50"
          : cmd === "/subbal"
            ? "Usage: /subbal @username|user_id amount\nExample: /subbal @user 10"
            : "Usage: /setbal @username|user_id amount\nExample: /setbal @user 100";
      await sendMessage(env, chatId, usage);
      return;
    }

    const amount = Number(args[1]);
    if (!Number.isFinite(amount)) {
      await sendMessage(env, chatId, "Amount must be a number.");
      return;
    }
    if (cmd === "/setbal") {
      if (amount < 0) {
        await sendMessage(env, chatId, "Amount cannot be negative.");
        return;
      }
    } else if (amount <= 0) {
      await sendMessage(env, chatId, "Amount must be positive.");
      return;
    }

    const row = await findUser(env, args[0]);
    if (!row) {
      await sendMessage(
        env,
        chatId,
        "User not found. They must /start the bot first, then use @username or id."
      );
      return;
    }
    const label = e(row.username || row.user_id);
    const actor = `tg:${user.id}`;
    if (cmd === "/addbal") {
      const r = await changeBalance(env, row.user_id, "add", amount, "admin_add", actor);
      await sendMessage(
        env,
        chatId,
        `Added ${e(money(amount, cur))} to @${label}.\nNew balance: ${e(money(r.balance, cur))}`
      );
    } else if (cmd === "/subbal") {
      const r = await changeBalance(env, row.user_id, "sub", amount, "admin_sub", actor);
      await sendMessage(
        env,
        chatId,
        `Removed ${e(money(amount, cur))} from @${label}.\nNew balance: ${e(money(r.balance, cur))}`
      );
    } else {
      const r = await changeBalance(env, row.user_id, "set", amount, "admin_set", actor);
      await sendMessage(env, chatId, `Set balance of @${label} to ${e(money(r.balance, cur))}.`);
    }
  }

  // Binance Pay transaction ID: a reply to the ID prompt, or a pasted long number (Binance Pay IDs are 12+ digits,
  // amounts are at most 7 digits, so the two never overlap).
  if (!cmd.startsWith("/") && message.chat?.type === "private") {
    const looksLikeTx = /^\d{12,32}$/.test(text.trim()) && binanceConfig(s, env).available;
    if (message._binanceReply || looksLikeTx) {
      await ensureKeyboard(env, nav);
      await binanceClaimFlow(env, s, user, nav, text);
      if (message._binancePromptId) await deleteMessageQuiet(env, chatId, message._binancePromptId);
      return;
    }
  }

  // Any other text: a typed number is a top-up amount; everything else shows the home card.
  if (!cmd.startsWith("/") && message.chat?.type === "private") {
    const amount = parseAmount(text);
    const tc = topupConfig(s, env);
    if (amount !== null && !tc.available && npConfig(s, env).available) {
      await ensureKeyboard(env, nav);
      return npTypedAmount(env, s, nav, amount, L);
    }
    if (amount !== null && !tc.available && spConfig(s, env).available) {
      await ensureKeyboard(env, nav);
      return spTypedAmount(env, s, nav, amount, L);
    }
    if (amount !== null && tc.available) {
      await ensureKeyboard(env, nav);
      const err = amountError(tc, amount, s.currency_symbol, L);
      if (err) return show(env, nav, screenKeypad(s, env, "", err, "kp", L));
      return show(env, nav, screenConfirmTopup(s, env, amount, null, L));
    }
    // Unrecognised text: the user may have lost the keyboard — re-attach it, then the home card below it.
    await ensureKeyboard(env, nav, { force: true });
    await show(env, nav, await screenHome(env, s, user));
  }
}

function npTypedAmount(env, s, nav, amount, L = "en") {
  const err = npAmountError(npConfig(s, env), amount, s.currency_symbol, L);
  if (err) return show(env, nav, screenKeypad(s, env, "", err, "np", L));
  return show(env, nav, screenConfirmNp(s, env, amount, null, L));
}

export async function handleTelegramUpdate(env, update) {
  try {
    const s = await getSettings(env);
    if (update.callback_query) {
      await handleCallback(env, update.callback_query, s);
      return;
    }
    // Community group: membership changes refresh the gate cache; the bot losing admin rights alerts the admins.
    if (update.chat_member) return void (await onChatMemberUpdate(env, s, update.chat_member));
    if (update.my_chat_member) return void (await onMyChatMember(env, s, update.my_chat_member));
    // Basic group upgraded to a supergroup: keep the configured chat id in sync.
    if (update.message?.migrate_to_chat_id) return void (await migrateGroup(env, s, update.message.chat?.id, update.message.migrate_to_chat_id));
    // Any incoming message in a private chat makes the current menu "not the latest" any more.
    if (update.message?.chat?.type === "private" && update.message.message_id) {
      await noteMessage(env, update.message.chat.id, update.message.message_id);
    }
    if (update.message && update.message.text && update.message.from) {
      const m = update.message;
      const replyTo = m.reply_to_message;
      // Legacy ForceReply prompt from older messages
      if (!m.text.startsWith("/") && replyTo?.from?.is_bot && String(replyTo.text || "").startsWith(TOPUP_PROMPT)) {
        m.reply_to_message = undefined;
      }
      // Reply to the Binance Pay "paste your transaction ID" prompt (ForceReply), in any language
      const prompt = String(replyTo?.text || "");
      if (!m.text.startsWith("/") && replyTo?.from?.is_bot && BINANCE_PROMPTS.some((p) => prompt.startsWith(p))) {
        m._binanceReply = true;
        m._binancePromptId = replyTo.message_id;
      }
      await handleCommand(env, m, s);
    }
  } catch (err) {
    console.error("Telegram handler error", err);
  }
}
