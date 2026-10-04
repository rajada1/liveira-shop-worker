#!/usr/bin/env bash
# Local end-to-end test: fresh local D1, fake OxaPay/Binance/Telegram on :9911, wrangler dev on :8799
# (+ a second instance on :8798 without the Binance secrets).
set -euo pipefail
cd "$(dirname "$0")/../.."
T=/tmp/lvtest; rm -rf $T/state $T/state2; mkdir -p $T; : > $T/fake.log
if [ ! -f .dev.vars ]; then
  cat > .dev.vars <<'V'
BOT_TOKEN=123:fake
ADMIN_IDS=1
TOKEN_API_KEY=tk_local
ADMIN_PASSWORD=pw_local
SESSION_SECRET=ss_local_secret
WEBHOOK_SECRET=whs_local
OXAPAY_MERCHANT_KEY=local_test_merchant_key
OXAPAY_API_BASE=http://127.0.0.1:9911/v1
TELEGRAM_API_BASE=http://127.0.0.1:9911
V
fi
# Fake Binance (local only). Appended to an existing .dev.vars if missing.
grep -q '^BINANCE_API_BASE=' .dev.vars || cat >> .dev.vars <<'V'
BINANCE_API_KEY=bn_test_key
BINANCE_API_SECRET=bn_test_secret
BINANCE_API_BASE=http://127.0.0.1:9911
BINANCE_CACHE_TTL_SEC=1
V
# Fake NOWPayments (local only). Appended to an existing .dev.vars if missing.
grep -q '^NOWPAYMENTS_API_BASE=' .dev.vars || cat >> .dev.vars <<'V'
NOWPAYMENTS_API_KEY=np_test_key
NOWPAYMENTS_IPN_SECRET=np_test_ipn_secret_0123456789abcd
NOWPAYMENTS_API_BASE=http://127.0.0.1:9911/np/v1
V
# Fake Stripe (local only, test-mode key). Appended to an existing .dev.vars if missing.
grep -q '^STRIPE_API_BASE=' .dev.vars || cat >> .dev.vars <<'V'
STRIPE_SECRET_KEY=sk_test_local_fake
STRIPE_WEBHOOK_SECRET=whsec_test_local_0123456789abcdef
STRIPE_API_BASE=http://127.0.0.1:9911/stripe/v1
V
grep -v -E '^(BINANCE_API_(KEY|SECRET)|NOWPAYMENTS_(API_KEY|IPN_SECRET)|STRIPE_(SECRET_KEY|WEBHOOK_SECRET))=' .dev.vars > tests/bot/nosecrets/.dev.vars
MIGS="tests/bot/base_schema.sql migrations/0002_admin_panel.sql migrations/0003_oxapay.sql migrations/0004_bot_ux.sql migrations/0005_accepted_currencies.sql migrations/0006_chat_nav.sql migrations/0007_binance.sql migrations/0008_binance_order_id.sql migrations/0009_nowpayments.sql migrations/0010_stripe.sql"
for st in state state2; do
  for f in $MIGS; do
    env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute liveira-shop --local --persist-to $T/$st --file $f >/dev/null 2>&1
  done
done
# 0007 / 0009 / 0010 are idempotent: a second run must not fail
env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute liveira-shop --local --persist-to $T/state --file migrations/0007_binance.sql >/dev/null 2>&1
env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute liveira-shop --local --persist-to $T/state --file migrations/0009_nowpayments.sql >/dev/null
env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute liveira-shop --local --persist-to $T/state --file migrations/0010_stripe.sql >/dev/null
if curl -s -o /dev/null http://127.0.0.1:8799/health || curl -s -o /dev/null http://127.0.0.1:8798/health || curl -s -o /dev/null http://127.0.0.1:9911/; then
  echo "ports 8798/8799/9911 already in use — stop the previous run first"; exit 1
fi
setsid python3 tests/bot/fake.py & FAKE=$!
setsid env -u CLOUDFLARE_API_TOKEN npx wrangler dev --local --persist-to $T/state --port 8799 --ip 127.0.0.1 --test-scheduled > $T/dev.log 2>&1 & DEV=$!
setsid env -u CLOUDFLARE_API_TOKEN npx wrangler dev --config tests/bot/nosecrets/wrangler.toml --local --persist-to $T/state2 --port 8798 --ip 127.0.0.1 --inspector-port 9231 --test-scheduled > $T/dev2.log 2>&1 & DEV2=$!
trap 'kill -- -$FAKE -$DEV -$DEV2 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf http://127.0.0.1:8799/health >/dev/null && curl -sf http://127.0.0.1:8798/health >/dev/null && break; sleep 0.5; done
python3 tests/bot/test.py
