// HAN observe-only widget. No keys. Paste into Scriptable.
// Parameter: 0 / 1 / 2 for Smart Stack copies, or a symbol like BTC-USDT.
const HOST = "https://quantum-server-402813283609.europe-north2.run.app";

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function fmt(v) {
  v = n(v);
  if (!v) return "—";
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(Number(v.toPrecision(6)));
}

async function loadIndex() {
  const req = new Request(HOST + "/api/index");
  req.timeoutInterval = 20;
  return req.loadJSON();
}

function pickRow(rows) {
  const p = String(args.widgetParameter || "").trim();
  if (!rows || !rows.length) return null;
  if (/^[A-Z0-9.-]+$/i.test(p) && /[A-Za-z]/.test(p) && !/^\d+$/.test(p)) {
    const hit = rows.find((r) => String(r.id).toUpperCase() === p.toUpperCase());
    if (hit) return hit;
  }
  const i = Math.abs(parseInt(p, 10) || 0) % rows.length;
  return rows[i];
}

function sparkPath(spark, w, h) {
  const vals = (spark || []).map(n).filter((x) => x > 0);
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  let d = "";
  vals.forEach((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - ((v - min) / span) * h;
    d += (i ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1);
  });
  return d;
}

const j = await loadIndex();
const row = pickRow(j.rows || []);
const w = new ListWidget();
w.backgroundColor = new Color("#090b0e");
w.url = HOST + "/app";
w.setPadding(12, 14, 12, 14);
w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);

const k = w.addText("HAN");
k.font = Font.mediumSystemFont(10);
k.textColor = new Color("#5c6470");

if (!row) {
  const t = w.addText("index empty");
  t.textColor = new Color("#8a929e");
  t.font = Font.systemFont(13);
} else {
  const title = w.addText(String(row.id).replace("-USDT", ""));
  title.font = Font.semiboldSystemFont(13);
  title.textColor = new Color("#eef1f5");
  const last = w.addText(fmt(row.last));
  last.font = Font.mediumSystemFont(22);
  last.textColor = new Color("#eef1f5");
  const pct = n(row.chgPct);
  const chg = w.addText((pct >= 0 ? "+" : "") + pct.toFixed(2) + "%");
  chg.font = Font.mediumSystemFont(12);
  chg.textColor = new Color(pct >= 0 ? "#5ec98a" : "#e06a72");
  const dc = new DrawContext();
  dc.size = new Size(240, 48);
  dc.opaque = false;
  const path = sparkPath(row.spark, 240, 48);
  if (path) {
    const p = new Path();
    // DrawContext has no SVG path parser; plot points.
    const vals = (row.spark || []).map(n).filter((x) => x > 0);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const line = new Path();
    vals.forEach((v, i) => {
      const x = (i / (vals.length - 1)) * 240;
      const y = 48 - ((v - min) / span) * 44 - 2;
      if (i === 0) line.move(new Point(x, y));
      else line.addLine(new Point(x, y));
    });
    dc.setStrokeColor(new Color(pct >= 0 ? "#5ec98a" : "#e06a72"));
    dc.setLineWidth(2);
    dc.addPath(line);
    dc.strokePath();
    const img = dc.getImage();
    const im = w.addImage(img);
    im.imageSize = new Size(140, 28);
  }
}

if (config.runsInWidget) {
  Script.setWidget(w);
} else {
  await w.presentSmall();
}
Script.complete();
