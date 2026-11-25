"use client"

// FIN-32: Logged — confirms what was saved, with Undo.

import { useEffect, useState } from "react"
import Link from "next/link"
import { CheckCircle2, Undo2 } from "lucide-react"
import { deletePayment, type PendingPayment } from "@/lib/payFlow"
import { PAY_DONE_KEY } from "@/components/pay/PendingPaymentPrompt"

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

export default function PayDonePage() {
  const [done, setDone] = useState<PendingPayment | null | undefined>(undefined)
  const [undone, setUndone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      setDone(JSON.parse(sessionStorage.getItem(PAY_DONE_KEY) ?? "null"))
    } catch {
      setDone(null)
    }
  }, [])

  async function undo() {
    if (!done) return
    setBusy(true)
    setError(null)
    try {
      await deletePayment(done.txId)
      setUndone(true)
      try {
        sessionStorage.removeItem(PAY_DONE_KEY)
      } catch {}
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't undo. Try again.")
    } finally {
      setBusy(false)
    }
  }

  if (done === undefined) return <div className="mx-auto max-w-md px-5 pt-6" />

  const buttons = (
    <div className="mt-8 grid w-full grid-cols-2 gap-3">
      <Link
        href="/dashboard"
        className="flex min-h-12 items-center justify-center rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--primary-foreground)]"
      >
        Done
      </Link>
      <Link
        href="/pay"
        className="flex min-h-12 items-center justify-center rounded-xl border border-[var(--hairline-strong)] px-4 text-sm font-medium text-[var(--ink)]"
      >
        Pay again
      </Link>
    </div>
  )

  if (!done) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-5 pt-16 text-center">
        <p className="text-[var(--ink-2)]">Nothing to show here.</p>
        {buttons}
      </div>
    )
  }

  const owed = Math.round((done.amount - done.share) * 100) / 100

  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-5 pb-28 pt-16 text-center">
      {undone ? (
        <>
          <Undo2 className="h-12 w-12 text-[var(--ink-3)]" aria-hidden />
          <h1 className="mt-4 text-xl font-semibold text-[var(--ink)]">Removed</h1>
          <p className="mt-2 text-sm text-[var(--ink-2)]">
            The {inr(done.amount)} payment to {done.payeeName} is no longer logged.
          </p>
        </>
      ) : (
        <>
          <CheckCircle2 className="h-12 w-12 text-[var(--pos)]" aria-hidden />
          <h1 className="mt-4 text-xl font-semibold text-[var(--ink)]">Logged</h1>
          <p className="tnum mt-2 text-3xl font-semibold text-[var(--ink)]">{inr(done.amount)}</p>
          <p className="mt-1 text-sm text-[var(--ink-2)]">
            to {done.payeeName}
            {done.categoryName ? ` · ${done.categoryName}` : ""}
          </p>
          {owed > 0 && (
            <p className="mt-3 text-sm text-[var(--ink-2)]">
              Your share {inr(done.share)} · friends owe you <span className="tnum font-medium">{inr(owed)}</span>
            </p>
          )}
          {error && <p className="mt-3 text-sm text-[var(--neg)]">{error}</p>}
          <button
            onClick={undo}
            disabled={busy}
            className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-medium text-[var(--ink-2)] hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            <Undo2 className="h-4 w-4" aria-hidden />
            Undo
          </button>
        </>
      )}
      {buttons}
    </div>
  )
}
