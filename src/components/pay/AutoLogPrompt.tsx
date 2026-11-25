"use client"

// Auto-log UPI payments: "Log ₹150 to Riya?" for payments the Android app saw
// in Google Pay / PhonePe / Paytm / BHIM notifications. One tap logs it with
// the saved payee's usual category; Skip drops it.

import { useCallback, useEffect, useRef, useState } from "react"
import { Minus, Plus } from "lucide-react"
import {
  autoLogSupport,
  capturedPayments,
  forgetCaptured,
  matchesPending,
  onCaptured,
} from "@/lib/autoLog"
import { loadPending } from "@/lib/payFlow"
import type { UpiPaymentNotice } from "@/lib/upiNotifications"

interface Category {
  id: string
  name: string
  icon: string
}
interface Payee {
  name: string
  upiId: string
  defaultCategoryId: string | null
  recentPurposes: string[]
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
const round2 = (n: number) => Math.round(n * 100) / 100

function dateOf(ms: number) {
  const d = new Date(ms || Date.now())
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function timeLabel(ms: number) {
  const d = new Date(ms)
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay
    ? d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}

export function AutoLogPrompt() {
  const [queue, setQueue] = useState<UpiPaymentNotice[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [payees, setPayees] = useState<Payee[]>([])
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [purpose, setPurpose] = useState("")
  const [people, setPeople] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [logged, setLogged] = useState<string | null>(null)
  const loadedRefs = useRef(false)

  const refresh = useCallback(async () => {
    const pending = loadPending()
    const list = await capturedPayments()
    // The payment Fintra handed off is confirmed by PendingPaymentPrompt.
    setQueue(pending ? list.filter((n) => !matchesPending(n, pending)) : list)
  }, [])

  useEffect(() => {
    if (autoLogSupport() !== "ready") return
    refresh()
    let off = () => {}
    onCaptured(() => setTimeout(refresh, 1500)).then((fn) => (off = fn))
    const onVisible = () => document.visibilityState === "visible" && setTimeout(refresh, 1200)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      off()
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh])

  const current = queue[0] ?? null

  // Categories and saved payees, loaded the first time something needs logging.
  useEffect(() => {
    if (!current || loadedRefs.current) return
    loadedRefs.current = true
    fetch("/api/categories?type=expense")
      .then((r) => (r.ok ? r.json() : []))
      .then(setCategories)
      .catch(() => {})
    fetch("/api/payees?limit=100")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setPayees(Array.isArray(d) ? d : (d?.data ?? [])))
      .catch(() => {})
  }, [current])

  const payee = current
    ? (payees.find((p) => current.upiId && p.upiId === current.upiId) ??
      payees.find((p) => current.payee && p.name.toLowerCase() === current.payee.toLowerCase()) ??
      null)
    : null

  // New notice: reset the form, pre-pick the payee's usual category.
  useEffect(() => {
    setPurpose("")
    setPeople(1)
    setError(null)
    setCategoryId(payee?.defaultCategoryId ?? null)
  }, [current?.id, payee?.defaultCategoryId])

  if (!current) {
    return logged ? (
      <div role="status" className="fixed inset-x-0 bottom-24 z-50 mx-auto w-fit rounded-full bg-[var(--ink)] px-4 py-2 text-sm text-[var(--app-bg)] shadow-lg lg:bottom-6">
        {logged}
      </div>
    ) : null
  }

  // A payment just handed off from Fintra gets its own question first.
  const pending = loadPending()
  if (pending && Date.now() - pending.handedOffAt < 10 * 60_000) return null

  const name = payee?.name ?? current.payee ?? current.upiId ?? "someone"
  const share = round2(current.amount / people)
  const ordered = [...categories].sort((a, b) =>
    a.id === payee?.defaultCategoryId ? -1 : b.id === payee?.defaultCategoryId ? 1 : 0
  )

  async function skip() {
    if (!current) return
    await forgetCaptured([current.id])
    setQueue((q) => q.slice(1))
  }

  async function log() {
    if (!current || !categoryId) return
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        type: "expense",
        amount: people > 1 ? share : current.amount,
        categoryId,
        date: dateOf(current.postedAt),
        description: purpose.trim() || name,
        status: "paid",
        source: "upi",
      }
      const upiId = payee?.upiId ?? current.upiId
      if (upiId) body.payee = { upiId, name }
      if (people > 1) {
        body.paidAmount = current.amount
        body.splitTotal = current.amount
        body.splitPeople = people
      }
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? `Error ${res.status}`)
      await forgetCaptured([current.id])
      setQueue((q) => q.slice(1))
      setLogged(`Logged ${inr(current.amount)} to ${name}`)
      setTimeout(() => setLogged(null), 2500)
      window.dispatchEvent(new Event("fintra-data-changed"))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't log it. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="autolog-q">
      <div className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-[var(--app-bg)] p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-xl sm:rounded-3xl">
        <p className="text-xs text-[var(--ink-3)]">
          {current.app} · {timeLabel(current.postedAt)}
          {queue.length > 1 && ` · 1 of ${queue.length}`}
        </p>
        <h2 id="autolog-q" className="mt-1 text-lg font-semibold text-[var(--ink)]">
          Log <span className="tnum">{inr(current.amount)}</span> to {name}?
        </h2>

        <div className="mt-4 space-y-2">
          <span className="text-sm font-medium text-[var(--ink)]">Category</span>
          <div className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1 [scrollbar-width:none]">
            {ordered.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategoryId(c.id)}
                aria-pressed={c.id === categoryId}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${
                  c.id === categoryId
                    ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--primary-foreground)]"
                    : "border-[var(--hairline-strong)] text-[var(--ink-2)]"
                }`}
              >
                <span aria-hidden>{c.icon}</span> {c.name}
              </button>
            ))}
            {ordered.length === 0 && <span className="text-sm text-[var(--ink-3)]">Loading…</span>}
          </div>
        </div>

        <input
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="What for (optional)"
          maxLength={80}
          className="mt-4 w-full rounded-xl border border-[var(--hairline)] bg-transparent px-4 py-3 text-sm"
        />
        {payee && payee.recentPurposes.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {payee.recentPurposes.slice(0, 3).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPurpose(p)}
                className="rounded-full border border-[var(--hairline-strong)] px-3 py-1.5 text-xs text-[var(--ink-2)]"
              >
                {p}
              </button>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm text-[var(--ink-2)]">
            {people > 1 ? `Split ${people} ways · your share ${inr(share)}` : "Split with friends"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Fewer people"
              disabled={people <= 1}
              onClick={() => setPeople((p) => Math.max(1, p - 1))}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--hairline-strong)] disabled:opacity-40"
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="tnum w-5 text-center text-sm font-semibold">{people}</span>
            <button
              type="button"
              aria-label="More people"
              disabled={people >= 20}
              onClick={() => setPeople((p) => Math.min(20, p + 1))}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--hairline-strong)] disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-[var(--neg)]">{error}</p>}
        <div className="mt-5 grid grid-cols-[1fr_auto] gap-2">
          <button
            onClick={log}
            disabled={busy || !categoryId}
            className="min-h-12 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--primary-foreground)] disabled:opacity-50"
          >
            {categoryId ? "Log it" : "Pick a category"}
          </button>
          <button
            onClick={skip}
            disabled={busy}
            className="min-h-12 rounded-xl border border-[var(--hairline-strong)] px-5 text-sm font-medium text-[var(--ink)] disabled:opacity-50"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}
