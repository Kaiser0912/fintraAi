"use client"

// FIN-4 spike: does a upi://pay link from Fintra work in each UPI app, for a
// shop (merchant) UPI ID and a friend's (personal) one, with and without the
// amount pre-filled? Results stay on this device and can be copied out.
//
// Every test is a REAL payment the user approves with their UPI PIN in the
// UPI app — keep the amount at ₹1.

import { useEffect, useMemo, useState } from "react"

type Target = "merchant" | "personal"
type Status = "" | "worked" | "blocked" | "error" | "not-installed"

// pkg: Android package (used in Chrome via intent:// links).
// scheme: the app's own link prefix (used inside the Fintra app, whose shell
// opens links with a plain VIEW intent and can't follow intent:// links).
const APPS = [
  { id: "any", label: "Any UPI app", pkg: null, scheme: "upi://pay" },
  { id: "gpay", label: "Google Pay", pkg: "com.google.android.apps.nbu.paisa.user", scheme: "tez://upi/pay" },
  { id: "phonepe", label: "PhonePe", pkg: "com.phonepe.app", scheme: "phonepe://pay" },
  { id: "paytm", label: "Paytm", pkg: "net.one97.paytm", scheme: "paytmmp://pay" },
  { id: "bhim", label: "BHIM", pkg: "in.org.npci.upiapp", scheme: "upi://pay" },
] as const

const STATUS_LABEL: Record<Exclude<Status, "">, string> = {
  worked: "Worked",
  blocked: "Blocked / declined",
  error: "Error / wrong details",
  "not-installed": "Not installed",
}

const STORE = "fintra-upi-test-v1"
const UPI_RE = /^[a-z0-9._-]{2,255}@[a-z0-9]{2,64}$/i

function buildQuery(upiId: string, name: string, amount: string, note: string, withAmount: boolean) {
  const q = new URLSearchParams({ pa: upiId.trim(), pn: name.trim() || "Fintra test", cu: "INR" })
  if (withAmount && amount) q.set("am", Number(amount).toFixed(2))
  if (note.trim()) q.set("tn", note.trim())
  return q.toString()
}

function linkFor(app: (typeof APPS)[number], query: string, inApp: boolean) {
  if (inApp || !app.pkg) return `${app.scheme}?${query}`
  return `intent://pay?${query}#Intent;scheme=upi;package=${app.pkg};end`
}

export default function UpiTestPage() {
  const [payees, setPayees] = useState({
    merchant: { upi: "", name: "" },
    personal: { upi: "", name: "" },
  })
  const [amount, setAmount] = useState("1")
  const [note, setNote] = useState("Fintra UPI test")
  const [results, setResults] = useState<Record<string, Status>>({})
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}")
      if (saved.payees) setPayees(saved.payees)
      if (saved.results) setResults(saved.results)
    } catch {}
  }, [])
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ payees, results })) } catch {}
  }, [payees, results])

  // Known only in the browser; set after mount to keep server and client HTML identical.
  const [where, setWhere] = useState("Browser")
  useEffect(() => {
    const native = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()
    if (native) setWhere("Fintra app")
  }, [])

  const key = (t: Target, app: string, withAmount: boolean) => `${where}|${t}|${app}|${withAmount ? "amount" : "no-amount"}`

  const table = useMemo(() => {
    const rows = Object.entries(results)
      .filter(([, s]) => s)
      .map(([k, s]) => {
        const [w, t, app, am] = k.split("|")
        return `| ${w} | ${t === "merchant" ? "Shop" : "Friend"} | ${APPS.find((a) => a.id === app)?.label ?? app} | ${am === "amount" ? "pre-filled" : "typed in app"} | ${STATUS_LABEL[s as Exclude<Status, "">]} |`
      })
    return ["| Opened from | Payee | App | Amount | Result |", "|---|---|---|---|---|", ...rows].join("\n")
  }, [results])

  async function copy() {
    try {
      await navigator.clipboard.writeText(table)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt("Copy the results:", table)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-3)]">Lab · FIN-4</p>
        <h1 className="text-2xl font-semibold text-[var(--ink)]">UPI link test</h1>
        <p className="text-sm text-[var(--ink-2)]">
          Checks whether paying from Fintra works in each UPI app. Each button opens a real payment that you approve with
          your UPI PIN, so keep the amount at <strong>₹1</strong>. After each one, come back and mark what happened.
          Open this page in the <strong>Fintra app</strong> and in <strong>Chrome</strong> — results are kept separately.
        </p>
        <p className="text-xs text-[var(--ink-3)]">Opened from: <strong>{where}</strong></p>
      </header>

      <section className="grid gap-4 rounded-xl border border-[var(--hairline)] p-4 sm:grid-cols-2">
        {(["merchant", "personal"] as Target[]).map((t) => (
          <div key={t} className="space-y-2">
            <p className="text-sm font-medium text-[var(--ink)]">
              {t === "merchant" ? "Shop UPI ID (from a shop's QR)" : "Friend's UPI ID"}
            </p>
            <input
              className="w-full rounded-lg border border-[var(--hairline)] bg-transparent px-3 py-2 text-sm"
              placeholder={t === "merchant" ? "shopname@okaxis" : "friend@oksbi"}
              value={payees[t].upi}
              onChange={(e) => setPayees({ ...payees, [t]: { ...payees[t], upi: e.target.value } })}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <input
              className="w-full rounded-lg border border-[var(--hairline)] bg-transparent px-3 py-2 text-sm"
              placeholder="Name shown in the UPI app"
              value={payees[t].name}
              onChange={(e) => setPayees({ ...payees, [t]: { ...payees[t], name: e.target.value } })}
            />
            {payees[t].upi && !UPI_RE.test(payees[t].upi.trim()) && (
              <p className="text-xs text-[var(--neg)]">That doesn&apos;t look like a UPI ID (name@bank).</p>
            )}
          </div>
        ))}
        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--ink)]">Amount (₹)</p>
          <input
            className="w-full rounded-lg border border-[var(--hairline)] bg-transparent px-3 py-2 text-sm"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--ink)]">Note</p>
          <input
            className="w-full rounded-lg border border-[var(--hairline)] bg-transparent px-3 py-2 text-sm"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </section>

      {(["merchant", "personal"] as Target[]).map((t) => {
        const ok = UPI_RE.test(payees[t].upi.trim())
        return (
          <section key={t} className="space-y-3">
            <h2 className="text-lg font-semibold text-[var(--ink)]">{t === "merchant" ? "Pay the shop" : "Pay the friend"}</h2>
            {!ok && <p className="text-sm text-[var(--ink-3)]">Enter a valid UPI ID above first.</p>}
            {ok &&
              APPS.map((app) => (
                <div key={app.id} className="rounded-xl border border-[var(--hairline)] p-3">
                  <p className="mb-2 text-sm font-medium text-[var(--ink)]">{app.label}</p>
                  {[true, false].map((withAmount) => {
                    const k = key(t, app.id, withAmount)
                    const href = linkFor(app, buildQuery(payees[t].upi, payees[t].name, amount, note, withAmount), where === "Fintra app")
                    return (
                      <div key={String(withAmount)} className="mb-2 flex flex-wrap items-center gap-2">
                        <a
                          href={href}
                          className="rounded-lg bg-[var(--accent,#2e5f4c)] px-3 py-2 text-sm font-medium text-white"
                        >
                          {withAmount ? `Pay ₹${amount || "?"} (pre-filled)` : "Pay (type amount in app)"}
                        </a>
                        <select
                          className="rounded-lg border border-[var(--hairline)] bg-transparent px-2 py-2 text-sm"
                          value={results[k] ?? ""}
                          onChange={(e) => setResults({ ...results, [k]: e.target.value as Status })}
                        >
                          <option value="">Result…</option>
                          {Object.entries(STATUS_LABEL).map(([v, l]) => (
                            <option key={v} value={v}>{l}</option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                </div>
              ))}
          </section>
        )
      })}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-[var(--ink)]">Results</h2>
        <pre className="overflow-x-auto rounded-xl border border-[var(--hairline)] p-3 text-xs">{table}</pre>
        <div className="flex gap-2">
          <button onClick={copy} className="rounded-lg border border-[var(--hairline)] px-3 py-2 text-sm">
            {copied ? "Copied" : "Copy results"}
          </button>
          <button
            onClick={() => setResults({})}
            className="rounded-lg border border-[var(--hairline)] px-3 py-2 text-sm text-[var(--ink-3)]"
          >
            Clear results
          </button>
        </div>
      </section>
    </div>
  )
}
