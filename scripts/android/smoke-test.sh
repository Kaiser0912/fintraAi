#!/usr/bin/env bash
# Android smoke test for the Fintra app (runs inside the emulator job on CI).
#
#   1. install + launch the APK, check the WebView loads the live sign-in page
#   2. tap "Continue with Google", check Google opens in Chrome (not in-app)
#   3. send the sign-in deep link, check Android routes it into Fintra and the
#      app handles it (lands on /sign-in?error=...)
#
# Screenshots and a results file go to $OUT. Exits non-zero on any failure.
set -u
APK="${1:?apk path}"
OUT="${2:-smoke-out}"
PKG="com.fintra.app"
mkdir -p "$OUT"
RESULTS="$OUT/results.txt"
: > "$RESULTS"
fail=0
pass() { echo "PASS  $*" | tee -a "$RESULTS"; }
bad()  { echo "FAIL  $*" | tee -a "$RESULTS"; fail=1; }
shot() { adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null || true; }

# Current URL of the app's WebView via the DevTools socket (debug builds only).
webview_url() {
  local sock
  sock=$(adb shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | head -1)
  [ -z "$sock" ] && { echo ""; return; }
  adb forward tcp:9222 "localabstract:$sock" >/dev/null 2>&1
  curl -s --max-time 5 http://127.0.0.1:9222/json | grep -o '"url": *"[^"]*"' | head -1 | sed 's/.*"url": *"\(.*\)"/\1/'
}

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
  adb shell dumpsys activity activities 2>/dev/null | grep -E 'topResumedActivity|mResumedActivity' | head -1
}

# Coordinates of a node whose text/desc contains $1, from a UI dump.
tap_text() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb pull /sdcard/ui.xml "$OUT/ui.xml" >/dev/null 2>&1
  local node bounds
  node=$(sed 's/>/>\n/g' "$OUT/ui.xml" | grep -i "$1" | head -1)
  bounds=$(echo "$node" | grep -o 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | head -1)
  [ -z "$bounds" ] && return 1
  local x1 y1 x2 y2
  read -r x1 y1 x2 y2 <<<"$(echo "$bounds" | grep -o '[0-9]*' | tr '\n' ' ')"
  adb shell input tap $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))
}

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
url=$(wait_for_url "/sign-in" 30)
case "$url" in *"/sign-in"*) pass "signed-out app shows sign-in";; *) bad "expected /sign-in, got '${url:-none}'";; esac
sleep 4
shot 2-sign-in

echo "== Google button"
if tap_text "Continue with Google"; then
  sleep 10
  shot 3-after-google-tap
  act=$(top_activity)
  echo "top: $act" >> "$RESULTS"
  if echo "$act" | grep -qiE 'chrome|browser|customtab'; then
    pass "Google sign-in opened in the browser (custom tab), not inside the app"
  else
    bad "after tapping Google, top activity is not a browser: $act"
  fi
  inapp=$(webview_url)
  case "$inapp" in
    *accounts.google.com*) bad "Google page loaded INSIDE the app WebView (would be blocked)";;
    *) pass "app WebView did not navigate to Google ($inapp)";;
  esac
  adb shell input keyevent KEYCODE_BACK
  sleep 3
else
  bad "could not find the 'Continue with Google' button on screen"
fi

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

echo
cat "$RESULTS"
exit $fail
