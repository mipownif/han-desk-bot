#!/bin/bash
set -euo pipefail
ROOT="${HOME}/quantum-server"
if [ ! -d "$ROOT" ]; then
  echo "missing $ROOT"
  exit 1
fi
cd "$ROOT"
BASE="https://raw.githubusercontent.com/mipownif/han-desk-bot/main"
curl -fsSL "$BASE/han-api.js" -o han-api.js
curl -fsSL "$BASE/han-chat.js" -o han-chat.js
curl -fsSL "$BASE/han-auto.js" -o han-auto.js
python3 - << 'PY'
from pathlib import Path
p = Path("index.js")
t = p.read_text()
if 'require("./han-api").attach(app);' not in t:
    if "const app = express();" not in t:
        raise SystemExit("index.js has no const app = express();")
    t = t.replace(
        "const app = express();",
        "const app = express();\nrequire(\"./han-api\").attach(app);\nrequire(\"./han-chat\").attach(app);\nrequire(\"./han-auto\").attach(app);",
        1,
    )
    p.write_text(t)
print("files", Path("han-api.js").stat().st_size, Path("han-chat.js").stat().st_size, Path("han-auto.js").stat().st_size)
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
