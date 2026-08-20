/**
 * 竹知了 · 本地静态服务器(零依赖)
 *
 * 用法:
 *   node server.js            # 启动并自动打开浏览器
 *   node server.js --no-open  # 启动但不打开浏览器
 *   PORT=9000 node server.js  # 自定义端口
 *
 * 为什么需要服务器而不是直接双击 index.html:
 *   1. ES Module 与 import map 在 file:// 下受限;
 *   2. 摄像头(getUserMedia)要求安全上下文,只有 http://localhost/127.0.0.1
 *      或 HTTPS 才允许;
 *   3. MediaPipe 的 wasm 需要同源加载。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const NO_OPEN = process.argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 未找到 ${urlPath}`);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  🎋 竹知了已启动');
  console.log(`  👉 本机访问: ${url}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        console.log(`  📱 手机访问(同一 WiFi): http://${ni.address}:${PORT}`);
      }
    }
  }
  console.log('  💡 手机要用摄像头手势需 HTTPS,普通搓动/摇一摇不受影响');
  console.log('');
  if (!NO_OPEN) {
    const opener = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`;
    exec(opener, () => {});
  }
});
