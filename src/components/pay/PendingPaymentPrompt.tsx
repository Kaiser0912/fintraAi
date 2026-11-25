"use client"

// FIN-28: "Did it go through?" — asked when you come back from the UPI app
// (or reopen Fintra) while a payment is pending. Yes logs it, No removes it.

import { useCallback, useEffect, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { clearPending, deletePayment, loadPending, markPaid, type PendingPayment } from "@/lib/payFlow"
import { clearPayDraft } from "@/lib/upiQr"

export const PAY_DONE_KEY = "fintra-pay-done"

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

export function PendingPaymentPrompt() {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, setPending] = useState<PendingPayment | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    const p = loadPending()
    setPending(p)
    if (!p) setOpen(false)
    return p
  }, [])

  useEffect(() => {
    // Reopened Fintra with a payment still pending (e.g. Android restarted it).
    const p = refresh()
    if (p && Date.now() - p.handedOffAt > 3000) setOpen(true)

    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      const cur = refresh()
      if (cur && Date.now() - cur.handedOffAt > 1500) setOpen(true)
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("fintra-pay-pending", refresh)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("fintra-pay-pending", refresh)
    }
  }, [refresh])

  if (!pending || !open || pathname?.startsWith("/pay/done")) return null

  async function yes() {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      await markPaid(pending.txId)
      try {
        sessionStorage.setItem(PAY_DONE_KEY, JSON.stringify(pending))
      } catch {}
      clearPending()
      clearPayDraft()
      router.push("/pay/done")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save. Try again.")
    } finally {
      setBusy(false)
    }
  }

  async function no() {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      await deletePayment(pending.txId)
      clearPending()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove it. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="pay-q">
      <div className="w-full max-w-md rounded-t-3xl bg-[var(--app-bg)] p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-xl sm:rounded-3xl">
        <h2 id="pay-q" className="text-lg font-semibold text-[var(--ink)]">
          Did it go through?
        </h2>
        <p className="mt-1 text-sm text-[var(--ink-2)]">
          <span className="tnum font-medium">{inr(pending.amount)}</span> to {pending.payeeName}
        </p>
        {error && <p className="mt-3 text-sm text-[var(--neg)]">{error}</p>}
        <div className="mt-5 flex flex-col gap-2">
          <button
            onClick={yes}
            disabled={busy}
            className="min-h-12 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--primary-foreground)] disabled:opacity-50"
          >
            Yes, it&apos;s paid
          </button>
          <button
            onClick={no}
            disabled={busy}
            className="min-h-12 rounded-xl border border-[var(--hairline-strong)] px-4 text-sm font-medium text-[var(--ink)] disabled:opacity-50"
          >
            No, it failed
          </button>
          <button onClick={() => setOpen(false)} disabled={busy} className="min-h-11 text-sm text-[var(--ink-3)]">
            Not yet — ask me later
          </button>
        </div>
      </div>
    </div>
  )
}
