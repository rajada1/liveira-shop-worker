/* Telegram bot (HTML parse mode). Products/prices/settings come from D1. */
import {
  nowIso,
  isExpired,
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

const TG_UPLOAD_LIMIT = 50 * 1024 * 1024; // Bot API sendDocument upload limit

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

function formatDuration(days) {
  return Number(days) === 1 ? "1 day" : `${days} days`;
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return "no expiry";
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return expiresAt;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())} UTC`;
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

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Shop", callback_data: "shop" }],
      [{ text: "Balance", callback_data: "balance" }],
      [{ text: "My tokens", callback_data: "tokens" }],
      [{ text: "Downloads", callback_data: "downloads" }],
      [{ text: "Help", callback_data: "help" }],
    ],
  };
}

function backMenuKeyboard(cb = "menu") {
  return { inline_keyboard: [[{ text: "Back", callback_data: cb }]] };
}

function supportLine(s) {
  return s.support_contact ? `Support: ${e(s.support_contact)}` : "Contact the shop admin.";
}

async function sendMessage(env, chatId, text, extra = {}) {
  return tgApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function editMessage(env, chatId, messageId, text, extra = {}) {
  const res = await tgApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
  // If the source message can't be edited (e.g. it's a document), send a new one.
  if (!res.ok && !/not modified/i.test(res.description || "")) {
    return sendMessage(env, chatId, text, extra);
  }
  return res;
}

async function answerCallback(env, callbackQueryId, text = "", showAlert = false) {
  return tgApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || undefined,
    show_alert: showAlert || undefined,
  });
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

function welcomeText(s) {
  return (
    `Welcome to <b>${e(s.shop_name)}</b>!\n\n` +
    `${e(s.welcome_text)}\n\n` +
    "Choose an option below:"
  );
}

async function handleCommand(env, message, s) {
  const text = message.text || "";
  const chatId = message.chat.id;
  const user = message.from;
  const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const admin = isAdmin(env, user.id);

  if (s.maintenance_mode === "1" && !admin && cmd !== "/whoami") {
    if (cmd.startsWith("/")) await sendMessage(env, chatId, e(s.maintenance_text));
    return;
  }

  if (cmd === "/start") {
    await ensureUser(env, user.id, user.username);
    await sendMessage(env, chatId, welcomeText(s), { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (cmd === "/menu") {
    await ensureUser(env, user.id, user.username);
    await sendMessage(env, chatId, "Main menu:", { reply_markup: mainMenuKeyboard() });
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

async function handleCallback(env, query, s) {
  const data = query.data || "";
  const user = query.from;
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const cur = s.currency_symbol;
  if (!chatId) {
    await answerCallback(env, query.id);
    return;
  }

  if (s.maintenance_mode === "1" && !isAdmin(env, user.id)) {
    await answerCallback(env, query.id, String(s.maintenance_text).slice(0, 190), true);
    return;
  }

  // "dl:" answers the callback itself (to show progress/errors).
  if (!data.startsWith("dl:")) await answerCallback(env, query.id);
  await ensureUser(env, user.id, user.username);

  if (data === "menu") {
    await editMessage(env, chatId, messageId, "Main menu:", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data === "balance") {
    const bal = await getBalance(env, user.id);
    await editMessage(
      env,
      chatId,
      messageId,
      `Your balance: <b>${e(money(bal, cur))}</b>\n\nTo top up: ${supportLine(s)}`,
      { reply_markup: backMenuKeyboard("menu") }
    );
    return;
  }

  if (data === "help") {
    await editMessage(
      env,
      chatId,
      messageId,
      `<b>${e(s.shop_name)} — Help</b>\n\n` +
        "1. Ask the admin to credit your balance.\n" +
        "2. Open <b>Shop</b>, pick a product and duration, confirm.\n" +
        "3. You receive an <b>access token</b>. Enter it in the program to unlock access.\n" +
        "4. Products with a file can be downloaded in <b>Downloads</b> while your token is active.\n\n" +
        supportLine(s),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "My tokens", callback_data: "tokens" }],
            [{ text: "Shop", callback_data: "shop" }],
            [{ text: "Back", callback_data: "menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data === "shop") {
    const products = (await listProducts(env, { activeOnly: true })).filter((p) => p.prices.length);
    const rows = [];
    let text;
    if (!products.length) {
      text = "No products available right now.";
    } else {
      const lines = ["Shop — tap a product to buy:\n"];
      for (const p of products) {
        const label = priceRangeLabel(p, cur);
        lines.push(`• <b>${e(p.name)}</b> — ${e(label)}`);
        rows.push([{ text: `${p.name} — ${label}`.slice(0, 60), callback_data: `buy:${p.id}` }]);
      }
      text = lines.join("\n");
    }
    rows.push([{ text: "Back", callback_data: "menu" }]);
    await editMessage(env, chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
    return;
  }

  if (data.startsWith("buy:")) {
    const pid = data.slice(4);
    const product = await getProduct(env, pid);
    if (!product || !product.active || !product.prices.length) {
      await editMessage(env, chatId, messageId, "Product not found.", {
        reply_markup: backMenuKeyboard("shop"),
      });
      return;
    }
    const rows = product.prices.map((pr) => [
      {
        text: `${formatDuration(pr.days)} — ${money(pr.price, cur)}`,
        callback_data: `days:${pid}:${pr.days}`,
      },
    ]);
    rows.push([{ text: "Back", callback_data: "shop" }]);
    await editMessage(
      env,
      chatId,
      messageId,
      `<b>${e(product.name)}</b>\n\n${e(product.description)}\n\nChoose duration:`,
      { reply_markup: { inline_keyboard: rows } }
    );
    return;
  }

  if (data.startsWith("days:") || data.startsWith("confirm:")) {
    const parts = data.split(":");
    const isConfirm = parts[0] === "confirm";
    if (parts.length !== 3) {
      await sendMessage(env, chatId, "Invalid selection.");
      return;
    }
    const pid = parts[1];
    const days = Number(parts[2]);
    const product = await getProduct(env, pid);
    if (!product || !product.active) {
      await editMessage(env, chatId, messageId, "Product not found.", {
        reply_markup: backMenuKeyboard("shop"),
      });
      return;
    }
    const pr = product.prices.find((x) => x.days === days);
    if (!pr) {
      await editMessage(env, chatId, messageId, "Duration not available.", {
        reply_markup: backMenuKeyboard(`buy:${pid}`),
      });
      return;
    }
    const price = pr.price;

    if (!isConfirm) {
      await editMessage(
        env,
        chatId,
        messageId,
        `<b>${e(product.name)}</b>\n` +
          `Duration: <b>${formatDuration(days)}</b>\n` +
          `Price: <b>${e(money(price, cur))}</b>\n\n` +
          `${e(product.description)}\n\n` +
          "Confirm purchase?",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Confirm", callback_data: `confirm:${pid}:${days}` }],
              [{ text: "Cancel", callback_data: `buy:${pid}` }],
            ],
          },
        }
      );
      return;
    }

    // Atomic conditional debit (prevents overspending on double taps).
    const debit = await env.DB.prepare(
      "UPDATE users SET balance = balance - ? WHERE user_id=? AND balance >= ?"
    )
      .bind(price, user.id, price)
      .run();
    if (!debit.meta || debit.meta.changes !== 1) {
      const bal = await getBalance(env, user.id);
      await editMessage(
        env,
        chatId,
        messageId,
        `Insufficient balance.\nYou have ${e(money(bal, cur))}, this costs ${e(money(price, cur))}.\n${supportLine(s)}`,
        { reply_markup: backMenuKeyboard("shop") }
      );
      return;
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
      await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE user_id=?")
        .bind(price, user.id)
        .run();
      await sendMessage(env, chatId, "Something went wrong. Your balance was not charged.");
      return;
    }

    const newBal = await getBalance(env, user.id);
    const kb = [[{ text: "My tokens", callback_data: "tokens" }]];
    if (product.file_key && env.FILES) kb.push([{ text: "Download file", callback_data: `dl:${product.id}` }]);
    kb.push([{ text: "Menu", callback_data: "menu" }]);
    await editMessage(
      env,
      chatId,
      messageId,
      "Purchase successful!\n\n" +
        `Product: <b>${e(product.name)}</b>\n` +
        `Your access token:\n<code>${e(token)}</code>\n` +
        `Valid for: <b>${formatDuration(days)}</b>\n` +
        `Expires: <code>${formatExpiry(expiresAt)}</code>\n\n` +
        `New balance: ${e(money(newBal, cur))}\n\n` +
        "<i>Use this token in the Liveira program to unlock access.</i>",
      { reply_markup: { inline_keyboard: kb } }
    );
    return;
  }

  if (data === "tokens") {
    const { results } = await env.DB.prepare(
      `SELECT product_name, token, expires_at, status FROM tokens
        WHERE telegram_user_id=? ORDER BY created_at DESC LIMIT 20`
    )
      .bind(user.id)
      .all();
    let text;
    if (!results || !results.length) {
      text = "You have no tokens yet. Buy something in the Shop.";
    } else {
      const lines = ["Your tokens:\n"];
      for (const r of results) {
        const status =
          r.status === "revoked" ? "REVOKED" : r.status !== "active" || isExpired(r.expires_at) ? "EXPIRED" : "ACTIVE";
        lines.push(
          `• <b>${e(r.product_name)}</b> — ${status}\n<code>${e(r.token)}</code>\nExpires: <code>${e(formatExpiry(r.expires_at))}</code>\n`
        );
      }
      text = lines.join("\n");
    }
    await editMessage(env, chatId, messageId, text, { reply_markup: backMenuKeyboard("menu") });
    return;
  }

  if (data === "downloads") {
    if (!env.FILES) {
      await editMessage(
        env,
        chatId,
        messageId,
        "Downloads are not available right now.\n\nYour access token works in the Liveira program.\n" + supportLine(s),
        { reply_markup: backMenuKeyboard("menu") }
      );
      return;
    }
    const items = await activeDownloads(env, user.id);
    const rows = items.map((it) => [
      {
        text: `${it.name}${it.file_size ? ` (${formatSize(it.file_size)})` : ""}`.slice(0, 60),
        callback_data: `dl:${it.id}`,
      },
    ]);
    rows.push([{ text: "My tokens", callback_data: "tokens" }]);
    rows.push([{ text: "Back", callback_data: "menu" }]);
    const text = items.length
      ? "Downloads — tap a product to receive its file:"
      : "No downloads available.\n\nFiles are available for products you own with an <b>active</b> token.";
    await editMessage(env, chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
    return;
  }

  if (data.startsWith("dl:")) {
    const pid = data.slice(3);
    if (!env.FILES) {
      await answerCallback(env, query.id, "Downloads are not available right now.", true);
      return;
    }
    const product = await getProduct(env, pid);
    if (!product || !product.file_key) {
      await answerCallback(env, query.id, "No file for this product.", true);
      return;
    }
    if (!(await hasActiveToken(env, user.id, pid))) {
      await answerCallback(env, query.id, "You need an active token for this product.", true);
      return;
    }
    await answerCallback(env, query.id, "Sending file…");
    const r = await sendProductFile(env, chatId, product);
    if (!r.ok) {
      await sendMessage(env, chatId, `Could not send the file right now. ${supportLine(s)}`);
      await audit(env, `tg:${user.id}`, "download_failed", { product_id: pid, reason: r.reason });
    }
    return;
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
      await handleCommand(env, update.message, s);
    }
  } catch (err) {
    console.error("Telegram handler error", err);
  }
}
