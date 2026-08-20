/**
 * 摄像头手势操控:使用 MediaPipe HandLandmarker 识别双手,
 * 检测"双掌相对快速搓动"(模拟现实中双手搓竹签的动作)并输出搓动力度。
 * 模型与 wasm 均为本地 vendored 文件,运行时不需要联网。
 */

const PALM_IDX = [0, 5, 9, 13, 17];

/** 手势骨架连线(用于画布叠加显示)。 */
const HAND_LINES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9],
  [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export class HandController {
  constructor() {
    this.status = 'idle'; // idle | loading | error | running
    this.statusText = '';
    this.rub = 0;         // 0..1 搓动力度
    this.running = false;
    this.landmarker = null;
    this.stream = null;
    this.video = null;
    this.overlay = null;
    this._prevRel = null;
    this._prevT = 0;
    this._lastVideoTime = -1;
    this._raf = 0;
  }

  async init() {
    this.status = 'loading';
    this.statusText = '正在加载手势模型…';
    try {
      const vision = await import('../vendor/mediapipe/vision_bundle.mjs');
      const files = await vision.FilesetResolver.forVisionTasks('vendor/mediapipe/wasm');
      this.landmarker = await vision.HandLandmarker.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: 'vendor/models/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } catch (err) {
      console.error('[hands] 模型加载失败,尝试 CPU:', err);
      try {
        const vision = await import('../vendor/mediapipe/vision_bundle.mjs');
        const files = await vision.FilesetResolver.forVisionTasks('vendor/mediapipe/wasm');
        this.landmarker = await vision.HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: 'vendor/models/hand_landmarker.task', delegate: 'CPU' },
          runningMode: 'VIDEO',
          numHands: 2,
        });
      } catch (err2) {
        this.status = 'error';
        this.statusText = '手势模型加载失败';
        console.error('[hands] 模型加载失败:', err2);
        return false;
      }
    }
    return true;
  }

  async start(videoEl, overlayCanvas) {
    if (this.running) return true;
    this.video = videoEl;
    this.overlay = overlayCanvas;
    try {
      if (!this.landmarker) {
        const ok = await this.init();
        if (!ok) return false;
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.running = true;
      this.status = 'running';
      this.statusText = '请双手合掌,来回搓动';
      this._loop();
      return true;
    } catch (err) {
      this.status = 'error';
      this.statusText = '摄像头不可用(需 localhost 或 HTTPS)';
      console.error('[hands] 摄像头启动失败:', err);
      this.stop();
      return false;
    }
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.rub = 0;
    this._prevRel = null;
    if (this.status === 'running') {
      this.status = 'idle';
      this.statusText = '';
    }
  }

  _loop() {
    if (!this.running) return;
    this._raf = requestAnimationFrame(() => this._loop());
    const video = this.video;
    if (!video || video.readyState < 2 || video.currentTime === this._lastVideoTime) {
      return;
    }
    this._lastVideoTime = video.currentTime;
    let results = null;
    try {
      results = this.landmarker.detectForVideo(video, performance.now());
    } catch (e) {
      return;
    }
    const now = performance.now();
    const dt = Math.max(1, now - this._prevT) / 1000;
    this._prevT = now;
    this._process(results, dt);
    this._drawOverlay(results);
  }

  _process(results, dt) {
    const hands = results?.landmarks || [];
    if (hands.length < 2) {
      this.rub = lerp(this.rub, 0, 1 - Math.pow(0.02, dt));
      this.statusText = hands.length === 1 ? '看到一只手,请双手合掌搓动' : '未检测到双手';
      this._prevRel = null;
      return;
    }
    const p0 = palmCenter(hands[0]);
    const p1 = palmCenter(hands[1]);
    if (this._prevRel) {
      const vx = (p1[0] - p0[0]) - (this._prevRel[0]);
      const vy = (p1[1] - p0[1]) - (this._prevRel[1]);
      const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const speed = Math.hypot(vx, vy) / dt; // 归一化单位/秒
      const close = dist < 0.34;
      const eff = close ? clamp01(speed / 5.5) : 0;
      this.rub = lerp(this.rub, eff, 1 - Math.pow(0.015, dt));
      if (eff > 0.15) this.statusText = '搓动中!';
      else if (close) this.statusText = '双掌靠近,来回搓动';
      else this.statusText = '双掌靠近一些再搓';
    }
    this._prevRel = [p1[0] - p0[0], p1[1] - p0[1]];
  }

  _drawOverlay(results) {
    const cv = this.overlay;
    if (!cv || !this.video) return;
    const W = cv.width;
    const H = cv.height;
    const g = cv.getContext('2d');
    g.save();
    g.clearRect(0, 0, W, H);
    g.translate(W, 0);
    g.scale(-1, 1);
    try {
      g.drawImage(this.video, 0, 0, W, H);
    } catch {
      /* 视频帧未就绪 */
    }
    g.restore();
    const hands = results?.landmarks || [];
    for (const hand of hands) {
      g.strokeStyle = 'rgba(90,220,140,0.95)';
      g.lineWidth = 1.6;
      g.beginPath();
      for (const [a, b] of HAND_LINES) {
        g.moveTo((1 - hand[a].x) * W, hand[a].y * H);
        g.lineTo((1 - hand[b].x) * W, hand[b].y * H);
      }
      g.stroke();
      g.fillStyle = 'rgba(255,240,180,0.95)';
      for (const lm of hand) {
        g.beginPath();
        g.arc((1 - lm.x) * W, lm.y * H, 2.2, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

function palmCenter(hand) {
  let x = 0;
  let y = 0;
  for (const i of PALM_IDX) {
    x += hand[i].x;
    y += hand[i].y;
  }
  return [x / PALM_IDX.length, y / PALM_IDX.length];
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function lerp(a, b, k) {
  return a + (b - a) * k;
}
