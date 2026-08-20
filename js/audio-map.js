/**
 * 蝉鸣合成的声音参数映射(纯函数,可测试)。
 *
 * 真实竹知了的声音特征:
 *  - 双叶叶片每转一圈切割空气两次 → 产生"哇—哇"的周期性脉冲,脉冲频率
 *    就是叶片通过频率(blade pass)= 2 × 转/秒。转得慢是明显的
 *    "哇——哇——",转得快变成密集的蝉鸣颤音。
 *  - 音调(频谱重心)随转速升高:叶片搅动空气的气动噪声整体向高频移动。
 *  - 响度随转速急剧增大(气动声功率 ∝ 转速的立方),这里用压缩后的
 *    平滑曲线表现。
 *  - 低速时叶片"啪嗒"感更强(调制更深),高速时更接近稳定蝉鸣。
 */
import { W_SOUND_MIN, W_MAX } from './physics.js';

const SPEED_SPAN = W_MAX - W_SOUND_MIN;

/** 叶片通过频率 Hz(双叶):w/π,低速保底一个明显节拍。 */
export function bladePassHz(w) {
  if (w < W_SOUND_MIN) return 0;
  return Math.max(3.5, w / Math.PI);
}

/** 载波基频 Hz:随转速连续升高,听觉上"音调变高"。 */
export function carrierHz(w) {
  if (w < W_SOUND_MIN) return 0;
  const t = Math.max(0, Math.min(1, (w - W_SOUND_MIN) / SPEED_SPAN));
  return 240 * Math.pow(2800 / 240, Math.pow(t, 0.8));
}

/** 响度包络 0..1(平滑阶跃,起音自然、无爆音)。 */
export function loudness(w) {
  if (w < W_SOUND_MIN) return 0;
  const x = Math.max(0, Math.min(1, (w - W_SOUND_MIN) / (96 - W_SOUND_MIN)));
  return x * x * (3 - 2 * x);
}

/** 气流噪声("切风"嘶声)增益:只在高速时明显。 */
export function airNoiseGain(w) {
  if (w < W_SOUND_MIN) return 0;
  const t = Math.max(0, Math.min(1, w / W_MAX));
  return Math.pow(t, 1.7) * 0.5;
}

/** 振幅调制深度:低速深("啪嗒"感),高速稍浅更接近蝉鸣。 */
export function amDepth(w) {
  if (w < W_SOUND_MIN) return 0;
  const t = Math.max(0, Math.min(1, (w - W_SOUND_MIN) / SPEED_SPAN));
  return 0.62 - 0.18 * t;
}
