/**
 * 游戏主逻辑:把物理、声音、3D、输入、手势、挑战与 HUD 组装起来。
 */
import { Scene3D } from './scene3d.js';
import { CicadaAudio } from './audio-engine.js';
import { InputController } from './input.js';
import { HandController } from './hands.js';
import * as THREE from 'three';
import { SpinState, TAU_MAX, W_SOUND_MIN } from './physics.js';
import {
  MODES,
  SUSTAIN_TARGETS,
  SPRINT_TARGETS_RPM,
  makeGameState,
  stepGame,
  commitBestScore,
  switchMode,
  writeNum,
} from './logic.js';

const $ = (id) => document.getElementById(id);

export class Game {
  constructor() {
    this.physics = new SpinState();
    this.audio = new CicadaAudio();
    this.gs = makeGameState(this._savedMode(), localStorage);
    this._started = false;
    this._lastT = 0;
    this._t = 0;
    this._frameCount = 0;
    this._scoreSaveTimer = 0;
    this._flickQueue = [];
    const q = new URLSearchParams(location.search);
    this._demo = q.has('demo');       // 演示模式:自动周期性搓动
    this._noSplash = q.has('nosplash'); // 跳过开始界面
  }

  _savedMode() {
    try {
      const m = localStorage.getItem('zzl.mode');
      return MODES.some((x) => x.id === m) ? m : 'free';
    } catch {
      return 'free';
    }
  }

  boot() {
    window.__THREE = THREE; // 供调试/验证脚本使用
    const canvas = $('scene');
    this.scene = new Scene3D(canvas);
    this.input = new InputController(canvas, {
      onFlick: (k) => this._flickQueue.push(k),
      shouldRub: (e) => this._hitToy(e.clientX, e.clientY),
      onRubStart: () => {
        this.scene.controls.enabled = false;
      },
      onRubEnd: () => {
        this.scene.controls.enabled = true;
      },
    });
    this.input.attach();
    this.hands = new HandController();

    this._bindUI();
    this._bindGestures();
    this._syncModeUI();

    window.addEventListener('resize', () => this.scene.resize());
    window.addEventListener('pagehide', () => commitBestScore(this.gs));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.audio.ctx?.suspend();
        commitBestScore(this.gs);
      } else {
        this.audio.ctx?.resume();
      }
    });

    // 任何首次交互都算用户手势,激活音频
    const gesture = () => {
      this.audio.ensure();
      window.removeEventListener('pointerdown', gesture);
      window.removeEventListener('keydown', gesture);
    };
    window.addEventListener('pointerdown', gesture);
    window.addEventListener('keydown', gesture);

    this._lastT = performance.now();
    if (this._noSplash || this._demo) this.start();
    requestAnimationFrame((t) => this._frame(t));
  }

  _bindUI() {
    // 模式切换
    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.mode;
        switchMode(this.gs, id);
        try {
          localStorage.setItem('zzl.mode', id);
        } catch {
          /* ignore */
        }
        this._syncModeUI();
        this._toast(`切换到「${MODES.find((m) => m.id === id).label}」`);
      });
    });
    // 开始按钮
    $('btnStart').addEventListener('click', () => this.start());
    // 静音
    $('btnMute').addEventListener('click', () => {
      this.audio.setMuted(!this.audio.muted);
      try {
        localStorage.setItem('zzl.muted', this.audio.muted ? '1' : '0');
      } catch {
        /* ignore */
      }
      this._syncMuteUI();
    });
    // 摄像头手势
    $('btnCam').addEventListener('click', () => this._toggleCamera());
    $('btnCamClose').addEventListener('click', () => this._stopCamera());
    // 摇一摇(桌面无传感器时隐藏按钮)
    if (typeof DeviceMotionEvent === 'undefined') {
      $('btnShake').style.display = 'none';
    } else {
      $('btnShake').addEventListener('click', () => {
        this.input.enableShake();
        this._toast('摇一摇已开启,晃动手机给竹知了加速!');
      });
    }
    $('btnHelp').addEventListener('click', () => {
      $('helpCard').classList.toggle('open');
    });
    $('btnHelpClose').addEventListener('click', () => {
      $('helpCard').classList.remove('open');
    });
    $('helpCard').addEventListener('click', (e) => {
      if (e.target === $('helpCard')) $('helpCard').classList.remove('open');
    });
    const muted = localStorage.getItem('zzl.muted') === '1';
    this.audio.setMuted(muted);
    this._syncMuteUI();
  }

  _bindGestures() {
    // 键盘快捷:M 静音,C 摄像头
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') {
        $('btnMute').click();
      } else if (e.code === 'KeyC') {
        $('btnCam').click();
      }
    });
  }

  start() {
    if (this._started) return;
    this.audio.ensure();
    this._started = true;
    $('startOverlay').classList.add('hidden');
    this._toast('搓动竹签,听竹知了鸣叫!');
  }

  _syncModeUI() {
    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === this.gs.mode);
    });
    const mode = MODES.find((m) => m.id === this.gs.mode);
    $('challengeTitle').textContent = `${mode.icon} ${mode.label}`;
    $('challengeHint').textContent = mode.hint;
    this._syncChallengeUI();
  }

  _syncMuteUI() {
    $('btnMute').textContent = this.audio.muted ? '🔇' : '🔊';
    $('btnMute').classList.toggle('off', this.audio.muted);
  }

  _syncChallengeUI() {
    const gs = this.gs;
    const bar = $('challengeBar');
    const label = $('challengeProgress');
    if (gs.mode === 'sustain') {
      if (gs.sustainIdx >= SUSTAIN_TARGETS.length) {
        label.textContent = `全部达成!最高连续 ${gs.bestEpisode.toFixed(1)}s`;
        bar.style.width = '100%';
      } else {
        const target = SUSTAIN_TARGETS[gs.sustainIdx];
        label.textContent = `连续鸣叫 ${gs.episode.toFixed(1)} / ${target}s`;
        bar.style.width = `${Math.min(100, (gs.episode / target) * 100)}%`;
      }
    } else if (gs.mode === 'sprint') {
      if (gs.sprintIdx >= SPRINT_TARGETS_RPM.length) {
        label.textContent = `全部达成!最高 ${Math.round(gs.bestRpm)} RPM`;
        bar.style.width = '100%';
      } else {
        const target = SPRINT_TARGETS_RPM[gs.sprintIdx];
        const rpm = this.physics.rpm;
        label.textContent = `转速 ${Math.round(rpm)} / ${target} RPM`;
        bar.style.width = `${Math.min(100, (rpm / target) * 100)}%`;
      }
    } else {
      label.textContent = `连续鸣叫 ${gs.episode.toFixed(1)}s · 最高 ${Math.round(gs.bestRpm)} RPM`;
      bar.style.width = `${Math.min(100, (this.physics.w / 60) * 100)}%`;
    }
  }

  async _toggleCamera() {
    if (this.hands.running) {
      this._stopCamera();
      return;
    }
    $('btnCam').classList.add('busy');
    this._camStatus('正在启动摄像头…');
    $('camPip').classList.add('on');
    const ok = await this.hands.start($('camVideo'), $('camOverlay'));
    $('btnCam').classList.remove('busy');
    if (ok) {
      $('btnCam').classList.add('active');
      this._toast('手势操控已开启:双手合掌来回搓动');
    } else {
      $('camPip').classList.remove('on');
      this._toast(this.hands.statusText || '摄像头启动失败');
    }
  }

  _stopCamera() {
    this.hands.stop();
    $('btnCam').classList.remove('active');
    $('camPip').classList.remove('on');
  }

  _camStatus(text) {
    $('camStatus').textContent = text;
  }

  _toast(text, kind = 'info') {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.classList.add('show'), 30);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 500);
    }, 2800);
  }

  _handleEvents(evs) {
    for (const ev of evs) {
      if (ev.type === 'sustain') {
        this._toast(`🎉 达成!连续鸣叫 ${ev.target} 秒!`, 'win');
        this._burst($('challengeCard'));
        navigator.vibrate?.(120);
      } else if (ev.type === 'sprint') {
        this._toast(`🎉 突破 ${ev.target} RPM!`, 'win');
        this._burst($('challengeCard'));
        navigator.vibrate?.(120);
      } else if (ev.type === 'bestEpisode') {
        this._toast(`新纪录:连续鸣叫 ${ev.value.toFixed(1)} 秒!`, 'record');
      }
    }
  }

  _burst(el) {
    el.classList.remove('burst');
    void el.offsetWidth;
    el.classList.add('burst');
  }

  /**
   * 命中测试:按下的屏幕位置是否落在竹知了附近(用于区分"搓动"与"旋转视角")。
   */
  _hitToy(sx, sy) {
    const canvas = this.scene.canvas;
    const v = new THREE.Vector3(0, 0.55, 0).project(this.scene.camera);
    const px = (v.x * 0.5 + 0.5) * canvas.clientWidth;
    const py = (-v.y * 0.5 + 0.5) * canvas.clientHeight;
    const minDim = Math.min(canvas.clientWidth, canvas.clientHeight);
    const radius = Math.max(110, Math.min(300, minDim * 0.42));
    return Math.hypot(sx - px, sy - py) <= radius;
  }

  _frame(t) {
    requestAnimationFrame((x) => this._frame(x));
    this._frameCount++;
    const dt = Math.min((t - this._lastT) / 1000, 0.05);
    this._lastT = t;
    this._t += dt;

    // 甩动冲量
    while (this._flickQueue.length) {
      const k = this._flickQueue.shift();
      this.physics.flick(k);
    }

    // 各输入源的搓动力度(演示模式额外叠加自动搓动)
    const inputRub = this.input.poll(dt, t);
    const handRub = this.hands.rub;
    const autoRub = this._demo ? Math.max(0, Math.sin(this._t * 1.1)) * 0.95 : 0;
    const torque = Math.min(1, inputRub + handRub + autoRub) * TAU_MAX;
    this.physics.step(dt, torque);
    this.audio.update(this.physics.w);

    const evs = stepGame(this.gs, this.physics.w, dt);
    this._handleEvents(evs);

    this.scene.update(dt, { w: this.physics.w, t: this._t });

    // 定期保存最高分
    this._scoreSaveTimer += dt;
    if (this._scoreSaveTimer > 1) {
      this._scoreSaveTimer = 0;
      commitBestScore(this.gs);
    }

    this._updateHUD();
  }

  _updateHUD() {
    const w = this.physics.w;
    const rpm = Math.round(this.physics.rpm);
    const rpmEl = $('rpmVal');
    if (this._lastRpmText !== rpm) {
      this._lastRpmText = rpm;
      rpmEl.textContent = rpm;
    }
    $('rpmBar').style.width = `${Math.min(100, (rpm / 2400) * 100)}%`;
    const cls = rpm > 1400 ? 'hot' : rpm > 700 ? 'warm' : 'cool';
    if (this._rpmCls !== cls) {
      this._rpmCls = cls;
      $('rpmWrap').className = `hud-card rpmwrap ${cls}`;
    }
    const tag = w < W_SOUND_MIN ? '静悄悄' : w < 60 ? '低鸣' : w < 150 ? '鸣叫中' : '高亢蝉鸣';
    if (this._rpmTag !== tag) {
      this._rpmTag = tag;
      $('rpmTag').textContent = tag;
    }
    // 声音指示条
    const sounding = w >= W_SOUND_MIN;
    const lvl = sounding ? Math.min(1, (w - W_SOUND_MIN) / 130) : 0;
    const bars = $('soundBars').children;
    const heights = [0.35, 0.7, 1];
    for (let i = 0; i < bars.length; i++) {
      const h = sounding ? 0.12 + 0.88 * heights[i] * (0.3 + 0.7 * lvl) : 0.1;
      bars[i].style.transform = `scaleY(${h})`;
      bars[i].style.background = sounding ? (lvl > 0.6 ? '#ffb74d' : '#8bd46a') : '#b9c4a8';
    }
    // 计分
    const score = Math.floor(this.gs.score);
    if (this._lastScore !== score) {
      this._lastScore = score;
      $('scoreVal').textContent = score;
    }
    $('bestVal').textContent = Math.floor(Math.max(this.gs.bestScore, this.gs.score));
    $('rpmRecord').textContent = Math.round(Math.max(this.gs.bestRpm, this.gs.maxRpm));
    // 连续鸣叫
    $('episodeVal').textContent = this.gs.episode.toFixed(1);
    // 挑战进度(每秒刷新一次足够,但这里便宜,直接每帧)
    this._syncChallengeUI();
    // 摄像头状态
    if (this.hands.running) this._camStatus(this.hands.statusText);
  }
}
