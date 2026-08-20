/**
 * 开始流程验证:默认页面(无参数)→ 开始界面可见 →
 * 真实鼠标点击「开始」→ 界面隐藏、音频激活、Toast 出现。
 * 用法:node scripts/cdp-overlay.mjs
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9337;
const PROF = process.env.TEMP + '\\zzl-edge-cdp-ovl';
const URL = 'http://127.0.0.1:8080/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROF}`,
  '--headless=new',
  '--disable-gpu',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

let ws;
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('evalErr: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};
const report = (name, ok, detail = '') => console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);

let fails = 0;
const chk = (name, ok, detail = '') => {
  report(name, ok, detail);
  if (!ok) fails++;
};

(async () => {
  try {
    let target;
    const d = Date.now() + 20000;
    while (Date.now() < d) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        target = targets.find((t) => t.type === 'page');
        if (target) break;
      } catch { /* not ready */ }
      await sleep(300);
    }
    if (!target) throw new Error('调试端口未就绪');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws 连接失败'));
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg);
      }
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: URL });

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evalJs(`!!window.__zhuzhiliao && window.__zhuzhiliao._frameCount > 20`).catch(() => false)) break;
      await sleep(300);
    }

    const ov = await evalJs(`
      (() => {
        const el = document.getElementById('startOverlay');
        const cs = getComputedStyle(el);
        const btn = document.getElementById('btnStart').getBoundingClientRect();
        return { display: cs.display, opacity: cs.opacity, hidden: el.classList.contains('hidden'),
                 btnCenter: [Math.round(btn.x + btn.width/2), Math.round(btn.y + btn.height/2)],
                 btnSize: [Math.round(btn.width), Math.round(btn.height)] };
      })()
    `);
    chk('开始界面默认可见', ov.display === 'flex' && !ov.hidden && ov.opacity === '1', JSON.stringify(ov));
    chk('开始按钮位于视口内', ov.btnCenter[0] > 0 && ov.btnCenter[1] > 0 && ov.btnSize[0] > 100);

    // 真实鼠标点击「开始」
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ov.btnCenter[0], y: ov.btnCenter[1], button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ov.btnCenter[0], y: ov.btnCenter[1], button: 'left', buttons: 0, clickCount: 1 });
    await sleep(500);

    const after = await evalJs(`
      ({
        hidden: document.getElementById('startOverlay').classList.contains('hidden'),
        audio: window.__zhuzhiliao.audio.ctx ? window.__zhuzhiliao.audio.ctx.state : 'none',
        started: window.__zhuzhiliao._started,
        toasts: document.getElementById('toasts').children.length,
      })
    `);
    chk('点击开始后界面隐藏', after.hidden === true);
    chk('点击开始后游戏进入进行态', after.started === true);
    chk('音频上下文已创建', after.audio === 'running' || after.audio === 'suspended', `state=${after.audio}`);
    chk('欢迎 Toast 出现', after.toasts >= 1, `toasts=${after.toasts}`);

    console.log(fails === 0 ? '\n✅ 开始流程验证通过' : `\n❌ 失败 ${fails} 项`);
    process.exitCode = fails === 0 ? 0 : 1;
  } catch (e) {
    console.error('验证失败:', e.message);
    process.exitCode = 2;
  } finally {
    try { await send('Browser.close'); } catch { /* ignore */ }
    setTimeout(() => {
      try { edge.kill(); } catch { /* ignore */ }
      process.exit(process.exitCode || 0);
    }, 400);
  }
})();

setTimeout(() => {
  try { edge.kill(); } catch { /* ignore */ }
  process.exit(4);
}, 60000);
