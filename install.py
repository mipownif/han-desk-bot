#!/usr/bin/env python3
import os
import pathlib
import re
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


def fetch(name):
    dest = ROOT / name
    urllib.request.urlretrieve(BASE + name, dest)
    size = dest.stat().st_size
    if size < 20:
        raise SystemExit("tiny file %s (%s bytes)" % (name, size))
    print("got", dest, size)


def run(cmd, check=True):
    print("+", " ".join(cmd))
    return subprocess.run(cmd, cwd=str(ROOT), check=check)


def secrets_list():
    r = subprocess.run(
        ["gcloud", "secrets", "list", "--project", PROJECT, "--format=value(name)"],
        capture_output=True, text=True,
    )
    return [n.strip() for n in (r.stdout or "").splitlines() if n.strip()]


def grant(secret):
    run([
        "gcloud", "secrets", "add-iam-policy-binding", secret,
        "--project", PROJECT,
        "--member", SA,
        "--role", "roles/secretmanager.secretAccessor",
    ], check=False)


def secret_map():
    names = secrets_list()
    print("secrets", len(names))
    pairs = [
        ("TELEGRAM_BOT_TOKEN", "Telegram_HAN_thX_bot_API"),
        ("OKX_API_KEY", "OKX_API_key"),
        ("OKX_API_SECRET", "OKX_Secret_key"),
        ("OKX_API_PASSPHRASE", "OKX_PassPhrase"),
        ("GEMINI_API_KEY", "Gemini_API_key"),
        ("ALCHEMY_API_KEY", "Alchemy_API_key"),
        ("BLOCKSCOUT_API_KEY", "Blockscout_API_key"),
    ]
    out = []
    have = set(names)
    for env, secret in pairs:
        if secret in have:
            grant(secret)
            out.append("%s=%s:latest" % (env, secret))
    n = 0
    for secret in names:
        u = secret.upper().replace("-", "_")
        if u.startswith("LET"):
            continue
        if not re.search(r"WAL|WALLET|ADDR", u):
            continue
        if re.search(r"SECRET|PASS|PRIVATE|MNEMONIC|SEED|KEY$", u) and "ADDR" not in u:
            continue
        n += 1
        grant(secret)
        out.append("WAL_%d=%s:latest" % (n, secret))
    bound_env = set(x.split("=", 1)[0] for x in out)
    for secret in names:
        u = secret.upper().replace("-", "_")
        if u.startswith("LET"):
            continue
        if "XAI" in u and "KEY" in u and "XAI_API_KEY" not in bound_env:
            grant(secret)
            out.append("XAI_API_KEY=%s:latest" % secret)
            bound_env.add("XAI_API_KEY")
    return ",".join(out)


def deploy(secrets):
    cmd = [
        "gcloud", "run", "deploy", "quantum-server",
        "--source", str(ROOT),
        "--project", PROJECT,
        "--region", "europe-north2",
        "--allow-unauthenticated",
        "--clear-base-image",
        "--min-instances", "1",
        "--set-env-vars", "ALLOWED_CHAT_ID=8713335385,OKX_FLAG=0,MAX_ORDER_USDT=1000,INDEX_WATCH=BTC-USDT,ETH-USDT,SOL-USDT",
        "--set-secrets", secrets,
    ]
    return run(cmd, check=False)


def verify():
    run(["curl", "-sS", HOST + "/health"], check=False)
    print()
    run(["curl", "-sS", "-o", "/dev/null", "-w", "/app %{http_code}\\n", HOST + "/app"], check=False)
    run(["curl", "-sS", HOST + "/api/index"], check=False)
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
    secrets = secret_map()
    print("bind", secrets)
    result = deploy(secrets)
    if result.returncode != 0:
        raise SystemExit("deploy failed")
    verify()


if __name__ == "__main__":
    main()
