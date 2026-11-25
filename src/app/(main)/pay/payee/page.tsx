"use client"

// FIN-9: Scan to pay — step 2. Shows who the scanned QR pays, matched against
// saved payees, with the amount from the QR. Amount, purpose and category
// details are finished in FIN-14.

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, BadgeCheck, Store, User } from "lucide-react"
import { loadPayDraft, looksLikeMerchant, savePayDraft, type PayDraft } from "@/lib/upiQr"

interface Suggest {
  payee: { id: string; name: string; kind?: string } | null
  purposes: string[]
  category: { id: string; name: string; icon: string } | null
}

export default function PayeePage() {
  const router = useRouter()
  const [draft, setDraft] = useState<PayDraft | null | undefined>(undefined)
  const [suggest, setSuggest] = useState<Suggest | null>(null)
  const [amount, setAmount] = useState("")
  const [purpose, setPurpose] = useState("")
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const d = loadPayDraft()
    setDraft(d)
    if (!d) return
    if (d.amount ?? d.target.amount) setAmount(String(d.amount ?? d.target.amount))
    if (d.purpose ?? d.target.note) setPurpose((d.purpose ?? d.target.note) as string)
    let cancelled = false
    fetch(`/api/payees/suggest?upi=${encodeURIComponent(d.target.upiId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Suggest | null) => {
        if (!cancelled && s) setSuggest(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (draft === undefined) return <div className="mx-auto max-w-md px-5 pt-6" />

  if (!draft) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-start gap-4 px-5 pt-10">
        <p className="text-[var(--ink-2)]">Nothing scanned yet.</p>
        <Link
          href="/pay"
          className="inline-flex min-h-11 items-center rounded-lg bg-[var(--brand)] px-5 text-sm font-medium text-[var(--primary-foreground)]"
        >
          Scan a QR
        </Link>
      </div>
    )
  }

  const t = draft.target
  const merchant = looksLikeMerchant(t)
  const displayName = suggest?.payee?.name ?? t.name ?? t.upiId
  const qrFixedAmount = merchant && t.amount != null
  const amountNum = Number(amount)
  const amountOk = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= 1_00_000

  function onContinue(e: React.FormEvent) {
    e.preventDefault()
    if (!draft || !amountOk) return
    savePayDraft(draft.target, { amount: Math.round(amountNum * 100) / 100, purpose: purpose.trim() || null })
    setSaved(true)
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 px-5 pb-28 pt-6">
      <header className="flex items-center gap-2">
        <button
          onClick={() => router.replace("/pay")}
          aria-label="Scan again"
          className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--ink-3)] hover:bg-[var(--surface-2)]"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <span className="text-sm text-[var(--ink-3)]">Scan again</span>
      </header>

      {/* Who */}
      <section className="flex items-center gap-4 rounded-2xl border border-[var(--hairline)] p-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--ink-2)]">
          {merchant ? <Store className="h-5 w-5" /> : <User className="h-5 w-5" />}
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium text-[var(--ink)]">{displayName}</p>
          {displayName !== t.upiId && <p className="truncate text-sm text-[var(--ink-3)]">{t.upiId}</p>}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--ink-3)]">
            {merchant && <span>Shop QR</span>}
            {suggest?.payee && (
              <span className="inline-flex items-center gap-1 text-[var(--pos)]">
                <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                Saved payee
              </span>
            )}
          </p>
        </div>
      </section>

      <form onSubmit={onContinue} className="flex flex-col gap-5">
        {/* Amount */}
        <label className="block space-y-1">
          <span className="text-sm font-medium text-[var(--ink)]">Amount</span>
          <div className="flex items-center gap-2 rounded-xl border border-[var(--hairline)] px-4 py-3 focus-within:border-[var(--ink-3)]">
            <span className="text-2xl text-[var(--ink-3)]">₹</span>
            <input
              inputMode="decimal"
              value={amount}
              readOnly={qrFixedAmount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="0"
              autoFocus={!amount}
              className="tnum w-full bg-transparent text-2xl font-semibold text-[var(--ink)] outline-none"
            />
          </div>
          {qrFixedAmount && <span className="text-xs text-[var(--ink-3)]">Amount set by the shop&apos;s QR.</span>}
        </label>

        {/* Purpose */}
        <label className="block space-y-1">
          <span className="text-sm font-medium text-[var(--ink)]">What for (optional)</span>
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="Groceries, chai, rent…"
            maxLength={80}
            className="w-full rounded-xl border border-[var(--hairline)] bg-transparent px-4 py-3 text-sm"
          />
        </label>
        {suggest && suggest.purposes.length > 0 && (
          <div className="-mt-2 flex flex-wrap gap-2">
            {suggest.purposes.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPurpose(p)}
                className="rounded-full border border-[var(--hairline-strong)] px-3 py-1.5 text-xs text-[var(--ink-2)] hover:bg-[var(--surface-2)]"
              >
                {p}
              </button>
            ))}
          </div>
        )}
        {suggest?.category && (
          <p className="text-sm text-[var(--ink-3)]">
            Category: <span className="text-[var(--ink)]">{suggest.category.name}</span>
          </p>
        )}

        <button
          type="submit"
          disabled={!amountOk}
          className="min-h-12 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--primary-foreground)] disabled:opacity-40"
        >
          Continue
        </button>
        {saved && (
          <p role="status" className="text-sm text-[var(--ink-3)]">
            Saved. Splitting and paying come in the next update.
          </p>
        )}
      </form>
    </div>
  )
}
