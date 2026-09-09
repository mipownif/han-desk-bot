"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

const PORT = Number(process.env.PORT || 8080);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const OKX_API_KEY = process.env.OKX_API_KEY || "";
const OKX_API_SECRET = process.env.OKX_API_SECRET || "";
const OKX_API_PASSPHRASE = process.env.OKX_API_PASSPHRASE || "";
const OKX_FLAG = process.env.OKX_FLAG || "0";
const ALLOWED_CHAT_ID = String(process.env.ALLOWED_CHAT_ID || "8713335385");
const HOST = "https://quantum-server-402813283609.europe-north2.run.app";
const WEBAPP_URL = (process.env.WEBAPP_URL || `${HOST}/app`).trim();
const OKX = "https://www.okx.com";
const TG = "https://api.telegram.org/bot";

const TICKER_KO = "\uC2DC\uC138";
const BALANCE_KO = "\uC794\uACE0";
const startedAt = Date.now();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
require("./han-api").attach(app);
require("./han-chat").attach(app);
require("./han-auto").attach(app);

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function instFromText(text) {
  const u = String(text || "").toUpperCase();
  if (u.includes("ETH")) return "ETH-USDT";
  if (u.includes("SOL")) return "SOL-USDT";
  return "BTC-USDT";
}

function isAllowedId(id) {
  return String(id) === ALLOWED_CHAT_ID;
}

async function tg(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) return { ok: false };
  const res = await fetch(`${TG}${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function okxHeaders(method, path, body) {
  const ts = new Date().toISOString();
  const prehash = `${ts}${method}${path}${body || ""}`;
  const sign = crypto.createHmac("sha256", OKX_API_SECRET).update(prehash).digest("base64");
  return {
    "OK-ACCESS-KEY": OKX_API_KEY,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": OKX_API_PASSPHRASE,
    "x-simulated-trading": OKX_FLAG,
    "content-type": "application/json",
  };
}

async function okxPublic(path) {
  const res = await fetch(`${OKX}${path}`, { headers: { accept: "application/json" } });
  return res.json();
}

async function okxPrivate(method, path, body) {
  const payload = body ? JSON.stringify(body) : "";
  const res = await fetch(`${OKX}${path}`, {
    method,
    headers: okxHeaders(method, path, payload),
    body: payload || undefined,
  });
  return res.json();
}

async function fetchTicker(instId) {
  const body = await okxPublic(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
  const row = body && body.data && body.data[0];
  if (!row) throw new Error(body && body.msg ? body.msg : "ticker empty");
  return {
    ok: true,
    instId: row.instId || instId,
    last: num(row.last),
    bid: num(row.bidPx),
    ask: num(row.askPx),
    bidSz: num(row.bidSz),
    askSz: num(row.askSz),
    open24h: num(row.open24h),
    high24h: num(row.high24h),
    low24h: num(row.low24h),
    volCcy24h: num(row.volCcy24h),
    ts: num(row.ts),
  };
}

async function fetchOkxBalance() {
  const body = await okxPrivate("GET", "/api/v5/account/balance");
  if (!body || body.code !== "0" || !body.data || !body.data[0]) {
    throw new Error(body && body.msg ? body.msg : "balance empty");
  }
  const first = body.data[0];
  const details = Array.isArray(first.details) ? first.details : [];
  const rows = [];
  for (const item of details) {
    const ccy = String(item.ccy || "").trim();
    if (!ccy) continue;
    const eq = num(item.eq);
    const avail = num(item.availBal, eq);
    if (eq === 0 && avail === 0) continue;
    rows.push({ ccy, eq, avail });
  }
  return { ok: true, totalEq: num(first.totalEq), rows, source: "okx" };
}

function verifyInitData(raw) {
  if (!raw || !TELEGRAM_BOT_TOKEN) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TELEGRAM_BOT_TOKEN).digest();
  const computed = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 172800) return null;
  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  return n >= 100 ? n.toFixed(1) : n.toFixed(4);
}

function tickerText(q) {
  return [
    q.instId,
    `last ${fmt(q.last)}`,
    `bid ${fmt(q.bid)} x ${fmt(q.bidSz)}`,
    `ask ${fmt(q.ask)} x ${fmt(q.askSz)}`,
  ].join("\n");
}

function balanceText(b) {
  const lines = [`USDT eq ${fmt(b.totalEq)}`];
  for (const row of b.rows) lines.push(`${row.ccy}  ${fmt(row.avail)}`);
  if (b.rows.length === 0) lines.push("no non-zero balances");
  return lines.join("\n");
}

function webAppMarkup() {
  return {
    inline_keyboard: [[{ text: "Open HAN", web_app: { url: WEBAPP_URL } }]],
  };
}

async function handleMessage(message) {
  const chatId = message && message.chat && message.chat.id;
  const text = String((message && message.text) || "").trim();
  if (!chatId || !text) return;
  if (!isAllowedId(chatId)) return;

  const lower = text.toLowerCase();
  const compact = lower.replace(/^\//, "");

  if (compact === "id" || compact.startsWith("id ")) {
    await tg("sendMessage", { chat_id: chatId, text: `chat_id ${chatId}` });
    return;
  }

  if (compact === "app" || compact === "start") {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "HAN desk",
      reply_markup: webAppMarkup(),
    });
    return;
  }

  if (
    compact === "ticker" ||
    compact.startsWith("ticker ") ||
    text === TICKER_KO ||
    text.startsWith(`${TICKER_KO} `)
  ) {
    try {
      const quote = await fetchTicker(instFromText(text));
      await tg("sendMessage", { chat_id: chatId, text: tickerText(quote) });
    } catch {
      await tg("sendMessage", { chat_id: chatId, text: "ticker unavailable" });
    }
    return;
  }

  if (compact === "balance" || text === BALANCE_KO) {
    try {
      const bal = await fetchOkxBalance();
      await tg("sendMessage", { chat_id: chatId, text: balanceText(bal) });
    } catch {
      await tg("sendMessage", { chat_id: chatId, text: "balance unavailable" });
    }
  }
}

const APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>HAN</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100dvh; background: #090b0e; color: #eef1f5;
      font: 15px/1.4 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      padding: 24px 20px 40px;
    }
    .mark { font-size: 28px; font-weight: 650; letter-spacing: -0.04em; line-height: 0.9; }
    .sub { margin: 8px 0 22px; font-size: 11px; letter-spacing: 0.46em; color: #8a929e; }
    .row { display: flex; gap: 8px; margin-bottom: 16px; }
    button {
      flex: 1; height: 42px; border: 0; border-radius: 10px; background: #191d24;
      color: #8a929e; font: 500 14px/1 inherit;
    }
    button.on { background: #22272f; color: #eef1f5; }
    .card { background: #12151a; border-radius: 16px; padding: 18px; margin-bottom: 12px; }
    .k { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #5c6470; }
    .px { font: 500 34px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 10px 0 6px; }
    .dim { color: #8a929e; font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 14px; }
    .cell { background: #0c0e12; border-radius: 8px; padding: 10px; }
    .v { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 4px; }
    .lock { color: #8a929e; font-size: 14px; }
  </style>
</head>
<body>
  <div class="mark">HAN</div>
  <div class="sub">AND ONLY</div>
  <div class="row" id="pairs">
    <button data-id="BTC-USDT" class="on">BTC</button>
    <button data-id="ETH-USDT">ETH</button>
    <button data-id="SOL-USDT">SOL</button>
  </div>
  <div class="card">
    <div class="k">Ticker</div>
    <div class="px" id="last">-</div>
    <div class="dim" id="inst">BTC-USDT</div>
    <div class="grid">
      <div class="cell"><div class="k">Bid</div><div class="v" id="bid">-</div></div>
      <div class="cell"><div class="k">Ask</div><div class="v" id="ask">-</div></div>
      <div class="cell"><div class="k">Spread</div><div class="v" id="spread">-</div></div>
    </div>
  </div>
  <div class="card">
    <div class="k">Balance</div>
    <div id="bal" class="lock" style="margin-top:10px">Open inside Telegram</div>
  </div>
  <script>
    var inst = "BTC-USDT";
    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg) { tg.ready(); tg.expand(); tg.setBackgroundColor && tg.setBackgroundColor("#090b0e"); }
    function $(id) { return document.getElementById(id); }
    async function loadTicker() {
      var r = await fetch("/api/ticker?instId=" + encodeURIComponent(inst));
      var j = await r.json();
      if (!j || !j.ok) return;
      $("last").textContent = j.last;
      $("inst").textContent = j.instId;
      $("bid").textContent = j.bid;
      $("ask").textContent = j.ask;
      $("spread").textContent = (j.ask && j.bid) ? (j.ask - j.bid).toFixed(2) : "-";
    }
    async function loadBal() {
      var init = (tg && tg.initData) || "";
      var r = await fetch("/api/balance", { headers: init ? { "X-Telegram-Init-Data": init } : {} });
      var j = await r.json();
      var el = $("bal");
      if (j && j.ok) {
        el.className = "v";
        el.textContent = "USDT eq " + j.totalEq + "\\n" + (j.rows || []).map(function (row) {
          return row.ccy + "  " + row.avail;
        }).join("\\n");
        el.style.whiteSpace = "pre";
      } else {
        el.className = "lock";
        el.textContent = (j && j.message) || "Open inside Telegram";
      }
    }
    document.getElementById("pairs").onclick = function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      inst = b.getAttribute("data-id");
      [].forEach.call(document.querySelectorAll("#pairs button"), function (x) {
        x.className = x === b ? "on" : "";
      });
      loadTicker();
    };
    loadTicker();
    loadBal();
    setInterval(loadTicker, 8000);
  </script>
</body>
</html>`;

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    telegram: Boolean(TELEGRAM_BOT_TOKEN),
    uptime_ms: Date.now() - startedAt,
  });
});

app.get("/app", (_req, res) => {
  const file = path.join(__dirname, "app.html");
  const html = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : APP_HTML;
  res.set("content-type", "text/html; charset=utf-8").send(html);
});

app.get("/api/ticker", async (req, res) => {
  try {
    const quote = await fetchTicker(instFromText(req.query.instId || req.query.symbol || "BTC"));
    res.json(quote);
  } catch (error) {
    res.status(502).json({ ok: false, message: error.message || "ticker failed" });
  }
});

app.get("/api/balance", async (req, res) => {
  const initData = req.get("x-telegram-init-data") || "";
  if (!initData) {
    res.json({
      ok: false,
      reason: "open_inside_telegram",
      message: "Open this desk inside Telegram to read the live OKX balance.",
    });
    return;
  }
  const user = verifyInitData(initData);
  if (!user) {
    res.status(401).json({ ok: false, reason: "denied", message: "Invalid Telegram session." });
    return;
  }
  if (!isAllowedId(user.id)) {
    res.status(403).json({
      ok: false,
      reason: "denied",
      message: "This Telegram account is not on the HAN whitelist.",
    });
    return;
  }
  if (!OKX_API_KEY || !OKX_API_SECRET || !OKX_API_PASSPHRASE) {
    res.json({
      ok: false,
      reason: "backend_pending",
      message: "OKX keys are not bound on Cloud Run.",
    });
    return;
  }
  try {
    res.json(await fetchOkxBalance());
  } catch (error) {
    res.status(502).json({ ok: false, reason: "error", message: "Balance request failed." });
  }
});

app.post("/telegram", async (req, res) => {
  res.json({ ok: true });
  try {
    if (req.body && req.body.message) await handleMessage(req.body.message);
  } catch {
    /* never throw after ack */
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false });
});

async function bootTelegram() {
  if (!TELEGRAM_BOT_TOKEN) return;
  await tg("setWebhook", { url: `${HOST}/telegram`, allowed_updates: ["message", "callback_query"] });
  await tg("setMyCommands", {
    commands: [
      { command: "app", description: "Open HAN desk" },
      { command: "ticker", description: "Spot last / bid / ask" },
      { command: "balance", description: "OKX live equity" },
      { command: "arm", description: "ARM auto (confirm)" },
      { command: "disarm", description: "Disarm auto" },
      { command: "kill", description: "Kill auto now" },
      { command: "id", description: "Show chat_id" },
    ],
  });
  await tg("setChatMenuButton", {
    menu_button: { type: "web_app", text: "HAN", web_app: { url: WEBAPP_URL } },
  });
}

app.listen(PORT, "0.0.0.0", () => {
  bootTelegram().catch(() => {});
});
