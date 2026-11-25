"use client"

import { useEffect } from "react"
import { isNativeApp, NATIVE_AUTH_CALLBACK } from "@/lib/native"

/**
 * Android app only.
 *
 * Google sign-in finishes in Chrome, which hands the result back through
 * com.fintra.app://auth/callback?code=… . This finishes the sign-in inside the
 * app's WebView (where the PKCE verifier cookie lives) by loading
 * /auth/callback with the code.
 *
 * The link can arrive two ways:
 *  - app still running  → `appUrlOpen` event
 *  - app was restarted by Android while the user was in Chrome → the link is
 *    the launch URL, which must be read with getLaunchUrl() on startup.
 * It also skips the marketing landing page (/ → /dashboard).
 */
const HANDLED_KEY = "fintra-native-auth-handled"

function alreadyHandled(token: string): boolean {
  try {
    if (sessionStorage.getItem(HANDLED_KEY) === token) return true
    sessionStorage.setItem(HANDLED_KEY, token)
  } catch {
    // storage unavailable: worst case the same code is tried twice and fails harmlessly
  }
  return false
}

/** Returns true when it navigated away to finish (or report) a sign-in. */
async function finishFromLink(url: string | undefined | null): Promise<boolean> {
  if (!url || !url.startsWith(NATIVE_AUTH_CALLBACK)) return false
  const params = new URL(url.replace(NATIVE_AUTH_CALLBACK, "https://app.local/auth/callback")).searchParams
  const code = params.get("code")
  const errorText = params.get("error_description") ?? params.get("error")
  if (alreadyHandled(code ?? errorText ?? url)) return false

  const { Browser } = await import("@capacitor/browser")
  await Browser.close().catch(() => {})

  if (code) {
    window.location.href = `/auth/callback?code=${encodeURIComponent(code)}&next=/dashboard`
  } else {
    window.location.href = `/sign-in?error=${encodeURIComponent(errorText ?? "Google sign-in was cancelled")}`
  }
  return true
}

export function NativeAuthBridge() {
  useEffect(() => {
    if (!isNativeApp()) return
    let remove: (() => void) | undefined
    let cancelled = false

    ;(async () => {
      const { App } = await import("@capacitor/app")

      // Cold start: Android may have restarted the app with the sign-in link.
      const launch = await App.getLaunchUrl().catch(() => undefined)
      if (await finishFromLink(launch?.url)) return

      if (window.location.pathname === "/") {
        window.location.replace("/dashboard")
        return
      }

      if (cancelled) return
      const handle = await App.addListener("appUrlOpen", ({ url }) => {
        void finishFromLink(url)
      })
      remove = () => handle.remove()
    })()

    return () => {
      cancelled = true
      remove?.()
    }
  }, [])
  return null
}
