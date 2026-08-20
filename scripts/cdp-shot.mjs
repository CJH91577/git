/**
 * CDP 截图 + 控制台错误收集:node scripts/cdp-shot.mjs <url> <out.png> <width> <height>
 * 在 headless Edge 里打开页面,等待游戏运行若干帧后截图,
 * 同时打印页面内的 console 错误与未捕获异常。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const PROF = process.env.TEMP + '\\zzl-edge-cdp-shot';
const [url, outFile, width = '1280', height = '800'] = process.argv.slice(2);
const W = Number(width);
const H = Number(height);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(u) {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

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
const errors = [];

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('evaluate 异常: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};

(async () => {
  try {
    // 等待调试端口
    let target;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const targets = await httpJson(`http://127.0.0.1:${PORT}/json`);
        target = targets.find((t) => t.type === 'page');
        if (target) break;
      } catch {
        /* not ready */
      }
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
      } else if (msg.method === 'Runtime.exceptionThrown') {
        errors.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push('[console.error] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: W < 500,
    });
    await send('Page.navigate', { url });

    // 等待游戏跑起来(帧数 > 140 或 30 秒超时)
    const frameDeadline = Date.now() + 30000;
    let frames = -1;
    let err = null;
    while (Date.now() < frameDeadline) {
      try {
        const r = await evalJs(`window.__zhuzhiliao ? window.__zhuzhiliao._frameCount : -1`);
        frames = r ?? -1;
      } catch (e) {
        err = String(e);
      }
      if (frames > 140) break;
      await sleep(300);
    }
    console.log(`frames=${frames}${err ? ' evalErr=' + err : ''}`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot saved: ' + outFile + ' (' + fs.statSync(outFile).size + ' bytes)');

    const title = await evalJs('document.title').catch(() => '?');
    console.log('title=' + title);
    if (errors.length) {
      console.log('--- 页面错误 ---');
      for (const e of errors) console.log(e);
    } else {
      console.log('--- 无控制台错误/异常 ---');
    }
    process.exitCode = frames > 140 ? 0 : 2;
  } catch (e) {
    console.error('CDP 截图失败:', e.message);
    process.exitCode = 3;
  } finally {
    try {
      await send('Browser.close');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        edge.kill();
      } catch {
        /* ignore */
      }
      process.exit(process.exitCode || 0);
    }, 400);
  }
})();

setTimeout(() => {
  console.error('总超时');
  try {
    edge.kill();
  } catch {
    /* ignore */
  }
  process.exit(4);
}, 60000);
