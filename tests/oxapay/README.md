# OxaPay local integration test

Fake OxaPay + fake Telegram (`fake.py`, port 9911) and `wrangler dev --local` (port 8799).
All keys here are fake/local-only.

```bash
mkdir -p /tmp/lvtest && cp tests/oxapay/* /tmp/lvtest/
# .dev.vars (gitignored): BOT_TOKEN=123:fake ADMIN_IDS=1 TOKEN_API_KEY=tk_local ADMIN_PASSWORD=pw_local
#   SESSION_SECRET=ss_local_secret WEBHOOK_SECRET=whs_local OXAPAY_MERCHANT_KEY=local_test_merchant_key
#   OXAPAY_API_BASE=http://127.0.0.1:9911/v1 TELEGRAM_API_BASE=http://127.0.0.1:9911
for f in /tmp/lvtest/base_schema.sql migrations/0002_admin_panel.sql migrations/0003_oxapay.sql; do
  npx wrangler d1 execute liveira-shop --local --persist-to /tmp/lvtest/state --file $f; done
python3 /tmp/lvtest/fake.py &
npx wrangler dev --local --persist-to /tmp/lvtest/state --port 8799 --ip 127.0.0.1 &
python3 /tmp/lvtest/test.py
```
