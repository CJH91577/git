/**
 * 竹知了叶片旋转物理(纯逻辑模块,无 DOM 依赖,可被 Node 测试)。
 *
 * 单位约定:
 *  - 角速度 w:rad/s
 *  - 力矩/角加速度:rad/s²(转动惯量归一化为 1)
 *
 * 真实竹知了:双手搓动竹签给叶片一个转速,叶片很轻,之后主要受空气阻力
 * (低转速时以层流线性阻力为主,高转速时以湍流二次阻力为主)以及竹签在
 * 竹筒内的轴承摩擦影响,转速逐渐衰减直到停下。
 */
export const W_SOUND_MIN = 18;    // 低于此角速度(约 172 RPM)视为静音
export const W_SOUND_FULL = 96;   // 达到此角速度(约 917 RPM)声音完全响亮
export const W_MAX = 340;         // 显示与映射的上限

/** 空气阻力:线性项(1/s,低转速层流)+ 二次项(1/rad,高转速湍流) */
export const DRAG_LINEAR = 0.34;
export const DRAG_QUAD = 0.004;
/** 竹签与竹筒之间的轴承静摩擦,rad/s² */
export const FRICTION = 1.5;

/** 持续搓动可提供的最大力矩(rad/s²) */
export const TAU_MAX = 320;

/** 单次快速甩动(弹指)可增加的最大角速度,rad/s */
export const FLICK_MAX_DW = 95;

export const RPM_PER_RAD_S = 9.5492965855;

export class SpinState {
  constructor() {
    this.w = 0; // 当前角速度 rad/s
  }

  /**
   * 按给定力矩推进一步物理。
   * @param dt 秒(内部自动细分步长保证数值稳定;单次上限 2s,
   *           更大的帧间隔由调用方负责钳制)
   * @param torque 输入力矩 rad/s²(≥0;游戏只允许一个旋转方向)
   */
  step(dt, torque) {
    if (!(dt > 0)) return;
    const h = Math.min(dt, 2);
    const n = Math.max(1, Math.ceil(h / 0.008));
    const s = h / n;
    const t = Math.max(0, torque);
    for (let i = 0; i < n; i++) {
      if (this.w === 0 && t <= FRICTION) {
        this.w = 0;
        continue;
      }
      const wAbs = Math.abs(this.w);
      const drag = DRAG_LINEAR * wAbs + DRAG_QUAD * wAbs * wAbs + FRICTION;
      const a = t - Math.sign(this.w) * drag;
      this.w += a * s;
      if (this.w < 0) this.w = 0;
      if (this.w < 1e-4 && t <= FRICTION) this.w = 0;
    }
  }

  /** 施加一次"甩动"冲量(如快速划过屏幕)。 */
  flick(strength) {
    const k = Math.max(0, Math.min(1, strength));
    this.w += k * FLICK_MAX_DW;
  }

  get rpm() {
    return this.w * RPM_PER_RAD_S;
  }

  /** 归一化转速 0..1,用于画面/仪表。 */
  get wNorm() {
    return Math.max(0, Math.min(1, this.w / W_MAX));
  }

  /** 该力矩下最终会稳定到的平衡转速(解 阻力 = 力矩)。 */
  static equilibriumW(torque) {
    const t = Math.max(0, torque);
    if (t <= FRICTION) return 0;
    const T = t - FRICTION;
    const c1 = DRAG_LINEAR;
    const c2 = DRAG_QUAD;
    return (-c1 + Math.sqrt(c1 * c1 + 4 * c2 * T)) / (2 * c2);
  }
}
