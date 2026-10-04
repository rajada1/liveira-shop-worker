#!/usr/bin/env bash
# Store the Binance READ-ONLY API key pair as Worker secrets of `liveira-shop` (@liveirashop_bot).
# Values are read from the environment and piped to wrangler on stdin: they are never printed or written to disk.
#
#   BINANCE_API_KEY=… BINANCE_API_SECRET=… CLOUDFLARE_API_TOKEN=… bash scripts/put-binance-secrets.sh
#   (CLOUDFLARE_STORE_TOKEN is used when CLOUDFLARE_API_TOKEN is not set)
#
# The key must have ONLY "Enable Reading" (no trading, no withdrawals). Leave IP restriction off:
# Cloudflare Workers do not have fixed outgoing IPs. `wrangler secret put` deploys the current code with the new secret;
# the "🟡 Binance Pay" option appears in the bot right after (if binance_enabled=1 and a Pay ID is set).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${BINANCE_API_KEY:?BINANCE_API_KEY is not set}"
: "${BINANCE_API_SECRET:?BINANCE_API_SECRET is not set}"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-${CLOUDFLARE_STORE_TOKEN:-}}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN (or CLOUDFLARE_STORE_TOKEN) is not set}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-0d3330f1cc9f7a3f2f18afba43570277}"

# Light sanity checks (lengths only, nothing echoed). Binance keys are 64 alphanumeric characters.
for v in BINANCE_API_KEY BINANCE_API_SECRET; do
  val="${!v}"
  if [[ ! "$val" =~ ^[A-Za-z0-9]{32,128}$ ]]; then
    echo "$v does not look like a Binance API key (expected 32–128 letters/digits, got ${#val} chars)" >&2
    exit 1
  fi
done
if [ "$BINANCE_API_KEY" = "$BINANCE_API_SECRET" ]; then echo "BINANCE_API_KEY and BINANCE_API_SECRET are identical" >&2; exit 1; fi

put() { printf '%s' "${!1}" | npx wrangler secret put "$1" --name liveira-shop >/dev/null; echo "✓ $1 stored"; }
put BINANCE_API_KEY
put BINANCE_API_SECRET

# Confirm by name only
curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/liveira-shop/secrets" |
  python3 -c "import json,sys; n=[s['name'] for s in json.load(sys.stdin)['result']]; print('Worker secrets now include:', ', '.join(x for x in n if x.startswith('BINANCE_')) or 'NONE (check the errors above)')"
echo "Next: admin panel → Configurações → Recarga via Binance Pay → \"Testar conexão com a Binance\"."
