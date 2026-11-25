"use client"

// Labs: what the Android app captured from UPI app notifications, and how
// Fintra read each one. Helps check real notification wording. Stays on the
// phone; nothing here is sent anywhere.

import { useCallback, useEffect, useState } from "react"
import { autoLogEnabled, autoLogSupport, capturedRaw, forgetCaptured } from "@/lib/autoLog"
import { parseUpiNotification, type RawUpiNotification } from "@/lib/upiNotifications"

export default function CapturedNotificationsPage() {
  const [items, setItems] = useState<RawUpiNotification[]>([])
  const [status, setStatus] = useState("")

  const load = useCallback(async () => {
    const s = autoLogSupport()
    if (s === "web") return setStatus("Open this page in the Fintra Android app.")
    if (s === "update-app") return setStatus("Install the latest Fintra app to use this.")
    setStatus((await autoLogEnabled()) ? "Notification access: on" : "Notification access: off (Settings → Auto-log UPI payments)")
    setItems((await capturedRaw()).slice().reverse())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="mx-auto max-w-2xl px-5 pb-28 pt-6">
      <h1 className="text-xl font-semibold text-[var(--ink)]">Captured payment notifications</h1>
      <p className="mt-1 text-sm text-[var(--ink-3)]">{status}</p>
      <div className="mt-4 flex gap-2">
        <button onClick={load} className="min-h-10 rounded-lg border border-[var(--hairline-strong)] px-4 text-sm">
          Refresh
        </button>
        {items.length > 0 && (
          <button
            onClick={async () => {
              await forgetCaptured(items.map((i) => i.id))
              load()
            }}
            className="min-h-10 rounded-lg border border-[var(--hairline-strong)] px-4 text-sm text-[var(--neg)]"
          >
            Clear all
          </button>
        )}
      </div>
      <ul className="mt-5 space-y-3">
        {items.map((n) => {
          const p = parseUpiNotification(n)
          return (
            <li key={n.id} className="rounded-xl border border-[var(--hairline)] p-3 text-sm">
              <p className="text-xs text-[var(--ink-3)]">
                {n.pkg} · {new Date(n.postedAt).toLocaleString("en-IN")}
              </p>
              <p className="mt-1 font-medium text-[var(--ink)]">{n.title || "(no title)"}</p>
              <p className="text-[var(--ink-2)]">{n.text || "(no text)"}</p>
              <p className={`mt-2 text-xs ${p ? "text-[var(--pos)]" : "text-[var(--ink-3)]"}`}>
                {p ? `Read as: ₹${p.amount} to ${p.payee ?? p.upiId ?? "unknown"}` : "Ignored (not a payment you made)"}
              </p>
            </li>
          )
        })}
        {items.length === 0 && <li className="text-sm text-[var(--ink-3)]">Nothing captured yet.</li>}
      </ul>
    </div>
  )
}
