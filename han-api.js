"use strict";

const crypto = require("crypto");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED = String(process.env.ALLOWED_CHAT_ID || "8713335385");
const OKX_KEY = process.env.OKX_API_KEY || "";
const OKX_SEC = process.env.OKX_API_SECRET || "";
const OKX_PASS = process.env.OKX_API_PASSPHRASE || "";
const OKX_FLAG = process.env.OKX_FLAG || "0";
const MAX_USDT = Number(process.env.MAX_ORDER_USDT || 1000);
const OKX = "https://www.okx.com";
const started = Date.now();

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d || 0;
}

function instOk(id) {
  return /^[A-Z0-9]{2,16}-USDT$/.test(String(id || ""));
}

function allowed(id) {
  return String(id) === ALLOWED;
}

function verifyInit(raw) {
  if (!raw || !TOKEN) return null;
  const p = new URLSearchParams(raw);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dsc = Array.from(p.entries())
    .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; })
    .map(function (e) { return e[0] + "=" + e[1]; })
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const got = crypto.createHmac("sha256", secret).update(dsc).digest("hex");
  const A = Buffer.from(got, "hex");
  const B = Buffer.from(hash, "hex");
  if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) return null;
  const ad = Number(p.get("auth_date") || 0);
  if (!ad || Math.abs(Date.now() / 1000 - ad) > 172800) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch (e) { return null; }
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

function gate(req, res) {
  const init = req.headers["x-telegram-init-data"] || "";
  if (!init) {
    res.status(200).json({ ok: false, reason: "open_inside_telegram", message: "Open this desk inside Telegram." });
    return null;
  }
  const user = verifyInit(init);
  if (!user) {
    res.status(401).json({ ok: false, reason: "denied", message: "Invalid Telegram session." });
    return null;
  }
  if (!allowed(user.id)) {
    res.status(403).json({ ok: false, reason: "denied", message: "Not on the HAN whitelist." });
    return null;
  }
  return user;
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

let instCache = { at: 0, rows: [] };

async function loadInstruments() {
  if (instCache.rows.length && Date.now() - instCache.at < 600000) return instCache.rows;
  const r = await fetch(OKX + "/api/v5/public/instruments?instType=SPOT");
  const body = await r.json();
  const rows = body && Array.isArray(body.data) ? body.data : [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const it = rows[i];
    const id = String(it.instId || "");
    if (!instOk(id) || it.state !== "live") continue;
    out.push({ instId: id, base: String(it.baseCcy || id.split("-")[0]), quote: "USDT" });
  }
  instCache = { at: Date.now(), rows: out };
  return out;
}

async function instruments(req, res) {
  const q = String((req.query && req.query.q) || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  try {
    const rows = await loadInstruments();
    const hit = q
      ? rows.filter(function (it) { return it.instId.indexOf(q) === 0 || it.base.indexOf(q) === 0; }).slice(0, 30)
      : rows.filter(function (it) { return /^(BTC|ETH|SOL|XRP|DOGE|ADA)-USDT$/.test(it.instId); });
    res.json({ ok: true, q: q, rows: hit });
  } catch (e) {
    res.status(502).json({ ok: false, message: "instruments failed" });
  }
}

async function ticker(req, res) {
  const instId = instOk(req.query && req.query.instId) ? String(req.query.instId) : "BTC-USDT";
  try {
    const r = await fetch(OKX + "/api/v5/market/ticker?instId=" + encodeURIComponent(instId));
    const body = await r.json();
    const row = body && body.data && body.data[0];
    if (!row) { res.status(502).json({ ok: false, message: "ticker empty" }); return; }
    res.json({
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
    });
  } catch (e) {
    res.status(502).json({ ok: false, message: "ticker failed" });
  }
}

async function candles(req, res) {
  const instId = instOk(req.query && req.query.instId) ? String(req.query.instId) : "BTC-USDT";
  const bar = /^(1m|5m|15m|1H|4H|1D)$/.test(String((req.query && req.query.bar) || ""))
    ? String(req.query.bar)
    : "15m";
  try {
    const r = await fetch(
      OKX + "/api/v5/market/candles?instId=" + encodeURIComponent(instId) + "&bar=" + encodeURIComponent(bar) + "&limit=96",
    );
    const body = await r.json();
    const rows = body && Array.isArray(body.data) ? body.data : [];
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      out.push({ t: num(row[0]), o: num(row[1]), h: num(row[2]), l: num(row[3]), c: num(row[4]), v: num(row[5]) });
    }
    res.json({ ok: true, instId: instId, bar: bar, candles: out });
  } catch (e) {
    res.status(502).json({ ok: false, message: "candles failed" });
  }
}

async function health(_req, res) {
  res.json({
    ok: true,
    telegram: Boolean(TOKEN),
    uptime_ms: Date.now() - started,
    balance: true,
    trade: true,
    auto: true,
    ai: true,
  });
}

async function balance(req, res) {
  if (!gate(req, res)) return;
  try {
    const body = await okxPrivate("GET", "/api/v5/account/balance");
    const first = body && body.data && body.data[0];
    if (!body || body.code !== "0" || !first) {
      res.status(502).json({ ok: false, reason: "error", message: (body && body.msg) || "balance empty" });
      return;
    }
    const rows = [];
    const details = Array.isArray(first.details) ? first.details : [];
    for (let i = 0; i < details.length; i++) {
      const it = details[i];
      const ccy = String(it.ccy || "");
      const eq = num(it.eq);
      const avail = num(it.availBal, eq);
      if (!ccy || (eq === 0 && avail === 0)) continue;
      rows.push({ ccy: ccy, eq: eq, avail: avail });
    }
    res.json({ ok: true, totalEq: num(first.totalEq), rows: rows, source: "okx" });
  } catch (e) {
    res.status(502).json({ ok: false, reason: "error", message: "balance failed" });
  }
}

async function orders(req, res) {
  if (!gate(req, res)) return;
  try {
    const body = await okxPrivate("GET", "/api/v5/trade/orders-pending?instType=SPOT");
    const rows = body && Array.isArray(body.data) ? body.data : [];
    res.json({
      ok: true,
      orders: rows.map(function (row) {
        return {
          ordId: String(row.ordId || ""),
          instId: String(row.instId || ""),
          side: String(row.side || ""),
          ordType: String(row.ordType || ""),
          px: String(row.px || ""),
          sz: String(row.sz || ""),
          fillSz: String(row.fillSz || "0"),
          state: String(row.state || ""),
        };
      }),
    });
  } catch (e) {
    res.status(502).json({ ok: false, reason: "error", message: "orders failed" });
  }
}

async function place(b) {
  const instId = String(b.instId || "");
  const side = String(b.side || "");
  const ordType = String(b.ordType || "market");
  const sz = String(b.sz || "");
  const px = b.px == null ? "" : String(b.px);
  if (!instOk(instId) || (side !== "buy" && side !== "sell") || !(num(sz) > 0)) {
    return { ok: false, reason: "rejected", message: "Need instId, side, sz." };
  }
  if (side === "buy" && num(sz) > MAX_USDT) {
    return { ok: false, reason: "rejected", message: "over MAX_ORDER_USDT" };
  }
  const payload = { instId: instId, tdMode: "cash", side: side, ordType: ordType, sz: sz };
  if (ordType === "market") payload.tgtCcy = b.tgtCcy === "base_ccy" ? "base_ccy" : side === "buy" ? "quote_ccy" : "base_ccy";
  if (ordType === "limit") payload.px = px;
  const body = await okxPrivate("POST", "/api/v5/trade/order", payload);
  const row = body && body.data && body.data[0];
  if (!body || body.code !== "0" || !row) {
    return { ok: false, reason: "rejected", message: (body && (body.msg || (row && row.sMsg))) || "order rejected" };
  }
  return {
    ok: true,
    ordId: String(row.ordId || ""),
    clOrdId: row.clOrdId ? String(row.clOrdId) : null,
    state: String(row.state || "live"),
    instId: instId,
    side: side,
    sz: sz,
    px: px || null,
    fillPx: row.fillPx ? String(row.fillPx) : null,
    fillSz: row.fillSz ? String(row.fillSz) : null,
    source: "okx",
  };
}

async function order(req, res) {
  if (!gate(req, res)) return;
  const b = await readJson(req);
  if (b.confirm !== true) {
    res.json({ ok: false, reason: "rejected", message: "Order was not confirmed." });
    return;
  }
  try {
    res.json(await place(b));
  } catch (e) {
    res.status(502).json({ ok: false, reason: "error", message: "order failed" });
  }
}

async function cancel(req, res) {
  if (!gate(req, res)) return;
  const b = await readJson(req);
  if (b.confirm !== true || !b.ordId || !b.instId) {
    res.json({ ok: false, reason: "rejected", message: "Need confirm, ordId, instId." });
    return;
  }
  try {
    const body = await okxPrivate("POST", "/api/v5/trade/cancel-order", { instId: b.instId, ordId: b.ordId });
    if (!body || body.code !== "0") {
      res.json({ ok: false, reason: "rejected", message: (body && body.msg) || "cancel rejected" });
      return;
    }
    res.json({ ok: true, ordId: String(b.ordId), state: "canceled", instId: String(b.instId), source: "okx" });
  } catch (e) {
    res.status(502).json({ ok: false, reason: "error", message: "cancel failed" });
  }
}

async function book(req, res) {
  const instId = instOk(req.query && req.query.instId) ? String(req.query.instId) : "BTC-USDT";
  try {
    const r = await fetch(OKX + "/api/v5/market/books?instId=" + encodeURIComponent(instId) + "&sz=15");
    const body = await r.json();
    const row = body && body.data && body.data[0];
    if (!row) { res.status(502).json({ ok: false, message: "book empty" }); return; }
    function lvl(arr) {
      return (arr || []).map(function (x) { return { px: num(x[0]), sz: num(x[1]) }; });
    }
    res.json({ ok: true, instId: instId, bids: lvl(row.bids), asks: lvl(row.asks), ts: num(row.ts) });
  } catch (e) {
    res.status(502).json({ ok: false, message: "book failed" });
  }
}

async function trades(req, res) {
  const instId = instOk(req.query && req.query.instId) ? String(req.query.instId) : "BTC-USDT";
  try {
    const r = await fetch(OKX + "/api/v5/market/trades?instId=" + encodeURIComponent(instId) + "&limit=24");
    const body = await r.json();
    const rows = body && Array.isArray(body.data) ? body.data : [];
    res.json({
      ok: true,
      instId: instId,
      trades: rows.map(function (row) {
        return { px: num(row.px), sz: num(row.sz), side: String(row.side || ""), ts: num(row.ts) };
      }),
    });
  } catch (e) {
    res.status(502).json({ ok: false, message: "trades failed" });
  }
}

async function history(req, res) {
  if (!gate(req, res)) return;
  try {
    const body = await okxPrivate("GET", "/api/v5/trade/orders-history?instType=SPOT");
    const rows = body && Array.isArray(body.data) ? body.data : [];
    res.json({
      ok: true,
      orders: rows.slice(0, 40).map(function (row) {
        return {
          ordId: String(row.ordId || ""),
          instId: String(row.instId || ""),
          side: String(row.side || ""),
          ordType: String(row.ordType || ""),
          px: String(row.px || row.avgPx || ""),
          sz: String(row.sz || ""),
          fillSz: String(row.accFillSz || row.fillSz || "0"),
          state: String(row.state || ""),
        };
      }),
    });
  } catch (e) {
    res.status(502).json({ ok: false, reason: "error", message: "history failed" });
  }
}

async function fills(req, res) {
  if (!gate(req, res)) return;
  try {
    const body = await okxPrivate("GET", "/api/v5/trade/fills?instType=SPOT");
    const rows = body && Array.isArray(body.data) ? body.data : [];
    res.json({
      ok: true,
      fills: rows.slice(0, 40).map(function (row) {
        return {
          instId: String(row.instId || ""),
          side: String(row.side || ""),
          px: String(row.fillPx || row.px || ""),
          sz: String(row.fillSz || row.sz || ""),
          ts: num(row.ts),
        };
      }),
    });
  } catch (e) {
    res.status(502).json({ ok: false, reason: "error", message: "fills failed" });
  }
}

function attach(app) {
  app.use(function (req, res, next) {
    if (req.method === "GET" && req.path === "/health") return health(req, res);
    if (req.method === "GET" && req.path === "/api/instruments") return instruments(req, res);
    if (req.method === "GET" && req.path === "/api/ticker") return ticker(req, res);
    if (req.method === "GET" && req.path === "/api/candles") return candles(req, res);
    if (req.method === "GET" && req.path === "/api/book") return book(req, res);
    if (req.method === "GET" && req.path === "/api/trades") return trades(req, res);
    if (req.method === "GET" && req.path === "/api/balance") return balance(req, res);
    if (req.method === "GET" && req.path === "/api/orders") return orders(req, res);
    if (req.method === "GET" && req.path === "/api/orders-history") return history(req, res);
    if (req.method === "GET" && req.path === "/api/fills") return fills(req, res);
    if (req.method === "POST" && req.path === "/api/order") return order(req, res);
    if (req.method === "POST" && req.path === "/api/order-cancel") return cancel(req, res);
    next();
  });
}

module.exports = { attach };
