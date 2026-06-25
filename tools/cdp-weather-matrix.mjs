// Drive the dev Controls panel (weather <select> + time-of-day range) via CDP and capture a screenshot matrix.
// React controlled inputs need the native value setter + a dispatched event to fire onChange.
const BASE = process.env.CDP_BASE ?? 'http://localhost:9222';
const URL = process.env.APP_URL ?? 'http://localhost:5174/hoard/';
const OUTDIR = process.env.OUTDIR ?? '/tmp/hbn-wx-shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/json`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('no CDP page target');
}
function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
    else if (msg.method) events.push(msg);
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ready, send, events, close: () => ws.close() };
}

async function main() {
  const fs = await import('node:fs');
  fs.mkdirSync(OUTDIR, { recursive: true });
  const target = await findPageTarget();
  const c = client(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: URL });
  await sleep(6000); // let the slice boot + WebGPU init

  const evalExpr = async (expression) => {
    const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  // The dev Controls panel boots COLLAPSED — click "Open controls" so the weather <select> + time range mount.
  await evalExpr(`(()=>{
    const btn=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'').includes('Open controls'));
    if(btn) btn.click();
    return !!btn;
  })()`);
  await sleep(400);

  // Probe the controls.
  const probe = await evalExpr(`(()=>{
    const sel = document.querySelector('.hbn-controls select');
    const range = document.querySelector('.hbn-controls input[type=range]');
    return { hasSel: !!sel, hasRange: !!range, canvas: !!document.querySelector('canvas') };
  })()`);
  console.log('probe', JSON.stringify(probe));

  // Helper expression builders run IN PAGE. Use native setters so React's onChange fires.
  const setWeather = async (w) => {
    await evalExpr(`(()=>{
      const sel = document.querySelector('.hbn-controls select');
      if (!sel) return 'no-select';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
      setter.call(sel, ${JSON.stringify(w)});
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      return sel.value;
    })()`);
  };
  const setTime = async (t) => {
    await evalExpr(`(()=>{
      const range = document.querySelector('.hbn-controls input[type=range]');
      if (!range) return 'no-range';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(range, String(${t}));
      range.dispatchEvent(new Event('input',{bubbles:true}));
      range.dispatchEvent(new Event('change',{bubbles:true}));
      return range.value;
    })()`);
  };

  // Hide dev/diagnostic overlays for the clean shot.
  await evalExpr(`(()=>{const s=document.createElement('style');s.id='hide-dev';s.textContent='.hbn-dev,.hbn-dbg,.hbn-controls{display:none !important;}';document.head.appendChild(s);return true;})()`);

  const NOON = 0.5, NIGHT = 0.04;
  const matrix = [
    ['clear', NOON, 'clear-noon'],
    ['rain', NOON, 'rain-noon'],
    ['fog', NOON, 'fog-noon'],
    ['smoke', NOON, 'smoke-noon'],
    ['clear', NIGHT, 'clear-night'],
    ['fog', NIGHT, 'fog-night'],
  ];

  for (const [w, t, name] of matrix) {
    await setWeather(w);
    await setTime(t);
    await sleep(4000); // let grade + fog ease fully settle
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const path = `${OUTDIR}/${name}.png`;
    fs.writeFileSync(path, Buffer.from(shot.data, 'base64'));
    console.log('captured', name, '->', path);
  }

  // Capture any console errors.
  const errs = c.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error').length;
  const exc = c.events.filter((e) => e.method === 'Runtime.exceptionThrown').length;
  console.log('console-errors', errs, 'exceptions', exc);
  c.close();
}
main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
