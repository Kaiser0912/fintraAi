"use client"

import { useEffect } from "react"
import { isNativeApp, NATIVE_AUTH_CALLBACK } from "@/lib/native"

/**
 * Android app only. Skips the landing page, and when Google sign-in finishes in Chrome, Supabase redirects
 * to com.fintra.app://auth/callback?code=…, which Android hands back to the
 * app. Close the Chrome tab and finish the sign-in inside the app's WebView,
 * where the PKCE verifier cookie lives.
 */
export function NativeAuthBridge() {
  useEffect(() => {
    if (!isNativeApp()) return
    // The app has no use for the marketing landing page: go to the dashboard
    // (signed-out users are sent on to /sign-in by the middleware).
    if (window.location.pathname === "/") {
      window.location.replace("/dashboard")
      return
    }
    let remove: (() => void) | undefined

    ;(async () => {
      const [{ App }, { Browser }] = await Promise.all([import("@capacitor/app"), import("@capacitor/browser")])
      const handle = await App.addListener("appUrlOpen", async ({ url }) => {
        if (!url.startsWith(NATIVE_AUTH_CALLBACK)) return
        await Browser.close().catch(() => {})
        const params = new URL(url.replace(NATIVE_AUTH_CALLBACK, "https://app.local/auth/callback")).searchParams
        const code = params.get("code")
        if (code) {
          window.location.href = `/auth/callback?code=${encodeURIComponent(code)}&next=/dashboard`
        } else {
          const reason = params.get("error_description") ?? "Google sign-in was cancelled"
          window.location.href = `/sign-in?error=${encodeURIComponent(reason)}`
        }
      })
      remove = () => handle.remove()
    })()

    return () => remove?.()
  }, [])
  return null
}
