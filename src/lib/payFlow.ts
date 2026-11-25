"use client"

/**
 * Pay hand-off (FIN-24/28/32).
 *
 * NPCI refuses payments that an app starts towards personal UPI IDs and
 * unverified shops, so there are two ways to pay:
 *  - verified shop QR → the scanned QR is handed to the UPI app unchanged
 *  - friend / small shop → copy the UPI ID, open the UPI app, pay there
 *
 * Either way Fintra first saves the payment as `pending` (doesn't count in
 * totals), then asks "Did it go through?" when you come back: yes marks it
 * paid, no deletes it. The pending marker lives in localStorage so the
 * question survives Android restarting the app while you were paying.
 */

import { isNativeApp } from "@/lib/native"
import type { PayDraft } from "@/lib/upiQr"

export const UPI_APPS = [
  // scheme: the app's own pay link, used inside the Fintra app (its WebView
  // opens links with a plain VIEW intent and can't follow intent:// links).
  { id: "gpay", label: "Google Pay", pkg: "com.google.android.apps.nbu.paisa.user", scheme: "tez://upi/pay" },
  { id: "phonepe", label: "PhonePe", pkg: "com.phonepe.app", scheme: "phonepe://pay" },
  { id: "paytm", label: "Paytm", pkg: "net.one97.paytm", scheme: "paytmmp://pay" },
  { id: "bhim", label: "BHIM", pkg: "in.org.npci.upiapp", scheme: "upi://pay" },
] as const

// ─── Pre-filled payments ("quick pay") ───────────────────────────────────────
// Opens the UPI app with payee and amount filled in. NPCI lets apps refuse
// these for personal IDs and small shops, so when one fails we remember that
// app and go straight to copy-the-UPI-ID next time.

const BLOCKED_KEY = "fintra-quickpay-blocked"

export function quickPayBlocked(): string[] {
  try {
    return JSON.parse(localStorage.getItem(BLOCKED_KEY) ?? "[]")
  } catch {
    return []
  }
}

export function setQuickPayBlocked(appId: string, blocked: boolean) {
  const set = new Set(quickPayBlocked())
  if (blocked) set.add(appId)
  else set.delete(appId)
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify([...set]))
  } catch {}
}

export function clearQuickPayBlocked() {
  try {
    localStorage.removeItem(BLOCKED_KEY)
  } catch {}
}

/** Hands the UPI app a payment with payee and amount filled in. */
export function openQuickPay(app: UpiApp, p: { upiId: string; name: string; amount: number; note?: string | null }) {
  const q = new URLSearchParams({ pa: p.upiId, pn: p.name.slice(0, 50), am: p.amount.toFixed(2), cu: "INR" })
  if (p.note) q.set("tn", p.note.slice(0, 50))
  const query = q.toString()
  if (isNativeApp()) window.location.href = `${app.scheme}?${query}`
  else if (/Android/i.test(navigator.userAgent))
    window.location.href = `intent://pay?${query}#Intent;scheme=upi;package=${app.pkg};end`
  else window.location.href = `upi://pay?${query}`
}

/** Set when a hand-off failed, so the pay screen opens on the fallback. */
export const PAY_FALLBACK_KEY = "fintra-pay-fallback"

export type UpiApp = (typeof UPI_APPS)[number]

// ─── Pending payment marker ──────────────────────────────────────────────────

const PENDING_KEY = "fintra-pay-pending"

export interface PendingPayment {
  txId: string
  upiId: string
  amount: number // what you paid (whole bill)
  share: number // what counts for you
  payeeName: string
  categoryName: string | null
  /** When you left for the UPI app. */
  handedOffAt: number
  /** How it was handed off; a failed "quick" pay blocks that app. */
  method?: "shop" | "quick" | "copy"
  appId?: string
  appLabel?: string
}

export function savePending(p: PendingPayment) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p))
  } catch {}
  window.dispatchEvent(new Event("fintra-pay-pending"))
}

export function loadPending(): PendingPayment | null {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null")
  } catch {
    return null
  }
}

export function clearPending() {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {}
  window.dispatchEvent(new Event("fintra-pay-pending"))
}

// ─── API calls ───────────────────────────────────────────────────────────────

function today() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function failText(res: Response) {
  try {
    const j = await res.json()
    return j.message ?? j.issues?.[0]?.message ?? `Error ${res.status}`
  } catch {
    return `Error ${res.status}`
  }
}

/** Saves the payment as pending (and remembers the payee). Returns the marker. */
export async function createPendingPayment(draft: PayDraft): Promise<PendingPayment> {
  const total = draft.amount ?? 0
  const share = draft.split ? draft.split.share : total
  const payeeName = draft.payeeName || draft.target.name || draft.target.upiId
  const body: Record<string, unknown> = {
    type: "expense",
    amount: share,
    categoryId: draft.categoryId,
    date: today(),
    description: draft.purpose || payeeName,
    status: "pending",
    source: "upi",
    payee: {
      upiId: draft.target.upiId,
      name: payeeName,
      kind: draft.target.merchantCode && draft.target.merchantCode !== "0000" ? "merchant" : "personal",
    },
  }
  if (draft.split) {
    body.paidAmount = total
    body.splitTotal = total
    body.splitPeople = draft.split.people
    body.splitUneven = Math.abs(draft.split.share * draft.split.people - total) > 0.01
  }
  const res = await fetch("/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await failText(res))
  const tx = (await res.json()) as { id: string }
  return { txId: tx.id, upiId: draft.target.upiId, amount: total, share, payeeName, categoryName: draft.categoryName ?? null, handedOffAt: Date.now() }
}

export async function markPaid(txId: string) {
  const res = await fetch(`/api/transactions/${txId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "paid" }),
  })
  if (!res.ok) throw new Error(await failText(res))
}

/** Removes a payment (it didn't go through, or Undo). */
export async function deletePayment(txId: string) {
  const res = await fetch(`/api/transactions/${txId}`, { method: "DELETE" })
  if (!res.ok && res.status !== 404) throw new Error(await failText(res))
}

// ─── Opening the UPI app ─────────────────────────────────────────────────────

/** Hands a verified shop's QR to the UPI app exactly as scanned. */
export function openShopQr(raw: string) {
  const t = raw.trim()
  const query = t.slice(t.indexOf("?") + 1)
  window.location.href = `upi://pay?${query}`
}

/**
 * Opens a UPI app's home screen (no payment details: NPCI blocks those for
 * personal IDs). Returns false when it can't be opened from here.
 */
export async function openUpiApp(app: UpiApp): Promise<boolean> {
  if (isNativeApp()) {
    const cap = (window as unknown as { Capacitor?: { isPluginAvailable?: (n: string) => boolean } }).Capacitor
    if (!cap?.isPluginAvailable?.("AppLauncher")) return false
    try {
      const { AppLauncher } = await import("@capacitor/app-launcher")
      const { completed } = await AppLauncher.openUrl({ url: app.pkg })
      return completed
    } catch {
      return false
    }
  }
  if (/Android/i.test(navigator.userAgent)) {
    window.location.href = `intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${app.pkg};end`
    return true
  }
  return false
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older WebViews: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand("copy")
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
