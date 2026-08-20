/**
 * 页面内可视化验证(不依赖人眼):在游戏页面里直接采样 WebGL 画布像素、
 * 读取 HUD 状态与场景对象可见性,输出量化报告。
 * 用法:node scripts/cdp-analyze.mjs
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9335;
const PROF = process.env.TEMP + '\\zzl-edge-cdp-ana';
const URL = 'http://127.0.0.1:8080/?demo=1';

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
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error('evalErr: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  }
  return r.result?.result?.value;
};

/** 页面内执行的采样脚本:返回 {canvas, samples, ghosts, disc, rpmMax,...} */
const SAMPLER = `
(async () => {
  const g = window.__zhuzhiliao;
  if (!g) return { error: 'game not booted' };
  const capture = () => {
    // 同步渲染一帧后立刻采样(避开 preserveDrawingBuffer=false 的清空)
    g.scene.update(0.016, { w: g.physics.w, t: g._t });
    const canvas = g.scene.renderer.domElement;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const c2 = tmp.getContext('2d');
    c2.drawImage(canvas, 0, 0, W, H);
    const px = c2.getImageData(0, 0, W, H).data;
    const sample = (x, y) => {
      const i = (y * W + x) * 4;
      return [px[i], px[i+1], px[i+2], px[i+3]];
    };
    const v = new window.__THREE.Vector3(0, 0.78, 0).project(g.scene.camera); // 叶片中心
    const bx = (v.x * 0.5 + 0.5) * W, by = (-v.y * 0.5 + 0.5) * H;
    const v2 = new window.__THREE.Vector3(0, 0.55, 0).project(g.scene.camera); // 玩具中部
    const tx = (v2.x * 0.5 + 0.5) * W, ty = (-v2.y * 0.5 + 0.5) * H;
    const region = (cx, cy, r) => {
      let R=0,G2=0,B=0,A=0,n=0,wR=0,wG=0,wB=0,wA=0,maxB=0;
      const cols = new Set();
      for (let dy=-r; dy<=r; dy+=2) for (let dx=-r; dx<=r; dx+=2) {
        const x=Math.round(cx+dx), y=Math.round(cy+dy);
        if (x<0||y<0||x>=W||y>=H) continue;
        const s = sample(x,y);
        R+=s[0]; G2+=s[1]; B+=s[2]; A+=s[3]; n++;
        const a = s[3]/255;
        wR+=s[0]*a; wG+=s[1]*a; wB+=s[2]*a; wA+=a;
        const lum = 0.3*s[0]+0.6*s[1]+0.1*s[2];
        if (lum > maxB) maxB = lum;
        cols.add((s[0]>>4)+','+(s[1]>>4)+','+(s[2]>>4)+','+(s[3]>>6));
      }
      const wa = wA>0?1:wA; // 防除零
      return {
        avg:[R/n,G2/n,B/n,A/n],
        litAvg: wA>0.01 ? [Math.round(wR/wA), Math.round(wG/wA), Math.round(wB/wA), Math.round(wA/n*255)] : null,
        maxLum: Math.round(maxB),
        colors: cols.size,
      };
    };
    return {
      W, H, rpm: g.physics.rpm,
      blade: region(bx, by, 24),
      toyMid: region(tx, ty, 14),
      sky: region(W-40, H-60, 10),
      ghosts: g.scene.ghosts.map(x => x.ghost.visible),
      disc: g.scene.disc.visible,
    };
  };
  // 等转速降到低值再采样(低速画面)
  let low = null, guard = 0;
  while (guard++ < 120) {
    if (g.physics.rpm < 260) { low = capture(); break; }
    await new Promise(r => setTimeout(r, 100));
  }
  // 等转速升到高值再采样(高速画面:残影+模糊盘)
  let high = null;
  guard = 0;
  while (guard++ < 120) {
    if (g.physics.rpm > 1000) { high = capture(); break; }
    await new Promise(r => setTimeout(r, 100));
  }
  const hud = {
    rpmCardBg: getComputedStyle(document.getElementById('rpmWrap')).backgroundColor,
    rpmCardRect: (() => { const r = document.getElementById('rpmWrap').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    challengeRect: (() => { const r = document.getElementById('challengeCard').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    bodyBg: getComputedStyle(document.body).backgroundImage.slice(0, 60),
    rpmText: document.getElementById('rpmVal').textContent,
    score: document.getElementById('scoreVal').textContent,
    episode: document.getElementById('episodeVal').textContent,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    audioState: g.audio.ctx ? g.audio.ctx.state : 'none',
    lastParams: g.audio.lastParams,
  };
  return { low, high, hud, frames: g._frameCount };
})()
`;

async function analyze(device) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: device.width, height: device.height, deviceScaleFactor: 1, mobile: device.mobile,
  });
  await send('Page.navigate', { url: URL });
  const deadline = Date.now() + 25000;
  let booted = false;
  while (Date.now() < deadline) {
    booted = (await evalJs(`!!window.__zhuzhiliao && window.__zhuzhiliao._frameCount > 30`).catch(() => false)) || false;
    if (booted) break;
    await sleep(400);
  }
  if (!booted) throw new Error('游戏未启动');
  const res = await evalJs(SAMPLER);
  return { device, ...res };
}

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

    const desktop = await analyze({ width: 1280, height: 800, mobile: false });
    const mobile = await analyze({ width: 390, height: 844, mobile: true });
    console.log(JSON.stringify({ desktop, mobile }, null, 2));
    process.exitCode = 0;
  } catch (e) {
    console.error('分析失败:', e.message);
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
}, 90000);
