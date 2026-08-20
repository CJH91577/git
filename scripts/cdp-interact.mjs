/**
 * 真实输入交互验证(CDP 合成鼠标/键盘事件):
 *  1. 在竹知了上按住来回拖动 → 转速应明显上升(搓动生效)
 *  2. 松开后转速随空气阻力衰减
 *  3. 键盘按住空格 → 加速
 *  4. 摄像头在无摄像头环境 → 优雅失败且游戏继续运行
 * 用法:node scripts/cdp-interact.mjs
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9336;
const PROF = process.env.TEMP + '\\zzl-edge-cdp-int';
const URL = 'http://127.0.0.1:8080/?nosplash=1';

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
  if (r.result?.exceptionDetails) {
    throw new Error('evalErr: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  }
  return r.result?.result?.value;
};

const results = [];
const report = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
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
      if (await evalJs(`!!window.__zhuzhiliao && window.__zhuzhiliao._frameCount > 30`).catch(() => false)) break;
      await sleep(300);
    }
    report('游戏启动', await evalJs(`!!window.__zhuzhiliao`));

    // 竹知了屏幕坐标
    const pos = await evalJs(`
      (() => {
        const g = window.__zhuzhiliao;
        const v = new window.__THREE.Vector3(0, 0.6, 0).project(g.scene.camera);
        const W = g.scene.canvas.clientWidth, H = g.scene.canvas.clientHeight;
        return [Math.round((v.x*0.5+0.5)*W), Math.round((-v.y*0.5+0.5)*H)];
      })()
    `);
    const [tx, ty] = pos;
    report('竹知了屏幕坐标有效', tx > 0 && ty > 0, `(${tx},${ty})`);

    const w0 = await evalJs(`window.__zhuzhiliao.physics.w`);
    // 模拟按住来回搓动:从玩具位置来回快速拖动
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 0; i < 18; i++) {
      const dx = (i % 2 === 0 ? 1 : -1) * 14;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tx + dx * (i % 4), y: ty + ((i * 7) % 20) - 10, button: 'left', buttons: 1 });
      await sleep(12);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(100);
    const wRub = await evalJs(`window.__zhuzhiliao.physics.w`);
    report('鼠标来回搓动 → 转速明显上升', wRub > w0 + 10, `w: ${w0.toFixed(1)} → ${wRub.toFixed(1)} rad/s`);

    // 甩动冲量:快速长距离划过
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tx + i * 36, y: ty + i * 4, button: 'left', buttons: 1 });
      await sleep(8);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx + 288, y: ty + 32, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(100);
    const wFlick = await evalJs(`window.__zhuzhiliao.physics.w`);
    report('快速甩动 → 冲量加速', wFlick > wRub, `w: ${wRub.toFixed(1)} → ${wFlick.toFixed(1)}`);

    // 空气阻力衰减
    const wHigh = wFlick;
    await sleep(2000);
    const wDecayed = await evalJs(`window.__zhuzhiliao.physics.w`);
    report('松开后转速随空气阻力衰减', wDecayed < wHigh * 0.8, `w: ${wHigh.toFixed(1)} → ${wDecayed.toFixed(1)}`);

    // 键盘搓动:按住空格 1s
    const wk0 = await evalJs(`window.__zhuzhiliao.physics.w`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await sleep(1000);
    const wk1 = await evalJs(`window.__zhuzhiliao.physics.w`);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    report('按住空格 → 键盘搓动加速', wk1 > wk0 + 5, `w: ${wk0.toFixed(1)} → ${wk1.toFixed(1)}`);

    // 音频参数跟随
    const ap = await evalJs(`window.__zhuzhiliao.audio.lastParams`);
    report('音频参数随转速联动(g>0 且频率>300Hz)', ap && ap.g > 0.3 && ap.f > 300, `g=${ap?.g} f=${ap?.f?.toFixed(0)}Hz`);

    // 摄像头失败路径(无头环境无摄像头)
    await evalJs(`document.getElementById('btnCam').click()`);
    await sleep(2500);
    const cam = await evalJs(`({ status: window.__zhuzhiliao.hands.status, running: window.__zhuzhiliao.hands.running, gameFrames: window.__zhuzhiliao._frameCount, pipOn: document.getElementById('camPip').classList.contains('on') })`);
    report('无摄像头环境优雅降级', cam.status === 'error' && cam.running === false && cam.pipOn === false, JSON.stringify(cam));
    report('摄像头失败后游戏继续运行', cam.gameFrames > 0);

    // 挑战模式切换 UI
    await evalJs(`document.querySelector('[data-mode="sprint"]').click()`);
    const mode = await evalJs(`window.__zhuzhiliao.gs.mode`);
    report('切换极速模式生效', mode === 'sprint');

    console.log('');
    const fails = results.filter((r) => !r.ok);
    console.log(fails.length === 0 ? '✅ 交互验证全部通过' : `❌ 失败 ${fails.length} 项`);
    process.exitCode = fails.length === 0 ? 0 : 1;
  } catch (e) {
    console.error('交互验证失败:', e.message);
    process.exitCode = 2;
  } finally {
    try {
      await send('Browser.close');
    } catch { /* ignore */ }
    setTimeout(() => {
      try { edge.kill(); } catch { /* ignore */ }
      process.exit(process.exitCode || 0);
    }, 400);
  }
})();

setTimeout(() => {
  try { edge.kill(); } catch { /* ignore */ }
  process.exit(4);
}, 80000);
