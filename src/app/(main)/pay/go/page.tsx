"use client"

// Scan to pay — step 3 (FIN-24/28). Hands the payment to a UPI app.
//  - verified shop QR: the QR goes to the UPI app exactly as scanned
//  - friend / small shop: "quick pay" opens the UPI app with payee and amount
//    filled in; if that app refuses (NPCI lets it), we remember and fall back
//    to copy the UPI ID → open the UPI app → pay there
// The payment is saved as pending first; PendingPaymentPrompt asks
// "Did it go through?" when you come back.

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeft, Check, Copy, ExternalLink, Zap } from "lucide-react"
import { loadPayDraft, looksLikeMerchant, type PayDraft } from "@/lib/upiQr"
import {
  PAY_FALLBACK_KEY,
  UPI_APPS,
  clearQuickPayBlocked,
  copyText,
  createPendingPayment,
  loadPending,
  openQuickPay,
  openShopQr,
  openUpiApp,
  quickPayBlocked,
  savePending,
  type PendingPayment,
  type UpiApp,
} from "@/lib/payFlow"

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

type Mode = "shop" | "quick" | "id"

export default function PayGoPage() {
  const router = useRouter()
  const [draft, setDraft] = useState<PayDraft | null>(null)
  const [mode, setMode] = useState<Mode>("id")
  const [blocked, setBlocked] = useState<string[]>([])
  const [fallbackNote, setFallbackNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [manualApp, setManualApp] = useState<string | null>(null)

  useEffect(() => {
    const d = loadPayDraft()
    if (!d || !d.amount || !d.categoryId) {
      router.replace(d ? "/pay/payee" : "/pay")
      return
    }
    setDraft(d)
    const b = quickPayBlocked()
    setBlocked(b)

    // Coming back after a failed hand-off: open on the copy-the-UPI-ID way.
    let fallback: string | null = null
    try {
      fallback = sessionStorage.getItem(PAY_FALLBACK_KEY)
      sessionStorage.removeItem(PAY_FALLBACK_KEY)
    } catch {}
    if (fallback) {
      setFallbackNote(
        fallback === "shop"
          ? "The shop's QR didn't go through. Pay with the UPI ID instead:"
          : `${fallback} refused the pre-filled payment (UPI rules for personal IDs and small shops). Pay inside the app instead:`
      )
      setMode("id")
      return
    }
    if (looksLikeMerchant(d.target) && d.target.raw) setMode("shop")
    else setMode(UPI_APPS.every((a) => b.includes(a.id)) ? "id" : "quick")
  }, [router])

  if (!draft) return <div className="mx-auto max-w-md px-5 pt-6" />

  const t = draft.target
  const amount = draft.amount as number
  const name = draft.payeeName || t.name || t.upiId
  const quickApps = UPI_APPS.filter((a) => !blocked.includes(a.id))

  /** Saves the pending payment once; later taps reuse it. */
  async function handOff(how: Pick<PendingPayment, "method" | "appId" | "appLabel">) {
    const existing = loadPending()
    const p =
      existing && existing.upiId === t.upiId && existing.amount === amount
        ? existing
        : await createPendingPayment(draft as PayDraft)
    savePending({ ...p, ...how, handedOffAt: Date.now() })
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setManualApp(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the payment.")
    } finally {
      setBusy(false)
    }
  }

  const payShop = () =>
    run(async () => {
      await handOff({ method: "shop" })
      openShopQr(t.raw as string, amount)
    })

  const quickPay = (app: UpiApp) =>
    run(async () => {
      await handOff({ method: "quick", appId: app.id, appLabel: app.label })
      openQuickPay(app, { upiId: t.upiId, name, amount, note: draft.purpose })
    })

  const openApp = (app: UpiApp) =>
    run(async () => {
      setCopied(await copyText(t.upiId))
      await handOff({ method: "copy", appId: app.id, appLabel: app.label })
      if (!(await openUpiApp(app))) setManualApp(app.label)
    })

  async function onCopy() {
    setCopied(await copyText(t.upiId))
  }

  function retryQuick() {
    clearQuickPayBlocked()
    setBlocked([])
    setFallbackNote(null)
    setMode("quick")
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 px-5 pb-28 pt-6">
      <header>
        <button
          onClick={() => router.back()}
          className="flex min-h-10 items-center gap-1 rounded-full pr-3 text-sm text-[var(--ink-3)] hover:bg-[var(--surface-2)]"
        >
          <ArrowLeft className="ml-2 h-5 w-5" aria-hidden />
          Edit details
        </button>
      </header>

      <section className="rounded-2xl border border-[var(--hairline)] p-5 text-center">
        <p className="text-sm text-[var(--ink-3)]">Paying</p>
        <p className="mt-1 truncate text-lg font-medium text-[var(--ink)]">{name}</p>
        <p className="tnum mt-2 text-4xl font-semibold text-[var(--ink)]">{inr(amount)}</p>
        <p className="mt-2 text-xs text-[var(--ink-3)]">
          {[draft.categoryName, draft.purpose !== draft.categoryName && draft.purpose, draft.split && `your share ${inr(draft.split.share)}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </section>

      {error && (
        <p role="alert" className="rounded-xl bg-[var(--neg-bg)] px-4 py-3 text-sm text-[var(--neg)]">
          {error}
        </p>
      )}

      {mode === "shop" && (
        <section className="space-y-3">
          <button
            onClick={payShop}
            disabled={busy}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--primary-foreground)] disabled:opacity-50"
          >
            Pay in your UPI app
            <ExternalLink className="h-4 w-4" aria-hidden />
          </button>
          <button onClick={() => setMode("id")} className="text-sm text-[var(--ink-3)] underline">
            Didn&apos;t work? Pay with the UPI ID instead
          </button>
        </section>
      )}

      {mode === "quick" && (
        <section className="space-y-3">
          <div className="rounded-2xl border border-[var(--hairline)] p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
              <Zap className="h-4 w-4" aria-hidden />
              Pay with the amount filled in
            </p>
            <p className="mt-1 text-xs text-[var(--ink-3)]">
              Opens the app with {name} and {inr(amount)} ready. Some apps refuse this for personal UPI IDs; if yours
              does, no money moves and Fintra switches to the other way.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {quickApps.map((app) => (
                <button
                  key={app.id}
                  onClick={() => quickPay(app)}
                  disabled={busy}
                  className="min-h-11 rounded-xl bg-[var(--brand)] px-3 text-sm font-semibold text-[var(--primary-foreground)] disabled:opacity-50"
                >
                  {app.label}
                </button>
              ))}
            </div>
          </div>
          <button onClick={() => setMode("id")} className="text-sm text-[var(--ink-3)] underline">
            Pay with the UPI ID instead
          </button>
        </section>
      )}

      {mode === "id" && (
        <section className="space-y-4">
          {fallbackNote && (
            <p role="status" className="rounded-xl bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--ink-2)]">
              {fallbackNote}
            </p>
          )}
          <ol className="space-y-4">
            <li className="rounded-2xl border border-[var(--hairline)] p-4">
              <p className="text-sm font-medium text-[var(--ink)]">1. Copy the UPI ID</p>
              <button
                onClick={onCopy}
                className="mt-3 flex min-h-11 w-full items-center justify-between gap-3 rounded-xl bg-[var(--surface-2)] px-4 text-left"
              >
                <span className="truncate font-mono text-sm text-[var(--ink)]">{t.upiId}</span>
                <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-[var(--ink-2)]">
                  {copied ? <Check className="h-4 w-4 text-[var(--pos)]" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy"}
                </span>
              </button>
            </li>
            <li className="rounded-2xl border border-[var(--hairline)] p-4">
              <p className="text-sm font-medium text-[var(--ink)]">2. Open your UPI app and pay {inr(amount)}</p>
              <p className="mt-1 text-xs text-[var(--ink-3)]">
                Choose &quot;Pay UPI ID&quot; there and paste. Paying from inside the app avoids the bank limit error.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {UPI_APPS.map((app) => (
                  <button
                    key={app.id}
                    onClick={() => openApp(app)}
                    disabled={busy}
                    className="min-h-11 rounded-xl border border-[var(--hairline-strong)] px-3 text-sm font-medium text-[var(--ink)] disabled:opacity-50"
                  >
                    {app.label}
                  </button>
                ))}
              </div>
              {manualApp && (
                <p role="status" className="mt-3 text-sm text-[var(--ink-2)]">
                  UPI ID copied. Open {manualApp} yourself, pay {inr(amount)}, then come back here.
                </p>
              )}
            </li>
          </ol>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {looksLikeMerchant(t) && t.raw && (
              <button onClick={() => setMode("shop")} className="text-sm text-[var(--ink-3)] underline">
                Use the shop&apos;s QR instead
              </button>
            )}
            {!(looksLikeMerchant(t) && t.raw) && (
              <button onClick={retryQuick} className="text-sm text-[var(--ink-3)] underline">
                Try with the amount filled in
              </button>
            )}
          </div>
        </section>
      )}

      <p className="text-center text-xs text-[var(--ink-3)]">
        When you come back, Fintra asks if the payment went through before logging it.
      </p>
    </div>
  )
}
