// Dependency-free CDP smoke check. Connects to a headless Chrome (--remote-debugging-port=9222),
// navigates to the dev server, captures console + exceptions, probes WebGPU, checks React mount + HUD,
// and writes a screenshot. Node 24 globals (fetch, WebSocket) — no npm deps.

const BASE = process.env.CDP_BASE ?? 'http://localhost:9222';
const URL = process.env.APP_URL ?? 'http://localhost:5173';
const OUT = process.env.SHOT_OUT ?? '/tmp/hbn-smoke.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/json`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* chrome not up yet */ }
    await sleep(250);
  }
  throw new Error('no CDP page target found');
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ready, send, events, close: () => ws.close() };
}

async function main() {
  const target = await findPageTarget();
  const c = client(target.webSocketDebuggerUrl);
  await c.ready;

  const consoleMsgs = [];
  const exceptions = [];
  c.events.length = 0;

  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');

  // Re-navigate so we capture console output from the very start.
  await c.send('Page.navigate', { url: URL });
  await sleep(2500);

  for (const e of c.events) {
    if (e.method === 'Runtime.consoleAPICalled') {
      const text = (e.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      consoleMsgs.push({ level: e.params.type, text });
    } else if (e.method === 'Runtime.exceptionThrown') {
      exceptions.push(e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text ?? 'unknown');
    } else if (e.method === 'Log.entryAdded') {
      consoleMsgs.push({ level: e.params.entry.level, text: e.params.entry.text });
    }
  }

  const evalExpr = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  };

  const checks = {
    title: await evalExpr('document.title'),
    rootMounted: await evalExpr('!!document.getElementById("root") && document.getElementById("root").childElementCount > 0'),
    hudPresent: await evalExpr('!!document.querySelector(".hbn-shell")'),
    canvasPresent: await evalExpr('!!document.querySelector("canvas.hbn-viewport")'),
    crossOriginIsolated: await evalExpr('self.crossOriginIsolated === true'),
    hasWebGPU: await evalExpr('"gpu" in navigator'),
    adapter: await evalExpr(
      '(async()=>{try{if(!("gpu" in navigator))return "no-navigator.gpu";const a=await navigator.gpu.requestAdapter();if(!a)return "null-adapter";return "adapter-ok";}catch(e){return "err:"+e.message;}})()',
    ),
    bodyText: (await evalExpr('document.body.innerText'))?.slice(0, 200),
  };

  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

  console.log('=== CDP SMOKE CHECK ===');
  console.log(JSON.stringify(checks, null, 2));
  console.log(`screenshot: ${OUT}`);
  const errs = consoleMsgs.filter((m) => m.level === 'error');
  console.log(`console messages: ${consoleMsgs.length} (errors: ${errs.length})`);
  for (const m of consoleMsgs.slice(0, 25)) console.log(`  [${m.level}] ${m.text}`);
  console.log(`uncaught exceptions: ${exceptions.length}`);
  for (const e of exceptions.slice(0, 10)) console.log(`  ${e}`);

  c.close();
  const ok = checks.rootMounted && checks.hudPresent && checks.canvasPresent && errs.length === 0 && exceptions.length === 0;
  console.log(ok ? 'RESULT: PASS' : 'RESULT: ISSUES');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('CDP check failed:', e.message); process.exit(2); });
