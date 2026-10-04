# Deploy notes (owner)

## Release: Stripe card top-ups (Checkout, USD) — 2026-10-04

The customer taps **💰 Top up → 💳 Pay by card (Stripe)** (also "💳 Pay by card instead (Stripe)" on the OxaPay confirm
screen, a "💳 Pay $X by card" row on the not-enough-balance screen, and typed amounts / `/topup <amount>` when OxaPay and
NOWPayments are both off), picks a preset or types a USD amount, confirms, and gets a **Stripe Checkout Session**
(`POST /v1/checkout/sessions`, `mode=payment`, `payment_method_types[0]=card`, one line item "Wallet top-up" in **USD**,
`client_reference_id` + `metadata` = our top-up id `sp_…` and the Telegram user id (copied to the PaymentIntent),
success → `t.me/<bot>?start=sp_paid`, cancel → `?start=topup`, `expires_at` = +60 min, `Idempotency-Key`). API version
pinned to `2024-06-20` (requests and webhook endpoint). Code: `src/stripe.js`; tables `stripe_sessions`, `stripe_events`
(migration `0010_stripe.sql`, idempotent). USD presentment verified live on the BR account (real $5 session created and
expired via the panel test, 2026-10-04).

**Limits:** `stripe_min` (default $5) … `stripe_max` (default $500), also bounded by `topup_min` / `topup_max`; at most 5 open
invoices/sessions per user per hour (all providers); an open same-amount session (> 15 min left) is reused. ❌ Cancel first
expires the session at Stripe (so it can't be paid any more); if Stripe refuses because it was already paid, the session is
synced and credited instead.

**Webhook** `POST /stripe/webhook` — endpoint **`we_1UMoUeAdfCVAa0YUnqDpVlgK`** (created via the API, id kept in setting
`stripe_webhook_id`; signing secret = Worker secret `STRIPE_WEBHOOK_SECRET`, copy in gitignored `stripe_webhook_secret.txt`,
mode 600). Events: `checkout.session.completed`, `…async_payment_succeeded`, `…async_payment_failed`, `…expired`,
`charge.refunded`, `charge.dispute.created`. `Stripe-Signature` = HMAC-SHA256(`<t>.<raw body>`), any `v1`, |now − t| ≤ 300 s,
else **400**. Each event id is stored once (`stripe_events`): repeats → 200 "duplicate"; a delivery that fails (e.g. Stripe
API down) is un-recorded and answered 500 so Stripe retries. Sessions of *other* integrations on the same Stripe account
(e.g. the `cf-chase-key-server` endpoint) arrive too and are ignored quietly (audit `stripe_event_unmatched`).

**Crediting:** never from the webhook body — the session is re-read (`GET /v1/checkout/sessions/{id}?expand[]=payment_intent`)
and must be `status=complete`, `payment_status=paid`, our `client_reference_id`, currency `usd` and `amount_total` = the
top-up in cents → credit the **requested USD amount** exactly once (nonce batch, `topups.method='stripe'`, audit
`stripe_credit`, customer + admin notices). Different amount → **review** (not credited, admins told once).
`complete` + `unpaid` (delayed methods only) → "paying"; `async_payment_failed` → failed (+ notices); `expired` → expired.

**Fallback cron (every minute):** re-reads up to 5 open/complete-but-unpaid sessions with no news for 2 min (created < 2 days,
not credited/flagged); sessions close at Stripe after 60 min, the cron sees `expired` and stops. 🔄 Check status in the bot
and "Sincronizar" in the panel force a re-read.

**Refunds / disputes (choice):** admins always get a prominent 🚨 notice (amount, reason, evidence deadline for disputes).
The refunded + disputed USD amount (capped at the top-up) is **deducted from the wallet only if the balance covers the whole
difference**; otherwise nothing is deducted and the amount is recorded as `unrecovered_usd` ("NÃO recuperado" in the panel)
for the admin to decide (the customer may already have spent it on licenses). State-based, so repeated/partial refund events
only deduct the difference (`topups.method='stripe_refund'`, audit `stripe_debit` / `stripe_unrecovered`). The customer is
told about refund deductions, not about disputes. A dispute later *won* is not re-credited automatically (not subscribed to
`charge.dispute.closed`) — re-credit manually if you win.

Panel (Configurações → "Recarga com cartão (Stripe)"): on/off, min/max, "Testar conexão com a Stripe" (account country /
currency / charges / payouts + webhook status and events), "Testar checkout" (real min-amount USD session, expired at once).
Pagamentos shows "Cartão (Stripe)" with session state, refunds, disputes, deducted / not-recovered amounts; search by
`cs_…`, `pi_…`, `ch_…`, `dp_…`.

Secrets (piped, never printed): `printf '%s' "$STRIPE_SECRET_KEY" | npx wrangler secret put STRIPE_SECRET_KEY` and
`npx wrangler secret put STRIPE_WEBHOOK_SECRET < stripe_webhook_secret.txt`. Without both the option is hidden and the
webhook answers 503. Steps for this release (all done 2026-10-04): migration 0010 remote → STRIPE_SECRET_KEY → deploy →
create the webhook endpoint → STRIPE_WEBHOOK_SECRET → `stripe_webhook_id` setting.

## Release: NOWPayments top-ups (hosted invoice, any coin) — 2026-10-04

The customer taps **💰 Top up → 🪙 Pay with crypto (NOWPayments)** (also offered as "🪙 Other coins via NOWPayments" on the
OxaPay confirm screen, and used automatically for typed amounts / `/topup <amount>` when OxaPay is off), picks a preset
or types a USD amount, confirms, and gets a **hosted NOWPayments invoice** (`POST /v1/invoice`, `price_currency=usd`,
`order_id=np_…` unique per top-up, `ipn_callback_url` = **`https://liveira-shop.kelumayou.workers.dev/nowpayments/ipn`**,
success/partial → `t.me/<bot>?start=np_paid`, cancel → `?start=topup`). On the NOWPayments page the customer chooses the
coin and network. Code: `src/nowpayments.js`; table `np_payments` (migration `0009_nowpayments.sql`, idempotent).

**Minimum:** `max(topup_min, nowpayments_min)`; `nowpayments_min` empty = automatic: `GET /v1/min-amount` with
`fiat_equivalent=usd` and `currency_to=usdttrc20` (payout; override with var `NOWPAYMENTS_PAYOUT_CURRENCY`) for usdttrc20/usdtbsc/ltc/trx, the highest × 1.1, rounded up (cached 6 h, refreshed by the cron;
fallback $15 until the first refresh). Live on 2026-10-04 that is **$14**. Presets = the minimum + the regular presets above it.
Max = `topup_max`. At most 5 open NOWPayments invoices per user per hour; an open same-amount invoice without payments is reused.

**IPN** (`POST /nowpayments/ipn`): `x-nowpayments-sig` must equal HMAC-SHA512 (hex) of the JSON body with keys sorted
recursively, key = `NOWPAYMENTS_IPN_SECRET` → otherwise 401. Matched by `order_id` (+ invoice id must match). Each
`payment_id` is stored in `np_payments`. Crediting rules:
- only `finished`, and only after re-reading `GET /v1/payment/{id}` with the API key (defense in depth; the API answer wins);
- `price_amount`/`price_currency` must equal the invoice (USD ±0.01) and `actually_paid ≥ 98 % of pay_amount` → credit
  **the invoice USD amount** (`price_amount`). Paid less (finished with < 98 %) or price mismatch → **review**, no credit, admins
  notified (if it's fine, adjust the user's balance manually in the panel / `/addbal`). Overpaid > 102 % → credited the invoice amount, admins told about the extra.
- `partially_paid` → status **underpaid**, no credit, customer + admins notified (customer can pay the rest on the same page;
  a later `finished` credits normally).
- `failed` / `refunded` → status failed/refunded + notices; `expired` → expired (unless another payment on the invoice is active);
  `confirming/confirmed/sending` → "paying"; `waiting` → only stored.
- exactly once per top-up: nonce batch (`topups.method='nowpayments'`, `audit_log` `nowpayments_credit`, `np_payments.credited=1`);
  repeated / concurrent IPNs are no-ops; a second finished payment on an already credited invoice → flagged for admins, not credited.
- unknown `order_id` → 200 "ok" + audit `nowpayments_ipn_unmatched` (so NOWPayments stops retrying).

**Fallback cron (every minute):** refreshes the minimum; re-polls up to 5 known payments (`np_payments`) without news for
3 min (created < 3 days ago, not credited/flagged) through the same idempotent path; marks invoices pending > 24 h as expired
(a late `finished` IPN still credits). 5 failed polls → status `unknown`. 🔄 Check status in the bot and "Sincronizar" in the panel
force a poll. Limitation: a payment that never sent *any* IPN has no known `payment_id` (listing by invoice needs the
dashboard JWT login) — it's credited once any IPN arrives, or manually.

Panel (Configurações → "Recarga via NOWPayments"): enable/disable, minimum (empty = automatic), "Testar conexão",
"Criar fatura de teste (valor mínimo)" (real invoice for the first ADMIN_IDS user, no Telegram message; don't pay it).
Pagamentos shows provider "NOWPayments" with coin/paid info and the invoice link.

Secrets (piped, never printed):
```bash
printf '%s' "$NOWPAYMENTS_API_KEY"   | npx wrangler secret put NOWPAYMENTS_API_KEY
printf '%s' "$NOWPAYMENTS_IPN_SECRET" | npx wrangler secret put NOWPAYMENTS_IPN_SECRET
```
Without them the option is hidden and the IPN route answers 503.
Steps for this release: (1) secrets; (2) `npx wrangler d1 execute liveira-shop --remote --file migrations/0009_nowpayments.sql`;
(3) `npx wrangler deploy` (bindings and cron unchanged). All applied 2026-10-04.

NOWPayments dashboard to-dos: payout wallet/currency (Store settings → payout), keep the IPN secret matching the Worker secret
(regenerating it there requires updating the Worker secret), optional IPN URL above (it's also sent per invoice), and
fiat/card on-ramp if wanted (see report).

## Release: Binance Pay top-ups (auto-verified) — 2026-10-04

The customer taps **💰 Top up → 🟡 Binance Pay**, sends USDT via Binance Pay to the Pay ID (setting `binance_pay_id`,
default `290455535`), then pastes the transaction ID (reply to the prompt, plain paste of the number, or `/binance <id>`).
The Worker looks the ID up in the shop's own Binance Pay history (`GET /sapi/v1/pay/transactions`, read-only key, HMAC-SHA256)
and credits the **amount actually received**, 1 USDT = $1. Code: `src/binance.js`.

Rules: exact `transactionId` **or** `orderId` (the Binance app shows the Order ID; claims are re-keyed to the canonical
`transactionId` before crediting, so both forms of one transfer can't be credited twice); amount > 0 (incoming); `orderType` C2C or PAY; currency in `binance_currencies` (default USDT);
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

### Binance egress (2026-10-04) — why there is a second Worker
Live test: from the main Worker, Binance answered **451** (request ran in IAD/US). Cloudflare egress IPs geolocate as US even
from non-US data centers: `api.binance.com` / `api1-4` answered **403** (CloudFront geo-block) even from Tokyo (NRT).
The official alternate endpoint **`api-gcp.binance.com`** accepts requests from a non-US data center (still 451 from IAD).
So Binance calls go through **`liveira-shop-binance-egress`** (`egress/`): pinned with `[placement] region = "aws:ap-northeast-1"`
(runs in NRT), forwards only `GET /sapi/v1/pay/transactions`, `/sapi/v1/account/apiRestrictions`, `/api/v3/time` to
`api-gcp.binance.com`, no workers.dev URL / routes (reachable only via the service binding `BINANCE_EGRESS`), stores no
secrets (the main Worker signs and passes `X-MBX-APIKEY`). Deploy it **before** the main Worker (needs wrangler ≥ 4 with
Node 20 → 4.80.0):
```
cd egress && CLOUDFLARE_API_TOKEN="$CLOUDFLARE_STORE_TOKEN" CLOUDFLARE_ACCOUNT_ID=0d3330f1cc9f7a3f2f18afba43570277 npx -y wrangler@4.80.0 deploy
```
Diagnostics (admin only, privacy-safe): `POST /admin/api/binance/diag` → egress colo, API key restrictions (booleans), and the
*shape* of recent Pay history (field names/kinds, counts, where the Pay ID appears) — no payer data.
Verified live shapes: `transactionId` = 18-char string with underscore (`A_A99…`), `orderId` = different 18-digit number,
`amount` decimal string, negative for outgoing; `orderType` C2C; the Pay ID 290455535 is the account UID (`uid`, and
`payerInfo.binanceId` on outgoing → `receiverInfo.binanceId` on incoming); `receiverInfo.accountId` is a different number.
Migration `0008_binance_order_id.sql` (adds `binance_tx.order_id`, not idempotent) — applied remotely 2026-10-04.

Notes / caveats: if a cross-bot setup ever verifies the same Binance account from another bot (@LiveiraStore_bot), the
duplicate protection is per database — don't auto-verify the same account in both bots. Binance answers 451 from
restricted regions (e.g. US IPs) — that's why calls go through the Tokyo egress Worker above; if Binance ever answers
451/403 again, checks pause for 10 min and the claim stays pending.

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
