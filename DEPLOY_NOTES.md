# Deploy notes (owner)

## Release: Binance Pay top-ups (auto-verified) — 2026-10-04

The customer taps **💰 Top up → 🟡 Binance Pay**, sends USDT via Binance Pay to the Pay ID (setting `binance_pay_id`,
default `290455535`), then pastes the transaction ID (reply to the prompt, plain paste of the number, or `/binance <id>`).
The Worker looks the ID up in the shop's own Binance Pay history (`GET /sapi/v1/pay/transactions`, read-only key, HMAC-SHA256)
and credits the **amount actually received**, 1 USDT = $1. Code: `src/binance.js`.

Rules: exact `transactionId`; amount > 0 (incoming); `orderType` C2C or PAY; currency in `binance_currencies` (default USDT);
receiver ids (Pay ID `accountId` / UID `binanceId`) must include the configured Pay ID, otherwise → **review**; above
`binance_max` (default $1000) → **review** (admin: Pagamentos → "Aprovar e creditar"). Each ID can be claimed by one account
only (`payments.track_id = 'binance:<txid>'` UNIQUE) and is credited exactly once (nonce batch, `topups.method='binance'`,
`audit_log` `binance_credit`, notice to `ADMIN_IDS`). Not found yet → claim stays pending; the **cron (every minute)**
re-checks for 30 min, then marks it expired (the user can tap 🔄 Check again later). Per user: 1 check / 20 s, 10 / hour.
The Binance history is cached in D1 and fetched at most every 45 s (`BINANCE_CACHE_TTL_SEC`); 451/429/418/403/5xx/auth
errors set a backoff (shown in Configurações → Recarga via Binance Pay).

**Without the secrets `BINANCE_API_KEY` / `BINANCE_API_SECRET` the option is hidden** (bot, cron and panel do nothing).
To enable it later (values are piped, never printed):

```bash
BINANCE_API_KEY=… BINANCE_API_SECRET=… bash scripts/put-binance-secrets.sh   # uses CLOUDFLARE_STORE_TOKEN if CLOUDFLARE_API_TOKEN is unset
```

Key: Binance → Profile → API Management → Create API → System generated, **only "Enable Reading"**, no IP restriction
(Workers have no fixed IPs). Then panel → Configurações → "Testar conexão com a Binance".

Steps for this release: (1) `npx wrangler d1 execute liveira-shop --remote --file migrations/0007_binance.sql`
(idempotent: new tables `binance_tx`, `binance_state`, `binance_checks`, index, default settings); (2) `npx wrangler deploy`
(adds the cron trigger `* * * * *`; bindings unchanged). Tests: `bash tests/bot/run.sh` (fake Binance, plus a second local
instance without the secrets).

Notes / caveats: if a cross-bot setup ever verifies the same Binance account from another bot (@LiveiraStore_bot), the
duplicate protection is per database — don't auto-verify the same account in both bots. Binance answers 451 from
restricted regions (e.g. US IPs); Cloudflare runs the request near Telegram's webhook servers (EU), and the cron may run
elsewhere — a 451 only pauses checks for 10 min, the claim stays pending.

---

## Previous release: reply keyboard / navigation

This release adds the persistent reply keyboard and "the active screen follows the user" navigation,
on top of the USDT-only top-ups. Nothing here was deployed or applied automatically — do the steps below yourself.

## 0. Before you deploy — bindings and out-of-repo changes

`wrangler.toml` in this repo declares **three bindings**:

| binding | type |
|---|---|
| `DB` | D1 database `liveira-shop` |
| `FILES` | R2 bucket for product files |
| `CHASE_FILES` | R2 bucket `cf-chase-files` (kept as on the live Worker) |

`wrangler deploy` replaces the Worker's code **and its binding list** with what is in the repo. Any binding you
added yourself (dashboard or another project) that is not in `wrangler.toml` **will be removed** by the deploy,
and any code you uploaded outside this repo will be replaced. So, before deploying:

1. Add every binding of your own to `wrangler.toml` (same `binding` name and target as today).
2. Merge any code you changed outside the repo into this repo first.
3. Check with a dry run: `npx wrangler deploy --dry-run` lists the bindings that will be deployed.

`CHASE_FILES` (R2 `cf-chase-files`) was added on the live Worker outside this repo and is now declared in
`wrangler.toml` (2026-09-30), so deploys keep it.

Secrets (`BOT_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_*`, `SESSION_SECRET`, `TOKEN_API_KEY`, `OXAPAY_MERCHANT_KEY`) are
kept across deploys; nothing new is required.

## 1. Apply migration 0006 (new table, safe to run any time)

```bash
npx wrangler d1 execute liveira-shop --remote --file migrations/0006_chat_nav.sql
```

`CREATE TABLE IF NOT EXISTS chat_nav …` — stores, per private chat, the current menu message, the latest message
id and the reply-keyboard message. Until it exists the bot keeps working with the previous edit-in-place behaviour.

## 2. Deploy

```bash
npm ci
bash tests/bot/run.sh        # optional: local test suite (fake Telegram/OxaPay, local D1) — expect all PASS
npx wrangler deploy
```

## 3. Apply migration 0005 (after the deploy)

Only its **second statement** is still pending in production (the `accepted_currencies` row already exists), but
the whole file is idempotent, so running it completely is fine:

```bash
npx wrangler d1 execute liveira-shop --remote --file migrations/0005_accepted_currencies.sql
```

It changes the welcome text to the `{coins}` version **only if it still equals the previous default**. Run it
after the deploy: older code would show `{coins}` literally.

If `wrangler d1 execute --remote` fails with an authentication/permission error, paste the SQL of the file into
the D1 console in the Cloudflare dashboard instead (one statement at a time).

## 4. Bot setup (commands, menu button, descriptions)

Admin panel → **Configurações** → **Configurar comandos/descrição** (calls `POST /admin/api/bot/setup`).
This updates the command list, the menu button and the description/short description (now "Pay with USDT").
It does not message any user.

## 5. Check

- `https://<worker>/health` → `{"ok":true}`
- Admin panel → Configurações → Webhook: status OK, no last error.
- Admin panel → Configurações → "Verificar moedas na OxaPay": OxaPay and bot settings both `USDT`.
- In Telegram, send `/start` to the bot: a small "menu is pinned below" message with the keyboard
  (🛒 Shop · 💰 Top up / 🔑 My licenses · 📥 Downloads / 👤 Profile · 💬 Support) appears, then the home card.
  Tapping a keyboard button opens that screen at the bottom and removes the previous menu message.

Rollback if needed: `npx wrangler deployments list`, then `npx wrangler rollback <version-id>`. The migrations are
additive and can stay.

## How the navigation works (for reference)

- Tapping a button on the **current menu while it is the latest message** edits it in place (as before).
- Tapping an **older** message, using the reply keyboard, a command or typing: the screen is sent fresh at the
  bottom and the previous menu message is deleted (errors ignored — Telegram can't delete messages older than 48 h).
- **Records are never deleted or reused as menus:** invoice cards, purchase receipts (license key), files and
  payment notifications. Buttons on an invoice card (Check status / Cancel) still update that card.
- The keyboard is sent on `/start`, `/menu` and unrecognised text, and re-sent automatically if a chat never got it
  or got an older layout (`REPLY_KB_VERSION` in `src/ui.js`).
- Admin broadcasts record the delivered message ids with **one** batched D1 write per batch (not one per
  message), so the next tap after a broadcast moves the menu below it.
- Reply-keyboard button presses ("🛒 Shop"…) are deleted after their screen is sent (best effort; commands and
  typed text are kept).
- Rapid double taps: the menu id is claimed with a compare-and-set on `chat_nav.menu_msg_id`; the request that
  loses deletes the duplicate, so only one menu stays at the bottom. No new migration.
- `/menu` is in the command list (run step 4 again after deploying to publish it).
