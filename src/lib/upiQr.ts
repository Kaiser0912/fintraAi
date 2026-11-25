/**
 * UPI QR codes and the pay draft (FIN-9).
 *
 * A UPI QR is a `upi://pay?…` link: pa = payee UPI ID, pn = name, am = amount,
 * tn = note, mc = merchant category code. Verified merchants also include
 * fields such as tr (reference) and sign; we keep the exact text (`raw`) so a
 * verified shop QR can be handed to the UPI app unchanged (NPCI refuses
 * app-started payments to personal IDs and unverified shops).
 */

export interface UpiTarget {
  upiId: string
  name: string | null
  amount: number | null
  note: string | null
  /** Merchant category code; present on merchant QRs. */
  merchantCode: string | null
  /** Exact QR text, when scanned. */
  raw: string | null
}

const UPI_ID_RE = /^[a-z0-9._-]{2,255}@[a-z0-9]{2,64}$/i

export function isUpiId(value: string): boolean {
  return UPI_ID_RE.test(value.trim())
}

/** Parses a scanned QR string. Returns null for anything that isn't a UPI payment QR. */
export function parseUpiQr(text: string): UpiTarget | null {
  const raw = text.trim()
  if (!raw.toLowerCase().startsWith("upi://pay?")) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(raw.slice(raw.indexOf("?") + 1))
  } catch {
    return null
  }
  const upiId = (params.get("pa") ?? "").trim().toLowerCase()
  if (!isUpiId(upiId)) return null
  const am = Number(params.get("am"))
  return {
    upiId,
    name: params.get("pn")?.trim() || null,
    amount: Number.isFinite(am) && am > 0 ? Math.round(am * 100) / 100 : null,
    note: params.get("tn")?.trim() || null,
    merchantCode: params.get("mc")?.trim() || null,
    raw,
  }
}

/** A typed-in UPI ID (fallback when there is no QR). */
export function targetFromUpiId(upiId: string, name?: string): UpiTarget | null {
  const id = upiId.trim().toLowerCase()
  if (!isUpiId(id)) return null
  return { upiId: id, name: name?.trim() || null, amount: null, note: null, merchantCode: null, raw: null }
}

/** Merchant QRs carry a category code; personal QRs usually don't (or use 0000). */
export function looksLikeMerchant(t: UpiTarget): boolean {
  return Boolean(t.merchantCode && t.merchantCode !== "0000")
}

// ─── Pay draft: carried from scan → amount → split → pay ─────────────────────

const DRAFT_KEY = "fintra-pay-draft"

export interface PayDraft {
  target: UpiTarget
  /** Filled on the details step (FIN-14/19). `amount` is the whole bill you pay. */
  amount?: number | null
  purpose?: string | null
  payeeName?: string | null
  categoryId?: string | null
  categoryName?: string | null
  /** Split with friends: you pay the whole bill, your share is what counts. */
  split?: { people: number; share: number } | null
  createdAt: number
}

export type PayDetails = Omit<PayDraft, "target" | "createdAt">

export function savePayDraft(target: UpiTarget, details: PayDetails = {}) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ target, ...details, createdAt: Date.now() } satisfies PayDraft))
  } catch {}
}

export function loadPayDraft(): PayDraft | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null") as PayDraft | null
    // Drafts older than 30 minutes are stale (a different payment).
    return d && Date.now() - d.createdAt < 30 * 60_000 ? d : null
  } catch {
    return null
  }
}

export function clearPayDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY)
  } catch {}
}
