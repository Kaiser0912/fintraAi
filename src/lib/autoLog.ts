"use client"

/**
 * Auto-log UPI payments (client side). Talks to the Android plugin
 * PaymentNotifications, parses what it captured, and matches captured
 * payments to a payment started in Fintra (which then counts as confirmed).
 */

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core"
import { isNativeApp } from "@/lib/native"
import { parseUpiNotification, type RawUpiNotification, type UpiPaymentNotice } from "@/lib/upiNotifications"
import type { PendingPayment } from "@/lib/payFlow"

interface PaymentNotificationsPlugin {
  isEnabled(): Promise<{ enabled: boolean }>
  openSettings(): Promise<void>
  getPending(): Promise<{ items: RawUpiNotification[] }>
  remove(o: { ids: string[] }): Promise<void>
  addListener(event: "captured", fn: (item: RawUpiNotification) => void): Promise<PluginListenerHandle>
}

const PaymentNotifications = registerPlugin<PaymentNotificationsPlugin>("PaymentNotifications")

export type AutoLogSupport = "web" | "update-app" | "ready"

/** "web": not in the Android app; "update-app": the installed APK predates this. */
export function autoLogSupport(): AutoLogSupport {
  if (!isNativeApp()) return "web"
  const cap = (window as unknown as { Capacitor?: { isPluginAvailable?: (n: string) => boolean } }).Capacitor
  return cap?.isPluginAvailable?.("PaymentNotifications") ? "ready" : "update-app"
}

export async function autoLogEnabled(): Promise<boolean> {
  if (autoLogSupport() !== "ready") return false
  try {
    return (await PaymentNotifications.isEnabled()).enabled
  } catch {
    return false
  }
}

export async function openAutoLogSettings() {
  if (autoLogSupport() === "ready") await PaymentNotifications.openSettings()
}

/** Everything captured, raw (Labs page). */
export async function capturedRaw(): Promise<RawUpiNotification[]> {
  if (autoLogSupport() !== "ready") return []
  try {
    return (await PaymentNotifications.getPending()).items ?? []
  } catch {
    return []
  }
}

/** Captured payments you made, oldest first. */
export async function capturedPayments(): Promise<UpiPaymentNotice[]> {
  const raw = await capturedRaw()
  return raw
    .map(parseUpiNotification)
    .filter((n): n is UpiPaymentNotice => n !== null)
    .sort((a, b) => a.postedAt - b.postedAt)
}

/** Drops handled items (logged, skipped or matched) from the phone's queue. */
export async function forgetCaptured(ids: string[]) {
  if (!ids.length || autoLogSupport() !== "ready") return
  try {
    await PaymentNotifications.remove({ ids })
  } catch {}
}

export async function onCaptured(fn: () => void): Promise<() => void> {
  if (autoLogSupport() !== "ready") return () => {}
  const handle = await PaymentNotifications.addListener("captured", () => fn())
  return () => {
    handle.remove()
  }
}

/** A captured payment that is the one Fintra handed off: same amount, after hand-off. */
export function matchesPending(n: UpiPaymentNotice, p: PendingPayment): boolean {
  return Math.abs(n.amount - p.amount) < 0.005 && n.postedAt >= p.handedOffAt - 60_000
}

/** Notice for the payment Fintra handed off, if the UPI app already confirmed it. */
export async function confirmationFor(p: PendingPayment): Promise<UpiPaymentNotice | null> {
  const list = await capturedPayments()
  return list.find((n) => matchesPending(n, p)) ?? null
}
