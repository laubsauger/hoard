// Crowd-test CDP driver. Connects to a headless Chrome (--remote-debugging-port=9224), opens the isolated
// crowd-test page, waits for the GLB bake, captures screenshots at a few camera distances, and prints
// window.__crowd.info() at each (so a reviewer can confirm: rigged near + impostor far, ZERO boxes). Node 24
// globals (fetch, WebSocket) — no npm deps. Mirrors tools/ragdoll-shot.mjs.
//
// Env: CDP_BASE (default http://localhost:9224), APP_URL (default http://localhost:5180/crowd-test.html),
//      OUT_DIR (default /tmp), LABEL (default crowd), DISTS (default "70,120,180"), COUNT (default 200).

const BASE = process.env.CDP_BASE ?? 'http://localhost:9224';
const APP_URL = process.env.APP_URL ?? 'http://localhost:5180/crowd-test.html';
const OUT_DIR = process.env.OUT_DIR ?? '/tmp';
const LABEL = process.env.LABEL ?? 'crowd';
const DISTS = (process.env.DISTS ?? '70,120,180').split(',').map(Number);
const COUNT = Number(process.env.COUNT ?? '200');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 80; i++) {
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
  const fs = await import('node:fs');
  const target = await findPageTarget();
  const c = client(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');

  const consoleMsgs = [];
  c.events.length = 0;
  await c.send('Page.navigate', { url: APP_URL });

  const evalExpr = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  let ready = false;
  for (let i = 0; i < 160; i++) {
    try { ready = await evalExpr('window.__crowdReady === true'); } catch { /* page still loading */ }
    if (ready) break;
    await sleep(250);
  }
  if (!ready) throw new Error('crowd-test never became ready (WebGPU init / GLB bake failed?)');

  for (const e of c.events) {
    if (e.method === 'Runtime.consoleAPICalled') {
      consoleMsgs.push({ level: e.params.type, text: (e.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ') });
    } else if (e.method === 'Runtime.exceptionThrown') {
      consoleMsgs.push({ level: 'exception', text: e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text ?? 'unknown' });
    } else if (e.method === 'Log.entryAdded') {
      consoleMsgs.push({ level: e.params.entry.level, text: e.params.entry.text });
    }
  }

  const shot = async (label) => {
    const s = await c.send('Page.captureScreenshot', { format: 'png' });
    const path = `${OUT_DIR}/${LABEL}-${label}.png`;
    fs.writeFileSync(path, Buffer.from(s.data, 'base64'));
    return path;
  };

  await evalExpr(`window.__crowd.setCount(${COUNT})`);
  await sleep(300);

  const paths = {};
  const infos = {};
  for (const d of DISTS) {
    await evalExpr(`window.__crowd.setCameraDistance(${d})`);
    await sleep(600); // let a few frames settle (gait + impostor angle)
    paths[`d${d}`] = await shot(`d${d}`);
    infos[`d${d}`] = await evalExpr('window.__crowd.info()');
  }

  console.log('=== CROWD SHOT ===');
  console.log('screenshots:', JSON.stringify(paths, null, 2));
  console.log('info:', JSON.stringify(infos, null, 2));
  const errs = consoleMsgs.filter((m) => m.level === 'error' || m.level === 'exception');
  console.log(`console errors: ${errs.length}`);
  for (const m of errs.slice(0, 12)) console.log(`  [${m.level}] ${m.text}`);
  c.close();
  process.exit(0);
}

main().catch((e) => { console.error('crowd-shot failed:', e.message); process.exit(2); });
