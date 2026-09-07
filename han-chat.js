"use strict";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED = String(process.env.ALLOWED_CHAT_ID || "8713335385");
const GEMINI = process.env.GEMINI_API_KEY || "";
const XAI = process.env.XAI_API_KEY || "";
const TG = "https://api.telegram.org/bot";
const MODEL = { gemini: "gemini-2.0-flash", grok: "grok-3" };
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
  if (/^(ticker|balance|id|buy|sell|kill|arm)\b/.test(t)) return true;
  if (t === "\uC2DC\uC138" || t === "\uC794\uACE0") return true;
  return false;
}

function systemPrompt() {
  return [
    "You are HAN, a live OKX spot desk in Telegram.",
    "Reply short. Korean if the user writes Korean.",
    "You may quote public market context. You must not claim a fill unless a tool returned an ordId.",
    "Never place an order in prose. Use the order_preview tool. Live auto stays disarmed until the user ARMs in the Mini App or /arm with confirm.",
    "No seeds, no private keys, no LET/WAL.",
  ].join(" ");
}

async function geminiChat(userText) {
  if (!GEMINI) throw new Error("GEMINI_API_KEY missing");
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    MODEL.gemini +
    ":generateContent?key=" +
    encodeURIComponent(GEMINI);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
    }),
  });
  const body = await res.json();
  const text =
    body &&
    body.candidates &&
    body.candidates[0] &&
    body.candidates[0].content &&
    body.candidates[0].content.parts &&
    body.candidates[0].content.parts[0] &&
    body.candidates[0].content.parts[0].text;
  if (!text) throw new Error((body && body.error && body.error.message) || "gemini empty");
  return text;
}

async function grokChat(userText) {
  if (!XAI) throw new Error("XAI_API_KEY missing");
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + XAI,
    },
    body: JSON.stringify({
      model: MODEL.grok,
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: userText },
      ],
    }),
  });
  const body = await res.json();
  const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  if (!text) throw new Error((body && body.error && body.error.message) || "grok empty");
  return text;
}

function pickModel(text) {
  const u = String(text || "").toLowerCase();
  if (/\bgrok\b/.test(u) && XAI) return "grok";
  if (/\bgemini\b/.test(u) && GEMINI) return "gemini";
  if (GEMINI) return "gemini";
  if (XAI) return "grok";
  return null;
}

async function replyChat(chatId, text) {
  const model = pickModel(text);
  if (!model) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "No Gemini/Grok key bound. Bind GEMINI_API_KEY=Gemini_API_key (and XAI_API_KEY if you have it).",
    });
    return;
  }
  try {
    const out = model === "grok" ? await grokChat(text) : await geminiChat(text);
    await tg("sendMessage", { chat_id: chatId, text: String(out).slice(0, 3500) });
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
      if (data.indexOf("han_") !== 0) return next();
      Promise.resolve()
        .then(function () {
          return tg("answerCallbackQuery", { callback_query_id: cq.id });
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
