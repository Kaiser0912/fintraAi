"use client"

// Scan to pay — step 3 (FIN-24/28). Hands the payment to a UPI app.
//  - verified shop QR: the QR goes to the UPI app exactly as scanned
//  - friend / small shop: copy the UPI ID, open the UPI app, pay there
// The payment is saved as pending first; PendingPaymentPrompt asks
// "Did it go through?" when you come back.

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeft, Check, Copy, ExternalLink } from "lucide-react"
import { loadPayDraft, looksLikeMerchant, type PayDraft } from "@/lib/upiQr"
import {
  UPI_APPS,
  copyText,
  createPendingPayment,
  loadPending,
  openShopQr,
  openUpiApp,
  savePending,
  type UpiApp,
} from "@/lib/payFlow"

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

export default function PayGoPage() {
  const router = useRouter()
  const [draft, setDraft] = useState<PayDraft | null>(null)
  const [mode, setMode] = useState<"shop" | "id">("id")
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
    setMode(looksLikeMerchant(d.target) && d.target.raw ? "shop" : "id")
  }, [router])

  if (!draft) return <div className="mx-auto max-w-md px-5 pt-6" />

  const t = draft.target
  const amount = draft.amount as number
  const name = draft.payeeName || t.name || t.upiId
  const qrHasAmount = t.amount != null

  /** Saves the pending payment once; later taps reuse it. */
  async function ensurePending() {
    const existing = loadPending()
    if (existing && existing.upiId === t.upiId && existing.amount === amount) return existing
    const p = await createPendingPayment(draft as PayDraft)
    savePending(p)
    return p
  }

  async function payShop() {
    setBusy(true)
    setError(null)
    try {
      const p = await ensurePending()
      savePending({ ...p, handedOffAt: Date.now() })
      openShopQr(t.raw as string)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the payment.")
    } finally {
      setBusy(false)
    }
  }

  async function onCopy() {
    setCopied(await copyText(t.upiId))
  }

  async function openApp(app: UpiApp) {
    setBusy(true)
    setError(null)
    setManualApp(null)
    try {
      setCopied(await copyText(t.upiId))
      const p = await ensurePending()
      savePending({ ...p, handedOffAt: Date.now() })
      const opened = await openUpiApp(app)
      if (!opened) setManualApp(app.label)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the payment.")
    } finally {
      setBusy(false)
    }
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

      {mode === "shop" ? (
        <section className="space-y-3">
          <button
            onClick={payShop}
            disabled={busy}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--primary-foreground)] disabled:opacity-50"
          >
            Pay in your UPI app
            <ExternalLink className="h-4 w-4" aria-hidden />
          </button>
          {!qrHasAmount && (
            <p className="text-sm text-[var(--ink-2)]">
              This QR has no amount: enter <strong className="tnum">{inr(amount)}</strong> in the UPI app.
            </p>
          )}
          <button onClick={() => setMode("id")} className="text-sm text-[var(--ink-3)] underline">
            Didn&apos;t work? Pay with the UPI ID instead
          </button>
        </section>
      ) : (
        <section className="space-y-4">
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
          {looksLikeMerchant(t) && t.raw && (
            <button onClick={() => setMode("shop")} className="text-sm text-[var(--ink-3)] underline">
              Use the shop&apos;s QR instead
            </button>
          )}
        </section>
      )}

      <p className="text-center text-xs text-[var(--ink-3)]">
        When you come back, Fintra asks if the payment went through before logging it.
      </p>
    </div>
  )
}
