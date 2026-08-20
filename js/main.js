/**
 * 入口:默认启动游戏;?selftest=1 时运行页面内自检。
 */
import { Game } from './game.js';
import { runSelfTest } from './selftest.js';

const params = new URLSearchParams(location.search);

if (params.has('selftest')) {
  runSelfTest();
} else {
  const game = new Game();
  game.boot();
  window.__zhuzhiliao = game;
}
