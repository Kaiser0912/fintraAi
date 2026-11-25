/**
 * Auto-log UPI payments: parsing (runs in the web app, so it can be improved
 * without a new APK). The Android listener hands over the raw title + text of
 * Google Pay / PhonePe / Paytm / BHIM notifications; this turns "₹150 paid to
 * Riya" into { amount: 150, payee: "Riya" } and ignores everything that isn't
 * money you sent (received, requests, failures, cashback, offers…).
 *
 * No imports: scripts/notif/parse-check.mjs runs this file directly in Node.
 */

export interface RawUpiNotification {
  id: string
  pkg: string
  title: string
  text: string
  postedAt: number
}

export interface UpiPaymentNotice {
  id: string
  amount: number
  payee: string | null
  upiId: string | null
  app: string
  postedAt: number
}

const APP_LABELS: Record<string, string> = {
  "com.google.android.apps.nbu.paisa.user": "Google Pay",
  "com.phonepe.app": "PhonePe",
  "net.one97.paytm": "Paytm",
  "in.org.npci.upiapp": "BHIM",
  "com.android.shell": "Test",
}

// Money coming in, asks, failures and promos: never a payment you made.
const IGNORE =
  /\b(received|receive|credited|requested|request|requesting|collect|failed|failure|declined|unsuccessful|pending|processing|cashback|reward|rewards|offer|offers|won|win|scratch|coupon|voucher|refund|refunded|reminder|due|bill is|expired|cancelled|reversed|autopay set|mandate)\b/i
// Words that mean money left your account.
const SENT = /\b(paid|sent|debited|transferred|payment successful|paid successfully|money sent|payment done)\b/i
const AMOUNT = /(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d{1,2})?)/i
const UPI_ID = /\b([a-z0-9._-]{2,255}@[a-z][a-z0-9]{1,63})\b/i
// "… to <name>" up to a stop word or punctuation.
const TO_NAME = /\bto\s+(.+?)(?=\s+(?:via|using|from|on|at|successfully|through|for|is|has)\b|\s*[.!,|•·]|\s+(?:₹|rs\.?\s*\d|inr)|$)/i

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

export function parseUpiNotification(n: RawUpiNotification): UpiPaymentNotice | null {
  const full = clean(`${n.title} . ${n.text}`)
  if (!full || IGNORE.test(full) || !SENT.test(full)) return null

  const am = full.match(AMOUNT)
  if (!am) return null
  const amount = Math.round(Number(am[1].replace(/,/g, "")) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_00_000) return null

  const upiId = full.match(UPI_ID)?.[1]?.toLowerCase() ?? null

  let payee: string | null = null
  for (const part of [n.title, n.text, full]) {
    const m = clean(part).match(TO_NAME)
    if (m) {
      const name = clean(m[1]).replace(/^(?:₹|rs\.?|inr)\s*[\d,.]+\s*/i, "")
      if (name && !/^(?:₹|rs\.?|inr)?\s*[\d,.]+$/i.test(name) && name.length <= 80) {
        payee = name
        break
      }
    }
  }
  // "to amit.s@ybl": the name match stops at the dot; the UPI ID is the payee.
  if (payee && upiId && upiId.startsWith(payee.toLowerCase())) payee = null

  return { id: n.id, amount, payee, upiId, app: APP_LABELS[n.pkg] ?? "UPI app", postedAt: n.postedAt }
}
