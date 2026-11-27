"use client"

// Settings → Auto-log UPI payments: turn on Android Notification access so
// Fintra can offer to log payments made in Google Pay / PhonePe / Paytm / BHIM.

import { useEffect, useState } from "react"
import { autoLogEnabled, autoLogSupport, openAutoLogSettings, type AutoLogSupport } from "@/lib/autoLog"

export function AutoLogSection() {
  const [support, setSupport] = useState<AutoLogSupport | null>(null)
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    const s = autoLogSupport()
    setSupport(s)
    if (s !== "ready") return
    const check = () => autoLogEnabled().then(setEnabled)
    check()
    // Coming back from Android settings.
    const onVisible = () => document.visibilityState === "visible" && check()
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  if (!support) return null

  return (
    <section className="border-t border-[var(--hairline)] pt-6">
      <h2 className="mb-5 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--ink-3)]">Auto-log UPI payments</h2>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--ink)]">
            {support === "ready" ? (enabled ? "On" : "Off") : "Pay anywhere, log in Fintra"}
          </p>
          <p className="mt-0.5 text-xs text-[var(--ink-3)]">
            {support === "web" && "Available in the Fintra Android app."}
            {support === "update-app" && "Install the latest Fintra app to use this."}
            {support === "ready" &&
              "Fintra spots payments in Google Pay, PhonePe, Paytm and BHIM notifications and in bank debit SMS, on your phone, and asks before logging. OTP messages and other apps are ignored, and nothing is sent until you tap Log."}
          </p>
        </div>
        {support === "ready" && (
          <button
            onClick={() => openAutoLogSettings()}
            className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-[var(--hairline-strong)] px-4 text-sm font-medium text-[var(--ink)] hover:bg-[var(--surface-2)]"
          >
            {enabled ? "Manage" : "Turn on"}
          </button>
        )}
      </div>
      {support === "ready" && !enabled && (
        <p className="mt-3 text-xs text-[var(--ink-3)]">
          In the list, turn on Fintra. If Android says it&apos;s a restricted setting: open Settings → Apps → Fintra →
          ⋮ (top right) → Allow restricted settings, then try again.
        </p>
      )}
    </section>
  )
}
