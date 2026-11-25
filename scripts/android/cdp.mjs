// Tiny Chrome DevTools Protocol client for the app's WebView (debug builds
// expose it). Used by smoke-test.sh after `adb forward tcp:9222 ...`.
//
//   node scripts/android/cdp.mjs url
//   node scripts/android/cdp.mjs eval "<javascript expression>"
//
// Prints the page URL or the expression's value. Node 22 has WebSocket built in.
const [, , cmd, expr] = process.argv;

async function page() {
  const list = await (await fetch("http://127.0.0.1:9222/json")).json();
  return list.find((p) => p.type === "page") ?? list[0];
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error("CDP timeout")); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      resolve(msg.result?.result?.value ?? msg.result?.exceptionDetails?.text ?? null);
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  });
}

try {
  const p = await page();
  if (!p) throw new Error("no WebView page");
  if (cmd === "url") console.log(p.url);
  else if (cmd === "eval") console.log(JSON.stringify(await evaluate(p.webSocketDebuggerUrl, expr)));
  else throw new Error("usage: url | eval <expr>");
} catch (e) {
  console.log("");
  console.error(String(e?.message ?? e));
  process.exit(1);
}
