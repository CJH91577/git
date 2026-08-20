/**
 * 蝉鸣 WebAudio 合成引擎 —— 全部声音实时合成,不使用任何音频文件。
 *
 * 声音结构(对应真实竹知了的发声特征):
 *  1. 载波:两把轻微失谐的锯齿波 + 一把低八度方波,经带通滤波器塑形,
 *     基频随转速连续升高(听感"音调变高")。
 *  2. "哇鸣—哇鸣"脉冲:正弦 LFO 以叶片通过频率对载波做振幅调制,
 *     低速是缓慢的"哇——哇——",高速变成密集蝉鸣颤音。
 *  3. 切风嘶声:带通白噪声,高速时明显,模拟叶片切割空气的气流声。
 *  4. 响度:由转速驱动的平滑包络,转速降下来自然衰减消失;
 *     所有参数用 setTargetAtTime 平滑,避免爆音。
 */
import { W_SOUND_MIN } from './physics.js';
import { bladePassHz, carrierHz, loudness, airNoiseGain, amDepth } from './audio-map.js';

const SMOOTH = 0.028; // 参数平滑时间常数(秒)

export class CicadaAudio {
  /**
   * @param opts { context, skipResume } 测试可注入 OfflineAudioContext。
   */
  constructor(opts = {}) {
    this.ctx = null;
    this.muted = false;
    this.ready = false;
    this._opts = opts;
  }

  /** 必须在用户手势(点击/按键)中调用,以满足浏览器自动播放策略。 */
  ensure() {
    if (!this.ctx) this._build();
    if (!this._opts.skipResume && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ready;
  }

  _build() {
    try {
      const ctx = this._opts.context || new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;

      // --- 载波(锯齿×2 + 方波低八度)→ 带通塑形 ---
      const carrierGain = ctx.createGain();
      carrierGain.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 900;
      filter.Q.value = 0.85;

      const oscs = [];
      const defs = [
        { type: 'sawtooth', mult: 1.0, gain: 0.5 },
        { type: 'sawtooth', mult: 1.007, gain: 0.34 },
        { type: 'square', mult: 0.5, gain: 0.2 },
      ];
      for (const d of defs) {
        const o = ctx.createOscillator();
        o.type = d.type;
        o.frequency.value = 200 * d.mult;
        const g = ctx.createGain();
        g.gain.value = d.gain;
        o.connect(g);
        g.connect(filter);
        o.start();
        oscs.push({ o, mult: d.mult });
      }
      filter.connect(carrierGain);

      // --- 切风噪声 ---
      const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      noise.loop = true;
      noise.start();
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = 2600;
      nf.Q.value = 0.6;
      const nGain = ctx.createGain();
      nGain.gain.value = 0;
      noise.connect(nf);
      nf.connect(nGain);

      // --- "哇鸣"振幅调制 ---
      const am = ctx.createGain();
      am.gain.value = 1;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 8;
      lfo.start();
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0;
      lfo.connect(lfoGain);
      lfoGain.connect(am.gain);
      carrierGain.connect(am);

      // --- 汇总 → 压缩 → 输出 ---
      const master = ctx.createGain();
      master.gain.value = 0;
      am.connect(master);
      nGain.connect(master);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 6;
      comp.attack.value = 0.006;
      comp.release.value = 0.18;
      master.connect(comp);
      comp.connect(ctx.destination);

      this.oscs = oscs;
      this.carrierGain = carrierGain;
      this.filter = filter;
      this.lfo = lfo;
      this.lfoGain = lfoGain;
      this.nGain = nGain;
      this.nf = nf;
      this.master = master;
      this.ready = true;
    } catch (err) {
      console.error('[audio] 初始化失败:', err);
      this.ready = false;
    }
  }

  /**
   * 每帧调用:所有参数随转速连续变化,用 setTargetAtTime 平滑,
   * 形成自然的起音与"转速降下来声音自然衰减消失"的听感。
   * @param w 当前角速度 rad/s
   */
  update(w) {
    if (!this.ctx || !this.ready) return;
    const now = this.ctx.currentTime;
    const g = this.muted ? 0 : loudness(w);
    const base = g * 0.5;
    const f = carrierHz(w);

    for (const { o, mult } of this.oscs) {
      o.frequency.setTargetAtTime(f * mult, now, SMOOTH);
    }
    this.filter.frequency.setTargetAtTime(Math.max(400, f * 2.1), now, SMOOTH);
    this.carrierGain.gain.setTargetAtTime(base, now, SMOOTH);
    this.lfo.frequency.setTargetAtTime(Math.max(3.5, bladePassHz(w)), now, SMOOTH);
    this.lfoGain.gain.setTargetAtTime(base * amDepth(w), now, SMOOTH);
    this.nGain.gain.setTargetAtTime(this.muted ? 0 : airNoiseGain(w), now, SMOOTH);
    this.nf.frequency.setTargetAtTime(1700 + 4300 * g, now, SMOOTH);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, now, SMOOTH * 2);

    // 记录最近一次目标参数,便于测试与调试
    this.lastParams = { w, g, base, f, modHz: Math.max(3.5, bladePassHz(w)), depth: base * amDepth(w), noise: airNoiseGain(w) };
  }

  setMuted(m) {
    this.muted = !!m;
  }

  dispose() {
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.ready = false;
    }
  }
}

export { W_SOUND_MIN };
