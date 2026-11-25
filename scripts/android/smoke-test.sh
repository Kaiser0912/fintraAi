#!/usr/bin/env bash
# Android smoke test for the Fintra app (runs inside the emulator job on CI).
#
#   1. install + launch the APK, check the WebView loads the live site
#   2. reach the sign-in page, press "Continue with Google", check Google
#      opens in the browser (custom tab), not inside the app
#   3. send the sign-in deep link, check Android routes it into Fintra and the
#      app handles it (lands on /sign-in?error=...)
#
# The page is driven through the WebView's DevTools socket (debug builds), not
# screen taps. Screenshots, crash log and results go to $OUT. Exits non-zero
# on any failure.
set -u
APK="${1:?apk path}"
OUT="${2:-smoke-out}"
PKG="com.fintra.app"
CDP="node scripts/android/cdp.mjs"
mkdir -p "$OUT"
RESULTS="$OUT/results.txt"
: > "$RESULTS"
fail=0
pass() { echo "PASS  $*" | tee -a "$RESULTS"; }
bad()  { echo "FAIL  $*" | tee -a "$RESULTS"; fail=1; }
info() { echo "INFO  $*" | tee -a "$RESULTS"; }
shot() { adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null || true; }

# Point tcp:9222 at the app's WebView DevTools socket (pid changes per launch).
forward_devtools() {
  local sock
  sock=$(adb shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | head -1)
  [ -z "$sock" ] && return 1
  adb forward tcp:9222 "localabstract:$sock" >/dev/null 2>&1
}
webview_url() { forward_devtools && $CDP url 2>/dev/null; }
page_eval() { forward_devtools && $CDP eval "$1" 2>/dev/null; }

wait_for_url() { # $1 = substring, $2 = seconds
  local i url=""
  for i in $(seq 1 "$2"); do
    url=$(webview_url)
    case "$url" in *"$1"*) echo "$url"; return 0;; esac
    sleep 1
  done
  echo "$url"
  return 1
}

top_activity() {
  adb shell dumpsys activity activities 2>/dev/null | grep -E 'topResumedActivity|mResumedActivity' | head -1 | sed 's/^ *//'
}

adb logcat -c 2>/dev/null

echo "== install"
adb install -r "$APK" >/dev/null && pass "APK installs" || bad "APK install failed"

echo "== launch"
adb shell am start -W -n "$PKG/.MainActivity" >/dev/null
url=$(wait_for_url "fintra-ai-xi.vercel.app" 60)
shot 1-launch
case "$url" in
  *fintra-ai-xi.vercel.app*) pass "app loads the live site ($url)";;
  *) bad "app did not load the live site (WebView url: '${url:-none}')";;
esac

echo "== sign-in page"
url=$(wait_for_url "/sign-in" 20)
case "$url" in
  *"/sign-in"*) pass "signed-out app goes straight to sign-in";;
  *)
    info "app opened on '${url:-none}' (web build without the in-app redirect); navigating to /sign-in"
    page_eval "location.href = '/sign-in'; true" >/dev/null
    url=$(wait_for_url "/sign-in" 30)
    case "$url" in *"/sign-in"*) pass "reached /sign-in";; *) bad "could not reach /sign-in (at '${url:-none}')";; esac
    ;;
esac
sleep 5
shot 2-sign-in
has_google=$(page_eval "[...document.querySelectorAll('button')].some(b => b.innerText.includes('Continue with Google'))")
[ "$has_google" = "true" ] && pass "sign-in page shows 'Continue with Google'" || bad "Google button not found (got '$has_google')"
native=$(page_eval "!!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())")
[ "$native" = "true" ] && pass "page knows it runs inside the app (Capacitor native)" || bad "Capacitor native bridge not detected (got '$native')"

echo "== Google button"
page_eval "[...document.querySelectorAll('button')].find(b => b.innerText.includes('Continue with Google')).click(); true" >/dev/null
sleep 10
shot 3-after-google-tap
act=$(top_activity)
info "top activity after Google tap: $act"
if echo "$act" | grep -qiE 'chrome|browser|customtab'; then
  pass "Google sign-in opened in the browser (custom tab), not inside the app"
else
  bad "after tapping Google, the top activity is not a browser"
fi
inapp=$(webview_url)
case "$inapp" in
  *accounts.google.com*) bad "Google page loaded INSIDE the app WebView (Google would block it)";;
  *) pass "app WebView stayed on Fintra (${inapp:-unreadable while in background})";;
esac
adb shell input keyevent KEYCODE_BACK
sleep 3

echo "== deep link"
adb shell am start -W -a android.intent.action.VIEW \
  -d "com.fintra.app://auth/callback?error_description=smoke%20test" >/dev/null
url=$(wait_for_url "error=smoke" 30)
shot 4-after-deep-link
case "$url" in
  *"/sign-in?error=smoke"*) pass "deep link opens Fintra and the app handles it ($url)";;
  *) bad "deep link not handled (WebView url: '${url:-none}')";;
esac
act=$(top_activity)
echo "$act" | grep -q "$PKG" && pass "deep link brought Fintra to the front" || bad "Fintra not in front after deep link: $act"

echo "== crashes"
adb logcat -d -b crash > "$OUT/crash.txt" 2>/dev/null
if grep -q "$PKG" "$OUT/crash.txt"; then bad "app crashed (see crash.txt)"; grep -m5 -A5 "$PKG" "$OUT/crash.txt" | tee -a "$RESULTS"; else pass "no app crashes"; fi

echo
cat "$RESULTS"
exit $fail
