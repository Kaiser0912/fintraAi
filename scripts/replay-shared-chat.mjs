// Replay test for FIN-35: the chat agent handles shared bills and settle-ups.
//
// Runs against LOCAL Supabase and the app on http://localhost:3100 pointed at
// it (see .claude/launch.json "fintra-local-supabase"). Uses the local-only
// seed login (supabase/seed.sql). Never point this at prod.
//
//   node scripts/replay-shared-chat.mjs
//
// The model's wording varies, so checks look at what was saved, not the text.

const APP = process.env.APP_URL ?? "http://localhost:3100";
const SUPA = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const EMAIL = "test@fintra.local";
const PASSWORD = "fintra-local-test";

if (!/localhost|127\.0\.0\.1/.test(APP + SUPA)) {
  console.error("Refusing to run against a non-local URL.");
  process.exit(1);
}

const ANON = process.env.LOCAL_ANON_KEY;
if (!ANON) {
  console.error("Set LOCAL_ANON_KEY to the local anon key (npx supabase status -o env).");
  process.exit(1);
}

const session = await (
  await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
).json();
if (!session.access_token) throw new Error("Local sign-in failed: " + JSON.stringify(session));

const ref = new URL(SUPA).hostname.split(".")[0];
const cookie = `sb-${ref}-auth-token=base64-` + Buffer.from(JSON.stringify(session)).toString("base64url");
const rest = async (path) =>
  (await fetch(`${SUPA}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}` } })).json();

async function chat(message) {
  const r = await fetch(`${APP}/api/chat`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "replay-" + Date.now() + Math.random(), messages: [{ role: "user", content: message }] }),
  });
  const text = await r.text();
  const events = text.split("\n\n").filter(Boolean).map((l) => { try { return JSON.parse(l.replace(/^data: /, "")); } catch { return {}; } });
  return {
    status: r.status,
    tools: events.filter((e) => e.type === "tool_start").map((e) => e.name || e.tool),
    answer: events.filter((e) => e.type === "token").map((e) => e.content ?? "").join(""),
  };
}

const tag = "r" + Date.now().toString(36);
const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
// Rows are matched by "created during this case", not by note text: the model may reword notes.
const newest = async (filter, since) => (await rest(`transactions?select=*&${filter}&created_at=gt.${encodeURIComponent(since)}&order=created_at.desc&limit=1`))[0];
const now = () => new Date(Date.now() - 2000).toISOString();
const countSince = async (filter, since) => (await rest(`transactions?select=id&${filter}&created_at=gt.${encodeURIComponent(since)}`)).length;

// 1. split with a stated share
let t0 = now();
let c = await chat(`2000 dinner today, my share 350, note dinner ${tag}`);
let row = await newest(`type=eq.expense&split_total=eq.2000`, t0);
check("split saved exactly once", (await countSince(`type=eq.expense&split_total=eq.2000`, t0)) === 1);
check("split: '2000 dinner, my share 350'", row && Number(row.amount) === 350 && Number(row.paid_amount) === 2000 && Number(row.split_total) === 2000 && !row.split_payer, `tools ${c.tools} → amount ${row?.amount}, paid ${row?.paid_amount}`);

// 2. someone else paid, equal split
t0 = now();
c = await chat(`Priya paid 1200 for the movie today, 3 of us, note movie ${tag}`);
row = await newest(`type=eq.expense&split_total=eq.1200`, t0);
check("someone-else-paid saved exactly once", (await countSince(`type=eq.expense&split_total=eq.1200`, t0)) === 1);
check("someone else paid: 'Priya paid 1200, 3 of us'", row && Number(row.amount) === 400 && Number(row.paid_amount) === 0 && /priya/i.test(row.split_payer ?? "") && row.split_people === 3, `tools ${c.tools} → amount ${row?.amount}, payer ${row?.split_payer}`);

// 3. settle-up in
t0 = now();
c = await chat(`Rahul paid me back 500 today`);
row = await newest(`type=eq.transfer&transfer_direction=eq.in`, t0);
check("settle-up saved exactly once", (await countSince(`type=eq.transfer&transfer_direction=eq.in`, t0)) === 1);
check("settle-up: 'Rahul paid me back 500'", row && Number(row.amount) === 500 && /rahul/i.test(row.counterparty ?? "") && c.tools.includes("settle_up"), `tools ${c.tools}`);

// 4. how much did I front
c = await chat(`How much did I front for friends this month?`);
const month = new Date().toISOString().slice(0, 7);
const [yy, mm] = month.split("-").map(Number);
const lastDay = `${month}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, "0")}`;
const summary = await (await fetch(`${APP}/api/shared?month=${month}`, { headers: { Cookie: cookie } })).json();
const frontedText = summary.fronted.toLocaleString("en-IN");
check("'how much did I front this month'", c.tools.includes("get_shared_summary") && (c.answer.includes(frontedText) || c.answer.includes(String(summary.fronted))), `tools ${c.tools}; fronted ₹${summary.fronted}`);

// 5. totals use the share only
const totals = await (await fetch(`${APP}/api/summary?startDate=${month}-01&endDate=${lastDay}`, { headers: { Cookie: cookie } })).json();
const sums = await rest(`transactions?select=amount,type,status&type=eq.expense&status=eq.paid&date=gte.${month}-01&date=lte.${lastDay}`);
const expected = Math.round(sums.reduce((a, r) => a + Number(r.amount), 0) * 100) / 100;
check("spending total = sum of shares (not cash paid)", Number(totals.total?.totalExpense) === expected, `${totals.total?.totalExpense} vs ${expected}`);

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
