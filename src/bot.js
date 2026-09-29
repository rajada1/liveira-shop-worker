/* Telegram bot — button-driven UI (HTML parse mode). Products/prices/settings come from D1.
 * Navigation edits one message in place; new messages are only sent for events (/start, payments, files).
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
  HOW_IT_WORKS,
} from "./ui.js";

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

function priceRangeLabel(product, cur) {
  const vals = product.prices.map((p) => p.price);
  if (!vals.length) return "n/a";
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (lo === hi) return money(lo, cur);
  return `from ${money(lo, cur)}`;
}

function supportLine(s) {
  return s.support_contact ? `💬 Support: ${e(s.support_contact)}` : "💬 Contact the shop admin.";
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

async function ensureUser(env, userId, username) {
  await env.DB.prepare(
    `INSERT INTO users (user_id, username, balance, created_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET username=excluded.username`
  )
    .bind(userId, username || null, nowIso())
    .run();
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

function maintenanceText(s) {
  return `🛠 <b>Maintenance</b>\n\n${e(s.maintenance_text)}\n\n<i>We'll be back soon — thanks for your patience!</i>`;
}

/* ───────────────────────── screens ─────────────────────────
 * Each screen returns { text, reply_markup }. `nav` = { chatId, messageId } decides edit vs. send.
 */

async function screenHome(env, s, user) {
  const [bal, active] = await Promise.all([getBalance(env, user.id), activeLicenseCount(env, user.id)]);
  const cur = s.currency_symbol;
  const first = user.first_name || user.username || "there";
  const tc = topupConfig(s, env);
  let text = `👋 Hi, <b>${e(first)}</b>! Welcome to <b>${e(s.shop_name)}</b>.\n\n`;
  if (String(s.welcome_text || "").trim()) text += `<blockquote>${e(s.welcome_text)}</blockquote>\n\n`;
  text += `💰 Balance: <b>${e(money(bal, cur))}</b>\n`;
  text += `🔑 Active licenses: <b>${active}</b>`;
  if (bal <= 0 && tc.available) text += "\n\n<i>Tip: tap 💰 Top up to add funds with crypto — it's credited automatically.</i>";
  return {
    text,
    reply_markup: kb([
      [btn("🛒 Shop", "shop", "primary"), btn("💰 Top up", "topup", "success")],
      [btn("🔑 My licenses", "licenses"), btn("📥 Downloads", "downloads")],
      [btn("👤 Profile", "profile"), btn("💬 Support", "support")],
    ]),
  };
}

async function screenShop(env, s) {
  const cur = s.currency_symbol;
  const products = (await listProducts(env, { activeOnly: true })).filter((p) => p.prices.length);
  if (!products.length) {
    return {
      text: "🛒 <b>Shop</b>\n\nThe shop is empty right now — please check back soon!",
      reply_markup: kb([navRow("home")]),
    };
  }
  const lines = ["🛒 <b>Shop</b>\n", "Pick a product:\n"];
  const rows = [];
  for (const p of products) {
    const label = priceRangeLabel(p, cur);
    lines.push(`🔹 <b>${e(p.name)}</b> — ${e(label)}`);
    rows.push([btn(`🔹 ${p.name} · ${label}`.slice(0, 64), `buy:${p.id}`)]);
  }
  rows.push(navRow("home"));
  return { text: lines.join("\n"), reply_markup: kb(rows) };
}

async function screenProduct(env, s, user, pid) {
  const cur = s.currency_symbol;
  const product = await getProduct(env, pid);
  if (!product || !product.active || !product.prices.length) {
    return { text: "😕 This product is not available anymore.", reply_markup: kb([navRow("shop")]) };
  }
  const bal = await getBalance(env, user.id);
  const text =
    `🔹 <b>${e(product.name)}</b>\n\n` +
    (product.description ? `<blockquote expandable>${e(product.description)}</blockquote>\n\n` : "") +
    `💰 Your balance: <b>${e(money(bal, cur))}</b>\n\n` +
    "Choose a duration:";
  const buttons = product.prices.map((pr) =>
    btn(`${formatDuration(pr.days)} · ${money(pr.price, cur)}`, `days:${pid}:${pr.days}`)
  );
  return { text, reply_markup: kb([...grid(buttons, 2), navRow("shop")]) };
}

/** Amount to top up for a shortfall: exact missing amount (rounded up to cents), at least the minimum. */
function shortfallAmount(missing, tc) {
  const up = Math.ceil(round2(missing) * 100 - 1e-6) / 100;
  return Math.min(tc.max, Math.max(tc.min, up));
}

function shortfallBlock(s, env, bal, price, pid, days) {
  const cur = s.currency_symbol;
  const missing = round2(price - bal);
  const tc = topupConfig(s, env);
  let text = `\n\n⚠️ <b>Not enough balance.</b>\nYou have ${e(money(bal, cur))} — missing <b>${e(money(missing, cur))}</b>.`;
  const rows = [];
  if (tc.available) {
    const amt = shortfallAmount(missing, tc);
    rows.push([btn(`💰 Top up ${money(amt, cur)}`, `tuc:${amt}:${pid}:${days}`, "success")]);
    rows.push([btn("💰 Other amount", "topup")]);
    text += "\nTop up with crypto in one tap — you can continue this purchase right after the payment is confirmed.";
  } else {
    text += `\n${supportLine(s)}`;
  }
  return { text, rows };
}

async function screenConfirmPurchase(env, s, user, pid, days) {
  const cur = s.currency_symbol;
  const product = await getProduct(env, pid);
  if (!product || !product.active) return { text: "😕 This product is not available anymore.", reply_markup: kb([navRow("shop")]) };
  const pr = product.prices.find((x) => x.days === days);
  if (!pr) return { text: "😕 This duration is not available anymore.", reply_markup: kb([navRow(`buy:${pid}`)]) };
  const bal = await getBalance(env, user.id);
  let text =
    "🧾 <b>Confirm purchase</b>\n\n" +
    `Product: <b>${e(product.name)}</b>\n` +
    `Duration: <b>${formatDuration(days)}</b>\n` +
    `Price: <b>${e(money(pr.price, cur))}</b>\n` +
    `Balance: ${e(money(bal, cur))}`;
  const rows = [];
  if (bal + 1e-9 >= pr.price) {
    text += ` → after purchase <b>${e(money(round2(bal - pr.price), cur))}</b>`;
    rows.push([btn(`✅ Confirm · ${money(pr.price, cur)}`, `confirm:${pid}:${days}`, "success")]);
  } else {
    const sf = shortfallBlock(s, env, bal, pr.price, pid, days);
    text += sf.text;
    rows.push(...sf.rows);
  }
  rows.push(navRow(`buy:${pid}`));
  return { text, reply_markup: kb(rows) };
}

async function doPurchase(env, s, user, pid, days) {
  const cur = s.currency_symbol;
  const product = await getProduct(env, pid);
  if (!product || !product.active) return { text: "😕 This product is not available anymore.", reply_markup: kb([navRow("shop")]) };
  const pr = product.prices.find((x) => x.days === days);
  if (!pr) return { text: "😕 This duration is not available anymore.", reply_markup: kb([navRow(`buy:${pid}`)]) };
  const price = pr.price;

  // Atomic conditional debit (prevents overspending on double taps).
  const debit = await env.DB.prepare("UPDATE users SET balance = balance - ? WHERE user_id=? AND balance >= ?")
    .bind(price, user.id, price)
    .run();
  if (!debit.meta || debit.meta.changes !== 1) {
    const bal = await getBalance(env, user.id);
    const sf = shortfallBlock(s, env, bal, price, pid, days);
    return {
      text: `🧾 <b>${e(product.name)}</b> · ${formatDuration(days)} · ${e(money(price, cur))}` + sf.text,
      reply_markup: kb([...sf.rows, navRow(`buy:${pid}`)]),
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
    return { text: "⚠️ Something went wrong. Your balance was not charged — please try again.", reply_markup: kb([navRow("shop")]) };
  }

  const newBal = await getBalance(env, user.id);
  const rows = [[copyBtn("📋 Copy license key", token)]];
  const second = [];
  if (product.file_key && env.FILES) second.push(btn("📥 Download", `dl:${product.id}`, "primary"));
  second.push(btn("🔑 My licenses", "licenses"));
  rows.push(second);
  rows.push([HOME()]);
  return {
    text:
      "✅ <b>Purchase successful!</b>\n\n" +
      `Product: <b>${e(product.name)}</b>\n` +
      `Duration: <b>${formatDuration(days)}</b>\n` +
      `Expires: <b>${e(fmtDateTimeBrt(expiresAt))}</b>\n\n` +
      `🔑 Your license key (tap to copy):\n<code>${e(token)}</code>\n\n` +
      `💰 New balance: ${e(money(newBal, cur))}\n\n` +
      "<i>Enter this key in the Liveira program to unlock access.</i>",
    reply_markup: kb(rows),
    toast: "✅ Purchase successful!",
  };
}

async function screenLicenses(env, s, user) {
  const { results } = await env.DB.prepare(
    `SELECT product_name, token, expires_at, status FROM tokens
      WHERE telegram_user_id=? ORDER BY created_at DESC LIMIT 20`
  )
    .bind(user.id)
    .all();
  const list = results || [];
  if (!list.length) {
    return {
      text: "🔑 <b>My licenses</b>\n\nNo licenses yet — visit the 🛒 Shop to get your first one!",
      reply_markup: kb([[btn("🛒 Shop", "shop", "primary")], navRow("home")]),
    };
  }
  const now = Date.now();
  const state = (r) =>
    r.status === "revoked" ? "revoked" : r.status !== "active" || !(Date.parse(r.expires_at) > now) ? "expired" : "active";
  list.sort((a, b) => (state(b) === "active") - (state(a) === "active")); // active first, stable
  const lines = ["🔑 <b>My licenses</b>\n"];
  const copyRows = [];
  for (const r of list) {
    const st = state(r);
    const emoji = st === "active" ? "🟢" : st === "revoked" ? "⛔" : "🔴";
    const info =
      st === "active"
        ? `${daysLeftLabel(r.expires_at)} · until ${fmtShortBrt(r.expires_at)}`
        : st === "revoked"
          ? "revoked"
          : `expired ${fmtShortBrt(r.expires_at)}`;
    lines.push(`${emoji} <b>${e(r.product_name)}</b> — ${e(info)}\n<code>${e(r.token)}</code>\n`);
    if (st === "active" && copyRows.length < 3) {
      copyRows.push([copyBtn(`📋 Copy · ${r.product_name} …${String(r.token).slice(-4)}`.slice(0, 64), r.token)]);
    }
  }
  lines.push("<i>Tap a key to copy it. Times in BRT.</i>");
  return {
    text: lines.join("\n"),
    reply_markup: kb([...copyRows, [btn("📥 Downloads", "downloads"), btn("🛒 Shop", "shop")], navRow("home")]),
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
  if (!env.FILES) {
    return {
      text: "📥 <b>Downloads</b>\n\nDownloads are not available right now.\nYour license key works in the Liveira program.\n\n" + supportLine(s),
      reply_markup: kb([navRow("home")]),
    };
  }
  const items = await activeDownloads(env, user.id);
  if (!items.length) {
    return {
      text: "📥 <b>Downloads</b>\n\nNo downloads yet.\nFiles unlock for products you own with an <b>active</b> license — visit the 🛒 Shop.",
      reply_markup: kb([[btn("🛒 Shop", "shop", "primary"), btn("🔑 My licenses", "licenses")], navRow("home")]),
    };
  }
  const rows = items.map((it) => [
    btn(`📥 ${it.name}${it.file_size ? ` · ${formatSize(it.file_size)}` : ""}`.slice(0, 64), `dl:${it.id}`, "primary"),
  ]);
  rows.push([btn("🔑 My licenses", "licenses")], navRow("home"));
  return { text: "📥 <b>Downloads</b>\n\nTap a product to receive its file here:", reply_markup: kb(rows) };
}

const METHOD_LABEL = {
  oxapay: "crypto top-up",
  admin_add: "credit",
  panel_add: "credit",
  admin_sub: "adjustment",
  panel_sub: "adjustment",
  admin_set: "adjustment",
  panel_set: "adjustment",
};

async function screenProfile(env, s, user) {
  const cur = s.currency_symbol;
  const [u, tops, ords, active] = await Promise.all([
    env.DB.prepare("SELECT balance, created_at FROM users WHERE user_id=?").bind(user.id).first(),
    env.DB.prepare("SELECT amount, method, created_at FROM topups WHERE user_id=? ORDER BY id DESC LIMIT 5").bind(user.id).all(),
    env.DB.prepare("SELECT product_name, duration_days, price, created_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 5")
      .bind(user.id)
      .all(),
    activeLicenseCount(env, user.id),
  ]);
  let text =
    "👤 <b>Profile</b>\n\n" +
    `ID: <code>${user.id}</code>${user.username ? ` · @${e(user.username)}` : ""}\n` +
    `💰 Balance: <b>${e(money(u?.balance || 0, cur))}</b>\n` +
    `🔑 Active licenses: <b>${active}</b>\n`;
  const t = tops.results || [];
  text += "\n<b>Recent top-ups</b>\n";
  text += t.length
    ? t
        .map((x) => `• ${fmtShortBrt(x.created_at)} · ${x.amount >= 0 ? "+" : "−"}${e(money(Math.abs(x.amount), cur))} · ${e(METHOD_LABEL[x.method] || x.method)}`)
        .join("\n")
    : "<i>No top-ups yet.</i>";
  const o = ords.results || [];
  text += "\n\n<b>Recent purchases</b>\n";
  text += o.length
    ? o.map((x) => `• ${fmtShortBrt(x.created_at)} · ${e(x.product_name)} · ${formatDuration(x.duration_days || 0)} · ${e(money(x.price, cur))}`).join("\n")
    : "<i>No purchases yet.</i>";
  text += "\n\n<i>Times in BRT.</i>";
  return {
    text,
    reply_markup: kb([[btn("💰 Top up", "topup", "success"), btn("🔑 My licenses", "licenses")], navRow("home")]),
  };
}

async function screenSupport(env, s) {
  const url = supportUrl(s);
  const tc = topupConfig(s, env);
  let text = "💬 <b>Support</b>\n\n";
  text += s.support_contact ? `Need help? Contact us: <b>${e(s.support_contact)}</b>\n\n` : "Need help? Contact the shop admin.\n\n";
  text +=
    "<blockquote expandable><b>Quick guide</b>\n" +
    (tc.available
      ? "1. 💰 <b>Top up</b> your balance with crypto — it's credited automatically.\n"
      : "1. Ask the admin to credit your balance.\n") +
    "2. 🛒 Open the <b>Shop</b>, pick a product and a duration, confirm.\n" +
    "3. 🔑 You get a <b>license key</b> — enter it in the Liveira program.\n" +
    "4. 📥 Products with a file can be downloaded in <b>Downloads</b> while your license is active.</blockquote>";
  const rows = [];
  if (url) rows.push([urlBtn("💬 Message support", url, "primary")]);
  rows.push(navRow("home"));
  return { text, reply_markup: kb(rows) };
}

/* ─── top-up screens ─── */

function unavailableTopup(s) {
  return {
    text: `💰 <b>Top up</b>\n\nCrypto top-up is currently unavailable.\n\n${supportLine(s)}`,
    reply_markup: kb([navRow("home")]),
  };
}

async function screenTopup(env, s, user) {
  const tc = topupConfig(s, env);
  if (!tc.available) return unavailableTopup(s);
  const cur = s.currency_symbol;
  const bal = await getBalance(env, user.id);
  const presetBtns = tc.presets.map((a) => btn(money(a, cur).replace(/\.00$/, ""), `tuc:${a}`, "primary"));
  return {
    text:
      "💰 <b>Top up balance</b>\n\n" +
      `Current balance: <b>${e(money(bal, cur))}</b>\n\n` +
      `Choose an amount (min ${e(money(tc.min, cur))}, max ${e(money(tc.max, cur))}):\n\n` +
      HOW_IT_WORKS.replace("1. Tap <b>💳 Pay now</b> and choose", "1. Pick an amount, tap <b>💳 Pay now</b> and choose"),
    reply_markup: kb([...grid(presetBtns, presetBtns.length === 4 ? 2 : 3), [btn("✏️ Other amount", "kp:")], navRow("home")]),
  };
}

function screenKeypad(s, env, digits, note) {
  const tc = topupConfig(s, env);
  if (!tc.available) return unavailableTopup(s);
  const cur = s.currency_symbol;
  const shown = digits ? Number(digits).toLocaleString("en-US") : "0";
  const valid = digits && Number(digits) >= tc.min && Number(digits) <= tc.max;
  const text =
    "✏️ <b>Other amount</b>\n\n" +
    `<b>💵 ${e(cur)} ${e(shown)}</b>${digits ? "" : " ▏"}\n\n` +
    `Min ${e(money(tc.min, cur))} · Max ${e(money(tc.max, cur))}\n` +
    (note ? `\n⚠️ ${e(note)}\n` : "") +
    "\n<i>Tap the digits, then ✅. You can also just type a number.</i>";
  const d = (n) => btn(String(n), `kp:${digits}${n}`);
  return {
    text,
    reply_markup: kb([
      [d(1), d(2), d(3)],
      [d(4), d(5), d(6)],
      [d(7), d(8), d(9)],
      [btn("⌫", `kp:${digits.slice(0, -1)}`), d(0), btn("✅", `kpok:${digits}`, valid ? "success" : undefined)],
      navRow("topup"),
    ]),
  };
}

function screenConfirmTopup(s, env, amount, resume) {
  const tc = topupConfig(s, env);
  if (!tc.available) return unavailableTopup(s);
  const cur = s.currency_symbol;
  const suffix = resume ? `:${resume.pid}:${resume.days}` : "";
  return {
    text:
      "💰 <b>Confirm top-up</b>\n\n" +
      `Amount: <b>${e(money(amount, cur))}</b>\n` +
      "Pay with: <b>any crypto</b> via OxaPay\n" +
      `Invoice valid for: <b>${INVOICE_LIFETIME_MIN} min</b>\n` +
      (resume ? "\n🛒 After the payment is confirmed you can continue your purchase in one tap.\n" : "") +
      "\n<i>Your balance is credited automatically once the payment is confirmed.</i>",
    reply_markup: kb([
      [btn(`✅ Create invoice · ${money(amount, cur)}`, `tun:${amount}${suffix}`, "success")],
      [btn("✏️ Change amount", "topup")],
      [HOME()],
    ]),
  };
}

function parseTopupData(rest) {
  // "<amount>" or "<amount>:<pid>:<days>"
  const m = /^(\d{1,7}(?:\.\d{1,2})?)(?::([a-z0-9_-]{1,32}):(\d{1,4}))?$/.exec(rest);
  if (!m) return null;
  return { amount: round2(m[1]), resume: m[2] ? { pid: m[2], days: Number(m[3]) } : null };
}

function amountError(tc, amount, cur) {
  if (amount === null || !Number.isFinite(amount)) return "Please enter a valid amount.";
  if (amount < tc.min) return `Minimum is ${money(tc.min, cur)}.`;
  if (amount > tc.max) return `Maximum is ${money(tc.max, cur)}.`;
  return null;
}

async function createInvoiceFlow(env, s, user, nav, amount, resume) {
  const tc = topupConfig(s, env);
  if (!tc.available) return show(env, nav, unavailableTopup(s));
  const errMsg = amountError(tc, amount, s.currency_symbol);
  if (errMsg) return show(env, nav, screenKeypad(s, env, "", errMsg));
  const r = await createTopupInvoice(env, {
    userId: user.id,
    chatId: nav.chatId,
    amount,
    shopName: s.shop_name,
    resume: resume ? `${resume.pid}:${resume.days}` : null,
  });
  if (!r.ok) {
    const msg =
      r.reason === "too_many"
        ? "🧾 You already have several open invoices. Please pay one of them or wait until they expire."
        : r.reason === "unconfigured"
          ? "Crypto top-up is currently unavailable."
          : "⚠️ Could not create the payment right now. Please try again in a minute.";
    return show(env, nav, { text: `💰 <b>Top up</b>\n\n${msg}\n\n${supportLine(s)}`, reply_markup: kb([navRow("topup")]) });
  }
  const card = invoiceCard(r.payment, s, supportLine(s));
  const res = await show(env, nav, card);
  if (res?.message_id) await setPaymentMessage(env, r.payment.id, nav.chatId, res.message_id);
  return { ...res, toast: r.reused ? "Your open invoice for this amount" : "🧾 Invoice created" };
}

async function checkStatusFlow(env, s, user, nav, id) {
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE id=? AND telegram_user_id=?").bind(id, user.id).first();
  if (!pay) return show(env, nav, { text: "😕 Payment not found.", reply_markup: kb([navRow("home")]) });
  if (nav.messageId && pay.message_id !== nav.messageId) await setPaymentMessage(env, pay.id, nav.chatId, nav.messageId);
  if (pay.credited) {
    const bal = await getBalance(env, user.id);
    await show(env, nav, paidCard(pay, s, bal));
    return { toast: "✅ Already paid and credited" };
  }
  let toast = null;
  if (pay.track_id && !["error", "refunded"].includes(pay.status)) {
    const r = await syncPayment(env, { ...pay, message_id: nav.messageId || pay.message_id }, "user_check");
    if (r.action === "credited") return { toast: "✅ Payment confirmed!" };
    if (r.action === "duplicate") return { toast: "✅ Already paid and credited" };
    if (r.action === "api_error") toast = "Couldn't reach the payment provider — try again in a moment.";
  }
  const fresh = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(id).first();
  await show(env, nav, invoiceCard(fresh, s, supportLine(s)));
  const labels = {
    pending: "🟡 Not paid yet — waiting for your payment",
    paying: "🔵 Payment detected — waiting for confirmations",
    expired: "⌛ This invoice has expired",
    canceled: "❌ Invoice canceled",
    underpaid: "🟠 Underpaid — please contact support",
  };
  return { toast: toast || labels[fresh.status] || `Status: ${fresh.status}` };
}

/* ─── routing helpers ─── */

async function show(env, nav, screen) {
  const res = await editOrSend(env, nav.chatId, nav.messageId, screen.text, { reply_markup: screen.reply_markup });
  return { message_id: res.message_id, toast: screen.toast };
}

async function answerCallback(env, id, text, alert) {
  try {
    return await tgApi(env, "answerCallbackQuery", {
      callback_query_id: id,
      text: text ? String(text).slice(0, 200) : undefined,
      show_alert: alert || undefined,
    });
  } catch (err) {
    console.error("answerCallbackQuery failed", err);
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

/** Route a navigation target (callback data, deep link or command) to a screen. Returns { toast?, alert? }. */
async function route(env, s, user, nav, data) {
  if (data === "noop") return {};
  if (data === "home" || data === "menu") return show(env, nav, await screenHome(env, s, user));
  if (data === "shop") return show(env, nav, await screenShop(env, s));
  if (data === "licenses" || data === "tokens") return show(env, nav, await screenLicenses(env, s, user));
  if (data === "downloads") return show(env, nav, await screenDownloads(env, s, user));
  if (data === "profile" || data === "balance") return show(env, nav, await screenProfile(env, s, user));
  if (data === "support" || data === "help") return show(env, nav, await screenSupport(env, s));
  if (data === "topup") return show(env, nav, await screenTopup(env, s, user));

  if (data.startsWith("buy:")) return show(env, nav, await screenProduct(env, s, user, data.slice(4)));

  let m;
  if ((m = /^(days|confirm):([a-z0-9_-]{1,32}):(\d{1,4})$/.exec(data))) {
    const days = Number(m[3]);
    if (m[1] === "days") return show(env, nav, await screenConfirmPurchase(env, s, user, m[2], days));
    return show(env, nav, await doPurchase(env, s, user, m[2], days));
  }

  // keypad: kp:<digits> (live edit), kpok:<digits> (confirm)
  if ((m = /^kp:(\d{0,12})$/.exec(data))) {
    const tc = topupConfig(s, env);
    let digits = m[1].replace(/^0+/, "");
    if (digits.length > KEYPAD_MAX_DIGITS || (digits && Number(digits) > tc.max)) {
      return { toast: `Maximum is ${money(tc.max, s.currency_symbol)}` };
    }
    return show(env, nav, screenKeypad(s, env, digits));
  }
  if ((m = /^kpok:(\d{0,12})$/.exec(data))) {
    const tc = topupConfig(s, env);
    const amount = m[1] ? Number(m[1]) : 0;
    const err = amountError(tc, amount, s.currency_symbol);
    if (err) return { toast: err };
    return show(env, nav, screenConfirmTopup(s, env, amount, null));
  }

  // top-up confirm (tuc) / create invoice (tun); legacy "tu:<amount>" / "tu:custom"
  if (data === "tu:custom") return show(env, nav, screenKeypad(s, env, ""));
  if ((m = /^(tuc|tun|tu):(.+)$/.exec(data))) {
    const p = parseTopupData(m[2]);
    const tc = topupConfig(s, env);
    if (!tc.available) return show(env, nav, unavailableTopup(s));
    if (!p) return { toast: "Invalid amount" };
    const err = amountError(tc, p.amount, s.currency_symbol);
    if (err) return show(env, nav, screenKeypad(s, env, "", err));
    if (m[1] === "tun") return createInvoiceFlow(env, s, user, nav, p.amount, p.resume);
    return show(env, nav, screenConfirmTopup(s, env, p.amount, p.resume));
  }
  if (data.startsWith("tuchk:")) return checkStatusFlow(env, s, user, nav, data.slice(6));
  if (data.startsWith("tux:")) {
    const id = data.slice(4);
    const ok = await cancelPayment(env, id, user.id);
    const pay = await env.DB.prepare("SELECT * FROM payments WHERE id=? AND telegram_user_id=?").bind(id, user.id).first();
    if (pay) await show(env, nav, invoiceCard(pay, s, supportLine(s)));
    return { toast: ok ? "Invoice canceled" : pay ? `Can't cancel — status: ${pay.status}` : "Payment not found" };
  }

  if (data.startsWith("dl:")) {
    const pid = data.slice(3);
    if (!env.FILES) return { toast: "Downloads are not available right now.", alert: true };
    const product = await getProduct(env, pid);
    if (!product || !product.file_key) return { toast: "No file for this product.", alert: true };
    if (!(await hasActiveToken(env, user.id, pid))) return { toast: "You need an active license for this product.", alert: true };
    await answerCallback(env, nav.queryId, "📥 Sending file…");
    nav.answered = true;
    const r = await sendProductFile(env, nav.chatId, product);
    if (!r.ok) {
      await sendMessage(env, nav.chatId, `⚠️ Could not send the file right now. ${supportLine(s)}`, { reply_markup: kb([[HOME()]]) });
      await audit(env, `tg:${user.id}`, "download_failed", { product_id: pid, reason: r.reason });
    }
    return {};
  }

  return show(env, nav, await screenHome(env, s, user));
}

/* ───────────────────────── updates ───────────────────────── */

async function handleCallback(env, query, s) {
  const data = query.data || "";
  const user = query.from;
  const chatId = query.message?.chat?.id;
  const nav = { chatId, messageId: query.message?.message_id, queryId: query.id, answered: false };
  let out = {};
  try {
    if (!chatId) return;
    if (s.maintenance_mode === "1" && !isAdmin(env, user.id)) {
      out = { toast: `🛠 ${String(s.maintenance_text)}`.slice(0, 190), alert: true };
      return;
    }
    await ensureUser(env, user.id, user.username);
    out = (await route(env, s, user, nav, data)) || {};
  } catch (err) {
    console.error("callback error", err && err.stack ? err.stack : err);
    out = { toast: "⚠️ Something went wrong. Please try again.", alert: true };
  } finally {
    // Always answer so the button spinner never hangs.
    if (!nav.answered) await answerCallback(env, query.id, out.toast, out.alert);
  }
}

const DEEP_LINKS = new Set(["shop", "topup", "licenses", "downloads", "profile", "support", "help", "home", "menu"]);

async function handleCommand(env, message, s) {
  const text = message.text || "";
  const chatId = message.chat.id;
  const user = message.from;
  const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const admin = isAdmin(env, user.id);
  const nav = { chatId, messageId: null };

  if (s.maintenance_mode === "1" && !admin && cmd !== "/whoami") {
    if (cmd.startsWith("/")) await sendMessage(env, chatId, maintenanceText(s));
    return;
  }

  if (cmd === "/start") {
    await ensureUser(env, user.id, user.username);
    // Deep links: t.me/<bot>?start=topup | shop | licenses | profile | support | topup_25
    const payload = (parseArgs(text)[0] || "").toLowerCase();
    let m;
    if ((m = /^topup_(\d{1,7})$/.exec(payload))) return route(env, s, user, nav, `tuc:${m[1]}`);
    if (DEEP_LINKS.has(payload)) return route(env, s, user, nav, payload);
    await show(env, nav, await screenHome(env, s, user));
    return;
  }

  if (cmd === "/menu" || cmd === "/home") {
    await ensureUser(env, user.id, user.username);
    await show(env, nav, await screenHome(env, s, user));
    return;
  }

  if (["/shop", "/licenses", "/profile", "/support", "/help", "/downloads"].includes(cmd)) {
    await ensureUser(env, user.id, user.username);
    await route(env, s, user, nav, cmd.slice(1));
    return;
  }

  if (cmd === "/topup") {
    await ensureUser(env, user.id, user.username);
    const args = parseArgs(text);
    if (args.length) {
      const tc = topupConfig(s, env);
      const amount = parseAmount(args.join(" "));
      if (!tc.available) return show(env, nav, unavailableTopup(s));
      const err = amountError(tc, amount, s.currency_symbol);
      if (err) return show(env, nav, screenKeypad(s, env, "", err));
      return show(env, nav, screenConfirmTopup(s, env, amount, null));
    }
    await show(env, nav, await screenTopup(env, s, user));
    return;
  }

  if (cmd === "/whoami") {
    await ensureUser(env, user.id, user.username);
    await sendMessage(
      env,
      chatId,
      `Your Telegram ID: <code>${user.id}</code>\nUsername: @${e(user.username || "—")}`
    );
    return;
  }

  // Admin commands — silent deny for non-admins
  if (["/addbal", "/subbal", "/setbal", "/bal"].includes(cmd)) {
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

  // Any other text: a typed number is a top-up amount; everything else shows the home card.
  if (!cmd.startsWith("/") && message.chat?.type === "private") {
    await ensureUser(env, user.id, user.username);
    const amount = parseAmount(text);
    const tc = topupConfig(s, env);
    if (amount !== null && tc.available) {
      const err = amountError(tc, amount, s.currency_symbol);
      if (err) return show(env, nav, screenKeypad(s, env, "", err));
      return show(env, nav, screenConfirmTopup(s, env, amount, null));
    }
    await show(env, nav, await screenHome(env, s, user));
  }
}

export async function handleTelegramUpdate(env, update) {
  try {
    const s = await getSettings(env);
    if (update.callback_query) {
      await handleCallback(env, update.callback_query, s);
      return;
    }
    if (update.message && update.message.text && update.message.from) {
      const m = update.message;
      const replyTo = m.reply_to_message;
      // Legacy ForceReply prompt from older messages
      if (!m.text.startsWith("/") && replyTo?.from?.is_bot && String(replyTo.text || "").startsWith(TOPUP_PROMPT)) {
        m.reply_to_message = undefined;
      }
      await handleCommand(env, m, s);
    }
  } catch (err) {
    console.error("Telegram handler error", err);
  }
}
