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
    "Dockerfile",
]
HOST = "https://quantum-server-402813283609.europe-north2.run.app"
PROJECT = "future-shuttle-507619-f7"
SA = "serviceAccount:402813283609-compute@developer.gserviceaccount.com"
SECRETS_OKX = (
    "TELEGRAM_BOT_TOKEN=Telegram_HAN_thX_bot_API:latest,"
    "OKX_API_KEY=OKX_API_key:latest,"
    "OKX_API_SECRET=OKX_Secret_key:latest,"
    "OKX_API_PASSPHRASE=OKX_PassPhrase:latest"
)
SECRETS_ALL = SECRETS_OKX + ",GEMINI_API_KEY=Gemini_API_key:latest"


def fetch(name):
    dest = ROOT / name
    url = BASE + name
    urllib.request.urlretrieve(url, dest)
    size = dest.stat().st_size
    if size < 20:
        raise SystemExit("tiny file %s (%s bytes)" % (name, size))
    print("got", dest, size)


def run(cmd, check=True):
    print("+", " ".join(cmd))
    return subprocess.run(cmd, cwd=str(ROOT), check=check)


def deploy(secrets):
    cmd = [
        "gcloud", "run", "deploy", "quantum-server",
        "--source", str(ROOT),
        "--project", PROJECT,
        "--region", "europe-north2",
        "--allow-unauthenticated",
        "--clear-base-image",
        "--min-instances", "1",
        "--set-env-vars", "ALLOWED_CHAT_ID=8713335385,OKX_FLAG=0,MAX_ORDER_USDT=1000",
        "--set-secrets", secrets,
    ]
    return run(cmd, check=False)


def verify():
    run(["curl", "-sS", HOST + "/health"], check=False)
    print()
    run(["curl", "-sS", "-o", "/dev/null", "-w", "/app %{http_code}\\n", HOST + "/app"], check=False)
    run(["curl", "-sS", HOST + "/api/balance"], check=False)
    print()


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    os.chdir(ROOT)
    print("cwd", os.getcwd())
    for name in FILES:
        fetch(name)
    text = (ROOT / "index.js").read_text()
    if 'require("./han-api").attach(app);' not in text:
        raise SystemExit("index.js missing han-api attach")
    run([
        "gcloud", "secrets", "add-iam-policy-binding", "Gemini_API_key",
        "--project", PROJECT,
        "--member", SA,
        "--role", "roles/secretmanager.secretAccessor",
    ], check=False)
    result = deploy(SECRETS_ALL)
    if result.returncode != 0:
        print("Gemini bind failed or deploy failed. Retry without GEMINI_API_KEY.")
        result = deploy(SECRETS_OKX)
        if result.returncode != 0:
            raise SystemExit("deploy failed")
    verify()


if __name__ == "__main__":
    main()
