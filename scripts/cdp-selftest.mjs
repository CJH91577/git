/**
 * CDP 驱动有头 Edge 跑页面自检(真实浏览器 + 真实音频栈)。
 * 用法:node scripts/cdp-selftest.mjs [edgePath]
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const EDGE = process.argv[2] || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const PROF = process.env.TEMP + '\\zzl-edge-cdp';
const URL = 'http://127.0.0.1:8080/?selftest=1';
const TIMEOUT_MS = 45000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function waitTarget() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${PORT}/json`);
      const page = targets.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* browser not up yet */
    }
    await sleep(300);
  }
  throw new Error('Edge 调试端口未就绪');
}

function main() {
  const edge = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROF}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  edge.on('error', (e) => {
    console.error('无法启动 Edge:', e.message);
    process.exit(2);
  });

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
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.result?.value;
  };

  (async () => {
    try {
      const target = await waitTarget();
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = () => rej(new Error('WebSocket 连接失败'));
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
      await send('Page.navigate', { url: URL });

      const deadline = Date.now() + TIMEOUT_MS;
      let title = '';
      while (Date.now() < deadline) {
        title = (await evalJs('document.title')) || '';
        if (title.includes('SELFTEST-RESULT')) break;
        await sleep(400);
      }
      if (!title.includes('SELFTEST-RESULT')) {
        console.error('超时:页面未完成自检,title=' + title);
        process.exitCode = 3;
        return;
      }
      const body = await evalJs(`document.getElementById('selftest').textContent`);
      console.log(body);
      process.exitCode = title.includes('PASS') ? 0 : 1;
    } catch (e) {
      console.error('CDP 自检失败:', e.message);
      process.exitCode = 2;
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

  // 总保险:45s 后强制退出
  setTimeout(() => {
    console.error('总超时,强制退出');
    try {
      edge.kill();
    } catch {
      /* ignore */
    }
    process.exit(4);
  }, TIMEOUT_MS + 20000);
}

main();
