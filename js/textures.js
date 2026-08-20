/**
 * 程序化 Canvas 纹理:竹材质感全部用代码绘制,不依赖任何图片资源。
 */
import * as THREE from 'three';

function makeCanvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  return c;
}

function toTexture(c, repeatX = 1, repeatY = 1) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  return t;
}

/** 竹竿纹理:纵向竹纤维条纹 + 竹节环 + 细碎斑点。 */
export function makeBambooTexture(seed = 1) {
  const W = 128;
  const H = 256;
  const rand = mulberry32(seed * 7919);
  const tex = makeCanvas(W, H, (g) => {
    // 底色:纵向色带,模拟竹纤维
    for (let x = 0; x < W; x++) {
      const band = 0.5 + 0.5 * Math.sin(x * 0.35 + seed * 2.3);
      const shade = 0.82 + 0.16 * band + (rand() - 0.5) * 0.06;
      const r = Math.round(214 * shade);
      const gr = Math.round(178 * shade);
      const b = Math.round(110 * shade);
      g.fillStyle = `rgb(${r},${gr},${b})`;
      g.fillRect(x, 0, 1, H);
    }
    // 更亮的细纤维丝
    for (let i = 0; i < 46; i++) {
      const x = Math.floor(rand() * W);
      const w = 1 + rand() * 2;
      const alpha = 0.05 + rand() * 0.1;
      g.fillStyle = `rgba(255,246,214,${alpha})`;
      g.fillRect(x, 0, w, H);
    }
    // 竹节环
    const nodeYs = [0.16, 0.52, 0.86];
    for (const ny of nodeYs) {
      const y = ny * H;
      const grad = g.createLinearGradient(0, y - 10, 0, y + 10);
      grad.addColorStop(0, 'rgba(120,92,46,0)');
      grad.addColorStop(0.5, 'rgba(120,92,46,0.55)');
      grad.addColorStop(1, 'rgba(120,92,46,0)');
      g.fillStyle = grad;
      g.fillRect(0, y - 10, W, 20);
      g.fillStyle = 'rgba(235,220,170,0.8)';
      g.fillRect(0, y - 1.5, W, 3);
    }
    // 细小斑点
    for (let i = 0; i < 160; i++) {
      g.fillStyle = `rgba(120,96,52,${0.04 + rand() * 0.08})`;
      g.fillRect(rand() * W, rand() * H, 1 + rand() * 2, 1);
    }
  });
  return toTexture(tex, 2, 1);
}

/** 叶片纹理:沿长度方向的竹纤维。 */
export function makeBladeTexture() {
  const W = 256;
  const H = 64;
  const rand = mulberry32(42);
  const tex = makeCanvas(W, H, (g) => {
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#efe3b2');
    grad.addColorStop(1, '#e2d08f');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 120; i++) {
      const y = rand() * H;
      const alpha = 0.05 + rand() * 0.12;
      g.strokeStyle = `rgba(160,132,70,${alpha})`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, y);
      const y2 = y + (rand() - 0.5) * 6;
      g.lineTo(W, y2);
      g.stroke();
    }
    // 叶脉中线略深
    g.strokeStyle = 'rgba(140,112,60,0.25)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, H / 2);
    g.lineTo(W, H / 2);
    g.stroke();
  });
  return toTexture(tex);
}

/** 地面:夏日草地径向渐变。 */
export function makeGroundTexture() {
  const S = 512;
  const tex = makeCanvas(S, S, (g) => {
    const grad = g.createRadialGradient(S / 2, S / 2, 20, S / 2, S / 2, S / 2);
    grad.addColorStop(0, '#a8cf7c');
    grad.addColorStop(0.55, '#8dbb63');
    grad.addColorStop(1, '#6da04c');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    // 草叶噪点
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const d = Math.hypot(x - S / 2, y - S / 2) / (S / 2);
      g.fillStyle = d < 0.6 ? `rgba(96,148,66,${0.05 + Math.random() * 0.1})` : `rgba(70,110,50,${0.1 + Math.random() * 0.15})`;
      g.fillRect(x, y, 2, 3);
    }
  });
  const t = new THREE.CanvasTexture(tex);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 旋转模糊圆盘纹理:中心亮、边缘透明,叠加在叶片上表现高速旋转。 */
export function makeDiscTexture() {
  const S = 256;
  const tex = makeCanvas(S, S, (g) => {
    const grad = g.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(255,244,214,0.9)');
    grad.addColorStop(0.45, 'rgba(255,236,190,0.35)');
    grad.addColorStop(0.8, 'rgba(255,232,180,0.08)');
    grad.addColorStop(1, 'rgba(255,232,180,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
  });
  return new THREE.CanvasTexture(tex);
}

/** 叶片叶形轮廓(单侧,从轮毂伸出的竹叶)。 */
export function makeBladeShape() {
  const s = new THREE.Shape();
  s.moveTo(0.014, 0.004);
  s.quadraticCurveTo(0.045, 0.021, 0.105, 0.018);
  s.quadraticCurveTo(0.145, 0.014, 0.168, 0.001);
  s.quadraticCurveTo(0.15, -0.009, 0.122, -0.014);
  s.quadraticCurveTo(0.06, -0.021, 0.014, -0.006);
  s.closePath();
  return s;
}

/** 简单可复现伪随机数。 */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
