/**
 * Auto-log UPI payments: parsing (runs in the web app, so it can be improved
 * without a new APK). The Android listener hands over the raw title + text of
 * UPI app notifications (Google Pay / PhonePe / Paytm / BHIM) and of bank SMS
 * (via the SMS app's notification). This turns "₹150 paid to Riya" or
 * "Rs.150.00 debited from A/c XX1234 … to VPA riya@oksbi" into
 * { amount: 150, payee, upiId } and ignores everything that isn't money you
 * sent (received, requests, failures, OTPs, cashback, offers, bills…).
 *
 * No imports: scripts/notif/parse-check.mjs runs this file directly in Node.
 */

export interface RawUpiNotification {
  id: string
  pkg: string
  kind?: "app" | "sms"
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

// Money you spent.
const SENT =
  /\b(paid|sent|debited|debit|spent|transferred|withdrawn|payment successful|paid successfully|money sent|payment done|trf to)\b/i
// Never a payment you made. "credited" alone means money in; with a debit
// word it's the payee side of a debit SMS ("…; RIYA credited").
const IGNORE =
  /\b(otp|received|receive|requested|request|requesting|collect request|failed|failure|declined|unsuccessful|pending|processing|cashback|reward|rewards|offer|offers|won|win|scratch|coupon|voucher|refund|refunded|reversed|reversal|reminder|is due|due on|due date|minimum due|statement|bill is|will be debited|scheduled|mandate|autopay set|expired|cancelled)\b/i
const CREDIT_ONLY = /\bcredited\b/i

// Amounts: "₹150", "Rs.1.00", "INR 1,200.50", SBI's "debited by 1.0".
const AMOUNT_DEBIT_BY = /\bdebited\s+(?:by|for|with)\s+(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i
const AMOUNT = /(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d{1,2})?)/i

const UPI_ID = /\b([a-z0-9._-]{2,255}@[a-z][a-z0-9]{1,63})\b/i

// Words that end a payee name.
const STOP =
  "via|using|from|on|at|successfully|through|for|is|has|ref|refno|ref\\.?no|upi|utr|a\\/c|ac|acct|avl|bal|not|if|call|info|date|dated|txn|imps|neft"
// "… to <name>" / "trf to <name>" / "Paid to <name>"
const TO_NAME = new RegExp(
  `\\bto\\s+(?:vpa\\s+|a\\/c\\s+)?(.+?)(?=\\s+(?:${STOP})\\b|\\s*[.!,;|•·()\\n]|\\s+(?:₹|rs\\.?\\s*\\d|inr)|$)`,
  "i"
)
// ICICI: "…; RIYA KUMAR credited."
const NAME_CREDITED = /[;:]\s*([^;:.]{2,60}?)\s+credited\b/i
// Axis: "UPI/P2P/432112345678/RIYA KUMAR"
const UPI_PATH = new RegExp(`\\bUPI\\/P2[PMA]\\/\\d+\\/(.+?)(?=\\s+(?:${STOP})\\b|\\s*[.!,;|()/]|$)`, "i")
// Cards: "Rs 500 spent on HDFC Bank Card x1234 at AMAZON on 2026-11-27"
const AT_NAME = new RegExp(`\\bat\\s+(.+?)(?=\\s+(?:${STOP})\\b|\\s*[.!,;|()]|$)`, "i")

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function tidyName(raw: string | undefined): string | null {
  if (!raw) return null
  let name = clean(raw)
    .replace(/^(?:₹|rs\.?|inr)\s*[\d,.]+\s*/i, "")
    .replace(/^(?:mr|mrs|ms|m\/s)\.?\s+/i, "")
    .replace(/[\s*:-]+$/, "")
  if (!name || name.length > 80 || /^(?:₹|rs\.?|inr)?\s*[\d,.*x]+$/i.test(name)) return null
  if (/^(?:your|you|a\/c|ac|account|card|bank)\b/i.test(name)) return null
  // Phone numbers and references ("to 9199518…" in "SMS BLOCK … to …").
  if (/^\+?\d{4,}/.test(name)) return null
  // Bank SMS often shout names: "RIYA KUMAR" → "Riya Kumar".
  if (name === name.toUpperCase() && /[A-Z]/.test(name) && !name.includes("@"))
    name = name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
  return name
}

export function parseUpiNotification(n: RawUpiNotification): UpiPaymentNotice | null {
  const full = clean(`${n.title} . ${n.text}`)
  if (!full || !SENT.test(full)) return null
  if (IGNORE.test(full)) return null
  if (CREDIT_ONLY.test(full) && !/\b(debited|debit|sent|paid|spent)\b/i.test(full)) return null

  const am = full.match(AMOUNT_DEBIT_BY) ?? full.match(AMOUNT)
  if (!am) return null
  const amount = Math.round(Number(am[1].replace(/,/g, "")) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_00_000) return null

  const upiId = full.match(UPI_ID)?.[1]?.toLowerCase() ?? null

  // Bank-specific shapes first (they're exact), then "to <name>", then "at <shop>".
  let payee: string | null = tidyName(full.match(UPI_PATH)?.[1]) ?? tidyName(full.match(NAME_CREDITED)?.[1])
  if (!payee) {
    for (const part of [n.title, n.text, full]) {
      payee = tidyName(clean(part).match(TO_NAME)?.[1])
      if (payee) break
    }
  }
  payee ??= tidyName(full.match(AT_NAME)?.[1])
  // "to amit.s@ybl": the name match stops at the dot; the UPI ID is the payee.
  if (payee && (payee.includes("@") || (upiId && upiId.startsWith(payee.toLowerCase())))) payee = null

  const sms = n.kind === "sms"
  return {
    id: n.id,
    amount,
    payee,
    upiId,
    app: APP_LABELS[n.pkg] ?? (sms ? "Bank SMS" : "UPI app"),
    postedAt: n.postedAt,
  }
}

/**
 * One payment can show up twice (Google Pay's notification and the bank SMS).
 * Notices with the same amount within 5 minutes are one payment; the one with
 * a name (or UPI ID) wins. Returns kept notices plus the ids folded into them.
 */
export function collapseDuplicates(list: UpiPaymentNotice[]): { notice: UpiPaymentNotice; ids: string[] }[] {
  const out: { notice: UpiPaymentNotice; ids: string[] }[] = []
  for (const n of [...list].sort((a, b) => a.postedAt - b.postedAt)) {
    const same = out.find((g) => Math.abs(g.notice.amount - n.amount) < 0.005 && Math.abs(g.notice.postedAt - n.postedAt) < 5 * 60_000)
    if (!same) {
      out.push({ notice: n, ids: [n.id] })
      continue
    }
    same.ids.push(n.id)
    const better = (x: UpiPaymentNotice) => (x.payee ? 2 : 0) + (x.upiId ? 1 : 0)
    if (better(n) > better(same.notice))
      same.notice = { ...n, payee: n.payee ?? same.notice.payee, upiId: n.upiId ?? same.notice.upiId }
    else same.notice = { ...same.notice, payee: same.notice.payee ?? n.payee, upiId: same.notice.upiId ?? n.upiId }
  }
  return out
}
