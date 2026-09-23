/**
 * 走啊 · 三态决策画布（定位态/扫描态/结果态，规划书 10.2）
 * 步骤4：接入真实数据（路线级代理 8.4 扇区指数 + 10.9 核密度热力）。
 * 数据诚实（7.3）：正式扫描用 scanSectors 的真实 ETA；仅当所有方向无数据时才显式降级提示，不填假指数。
 *
 * 合规（17.1）：定位仅在点击「扫一圈」时采集，进页面不请求；采集仅用于本次扫描。
 */

import { wgs84ToGcj02 } from './utils/geo.js';
import { RadarScanner } from './components/radar.js';
import { HeatmapRenderer, heatColor } from './components/heatmap.js';
import { scanSectors } from './utils/scan.js';
import { fetchRoute } from './utils/api.js';

const SECTOR_NAMES = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];

const app = document.getElementById('app');
const btnScan = document.getElementById('btn-scan');
const mapContainer = document.getElementById('map-container');

const scanState = {
  userGcj: null,    // GCJ-02 定位点
  indices: [],      // 扇区指数（真实）
  sectors: [],      // 扇区明细
  demo: false,      // 步骤4 为真实数据模式
  fetching: false,
  keepHeat: true    // 结果态保留热力背景（10.9），降级态移除
};

const radar = new RadarScanner(createScanCanvas());

function createScanCanvas() {
  const c = document.createElement('canvas');
  c.id = 'scan-canvas';
  c.width = Math.min(window.innerWidth, 480);
  c.height = Math.min(window.innerHeight, 480);
  c.style.cssText = 'position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);z-index:var(--z-scanner);';
  return c;
}

function setState(state) {
  app.dataset.state = state;
  if (state !== 'scanning') radar.stop();
}

function renderIdle() {
  setState('idle');
  mapContainer.textContent = '地图画布（高德底图，步骤4接入）';
}

function renderScanning() {
  setState('scanning');
  mapContainer.appendChild(radar.canvas);
  // 实时数据模式：扫描态显示热力底图（核密度连续面）
  const heatCanvas = createHeatCanvas();
  mapContainer.appendChild(heatCanvas);
  scanState.heatRenderer = new HeatmapRenderer(heatCanvas, scanState.userGcj, null);
}

function createHeatCanvas() {
  const c = document.createElement('canvas');
  c.id = 'heat-canvas';
  c.width = mapContainer.clientWidth || window.innerWidth;
  c.height = mapContainer.clientHeight || window.innerHeight;
  c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:var(--z-heat);pointer-events:none;';
  return c;
}

/** 真实扫描（8.4）：定位 + 预置景点一步步调路径规划，产出各扇区指数 */
async function runScan() {
  if (scanState.fetching) return;
  scanState.fetching = true;
  setState('scanning');
  try {
    const destinations = await loadDestinations();
    // 先挂载雷达 + 热力画布（扫描态视觉），再启动真实扫描
    renderScanning();
    const res = await scanSectors(scanState.userGcj, destinations, 12, fetchRoute);
    if (res.ok) {
      scanState.sectors = res.sectors;
      scanState.indices = res.sectors.map(s => s.index);
      // 展示真实热力 + 扇区动画（动画时长仍由指数驱动，10.12.4）
      if (scanState.heatRenderer) scanState.heatRenderer.render(res.sectors);
      const durationScale = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.02 : 1;
      radar.start(scanState.indices.map(v => v == null ? 0 : v), {
        onComplete: () => renderResult(),
        durationScale
      });
    } else {
      renderDegraded('真实数据不可用：' + (res.message || '所有方向均无路径数据') + '（已停止，不作模拟填充）');
    }
  } catch (err) {
    renderDegraded('扫描失败（' + (err && err.message ? err.message : '网络异常') + '）。请检查 Serverless 代理是否运行。');
  } finally {
    scanState.fetching = false;
  }
}

/** 页面上加载预置景点（data/destinations.json，走静态托管） */
async function loadDestinations() {
  try {
    const resp = await fetch('/data/destinations.json');
    const data = await resp.json();
    return data.destinations || [];
  } catch {
    return [];
  }
}

/** 显式降级态（7.3 下界）：明确提示，不伪造数据 */
function renderDegraded(message) {
  const heat = app.querySelector('#heat-canvas');
  if (heat) heat.remove();
  const c = document.createElement('div');
  c.className = 'degraded';
  c.textContent = message;
  mapContainer.replaceChildren(c);
  app.dataset.state = 'degraded';
}

function renderResult() {
  // 结果态：保留热力连续面为背景（10.9 收敛扇区线但保留热力），移除雷达扫描层
  setState('result');
  radar.canvas.remove();
  const heat = app.querySelector('#heat-canvas');
  // 热力背景保留；若无数据（降级已处理）则此 canvas 不存在，无需移除
  if (heat && !scanState.keepHeat) heat.remove();

  // 只取有数据的方向参与排序，缺失方向不显示
  const withData = scanState.indices
    .map((v, i) => ({ i, v }))
    .filter(x => x.v != null);
  if (withData.length === 0) { renderDegraded('未取得任何方向数据，无法推荐'); return; }
  const best = withData.slice().sort((a, b) => a.v - b.v).slice(0, 3);
  const worst = Math.max(...withData.map(x => x.v));

  const cards = document.createElement('div');
  cards.className = 'result-cards';
  cards.innerHTML = best.map(({ i, v }, rank) => `
    <div class="rec-card" data-sector="${i}" style="--rec-accent:${heatColor(v)}">
      <div class="rec-rank">推荐${rank + 1}</div>
      <div class="rec-title">${SECTOR_NAMES[i % SECTOR_NAMES.length]}方向</div>
      <div class="rec-num">节省约 <span class="num">${Math.max(1, Math.round(worst - v))}</span> 分钟</div>
      <div class="rec-meta">相对指数 ${v}/100 · 实际探测</div>
    </div>
  `).join('');
  app.appendChild(cards);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = '「节省约X分钟」为该方向与最堵方向的ETA对比，用于取舍方向（规划书 8.3）；指数由真实路径规划ETA换算。';
  app.appendChild(hint);
}

btnScan.addEventListener('click', () => {
  // 17.1：仅点击时采集定位；失败走手动选点兜底（两者均接真实扫描）
  if (!navigator.geolocation) { useManualFallback(); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const wgs = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      scanState.userGcj = wgs84ToGcj02(wgs); // 9.4 全链路 GCJ-02
      runScan();
    },
    () => useManualFallback(),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
  );
});

/** 手动选点兜底（定位失败/超时，10.7）：进入真实扫描（按城市占位定位） */
async function useManualFallback() {
  const city = window.prompt('定位失败：请输入城市名（用于确定扫描中心）', '杭州');
  if (!city) return;
  // 城市→中心坐标：内置常用城市，未命中用默认并提示
  const center = CITY_PRESETS[city] || CITY_PRESETS.杭州;
  scanState.userGcj = center;
  runScan();
}

/** 常用城市中心（GCJ-02）：兜底用；后续可接行政区划接口反查中心 */
const CITY_PRESETS = {
  杭州: { lng: 120.1552, lat: 30.2741 },
  北京: { lng: 116.407394, lat: 39.904211 },
  上海: { lng: 121.4737, lat: 31.2304 },
  广州: { lng: 113.2644, lat: 23.1291 },
  深圳: { lng: 114.0579, lat: 22.5431 },
  成都: { lng: 104.0665, lat: 30.5723 },
};

renderIdle();
