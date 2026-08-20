/**
 * 计分与挑战逻辑(纯逻辑模块,存储通过注入的 storage 抽象,可测试)。
 */
import { W_SOUND_MIN, RPM_PER_RAD_S } from './physics.js';

export const MODES = [
  { id: 'free', label: '自由把玩', icon: '🪀', hint: '随心搓动,听听转速带来的蝉鸣变化' },
  { id: 'sustain', label: '连续鸣叫', icon: '⏱️', hint: '保持竹知了不停鸣叫,冲击连续时长目标' },
  { id: 'sprint', label: '极速冲刺', icon: '💨', hint: '拼命搓动,突破一个个转速大关' },
];

export const SUSTAIN_TARGETS = [10, 20, 35];     // 连续鸣叫秒数目标
export const SPRINT_TARGETS_RPM = [600, 1100, 1700]; // 转速目标(RPM)

/** 鸣叫期间每秒每 RPM 的得分。 */
export const SCORE_PER_RPM_SEC = 0.02;

/** 静音宽限:鸣叫短暂中断不超过该秒数不打断连续记录。 */
export const EPISODE_GRACE = 0.45;

export function readNum(storage, key) {
  try {
    const v = Number(storage?.getItem(key));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export function writeNum(storage, key, v) {
  try {
    storage?.setItem(key, String(Math.round(v * 10) / 10));
  } catch {
    /* 存储不可用时静默忽略 */
  }
}

export function makeGameState(modeId, storage) {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  return {
    mode: modeId,
    score: 0,
    maxRpm: 0,
    episode: 0,      // 当前连续鸣叫时长(秒)
    episodeGrace: 0, // 静音宽限累计
    sustainIdx: 0,   // 已达成连续鸣叫目标数
    sprintIdx: 0,    // 已达成极速目标数
    bestScore: readNum(s, 'zzl.bestScore'),
    bestRpm: readNum(s, 'zzl.bestRpm'),
    bestEpisode: readNum(s, 'zzl.bestEpisode'),
    _s: s,
  };
}

export function switchMode(gs, modeId) {
  gs.mode = modeId;
  gs.score = 0;
  gs.maxRpm = 0;
  gs.episode = 0;
  gs.episodeGrace = 0;
  gs.sustainIdx = 0;
  gs.sprintIdx = 0;
}

/**
 * 推进一帧游戏逻辑。
 * @returns 触发的事件数组,如 [{type:'sustain', target:10}]
 */
export function stepGame(gs, w, dt) {
  const rpm = w * RPM_PER_RAD_S;
  const sounding = w >= W_SOUND_MIN;
  const ev = [];

  if (sounding) {
    gs.score += rpm * dt * SCORE_PER_RPM_SEC;
    gs.episode += dt;
    gs.episodeGrace = 0;
    if (rpm > gs.maxRpm) gs.maxRpm = rpm;
  } else if (gs.episode > 0) {
    gs.episodeGrace += dt;
    if (gs.episodeGrace > EPISODE_GRACE) {
      if (gs.episode > gs.bestEpisode) {
        gs.bestEpisode = gs.episode;
        writeNum(gs._s, 'zzl.bestEpisode', gs.episode);
        ev.push({ type: 'bestEpisode', value: gs.episode });
      }
      gs.episode = 0;
      gs.episodeGrace = 0;
    }
  }

  if (gs.maxRpm > gs.bestRpm) {
    gs.bestRpm = gs.maxRpm;
    writeNum(gs._s, 'zzl.bestRpm', gs.maxRpm);
  }

  if (gs.mode === 'sustain') {
    while (gs.sustainIdx < SUSTAIN_TARGETS.length && gs.episode >= SUSTAIN_TARGETS[gs.sustainIdx]) {
      ev.push({ type: 'sustain', target: SUSTAIN_TARGETS[gs.sustainIdx], idx: gs.sustainIdx });
      gs.sustainIdx++;
    }
  }
  if (gs.mode === 'sprint') {
    while (gs.sprintIdx < SPRINT_TARGETS_RPM.length && rpm >= SPRINT_TARGETS_RPM[gs.sprintIdx]) {
      ev.push({ type: 'sprint', target: SPRINT_TARGETS_RPM[gs.sprintIdx], idx: gs.sprintIdx });
      gs.sprintIdx++;
    }
  }
  return ev;
}

export function commitBestScore(gs) {
  if (gs.score > gs.bestScore) {
    gs.bestScore = gs.score;
    writeNum(gs._s, 'zzl.bestScore', gs.score);
  }
}
