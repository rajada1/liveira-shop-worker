#!/usr/bin/env bash
# Local end-to-end test: fresh local D1, fake OxaPay/Telegram on :9911, wrangler dev on :8799.
set -euo pipefail
cd "$(dirname "$0")/../.."
T=/tmp/lvtest; rm -rf $T/state; mkdir -p $T; : > $T/fake.log
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
for f in tests/bot/base_schema.sql migrations/0002_admin_panel.sql migrations/0003_oxapay.sql migrations/0004_bot_ux.sql migrations/0005_accepted_currencies.sql migrations/0006_chat_nav.sql; do
  env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute liveira-shop --local --persist-to $T/state --file $f >/dev/null 2>&1
done
if curl -s -o /dev/null http://127.0.0.1:8799/health || curl -s -o /dev/null http://127.0.0.1:9911/; then
  echo "ports 8799/9911 already in use — stop the previous run first"; exit 1
fi
setsid python3 tests/bot/fake.py & FAKE=$!
setsid env -u CLOUDFLARE_API_TOKEN npx wrangler dev --local --persist-to $T/state --port 8799 --ip 127.0.0.1 > $T/dev.log 2>&1 & DEV=$!
trap 'kill -- -$FAKE -$DEV 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -sf http://127.0.0.1:8799/health >/dev/null && break; sleep 0.5; done
python3 tests/bot/test.py
