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
  if (!/^(BTC|ETH|SOL)-USDT$/.test(instId) || (side !== "buy" && side !== "sell") || !(num(sz) > 0)) {
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

function attach(app) {
  app.use(function (req, res, next) {
    if (req.method === "GET" && req.path === "/health") return health(req, res);
    if (req.method === "GET" && req.path === "/api/balance") return balance(req, res);
    if (req.method === "GET" && req.path === "/api/orders") return orders(req, res);
    if (req.method === "POST" && req.path === "/api/order") return order(req, res);
    if (req.method === "POST" && req.path === "/api/order-cancel") return cancel(req, res);
    next();
  });
}

module.exports = { attach };
