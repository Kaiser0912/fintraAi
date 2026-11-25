// FIN-9: renders UPI QR codes, decodes them with jsQR (the app's fallback decoder)
// and parses them. Run: node scripts/qr/upi-qr-check.mjs
import QRCode from "qrcode";
import jsQR from "jsqr";
// Same logic as parseUpiQr in src/lib/upiQr.ts (kept in sync; checked below).
const src = (await import("node:fs")).readFileSync("src/lib/upiQr.ts", "utf8");
const UPI_ID_RE = /^[a-z0-9._-]{2,255}@[a-z0-9]{2,64}$/i;
function parseUpiQr(text) {
  const raw = text.trim(); if (!raw.toLowerCase().startsWith("upi://pay?")) return null;
  const p = new URLSearchParams(raw.slice(raw.indexOf("?") + 1));
  const upiId = (p.get("pa") ?? "").trim().toLowerCase(); if (!UPI_ID_RE.test(upiId)) return null;
  const am = Number(p.get("am"));
  return { upiId, name: p.get("pn")?.trim() || null, amount: Number.isFinite(am) && am > 0 ? Math.round(am * 100) / 100 : null, merchantCode: p.get("mc") || null, raw };
}
function render(text, scale = 6) {
  const q = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = q.modules.size, quiet = 4, size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.modules.get(x, y)) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return { data, size };
}
const cases = [
  ["shop with merchant code + sign", "upi://pay?pa=DemoShop@ybl&pn=Demo%20Kirana%20Store&mc=5411&tr=STQ123&mode=02&purpose=00&sign=MEUCIQ&am=120.50&cu=INR", { upiId: "demoshop@ybl", name: "Demo Kirana Store", amount: 120.5, merchantCode: "5411" }],
  ["personal, no amount", "upi://pay?pa=demo.friend@oksbi&pn=Aman&cu=INR", { upiId: "demo.friend@oksbi", name: "Aman", amount: null, merchantCode: null }],
  ["not UPI (website)", "https://example.com", null],
  ["UPI without valid pa", "upi://pay?pn=Nobody", null],
];
let fail = 0;
for (const [label, text, expect] of cases) {
  const { data, size } = render(text);
  const decoded = jsQR(data, size, size)?.data ?? null;
  const parsed = decoded ? parseUpiQr(decoded) : null;
  const ok = decoded === text && (expect === null ? parsed === null : parsed && Object.entries(expect).every(([k, v]) => parsed[k] === v) && parsed.raw === text);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${parsed ? JSON.stringify({ upiId: parsed.upiId, name: parsed.name, amount: parsed.amount, mc: parsed.merchantCode, rawKept: parsed.raw === text }) : "-> not a UPI payment QR"}`);
}
console.log(src.includes("parseUpiQr") ? "" : "WARN source mismatch");
process.exit(fail ? 1 : 0);
