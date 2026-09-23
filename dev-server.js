/**
 * 走啊 · 本地开发服务（零依赖）
 * 职责：加载 .env → 提供静态文件（index.html/src/data）→ 代理 /api/amap/*（对齐 Vercel Function 行为）。
 * 仅本地开发用；生产走 Vercel Functions（serverless/api/amap/*）+ 静态构建产物。
 * Node 18+。启动：node dev-server.js
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = __dirname;

// ---------- 加载 .env（本地） ----------
function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
const AMAP_KEY = process.env.AMAP_WEB_KEY;

// ---------- 高德上游（与 serverless 同口径） ----------
async function amapDriving(origin, destination, strategy) {
  if (!AMAP_KEY) return { status: 0, distance: null, duration: null, info: 'KEY_MISSING' };
  const q = new URLSearchParams({ key: AMAP_KEY, origin, destination, strategy: String(strategy), extensions: 'base', output: 'JSON' });
  const r = await fetch(`https://restapi.amap.com/v3/direction/driving?${q}`);
  const d = await r.json();
  if (d.status !== '1') return { status: 0, distance: null, duration: null, info: d.info };
  const p = d.route?.paths?.[0];
  return { status: 1, distance: p ? +p.distance : null, duration: p ? +p.duration : null, info: 'OK' };
}

async function amapDistrict(keywords, subdistrict, extensions) {
  if (!AMAP_KEY) return { status: 0, info: 'KEY_MISSING' };
  const q = new URLSearchParams({ key: AMAP_KEY, keywords, subdistrict: String(subdistrict), extensions, output: 'JSON' });
  const r = await fetch(`https://restapi.amap.com/v3/config/district?${q}`);
  return r.json();
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // ---- API 代理：/api/amap/route ----
  if (path === '/api/amap/route') {
    const o = url.searchParams.get('origin'), d = url.searchParams.get('destination');
    if (!o || !d) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 0, info: 'MISSING' })); return; }
    const [avoid, fastest] = await Promise.all([amapDriving(o, d, 12), amapDriving(o, d, 2)]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 1, avoid, fastest }));
    return;
  }
  // ---- 行政区划代理 ----
  if (path === '/api/amap/district') {
    const k = url.searchParams.get('keywords') || '中国';
    const sub = url.searchParams.get('subdistrict') || '0';
    const ext = url.searchParams.get('extensions') === 'all' ? 'all' : 'base';
    const data = await amapDistrict(k, sub, ext);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // ---- 静态文件（带路径穿越防护） ----
  let rel = path === '/' ? '/index.html' : path;
  let file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); res.end('Not Found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

const PORT = process.env.PORT || 5173;
server.listen(PORT, () => {
  console.log(`走啊 dev server → http://localhost:${PORT}`);
  console.log(`AMAP key ${AMAP_KEY ? '已加载' : '缺失（检查 .env）'}`);
});