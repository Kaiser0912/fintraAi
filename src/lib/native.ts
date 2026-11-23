"use client";

/**
 * Helpers for the Android app (Capacitor shell, FIN-6/FIN-30). The shell loads
 * the live site, so this code runs in both the browser and the app; native
 * plugins are only imported when actually inside the app.
 */

/** Deep link Google sign-in returns to, registered in AndroidManifest.xml. */
export const NATIVE_AUTH_CALLBACK = "com.fintra.app://auth/callback";

export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

/** Opens a URL in Chrome Custom Tabs (Google blocks its sign-in inside WebViews). */
export async function openInSystemBrowser(url: string) {
  const { Browser } = await import("@capacitor/browser");
  await Browser.open({ url });
}
