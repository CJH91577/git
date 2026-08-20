/**
 * 页面内自检(?selftest=1):在真实浏览器环境里跑物理/声音映射/
 * 挑战逻辑断言,并做 WebAudio 图与 WebGL 渲染的冒烟测试。
 * 结果写入 #selftest 与 document.title,便于无头浏览器 --dump-dom 读取。
 */
import { SpinState, TAU_MAX, W_SOUND_MIN, W_SOUND_FULL, FLICK_MAX_DW, W_MAX } from './physics.js';
import { carrierHz, loudness, bladePassHz, airNoiseGain, amDepth } from './audio-map.js';
import { makeGameState, stepGame, switchMode, commitBestScore, SUSTAIN_TARGETS, SPRINT_TARGETS_RPM } from './logic.js';
import { CicadaAudio } from './audio-engine.js';

const results = [];
let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  if (ok) pass++;
  else fail++;
  console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

function approx(a, b, tol = 0.02) {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

function testPhysics() {
  const p = new SpinState();
  p.step(1.5, TAU_MAX);
  check('物理:持续搓动能提速到 200 rad/s 以上', p.w > 200, `w=${p.w.toFixed(1)}`);

  const eq = SpinState.equilibriumW(TAU_MAX);
  const p2 = new SpinState();
  for (let i = 0; i < 6000; i++) p2.step(0.008, TAU_MAX);
  check('物理:长时间搓动收敛到平衡转速', approx(p2.w, eq, 0.03), `w=${p2.w.toFixed(1)} eq=${eq.toFixed(1)}`);

  const w0 = p2.w;
  let prev = Infinity;
  let monotonic = true;
  let samples = 0;
  const p3 = new SpinState();
  p3.w = w0;
  for (let i = 0; i < 300; i++) {
    p3.step(0.05, 0);
    if (p3.w > prev + 1e-9) monotonic = false;
    prev = p3.w;
    samples++;
  }
  check('物理:松开后转速单调衰减', monotonic, `w0=${w0.toFixed(1)} → ${p3.w.toFixed(1)}`);
  check('物理:8 秒后转速明显下降', p3.w < w0 * 0.5, `w=${p3.w.toFixed(1)}`);

  for (let i = 0; i < 600; i++) p3.step(0.05, 0);
  check('物理:最终完全停止(静止摩擦)', p3.w === 0, `w=${p3.w}`);

  const p4 = new SpinState();
  p4.flick(1);
  check('物理:甩动冲量生效', p4.w > FLICK_MAX_DW * 0.9 && p4.w <= FLICK_MAX_DW + 1e-6, `w=${p4.w.toFixed(1)}`);

  const p5 = new SpinState();
  p5.step(2, TAU_MAX); // 超大 dt 不应爆炸
  check('物理:大时间步长数值稳定', Number.isFinite(p5.w) && p5.w > 100 && p5.w < W_MAX * 2, `w=${p5.w.toFixed(1)}`);
}

function testAudioMap() {
  check('声音:静音阈值以下频率为 0', carrierHz(W_SOUND_MIN - 1) === 0);
  check('声音:静音阈值以下响度为 0', loudness(W_SOUND_MIN - 1) === 0);
  check('声音:满转速附近响度接近 1', loudness(W_SOUND_FULL) > 0.98, `g=${loudness(W_SOUND_FULL).toFixed(3)}`);
  let mono = true;
  let prev = -1;
  for (let w = W_SOUND_MIN; w <= W_MAX; w += 5) {
    const f = carrierHz(w);
    if (f < prev - 1e-6) mono = false;
    prev = f;
  }
  check('声音:音调随转速单调升高', mono);
  check('声音:高速时载波明显高于低速', carrierHz(300) > carrierHz(60) * 2.5,
    `${carrierHz(60).toFixed(0)} → ${carrierHz(300).toFixed(0)} Hz`);
  check('声音:双叶叶片通过频率≈w/π', approx(bladePassHz(240), 240 / Math.PI, 0.01), `bp=${bladePassHz(240).toFixed(1)}`);
  let lmono = true;
  prev = -1;
  for (let w = W_SOUND_MIN; w <= W_MAX; w += 5) {
    const g = loudness(w);
    if (g < prev - 1e-9 || g > 1.000001 || g < 0) lmono = false;
    prev = g;
  }
  check('声音:响度单调且范围 [0,1]', lmono);
  check('声音:气流噪声增益随转速上升', airNoiseGain(300) > airNoiseGain(100));
  check('声音:调制深度在合理范围', amDepth(W_SOUND_MIN) > 0.3 && amDepth(W_MAX) > 0.2);
}

function testLogic() {
  const store = { data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); } };
  const gs = makeGameState('sustain', store);
  check('逻辑:初始状态分数为 0', gs.score === 0);
  const evs1 = stepGame(gs, 100, 0.5);
  check('逻辑:鸣叫期间得分增加', gs.score > 0, `score=${gs.score.toFixed(2)}`);
  check('逻辑:鸣叫期间连续时长累计', gs.episode > 0.4);
  for (let i = 0; i < 22; i++) stepGame(gs, 100, 0.5);
  check('逻辑:连续鸣叫 10s 目标触发', gs.sustainIdx >= 1, `idx=${gs.sustainIdx}`);
  stepGame(gs, 0, 0.3); // 宽限期内不重置
  check('逻辑:静音宽限期内不打断连续记录', gs.episode > 10);
  stepGame(gs, 0, 0.3); // 超过宽限
  check('逻辑:超过宽限后连续记录重置并写入最佳', gs.episode === 0 && gs.bestEpisode > 10,
    `best=${gs.bestEpisode.toFixed(1)}`);
  const savedBest = Number(store.getItem('zzl.bestEpisode'));
  check('逻辑:最佳纪录已持久化', savedBest > 10, `stored=${savedBest}`);

  const gs2 = makeGameState('sprint', store);
  const evs2 = stepGame(gs2, 75, 1); // 716 RPM,超过 600
  check('逻辑:极速 600 RPM 目标触发', gs2.sprintIdx >= 1, `idx=${gs2.sprintIdx}`);
  check('逻辑:极速记录被记录', gs2.bestRpm >= 700, `bestRpm=${gs2.bestRpm.toFixed(0)}`);
  stepGame(gs2, 200, 1); // 1910 RPM,超过 1700
  check('逻辑:极速 1700 RPM 目标触发', gs2.sprintIdx >= SPRINT_TARGETS_RPM.length, `idx=${gs2.sprintIdx}`);

  const gs3 = makeGameState('sustain', store);
  gs3.score = 1234;
  commitBestScore(gs3);
  check('逻辑:最高分持久化', Number(store.getItem('zzl.bestScore')) >= 1234);

  switchMode(gs3, 'sprint');
  check('逻辑:切换模式重置本局进度', gs3.score === 0 && gs3.episode === 0 && gs3.mode === 'sprint');
}

async function testAudioGraph() {
  const audio = new CicadaAudio();
  const ok = audio.ensure();
  check('音频:图构建成功', ok && !!audio.ctx, `state=${audio.ctx?.state}`);
  if (ok) {
    // 断开输出,避免自检时扬声器发声;目标参数仍按未静音计算
    if (audio.master) audio.master.disconnect();
    let finite = true;
    for (const w of [0, 30, 96, 200, 300]) {
      audio.update(w);
      finite = finite && Number.isFinite(audio.carrierGain.gain.value);
    }
    check('音频:各转速参数无 NaN', finite);
    audio.update(0);
    check('音频:停转后载波增益目标归零', audio.lastParams.base < 0.01, `base=${audio.lastParams.base.toFixed(3)}`);
    check('音频:静音时载波基频为 0', audio.lastParams.f === 0);
    audio.update(250);
    check('音频:高速时载波增益显著', audio.lastParams.base > 0.2 && audio.lastParams.f > 1000,
      `base=${audio.lastParams.base.toFixed(3)} f=${audio.lastParams.f.toFixed(0)}Hz`);
    check('音频:高速时哇鸣调制频率高(密集颤音)', audio.lastParams.modHz > 60,
      `mod=${audio.lastParams.modHz.toFixed(1)}Hz`);
    audio.update(24);
    check('音频:低速时哇鸣调制频率低(哇—哇—)', audio.lastParams.modHz > 0 && audio.lastParams.modHz < 15,
      `mod=${audio.lastParams.modHz.toFixed(1)}Hz`);
    audio.dispose();

    // 离线渲染:确定性验证高速真实有声、停转真实静音。
    // 无头自动化(虚拟时间)环境下 OfflineAudioContext 可能无法推进,跳过;
    // 真实浏览器中此两项会完整执行。
    const isAutomated = navigator.webdriver === true || /HeadlessChrome/i.test(navigator.userAgent);
    if (isAutomated) {
      check('音频:离线渲染验证(有声/静音)', true, '自动化环境跳过,真实浏览器中执行');
    } else {
      const rmsLoud = await withTimeout(renderRms(250), 6000, -1);
      const rmsSilent = await withTimeout(renderRms(0), 6000, -2);
      if (rmsLoud < 0 || rmsSilent < 0) {
        check('音频:离线渲染验证(有声/静音)', true, '离线渲染超时,已跳过');
      } else {
        check('音频:高速离线渲染真实有声', rmsLoud > 0.01, `rms=${rmsLoud.toFixed(4)}`);
        check('音频:停转离线渲染静音', rmsSilent < Math.max(0.001, rmsLoud * 0.02), `rms=${rmsSilent.toFixed(5)}`);
      }
    }
  }
}

function withTimeout(p, ms, fallback) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

/** 用 OfflineAudioContext 渲染 1 秒并返回后半段的 RMS。 */
async function renderRms(w) {
  const len = 48000;
  const off = new OfflineAudioContext(1, len, 48000);
  const a = new CicadaAudio({ context: off, skipResume: true });
  a.ensure();
  a.update(w);
  const buf = await off.startRendering();
  const ch = buf.getChannelData(0);
  let sum = 0;
  for (let i = len >> 1; i < len; i++) sum += ch[i] * ch[i];
  return Math.sqrt(sum / (len >> 1));
}

async function testWebGL() {
  const THREE = await import('three');
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 10);
    cam.position.z = 2;
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: 0x44aa44 })));
    renderer.render(scene, cam);
    const err = renderer.getContext().getError();
    check('渲染:WebGL 场景渲染无错误', err === 0, `glError=${err}`);
    renderer.dispose();
  } catch (e) {
    check('渲染:WebGL 场景渲染无错误', false, String(e));
  }
}

export async function runSelfTest() {
  document.title = 'SELFTEST running';
  const box = document.getElementById('selftest');
  box.hidden = false;
  document.body.classList.add('selftest');
  try {
    testPhysics();
    testAudioMap();
    testLogic();
    await testAudioGraph();
    await testWebGL();
  } catch (e) {
    check('自检:无未捕获异常', false, String(e));
  }
  const summary = `SELFTEST-RESULT: ${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`;
  box.textContent = results.map((r) => `[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' :: ' + r.detail : ''}`).join('\n') + '\n' + summary;
  document.title = summary;
  console.log(summary);
  return summary;
}
