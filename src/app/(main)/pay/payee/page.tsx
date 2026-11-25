"use client"

// Scan to pay — step 2 (FIN-9/14/19). Who you're paying (matched against saved
// payees), the amount, what it was for, the category, and an optional split.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, BadgeCheck, Minus, Plus, Store, User, Users } from "lucide-react"
import { loadPayDraft, looksLikeMerchant, savePayDraft, type PayDraft } from "@/lib/upiQr"

interface Suggest {
  payee: { id: string; name: string; kind?: string } | null
  purposes: string[]
  category: { id: string; name: string; icon: string } | null
}
interface Category {
  id: string
  name: string
  icon: string
}

const MAX_AMOUNT = 1_00_000
const round2 = (n: number) => Math.round(n * 100) / 100

export default function PayDetailsPage() {
  const router = useRouter()
  const [draft, setDraft] = useState<PayDraft | null | undefined>(undefined)
  const [suggest, setSuggest] = useState<Suggest | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [amount, setAmount] = useState("")
  const [purpose, setPurpose] = useState("")
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [splitOn, setSplitOn] = useState(false)
  const [people, setPeople] = useState(2)
  const [shareText, setShareText] = useState<string | null>(null) // null = even split

  useEffect(() => {
    const d = loadPayDraft()
    setDraft(d)
    if (!d) return
    const a = d.amount ?? d.target.amount
    if (a) setAmount(String(a))
    if (d.purpose ?? d.target.note) setPurpose((d.purpose ?? d.target.note) as string)
    if (d.categoryId) setCategoryId(d.categoryId)
    if (d.split) {
      setSplitOn(true)
      setPeople(d.split.people)
      if (a && Math.abs(d.split.share * d.split.people - a) > 0.01) setShareText(String(d.split.share))
    }
    let cancelled = false
    fetch(`/api/payees/suggest?upi=${encodeURIComponent(d.target.upiId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Suggest | null) => {
        if (cancelled || !s) return
        setSuggest(s)
        if (s.category) setCategoryId((c) => c ?? s.category!.id)
      })
      .catch(() => {})
    fetch("/api/categories?type=expense")
      .then((r) => (r.ok ? r.json() : []))
      .then((cs: Category[]) => !cancelled && setCategories(cs))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Suggested category first, then the rest alphabetically.
  const orderedCategories = useMemo(() => {
    const first = suggest?.category?.id
    return [...categories].sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : 0))
  }, [categories, suggest])

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
  const qrAmount = merchant ? t.amount : null
  const amountNum = Number(amount)
  const amountOk = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= MAX_AMOUNT
  const evenShare = amountOk ? round2(amountNum / people) : 0
  const share = shareText == null ? evenShare : Number(shareText)
  const shareOk = !splitOn || (Number.isFinite(share) && share >= 0 && share <= amountNum)
  const category = categories.find((c) => c.id === categoryId) ?? (suggest?.category?.id === categoryId ? suggest?.category : null)
  const canContinue = amountOk && shareOk && Boolean(categoryId)

  function onContinue(e: React.FormEvent) {
    e.preventDefault()
    if (!draft || !canContinue) return
    savePayDraft(draft.target, {
      amount: round2(amountNum),
      purpose: purpose.trim() || null,
      payeeName: displayName,
      categoryId,
      categoryName: category?.name ?? null,
      split: splitOn ? { people, share: round2(share) } : null,
    })
    router.push("/pay/go")
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 px-5 pb-28 pt-6">
      <header className="flex items-center gap-2">
        <button
          onClick={() => router.replace("/pay")}
          className="flex min-h-10 items-center gap-1 rounded-full pr-3 text-sm text-[var(--ink-3)] hover:bg-[var(--surface-2)]"
        >
          <ArrowLeft className="ml-2 h-5 w-5" aria-hidden />
          Scan again
        </button>
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
          <span className="text-sm font-medium text-[var(--ink)]">{splitOn ? "Whole bill" : "Amount"}</span>
          <div className="flex items-center gap-2 rounded-xl border border-[var(--hairline)] px-4 py-3 focus-within:border-[var(--ink-3)]">
            <span className="text-2xl text-[var(--ink-3)]">₹</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="0"
              autoFocus={!amount}
              className="tnum w-full bg-transparent text-2xl font-semibold text-[var(--ink)] outline-none"
            />
          </div>
          {qrAmount != null && amountNum !== qrAmount && (
            <span className="text-xs text-[var(--ink-3)]">The shop&apos;s QR asks for ₹{qrAmount.toLocaleString("en-IN")}.</span>
          )}
          {amountNum > MAX_AMOUNT && <span className="text-xs text-[var(--neg)]">UPI allows up to ₹1,00,000 per payment.</span>}
        </label>

        {/* Purpose */}
        <div className="space-y-2">
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
            <div className="flex flex-wrap gap-2">
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
        </div>

        {/* Category */}
        <div className="space-y-2">
          <span className="text-sm font-medium text-[var(--ink)]">Category</span>
          <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none]">
            {orderedCategories.map((c) => (
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
            {orderedCategories.length === 0 && <span className="text-sm text-[var(--ink-3)]">Loading…</span>}
          </div>
        </div>

        {/* Split */}
        <div className="rounded-2xl border border-[var(--hairline)] p-4">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
              <Users className="h-4 w-4" aria-hidden />
              Split with friends
            </span>
            <input
              type="checkbox"
              checked={splitOn}
              onChange={(e) => setSplitOn(e.target.checked)}
              className="h-5 w-5 accent-[var(--brand)]"
            />
          </label>
          {splitOn && (
            <div className="mt-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--ink-2)]">People, including you</span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    aria-label="Fewer people"
                    disabled={people <= 2}
                    onClick={() => setPeople((p) => Math.max(2, p - 1))}
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--hairline-strong)] disabled:opacity-40"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <span className="tnum w-6 text-center font-semibold text-[var(--ink)]">{people}</span>
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
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm text-[var(--ink-2)]">Your share</span>
                <span className="flex items-center gap-1 rounded-lg border border-[var(--hairline)] px-3 py-2">
                  <span className="text-[var(--ink-3)]">₹</span>
                  <input
                    inputMode="decimal"
                    value={shareText ?? (evenShare ? String(evenShare) : "")}
                    onChange={(e) => setShareText(e.target.value.replace(/[^\d.]/g, ""))}
                    className="tnum w-20 bg-transparent text-right font-semibold text-[var(--ink)] outline-none"
                  />
                </span>
              </label>
              {shareText != null && (
                <button type="button" onClick={() => setShareText(null)} className="text-xs text-[var(--ink-3)] underline">
                  Split evenly instead
                </button>
              )}
              {!shareOk && <p className="text-xs text-[var(--neg)]">Your share can&apos;t be more than the bill.</p>}
              {amountOk && shareOk && (
                <p className="text-xs text-[var(--ink-3)]">
                  You pay ₹{round2(amountNum).toLocaleString("en-IN")}; ₹{round2(share).toLocaleString("en-IN")} counts as
                  your spending and friends owe you ₹{round2(amountNum - share).toLocaleString("en-IN")}.
                </p>
              )}
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={!canContinue}
          className="min-h-12 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--primary-foreground)] disabled:opacity-40"
        >
          Continue to pay
        </button>
      </form>
    </div>
  )
}
