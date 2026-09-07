"use strict";

const crypto = require("crypto");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED = String(process.env.ALLOWED_CHAT_ID || "8713335385");
const GEMINI = process.env.GEMINI_API_KEY || "";
const XAI = process.env.XAI_API_KEY || "";
const OKX_KEY = process.env.OKX_API_KEY || "";
const OKX_SEC = process.env.OKX_API_SECRET || "";
const OKX_PASS = process.env.OKX_API_PASSPHRASE || "";
const OKX_FLAG = process.env.OKX_FLAG || "0";
const HARD_MAX = Number(process.env.MAX_ORDER_USDT || 1000);
const TG = "https://api.telegram.org/bot";
const OKX = "https://www.okx.com";

const state = {
  armed: false,
  halted: false,
  haltReason: null,
  maxUsdt: 25,
  maxDailyUsdt: 200,
  intervalSec: 60,
  cooldownSec: 120,
  minConf: 0.7,
  maxSpreadBps: 8,
  allowBuy: true,
  allowSell: true,
  pairs: ["BTC-USDT"],
  model: "gemini",
  dayKey: "",
  notionalToday: 0,
  tradesToday: 0,
  lastFillAt: null,
  lastSkip: null,
  signal: null,
  timer: null,
};

function allowed(id) {
  return String(id) === ALLOWED;
}

function dayKey(now) {
  return new Date(now || Date.now()).toISOString().slice(0, 10);
}

function rollDay() {
  const key = dayKey();
  if (state.dayKey === key) return;
  state.dayKey = key;
  state.notionalToday = 0;
  state.tradesToday = 0;
}

function cfg() {
  rollDay();
  return {
    armed: state.armed,
    halted: state.halted,
    haltReason: state.haltReason,
    maxUsdt: state.maxUsdt,
    maxDailyUsdt: state.maxDailyUsdt,
    intervalSec: state.intervalSec,
    cooldownSec: state.cooldownSec,
    minConf: state.minConf,
    maxSpreadBps: state.maxSpreadBps,
    allowBuy: state.allowBuy,
    allowSell: state.allowSell,
    pairs: state.pairs,
    model: state.model,
    dayKey: state.dayKey,
    notionalToday: state.notionalToday,
    tradesToday: state.tradesToday,
    lastFillAt: state.lastFillAt,
    lastSkip: state.lastSkip,
  };
}

function gateHttp(req, res) {
  const init = req.headers["x-telegram-init-data"] || "";
  if (!init) {
    res.status(200).json({ ok: false, reason: "open_inside_telegram", message: "Open inside Telegram." });
    return false;
  }
  return true;
}

function okxHeaders(method, path, body) {
  const ts = new Date().toISOString();
  const sign = crypto.createHmac("sha256", OKX_SEC).update(ts + method + path + (body || "")).digest("base64");
  return {
    "OK-ACCESS-KEY": OKX_KEY,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": OKX_PASS,
    "x-simulated-trading": OKX_FLAG,
    "content-type": "application/json",
  };
}

async function okxPrivate(method, path, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const res = await fetch(OKX + path, { method: method, headers: okxHeaders(method, path, body), body: body || undefined });
  return res.json();
}

async function fetchQuote(instId) {
  const res = await fetch(OKX + "/api/v5/market/ticker?instId=" + encodeURIComponent(instId));
  const body = await res.json();
  const row = body && body.data && body.data[0];
  if (!row) return null;
  const bid = Number(row.bidPx);
  const ask = Number(row.askPx);
  const last = Number(row.last);
  const mid = (bid + ask) / 2;
  const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10000 : 99;
  return { instId: row.instId || instId, last: last, bid: bid, ask: ask, spreadBps: spreadBps };
}

async function askModel(snapshot) {
  const prompt =
    "OKX spot. JSON only {\"side\":\"buy|sell|flat\",\"instId\":\"BTC-USDT\",\"conf\":0-1,\"sz\":\"25\",\"reason\":\"...\"}. Conservative. Prefer flat. Data: " +
    JSON.stringify(snapshot);
  if (state.model === "grok" && XAI) {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + XAI },
      body: JSON.stringify({ model: "grok-3", messages: [{ role: "user", content: prompt }] }),
    });
    const body = await res.json();
    return body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  }
  if (!GEMINI) return null;
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
      encodeURIComponent(GEMINI),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    },
  );
  const body = await res.json();
  return (
    body &&
    body.candidates &&
    body.candidates[0] &&
    body.candidates[0].content &&
    body.candidates[0].content.parts &&
    body.candidates[0].content.parts[0] &&
    body.candidates[0].content.parts[0].text
  );
}

function parseSignal(raw, fallbackInst) {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    const j = JSON.parse(raw.slice(start, end + 1));
    const side = j.side === "buy" || j.side === "sell" ? j.side : "flat";
    return {
      side: side,
      instId: String(j.instId || fallbackInst),
      conf: Number(j.conf) || 0,
      sz: String(j.sz || state.maxUsdt),
      reason: String(j.reason || ""),
      model: state.model,
      ts: Date.now(),
    };
  } catch (e) {
    return null;
  }
}

function decide(signal, quote, now) {
  rollDay();
  if (!state.armed) return { action: "idle", reason: "Disarmed" };
  if (state.halted) return { action: "idle", reason: state.haltReason || "Halted" };
  if (!quote) return { action: "skip", reason: "No ticker" };
  if (quote.spreadBps > state.maxSpreadBps) return { action: "skip", reason: "wide spread" };
  if (!signal || signal.side === "flat") return { action: "skip", reason: "flat" };
  if (state.pairs.indexOf(signal.instId) < 0) return { action: "skip", reason: "pair" };
  if (signal.conf < state.minConf) return { action: "skip", reason: "conf" };
  if (signal.side === "buy" && !state.allowBuy) return { action: "skip", reason: "buys off" };
  if (signal.side === "sell" && !state.allowSell) return { action: "skip", reason: "sells off" };
  if (state.lastFillAt && now - state.lastFillAt < state.cooldownSec * 1000) return { action: "skip", reason: "cooldown" };
  const room = state.maxDailyUsdt - state.notionalToday;
  if (room <= 0) return { action: "halt", reason: "daily cap" };
  let sz = Number(signal.sz);
  if (!(sz > 0)) sz = state.maxUsdt;
  if (signal.side === "buy") {
    sz = Math.min(sz, state.maxUsdt, room, HARD_MAX);
    if (!(sz > 0)) return { action: "skip", reason: "size" };
    return { action: "place", side: "buy", instId: signal.instId, sz: String(sz), tgtCcy: "quote_ccy", notional: sz };
  }
  const px = quote.last > 0 ? quote.last : quote.bid;
  const base = px > 0 ? Math.min(sz, state.maxUsdt) / px : 0;
  const notion = base * px;
  if (!(base > 0)) return { action: "skip", reason: "size" };
  if (notion > room) return { action: "halt", reason: "daily cap" };
  return { action: "place", side: "sell", instId: signal.instId, sz: String(base), tgtCcy: "base_ccy", notional: notion };
}

async function place(decision) {
  const payload = {
    instId: decision.instId,
    tdMode: "cash",
    side: decision.side,
    ordType: "market",
    sz: decision.sz,
    tgtCcy: decision.tgtCcy,
  };
  const body = await okxPrivate("POST", "/api/v5/trade/order", payload);
  const row = body && body.data && body.data[0];
  if (!body || body.code !== "0" || !row) {
    return { ok: false, message: (body && (body.msg || (row && row.sMsg))) || "rejected" };
  }
  return { ok: true, ordId: String(row.ordId || "") };
}

async function tick() {
  const now = Date.now();
  const instId = state.pairs[0] || "BTC-USDT";
  const quote = await fetchQuote(instId);
  const raw = await askModel(quote);
  const signal = parseSignal(raw, instId);
  state.signal = signal;
  const d = decide(signal, quote, now);
  if (d.action === "skip") {
    state.lastSkip = d.reason;
    return;
  }
  if (d.action === "halt") {
    state.armed = false;
    state.halted = true;
    state.haltReason = d.reason;
    stopLoop();
    return;
  }
  if (d.action !== "place") return;
  const sent = await place(d);
  if (!sent.ok) {
    state.lastSkip = sent.message || "order rejected";
    return;
  }
  state.lastFillAt = now;
  state.lastSkip = null;
  state.tradesToday += 1;
  state.notionalToday += d.notional;
}

function stopLoop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function startLoop() {
  stopLoop();
  const ms = Math.max(60, Number(state.intervalSec) || 60) * 1000;
  state.timer = setInterval(function () {
    tick().catch(function () {});
  }, ms);
}

function kill() {
  state.armed = false;
  state.halted = false;
  state.haltReason = null;
  stopLoop();
}

async function tg(method, payload) {
  if (!TOKEN) return;
  await fetch(TG + TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function readJson(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  return new Promise(function (resolve) {
    let raw = "";
    req.on("data", function (c) { raw += c; });
    req.on("end", function () {
      try { resolve(JSON.parse(raw || "{}")); } catch (e) { resolve({}); }
    });
  });
}

function attach(app) {
  app.use(function (req, res, next) {
    if (req.method === "GET" && req.path === "/api/auto") {
      if (!gateHttp(req, res)) return;
      res.json({ ok: true, config: cfg(), signal: state.signal });
      return;
    }
    if (req.method === "POST" && req.path === "/api/auto") {
      if (!gateHttp(req, res)) return;
      readJson(req).then(function (b) {
        if (b.confirm !== true) {
          res.json({ ok: false, reason: "rejected", message: "not confirmed" });
          return;
        }
        if (typeof b.maxUsdt === "number") state.maxUsdt = Math.min(HARD_MAX, Math.max(1, b.maxUsdt));
        if (typeof b.maxDailyUsdt === "number") state.maxDailyUsdt = Math.max(1, b.maxDailyUsdt);
        if (b.intervalSec) state.intervalSec = Number(b.intervalSec);
        if (typeof b.cooldownSec === "number") state.cooldownSec = b.cooldownSec;
        if (typeof b.minConf === "number") state.minConf = b.minConf;
        if (typeof b.maxSpreadBps === "number") state.maxSpreadBps = b.maxSpreadBps;
        if (typeof b.allowBuy === "boolean") state.allowBuy = b.allowBuy;
        if (typeof b.allowSell === "boolean") state.allowSell = b.allowSell;
        if (Array.isArray(b.pairs) && b.pairs.length) state.pairs = b.pairs;
        if (b.model === "grok" || b.model === "gemini") state.model = b.model;
        if (b.armed === true) {
          state.armed = true;
          state.halted = false;
          state.haltReason = null;
          startLoop();
        } else {
          kill();
        }
        res.json({ ok: true, config: cfg(), message: state.armed ? "ARMED" : "Killed" });
      });
      return;
    }
    if (req.method === "GET" && req.path === "/api/signal") {
      if (!gateHttp(req, res)) return;
      const instId = (req.query && req.query.instId) || state.pairs[0] || "BTC-USDT";
      fetchQuote(instId)
        .then(askModel)
        .then(function (raw) {
          const signal = parseSignal(raw, instId);
          state.signal = signal;
          if (!signal) res.json({ ok: false, reason: "error", message: "no signal" });
          else res.json({ ok: true, signal: signal });
        })
        .catch(function () {
          res.status(502).json({ ok: false, reason: "error", message: "signal failed" });
        });
      return;
    }
    if (req.method === "POST" && req.path === "/telegram") {
      const msg = req.body && req.body.message;
      const text = String((msg && msg.text) || "").trim().toLowerCase();
      const chatId = msg && msg.chat && msg.chat.id;
      if (chatId && allowed(chatId) && (text === "/kill" || text === "kill")) {
        kill();
        tg("sendMessage", { chat_id: chatId, text: "auto killed" }).catch(function () {});
      }
    }
    next();
  });
}

module.exports = { attach };
