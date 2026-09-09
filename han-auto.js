"use strict";

const crypto = require("crypto");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED = String(process.env.ALLOWED_CHAT_ID || "8713335385");
const GEMINI = process.env.GEMINI_API_KEY || "";
const OKX_KEY = process.env.OKX_API_KEY || "";
const OKX_SEC = process.env.OKX_API_SECRET || "";
const OKX_PASS = process.env.OKX_API_PASSPHRASE || "";
const OKX_FLAG = process.env.OKX_FLAG || "0";
const HARD_MAX = Number(process.env.MAX_ORDER_USDT || 1000);
const TG = "https://api.telegram.org/bot";
const OKX = "https://www.okx.com";

const pendingArm = new Map();

const state = {
  armed: false,
  halted: false,
  haltReason: null,
  maxUsdt: 25,
  maxDailyUsdt: 200,
  intervalSec: 60,
  cooldownSec: 120,
  maxSpreadBps: 8,
  allowBuy: true,
  allowSell: true,
  pairs: [],
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
    maxSpreadBps: state.maxSpreadBps,
    allowBuy: state.allowBuy,
    allowSell: state.allowSell,
    pairs: state.pairs.slice(),
    model: "gemini",
    dayKey: state.dayKey,
    notionalToday: state.notionalToday,
    tradesToday: state.tradesToday,
    lastFillAt: state.lastFillAt,
    lastSkip: state.lastSkip,
  };
}

function snapshot() {
  return { config: cfg(), signal: state.signal };
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

async function askGemini(snapshot) {
  if (!GEMINI) return null;
  const prompt =
    "OKX spot. JSON only {\"side\":\"buy|sell|flat\",\"instId\":\"BTC-USDT\",\"sz\":\"25\",\"reason\":\"...\"}. " +
    "No other keys. Conservative. Prefer flat. Data: " +
    JSON.stringify(snapshot);
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
    const instId = String(j.instId || fallbackInst);
    const sz = String(j.sz || state.maxUsdt);
    const reason = String(j.reason || "");
    if (!instId) return null;
    return { side: side, instId: instId, sz: sz, reason: reason, model: "gemini", ts: Date.now() };
  } catch (e) {
    return null;
  }
}

function decide(signal, quote, now) {
  rollDay();
  if (!state.armed) return { action: "idle", reason: "Disarmed" };
  if (state.halted) return { action: "idle", reason: state.haltReason || "Halted" };
  if (!state.pairs.length) return { action: "skip", reason: "no searched pair" };
  if (!quote) return { action: "skip", reason: "No ticker" };
  if (quote.spreadBps > state.maxSpreadBps) return { action: "skip", reason: "wide spread" };
  if (!signal || signal.side === "flat") return { action: "skip", reason: "flat" };
  if (state.pairs.indexOf(signal.instId) < 0) return { action: "skip", reason: "pair" };
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
  const instId = state.pairs[0];
  if (!instId) {
    state.lastSkip = "no searched pair";
    return;
  }
  const quote = await fetchQuote(instId);
  const raw = await askGemini(quote);
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

function applyArm(pairs) {
  const clean = [];
  (pairs || []).forEach(function (id) {
    const s = String(id || "").toUpperCase();
    if (/^[A-Z0-9]{2,16}-USDT$/.test(s) && clean.indexOf(s) < 0) clean.push(s);
  });
  if (!clean.length) return { ok: false, message: "search-open a pair first" };
  state.pairs = clean;
  state.armed = true;
  state.halted = false;
  state.haltReason = null;
  startLoop();
  return { ok: true };
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

function instFromText(text) {
  const u = String(text || "").toUpperCase();
  const m = u.match(/\b([A-Z0-9]{2,16})-USDT\b/) || u.match(/\b([A-Z0-9]{2,16})\b/);
  if (!m) return "BTC-USDT";
  const id = m[1].indexOf("-") >= 0 ? m[1] : m[1] + "-USDT";
  return id;
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
        if (typeof b.maxSpreadBps === "number") state.maxSpreadBps = b.maxSpreadBps;
        if (typeof b.allowBuy === "boolean") state.allowBuy = b.allowBuy;
        if (typeof b.allowSell === "boolean") state.allowSell = b.allowSell;
        if (b.armed === true) {
          const r = applyArm(b.pairs);
          if (!r.ok) {
            res.json({ ok: false, reason: "rejected", message: r.message });
            return;
          }
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
        .then(askGemini)
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
      const cq = req.body && req.body.callback_query;
      if (cq) {
        const from = cq.from && cq.from.id;
        const data = String(cq.data || "");
        if (allowed(from) && data.indexOf("han_arm_") === 0) {
          Promise.resolve()
            .then(function () {
              return tg("answerCallbackQuery", { callback_query_id: cq.id });
            })
            .then(function () {
              const chatId = cq.message && cq.message.chat && cq.message.chat.id;
              const draft = pendingArm.get(String(from));
              pendingArm.delete(String(from));
              if (data === "han_arm_no") {
                return tg("sendMessage", { chat_id: chatId, text: "ARM cancelled" });
              }
              if (data === "han_arm_yes" && draft && draft.instId) {
                const r = applyArm([draft.instId]);
                return tg("sendMessage", {
                  chat_id: chatId,
                  text: r.ok ? "ARMED " + draft.instId : r.message,
                });
              }
            })
            .catch(function () {});
        }
        return next();
      }
      const msg = req.body && req.body.message;
      const text = String((msg && msg.text) || "").trim();
      const lower = text.toLowerCase();
      const chatId = msg && msg.chat && msg.chat.id;
      if (chatId && allowed(chatId)) {
        if (lower === "/kill" || lower === "kill") {
          kill();
          tg("sendMessage", { chat_id: chatId, text: "auto killed" }).catch(function () {});
        } else if (lower === "/disarm" || lower === "disarm") {
          kill();
          tg("sendMessage", { chat_id: chatId, text: "disarmed" }).catch(function () {});
        } else if (lower === "/arm" || lower.startsWith("/arm ") || lower === "arm" || lower.startsWith("arm ")) {
          const instId = instFromText(text);
          pendingArm.set(String(chatId), { instId: instId });
          tg("sendMessage", {
            chat_id: chatId,
            text: "ARM " + instId + " ? confirm:true required",
            reply_markup: {
              inline_keyboard: [[
                { text: "ARM", callback_data: "han_arm_yes" },
                { text: "Cancel", callback_data: "han_arm_no" },
              ]],
            },
          }).catch(function () {});
        }
      }
    }
    next();
  });
}

module.exports = { attach, snapshot, kill };
