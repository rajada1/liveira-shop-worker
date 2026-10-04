# Local end-to-end tests (bot UX + OxaPay + Binance Pay + token API + admin)

`./tests/bot/run.sh` — creates a fresh local D1 (`/tmp/lvtest/state`), starts a fake OxaPay + fake
Telegram Bot API (`fake.py`, :9911; it validates Bot API rules and returns "message is not modified"
like the real API) and `wrangler dev --local` (:8799), then runs `test.py`.
All keys are fake/local-only (`.dev.vars` is gitignored and created if missing).

Binance Pay: `fake.py` also serves `GET /sapi/v1/pay/transactions` (checks the X-MBX-APIKEY header, the HMAC-SHA256
signature with the fake secret, signature last, timestamp window; `/_bn/tx` adds a transaction, `/_bn/mode/<status>[/<retry-after>]`
simulates 451/429/5xx). `run.sh` appends fake `BINANCE_*` values to `.dev.vars` (cache TTL 1 s), starts wrangler with
`--test-scheduled` (cron via `/__scheduled`) and a second instance on :8798 (`tests/bot/nosecrets/`) without the Binance
secrets, to check the option stays hidden.
