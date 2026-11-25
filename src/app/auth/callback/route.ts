import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

const APP_CALLBACK = "com.fintra.app://auth/callback";

/**
 * OAuth / email-confirmation callback. Supabase redirects here with a `code`
 * which we exchange for a session (stored in cookies via the SSR client).
 *
 * `native=1`: Google sign-in started in the Android app. This request is in
 * Chrome, but the PKCE verifier cookie lives in the app's WebView, so don't
 * exchange here — hand the code to the app through its deep link, and the app
 * finishes the exchange on this same route (without `native`).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (searchParams.get("native") === "1") return handOffToApp(searchParams);

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/sign-in?error=Could not sign you in`);
}

function handOffToApp(params: URLSearchParams) {
  const forward = new URLSearchParams();
  for (const key of ["code", "error", "error_description"]) {
    const v = params.get(key);
    if (v) forward.set(key, v);
  }
  const appUrl = `${APP_CALLBACK}?${forward.toString()}`;
  // Chrome intent URL: opens the app even when a plain custom-scheme redirect
  // is ignored, and falls back to nothing harmful if the app isn't installed.
  const intentUrl = `intent://auth/callback?${forward.toString()}#Intent;scheme=com.fintra.app;package=com.fintra.app;end`;
  const safe = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opening Fintra…</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f7f4ec;color:#1f2a24;text-align:center;padding:24px}
  a{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:10px;background:#2e5f4c;color:#fff;text-decoration:none}
</style>
</head><body><main>
  <h1 style="font-size:20px;margin:0 0 6px">Signed in with Google</h1>
  <p style="margin:0;opacity:.7">Returning you to the Fintra app…</p>
  <a href="${safe(intentUrl)}">Open Fintra</a>
</main>
<script>location.replace(${JSON.stringify(appUrl)});</script>
</body></html>`;

  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
