# Local end-to-end tests (bot UX + OxaPay + token API + admin)

`./tests/bot/run.sh` — creates a fresh local D1 (`/tmp/lvtest/state`), starts a fake OxaPay + fake
Telegram Bot API (`fake.py`, :9911; it validates Bot API rules and returns "message is not modified"
like the real API) and `wrangler dev --local` (:8799), then runs `test.py`.
All keys are fake/local-only (`.dev.vars` is gitignored and created if missing).
