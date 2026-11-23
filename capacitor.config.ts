import type { CapacitorConfig } from "@capacitor/cli";

// Fintra Android app (FIN-6): a native shell that loads the live web app.
// Shipping a web change updates the app without a new APK. Native pieces
// (UPI result, SMS capture) are added as plugins in Sprint 4.
const config: CapacitorConfig = {
  appId: "com.fintra.app",
  appName: "Fintra",
  // Offline fallback bundled in the APK; the app itself is served from `server.url`.
  webDir: "mobile/www",
  server: {
    url: process.env.FINTRA_APP_URL ?? "https://fintra-ai-xi.vercel.app",
    cleartext: false,
    // Stay inside the app for Fintra and its Supabase auth calls.
    allowNavigation: ["fintra-ai-xi.vercel.app", "*.supabase.co"],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
