#!/bin/bash
set -euo pipefail
ROOT="${HOME}/quantum-server"
mkdir -p "$ROOT"
cd "$ROOT"
BASE="https://raw.githubusercontent.com/mipownif/han-desk-bot/main"
for f in package.json index.js han-api.js han-chat.js han-auto.js; do
  curl -fsSL "$BASE/$f" -o "$f"
done
python3 - << 'PY'
from pathlib import Path
need = ["package.json", "index.js", "han-api.js", "han-chat.js", "han-auto.js"]
for name in need:
    p = Path(name)
    if not p.is_file() or p.stat().st_size < 20:
        raise SystemExit("missing " + name)
text = Path("index.js").read_text()
if 'require("./han-api").attach(app);' not in text:
    raise SystemExit("index.js missing han-api attach")
print("ok", {n: Path(n).stat().st_size for n in need})
PY
gcloud run deploy quantum-server \
  --source . \
  --project future-shuttle-507619-f7 \
  --region europe-north2 \
  --allow-unauthenticated \
  --clear-base-image \
  --min-instances 1 \
  --set-env-vars ALLOWED_CHAT_ID=8713335385,OKX_FLAG=0,MAX_ORDER_USDT=1000 \
  --set-secrets=TELEGRAM_BOT_TOKEN=Telegram_HAN_thX_bot_API:latest,OKX_API_KEY=OKX_API_key:latest,OKX_API_SECRET=OKX_Secret_key:latest,OKX_API_PASSPHRASE=OKX_PassPhrase:latest,GEMINI_API_KEY=Gemini_API_key:latest
echo "--- verify ---"
curl -sS https://quantum-server-402813283609.europe-north2.run.app/health
echo
curl -sS https://quantum-server-402813283609.europe-north2.run.app/api/balance
echo
