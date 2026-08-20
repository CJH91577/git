/**
 * Node 端核心逻辑测试:node tests/core.test.mjs
 * 覆盖:旋转物理(加速/平衡/衰减/停止/冲量/稳定性)、
 *       声音映射(音调/响度/叶片通过频率随转速的连续性)、
 *       挑战与计分逻辑。
 */
import {
  SpinState,
  TAU_MAX,
  W_SOUND_MIN,
  W_SOUND_FULL,
  FLICK_MAX_DW,
  W_MAX,
} from '../js/physics.js';
import { carrierHz, loudness, bladePassHz, airNoiseGain, amDepth } from '../js/audio-map.js';
import {
  makeGameState,
  stepGame,
  switchMode,
  commitBestScore,
  SUSTAIN_TARGETS,
  SPRINT_TARGETS_RPM,
} from '../js/logic.js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}

function approx(a, b, tol = 0.02) {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

console.log('▶ 物理测试');
{
  const p = new SpinState();
  p.step(1.5, TAU_MAX);
  check('持续搓动 1.5s 提速到 200 rad/s 以上', p.w > 200, `w=${p.w.toFixed(1)}`);

  const eq = SpinState.equilibriumW(TAU_MAX);
  const p2 = new SpinState();
  for (let i = 0; i < 6000; i++) p2.step(0.008, TAU_MAX);
  check('长时间搓动收敛到理论平衡转速', approx(p2.w, eq, 0.03), `w=${p2.w.toFixed(1)} eq=${eq.toFixed(1)}`);

  const w0 = p2.w;
  let prev = Infinity;
  let monotonic = true;
  const p3 = new SpinState();
  p3.w = w0;
  for (let i = 0; i < 240; i++) {
    p3.step(0.05, 0);
    if (p3.w > prev + 1e-9) monotonic = false;
    prev = p3.w;
  }
  check('松开后转速单调衰减(空气阻力)', monotonic);
  check('12 秒后转速明显下降', p3.w < w0 * 0.45, `w=${p3.w.toFixed(1)}`);

  const p6 = new SpinState();
  p6.w = 100;
  const tSound = timeToSilence(p6);
  check('声音衰减时长在合理范围(3~18s)', tSound > 3 && tSound < 18, `${tSound.toFixed(1)}s`);

  for (let i = 0; i < 600; i++) p3.step(0.05, 0);
  check('最终完全停止(静止摩擦)', p3.w === 0);

  const p4 = new SpinState();
  p4.flick(1);
  check('甩动冲量生效', p4.w > FLICK_MAX_DW * 0.9 && p4.w <= FLICK_MAX_DW + 1e-6, `w=${p4.w.toFixed(1)}`);

  const p5 = new SpinState();
  p5.step(2, TAU_MAX); // 超大 dt(内部按 0.5s 处理,细分步长)
  check('超大时间步长数值稳定且有推进', Number.isFinite(p5.w) && p5.w > 100 && p5.w < W_MAX * 2, `w=${p5.w.toFixed(1)}`);

  const p7 = new SpinState();
  p7.step(0.5, 0.5 * TAU_MAX);
  p7.step(0.5, TAU_MAX);
  check('力矩增大后转速更快', p7.w > 0);

  // 0 输入不会自转
  const p8 = new SpinState();
  p8.step(1, 0);
  check('无输入保持静止', p8.w === 0);
}

console.log('▶ 声音映射测试');
{
  check('静音阈值以下载波为 0', carrierHz(W_SOUND_MIN - 1) === 0);
  check('静音阈值以下响度为 0', loudness(W_SOUND_MIN - 1) === 0);
  check('满转速响度接近 1', loudness(W_SOUND_FULL) > 0.98, `g=${loudness(W_SOUND_FULL).toFixed(3)}`);

  let mono = true;
  let prev = -1;
  for (let w = W_SOUND_MIN; w <= W_MAX; w += 5) {
    const f = carrierHz(w);
    if (f < prev - 1e-6) mono = false;
    prev = f;
  }
  check('音调随转速单调升高', mono);

  check('高速载波明显高于低速(音调连续爬升)', carrierHz(300) > carrierHz(60) * 2.5,
    `${carrierHz(60).toFixed(0)} → ${carrierHz(300).toFixed(0)} Hz`);

  check('双叶叶片通过频率 ≈ w/π', approx(bladePassHz(240), 240 / Math.PI, 0.01), `bp=${bladePassHz(240).toFixed(1)} Hz`);

  check('低速叶片通过频率仍有明显节拍(哇—哇—)', bladePassHz(W_SOUND_MIN) >= 3.5,
    `bp=${bladePassHz(W_SOUND_MIN).toFixed(2)} Hz`);

  let lmono = true;
  prev = -1;
  for (let w = W_SOUND_MIN; w <= W_MAX; w += 5) {
    const g = loudness(w);
    if (g < prev - 1e-9 || g > 1.000001 || g < 0) lmono = false;
    prev = g;
  }
  check('响度单调且范围 [0,1]', lmono);

  check('气流噪声增益随转速上升', airNoiseGain(300) > airNoiseGain(100));
  check('调制深度在合理范围', amDepth(W_SOUND_MIN) > 0.3 && amDepth(W_MAX) > 0.2);
}

console.log('▶ 挑战与计分测试');
{
  const store = {
    data: {},
    getItem(k) {
      return this.data[k] ?? null;
    },
    setItem(k, v) {
      this.data[k] = String(v);
    },
  };
  const gs = makeGameState('sustain', store);
  check('初始分数为 0', gs.score === 0);

  stepGame(gs, 100, 0.5);
  check('鸣叫期间得分增加', gs.score > 0, `score=${gs.score.toFixed(2)}`);
  check('鸣叫期间连续时长累计', gs.episode > 0.4);

  for (let i = 0; i < 22; i++) stepGame(gs, 100, 0.5);
  check('连续鸣叫 10s 目标触发', gs.sustainIdx >= 1, `idx=${gs.sustainIdx}`);
  check('目标数量定义正确', SUSTAIN_TARGETS.length === 3 && SUSTAIN_TARGETS[0] === 10);

  stepGame(gs, 0, 0.3);
  check('静音宽限期内不打断连续记录', gs.episode > 10);
  stepGame(gs, 0, 0.3);
  check('超过宽限后重置并写入最佳纪录', gs.episode === 0 && gs.bestEpisode > 10, `best=${gs.bestEpisode.toFixed(1)}`);
  check('最佳纪录已持久化', Number(store.getItem('zzl.bestEpisode')) > 10);

  const gs2 = makeGameState('sprint', store);
  stepGame(gs2, 75, 1); // ≈716 RPM
  check('极速 600 RPM 目标触发', gs2.sprintIdx >= 1);
  check('极速纪录被记录', gs2.bestRpm >= 700, `bestRpm=${gs2.bestRpm.toFixed(0)}`);
  stepGame(gs2, 200, 1); // ≈1910 RPM
  check('极速全部目标触发', gs2.sprintIdx >= SPRINT_TARGETS_RPM.length);
  check('极速目标数量定义正确', SPRINT_TARGETS_RPM.length === 3);

  const gs3 = makeGameState('sustain', store);
  gs3.score = 1234;
  commitBestScore(gs3);
  check('最高分持久化', Number(store.getItem('zzl.bestScore')) >= 1234);

  switchMode(gs3, 'sprint');
  check('切换模式重置本局进度', gs3.score === 0 && gs3.episode === 0 && gs3.mode === 'sprint');

  // 得分速率合理性:2000 RPM 鸣叫 10s ≈ 400 分
  const gs4 = makeGameState('free', store);
  for (let i = 0; i < 100; i++) stepGame(gs4, 200, 0.1);
  check('计分速率与转速成正比', approx(gs4.score, 200 * 9.5493 * 10 * 0.02, 0.05), `score=${gs4.score.toFixed(1)}`);
}

/** 模拟从 w0 自由衰减到静音阈值所需时间。 */
function timeToSilence(p) {
  let t = 0;
  while (p.w > W_SOUND_MIN && t < 60) {
    p.step(0.02, 0);
    t += 0.02;
  }
  return t;
}

console.log('');
if (failed === 0) {
  console.log(`✅ 全部通过:${passed} 项`);
  process.exit(0);
} else {
  console.log(`❌ 失败 ${failed} 项 / 共 ${passed + failed} 项`);
  process.exit(1);
}
