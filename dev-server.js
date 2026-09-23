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
// driving 为高配额敏感接口：全局平滑节流（保守 ≤3 req/s），防止前端扫描的并发/连发触发上游 QPS 限流
let lastDriving = 0;
async function amapDriving(origin, destination, strategy) {
  const MIN_GAP_MS = 320;
  const wait = Math.max(0, lastDriving + MIN_GAP_MS - Date.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastDriving = Date.now();
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

/** 地理编码：文字地址 → GCJ-02 坐标（高德 geocode 返回即 GCJ-02，9.4 全链路一致） */
async function amapGeocode(address) {
  if (!AMAP_KEY) return { status: 0, info: 'KEY_MISSING' };
  const q = new URLSearchParams({ key: AMAP_KEY, address, output: 'JSON' });
  const r = await fetch(`https://restapi.amap.com/v3/geocode/geo?${q}`);
  return r.json();
}

/** 关键词/类型 POI 搜索（v5 place/text）：动态拉取出发地周边景区，替代全量预置 */
async function amapPoiText(params) {
  if (!AMAP_KEY) return { status: 0, info: 'KEY_MISSING' };
  const q = new URLSearchParams(Object.assign({
    key: AMAP_KEY,
    types: '110200',      // 110200 = 风景名胜
    page_size: '25',
    output: 'JSON'
  }, params));
  const r = await fetch(`https://restapi.amap.com/v5/place/text?${q}`);
  return r.json();
}

/** 逆地理编码：坐标 → 城市/区县（真机定位成功时，自动识别出发城市供动态拉取） */
async function amapRegeo(location) {
  if (!AMAP_KEY) return { status: 0, info: 'KEY_MISSING' };
  const q = new URLSearchParams({ key: AMAP_KEY, location, extensions: 'base', output: 'JSON' });
  const r = await fetch(`https://restapi.amap.com/v3/geocode/regeo?${q}`);
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
  // ---- 地理编码代理（定位失败时，用户自行输入出发地） ----
  if (path === '/api/amap/geocode') {
    const address = url.searchParams.get('address') || '';
    if (!address) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 0, info: 'MISSING' })); return; }
    const data = await amapGeocode(address);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }
  // ---- 逆地理编码代理（真机定位成功 → 自动识别出发城市） ----
  if (path === '/api/amap/regeo') {
    const location = url.searchParams.get('location') || '';
    if (!location) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 0, info: 'MISSING' })); return; }
    const data = await amapRegeo(location);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }
  // ---- 动态景区 POI 代理（两阶段推荐·阶段1数据源：出发城市风景区，按区县聚合） ----
  if (path === '/api/amap/pois') {
    const usp = url.searchParams;
    const params = {};
    // city（城市名）+ keywords：v5 text 高质量风景区拉取（radius 模式的类型过滤不可靠，弃用）
    if (usp.get('city')) params.city = usp.get('city');
    if (usp.get('keywords')) params.keywords = usp.get('keywords');
    const page = Math.max(1, parseInt(usp.get('page') || '1', 10));
    params.page = String(page);
    const data = await amapPoiText(params);
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
  const type = MIME[extname(file)] || 'application/octet-stream';
  if (file.endsWith('index.html')) {
    // 注入 JS key（9.3：仅开发注入，不入 git；生产用占位替换）
    // 用解析后的 file 判断，兼容根路径「/」→ /index.html（请求 path 是 /，不以 index.html 结尾）
    const jsKey = process.env.AMAP_JS_KEY || '';
    let html = readFileSync(file, 'utf8');
    html = html.replace(
      '</head>',
      `<script>window.__AMAP_JS_KEY__=${JSON.stringify(jsKey)};</script></head>`
    );
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});

const PORT = process.env.PORT || 5173;
server.listen(PORT, () => {
  console.log(`走啊 dev server → http://localhost:${PORT}`);
  console.log(`AMAP key ${AMAP_KEY ? '已加载' : '缺失（检查 .env）'}`);
});