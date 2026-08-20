/**
 * 传统操控输入:鼠标拖拽/滑动、触摸滑动、键盘、手机摇一摇。
 * 所有输入最终归一为:
 *  - rub:0..1 的"搓动"力度(持续力矩)
 *  - flick:一次性"甩动"冲量(0..1)
 */
const RUB_SPEED_FULL = 480; // px/s 达到满搓动
const FLICK_MIN_SPEED = 300; // px/s 以上算甩动
const FLICK_FULL_SPEED = 1500;

export class InputController {
  /**
   * @param canvas 画布
   * @param opts { onFlick, shouldRub, onRubStart, onRubEnd }
   *   shouldRub(e): 判定该次按下是否算"搓动"(否则留给视角旋转);
   *   onRubStart/onRubEnd: 搓动开始/结束回调。
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.onFlick = opts.onFlick || (() => {});
    this.shouldRub = opts.shouldRub || (() => true);
    this.onRubStart = opts.onRubStart || (() => {});
    this.onRubEnd = opts.onRubEnd || (() => {});
    this.rub = 0;
    this.keyRub = 0;
    this.shake = 0;
    this.shakeReady = false;

    this._pointer = null; // {id, x, y, t, speed}
    this._lastMove = 0;
    this._accEMA = 0;
    this._shakeEMA = 0;
    this._hasShakeSource = false;
    this._attached = false;
    this._deviceMotionHandler = null;
    this._keyHeld = false;
    this._keyHoldTime = 0;
  }

  attach() {
    if (this._attached) return;
    this._attached = true;
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    window.addEventListener('pointercancel', (e) => this._up(e));
    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    window.addEventListener('blur', () => this._resetAll());
  }

  /** 摇一摇:需要用户手势触发权限(iOS),其它平台自动启用。 */
  enableShake() {
    if (typeof DeviceMotionEvent === 'undefined') return;
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission()
        .then((r) => {
          if (r === 'granted') this._startShake();
        })
        .catch(() => {});
    } else {
      this._startShake();
    }
  }

  _startShake() {
    if (this.shakeReady) return;
    this.shakeReady = true;
    this._deviceMotionHandler = (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a) return;
      const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) || 0; // m/s²
      // 过滤重力(约 9.8)后的"晃动能量"
      const energy = Math.max(0, mag - 11.2);
      this._accEMA = this._accEMA * 0.86 + energy * 0.14;
      const k = clamp01((this._accEMA - 1.2) / 7);
      this._shakeEMA = this._shakeEMA * 0.9 + k * 0.1;
      if (this._shakeEMA > 0.06) this._hasShakeSource = true;
    };
    window.addEventListener('devicemotion', this._deviceMotionHandler);
  }

  get shakeActive() {
    return this._hasShakeSource;
  }

  _down(e) {
    if (this._pointer) return; // 单指拖动为主
    if (!this.shouldRub(e)) return; // 留给视角旋转
    this._pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), speed: 0 };
    this.onRubStart();
    this.canvas.setPointerCapture?.(e.pointerId);
  }

  _move(e) {
    if (!this._pointer || e.pointerId !== this._pointer.id) return;
    const now = performance.now();
    const dt = Math.max(0.008, (now - this._pointer.t) / 1000);
    const dx = e.clientX - this._pointer.x;
    const dy = e.clientY - this._pointer.y;
    const dist = Math.hypot(dx, dy);
    const speed = dist / dt;
    this._pointer.speed = this._pointer.speed * 0.55 + speed * 0.45;
    this._pointer.x = e.clientX;
    this._pointer.y = e.clientY;
    this._pointer.t = now;
    this._lastMove = now;
  }

  _up(e) {
    if (!this._pointer || e.pointerId !== this._pointer.id) return;
    const speed = this._pointer.speed;
    if (speed > FLICK_MIN_SPEED) {
      // 快速划过 → 甩动冲量
      this.onFlick(clamp01((speed - FLICK_MIN_SPEED) / (FLICK_FULL_SPEED - FLICK_MIN_SPEED)));
    }
    this._pointer = null;
    this.onRubEnd();
  }

  _key(e, down) {
    if (e.repeat) return;
    const k = e.code;
    if (k === 'Space' || k === 'ArrowLeft' || k === 'ArrowUp') {
      e.preventDefault();
      this._keyHeld = down;
    }
  }

  _resetAll() {
    this._pointer = null;
    this._keyHeld = false;
    this.rub = 0;
    this.keyRub = 0;
    this.shake = 0;
  }

  /** 每帧轮询:更新各输入源并返回当前总搓动力度 0..1。 */
  poll(dt, now = performance.now()) {
    // 指针:按住并移动 → 搓动;停止移动迅速衰减
    if (this._pointer) {
      const moving = now - this._lastMove < 90;
      const target = moving ? clamp01(this._pointer.speed / RUB_SPEED_FULL) : 0;
      const k = moving ? 1 - Math.pow(0.02, dt) : 1 - Math.pow(0.001, dt);
      this.rub = lerp(this.rub, target, k);
    } else {
      this.rub = lerp(this.rub, 0, 1 - Math.pow(0.001, dt));
    }
    // 键盘:按住逐渐加力
    if (this._keyHeld) {
      this._keyHoldTime = (this._keyHoldTime || 0) + dt;
      this.keyRub = Math.min(1, this._keyHoldTime / 0.45);
    } else {
      this._keyHoldTime = 0;
      this.keyRub = lerp(this.keyRub, 0, 1 - Math.pow(0.001, dt));
    }
    // 摇一摇
    if (this.shakeReady) {
      this.shake = lerp(this.shake, this._shakeEMA, 1 - Math.pow(0.02, dt));
    } else {
      this.shake = 0;
    }
    return clamp01(this.rub + this.keyRub * 0.85 + this.shake);
  }
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function lerp(a, b, k) {
  return a + (b - a) * k;
}
