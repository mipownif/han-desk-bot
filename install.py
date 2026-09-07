#!/usr/bin/env python3
import os
import pathlib
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path("/tmp/quantum-server")
BASE = "https://raw.githubusercontent.com/mipownif/han-desk-bot/main/"
FILES = [
    "package.json",
    "index.js",
    "app.html",
    "han-api.js",
    "han-chat.js",
    "han-auto.js",
]
HOST = "https://quantum-server-402813283609.europe-north2.run.app"


def fetch(name):
    dest = ROOT / name
    url = BASE + name
    urllib.request.urlretrieve(url, dest)
    size = dest.stat().st_size
    if size < 20:
        raise SystemExit("tiny file %s (%s bytes) from %s" % (name, size, url))
    print("got", dest, size)
    return dest


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    os.chdir(ROOT)
    print("cwd", os.getcwd())
    for name in FILES:
        fetch(name)
    index = ROOT / "index.js"
    text = index.read_text()
    if 'require("./han-api").attach(app);' not in text:
        raise SystemExit("index.js missing han-api attach")
    cmd = [
        "gcloud",
        "run",
        "deploy",
        "quantum-server",
        "--source",
        str(ROOT),
        "--project",
        "future-shuttle-507619-f7",
        "--region",
        "europe-north2",
        "--allow-unauthenticated",
        "--clear-base-image",
        "--min-instances",
        "1",
        "--set-env-vars",
        "ALLOWED_CHAT_ID=8713335385,OKX_FLAG=0,MAX_ORDER_USDT=1000",
        "--set-secrets",
        "TELEGRAM_BOT_TOKEN=Telegram_HAN_thX_bot_API:latest,OKX_API_KEY=OKX_API_key:latest,OKX_API_SECRET=OKX_Secret_key:latest,OKX_API_PASSPHRASE=OKX_PassPhrase:latest,GEMINI_API_KEY=Gemini_API_key:latest",
    ]
    subprocess.check_call(cmd, cwd=str(ROOT))
    subprocess.check_call(["curl", "-sS", HOST + "/health"])
    print()
    subprocess.check_call(["curl", "-sS", "-o", "/dev/null", "-w", "/app %{http_code}\\n", HOST + "/app"])
    subprocess.check_call(["curl", "-sS", HOST + "/api/balance"])
    print()


if __name__ == "__main__":
    main()
