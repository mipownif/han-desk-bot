"use strict";

const crypto = require("crypto");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED = String(process.env.ALLOWED_CHAT_ID || "8713335385");
const XAI = process.env.XAI_API_KEY || "";
const OKX_KEY = process.env.OKX_API_KEY || "";
const OKX_SEC = process.env.OKX_API_SECRET || "";
const OKX_PASS = process.env.OKX_API_PASSPHRASE || "";
const OKX_FLAG = process.env.OKX_FLAG || "0";
const MAX_USDT = Number(process.env.MAX_ORDER_USDT || 1000);
const TG = "https://api.telegram.org/bot";
const OKX = "https://www.okx.com";
const MODEL = "grok-3";
const pending = new Map();

function allowed(id) {
  return String(id) === ALLOWED;
}

async function tg(method, payload) {
  if (!TOKEN) return { ok: false };
  const res = await fetch(TG + TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function isCommand(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  if (t[0] === "/") return true;
  if (/^(ticker|balance|id|app|start|arm|disarm|kill)\b/.test(t)) return true;
  if (t === "시세" || t === "잔고") return true;
  return false;
}

function systemPrompt() {
  return [
    "You are HAN, a live OKX spot desk in Telegram.",
    "Reply short. Korean if the user writes Korean.",
    "Use tools for ticker, balance, orders, arm status.",
    "Never place an order in prose. Call order_preview. The user must tap confirm.",
    "You must not claim a fill unless a tool returned an ordId.",
    "No seeds, no private keys, no LET/WAL.",
    "Gemini is not available in this chat. Auto scoring is a different path.",
  ].join(" ");
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "ticker",
      description: "Public OKX spot ticker",
      parameters: { type: "object", properties: { instId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "balance",
      description: "OKX live equity. Read only.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "orders",
      description: "Open spot orders. Read only.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "arm_status",
      description: "Auto arm / kill status. Read only.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "order_preview",
      description: "Draft a spot order. Does not place. User must tap confirm.",
      parameters: {
        type: "object",
        properties: {
          instId: { type: "string" },
          side: { type: "string", enum: ["buy", "sell"] },
          sz: { type: "string" },
          ordType: { type: "string", enum: ["market", "limit"] },
          px: { type: "string" },
        },
        required: ["instId", "side", "sz"],
      },
    },
  },
];

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

async function toolTicker(instId) {
  const id = /^[A-Z0-9]{2,16}-USDT$/.test(String(instId || "")) ? String(instId) : "BTC-USDT";
  const res = await fetch(OKX + "/api/v5/market/ticker?instId=" + encodeURIComponent(id));
  const body = await res.json();
  const row = body && body.data && body.data[0];
  if (!row) return { ok: false, message: "ticker empty" };
  return { ok: true, instId: row.instId, last: row.last, bid: row.bidPx, ask: row.askPx };
}

async function toolBalance() {
  const body = await okxPrivate("GET", "/api/v5/account/balance");
  const first = body && body.data && body.data[0];
  if (!body || body.code !== "0" || !first) return { ok: false, message: (body && body.msg) || "balance empty" };
  const rows = [];
  (first.details || []).forEach(function (it) {
    const eq = Number(it.eq) || 0;
    const avail = Number(it.availBal);
    if (!it.ccy || (eq === 0 && !(avail > 0))) return;
    rows.push({ ccy: it.ccy, eq: eq, avail: Number.isFinite(avail) ? avail : eq });
  });
  return { ok: true, totalEq: Number(first.totalEq) || 0, rows: rows };
}

async function toolOrders() {
  const body = await okxPrivate("GET", "/api/v5/trade/orders-pending?instType=SPOT");
  const rows = body && Array.isArray(body.data) ? body.data : [];
  return {
    ok: true,
    orders: rows.map(function (row) {
      return { ordId: row.ordId, instId: row.instId, side: row.side, sz: row.sz, px: row.px, state: row.state };
    }),
  };
}

function toolArm() {
  try {
    return require("./han-auto").snapshot();
  } catch (e) {
    return { ok: false, message: "auto unavailable" };
  }
}

async function runTool(name, args) {
  if (name === "ticker") return toolTicker(args && args.instId);
  if (name === "balance") return toolBalance();
  if (name === "orders") return toolOrders();
  if (name === "arm_status") return toolArm();
  if (name === "order_preview") return { ok: true, preview: true, draft: args };
  return { ok: false, message: "unknown tool" };
}

async function grokTurn(messages) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + XAI },
    body: JSON.stringify({ model: MODEL, messages: messages, tools: TOOLS, tool_choice: "auto" }),
  });
  const body = await res.json();
  const msg = body && body.choices && body.choices[0] && body.choices[0].message;
  if (!msg) throw new Error((body && body.error && body.error.message) || "grok empty");
  return msg;
}

async function placeDraft(draft) {
  const instId = String(draft.instId || "").toUpperCase();
  const side = String(draft.side || "");
  const ordType = String(draft.ordType || "market");
  const sz = String(draft.sz || "");
  if (!/^[A-Z0-9]{2,16}-USDT$/.test(instId) || (side !== "buy" && side !== "sell") || !(Number(sz) > 0)) {
    return { ok: false, message: "Need instId, side, sz." };
  }
  if (side === "buy" && Number(sz) > MAX_USDT) return { ok: false, message: "over MAX_ORDER_USDT" };
  const payload = { instId: instId, tdMode: "cash", side: side, ordType: ordType, sz: sz };
  if (ordType === "market") payload.tgtCcy = side === "buy" ? "quote_ccy" : "base_ccy";
  if (ordType === "limit" && draft.px) payload.px = String(draft.px);
  const body = await okxPrivate("POST", "/api/v5/trade/order", payload);
  const row = body && body.data && body.data[0];
  if (!body || body.code !== "0" || !row) {
    return { ok: false, message: (body && (body.msg || (row && row.sMsg))) || "rejected" };
  }
  return { ok: true, ordId: String(row.ordId || ""), instId: instId, side: side, sz: sz };
}

async function replyChat(chatId, text) {
  if (!XAI) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "No XAI_API_KEY bound. Desk chat is Grok only. Bind an XAI secret then install.sh.",
    });
    return;
  }
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: text },
  ];
  try {
    let msg = await grokTurn(messages);
    for (let hop = 0; hop < 4 && msg.tool_calls && msg.tool_calls.length; hop++) {
      messages.push(msg);
      for (let i = 0; i < msg.tool_calls.length; i++) {
        const call = msg.tool_calls[i];
        const name = call.function && call.function.name;
        let args = {};
        try { args = JSON.parse((call.function && call.function.arguments) || "{}"); } catch (e) { args = {}; }
        if (name === "order_preview") {
          const draft = {
            instId: String(args.instId || "BTC-USDT").toUpperCase(),
            side: args.side === "sell" ? "sell" : "buy",
            sz: String(args.sz || "25"),
            ordType: args.ordType === "limit" ? "limit" : "market",
            px: args.px ? String(args.px) : "",
          };
          pending.set(String(chatId), draft);
          await tg("sendMessage", {
            chat_id: chatId,
            text: "DRAFT " + draft.side + " " + draft.instId + " sz " + draft.sz + (draft.px ? " @ " + draft.px : " market") + "\nconfirm:true required",
            reply_markup: {
              inline_keyboard: [[
                { text: "Confirm", callback_data: "han_ord_yes" },
                { text: "Cancel", callback_data: "han_ord_no" },
              ]],
            },
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ ok: true, drafted: true, placed: false, draft: draft }),
          });
        } else {
          const out = await runTool(name, args);
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
        }
      }
      msg = await grokTurn(messages);
    }
    const out = String((msg && msg.content) || "").trim();
    if (out) await tg("sendMessage", { chat_id: chatId, text: out.slice(0, 3500) });
  } catch (e) {
    await tg("sendMessage", { chat_id: chatId, text: "model unavailable" });
  }
}

function attach(app) {
  app.use(function (req, res, next) {
    if (req.method !== "POST" || req.path !== "/telegram") return next();
    const cq = req.body && req.body.callback_query;
    const msg = req.body && req.body.message;
    if (cq) {
      const from = cq.from && cq.from.id;
      if (!allowed(from)) return next();
      const data = String(cq.data || "");
      if (data.indexOf("han_ord_") !== 0) return next();
      const chatId = cq.message && cq.message.chat && cq.message.chat.id;
      Promise.resolve()
        .then(function () {
          return tg("answerCallbackQuery", { callback_query_id: cq.id });
        })
        .then(function () {
          const draft = pending.get(String(from)) || pending.get(String(chatId));
          pending.delete(String(from));
          pending.delete(String(chatId));
          if (data === "han_ord_no") {
            return tg("sendMessage", { chat_id: chatId, text: "order cancelled" });
          }
          if (data === "han_ord_yes") {
            if (!draft) return tg("sendMessage", { chat_id: chatId, text: "no draft" });
            return placeDraft(draft).then(function (sent) {
              return tg("sendMessage", {
                chat_id: chatId,
                text: sent.ok ? ("filled ordId " + sent.ordId) : (sent.message || "rejected"),
              });
            });
          }
        })
        .catch(function () {});
      return next();
    }
    if (!msg) return next();
    const chatId = msg.chat && msg.chat.id;
    const text = String(msg.text || "").trim();
    if (!allowed(chatId) || !text || isCommand(text)) return next();
    replyChat(chatId, text).catch(function () {});
    return next();
  });
}

module.exports = { attach, pending };
