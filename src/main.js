/**
 * 走啊 · 三态决策画布（定位态/扫描态/结果态，规划书 10.2）
 * 步骤3 原型：模拟数据驱动，UI 明确标注「演示模式 · 模拟数据」（7.3 下界：降级必须明示）。
 * 真实数据接入在步骤4（路线级代理，8.4）。
 *
 * 合规（17.1）：定位仅在点击「扫一圈」时采集，进页面不请求；采集仅用于本次扫描。
 */

import { wgs84ToGcj02 } from './utils/geo.js';
import { RadarScanner } from './components/radar.js';

/** 固定种子伪随机，保证演示可复现（非真实数据，属演示模式明示范围） */
function seededIndices(k = 12, seed = 20260922) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  return Array.from({ length: k }, () => Math.round(next() * 100));
}

const SECTOR_NAMES = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];
const DEMO_COUNTIES = ['安吉县', '德清县', '桐乡市', '海宁市', '南浔区', '长兴县'];

const app = document.getElementById('app');
const btnScan = document.getElementById('btn-scan');
const mapContainer = document.getElementById('map-container');

const scanState = {
  userGcj: null,   // GCJ-02 定位点
  indices: [],     // 扇区指数
  demo: true       // 步骤3 为演示模式
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
  if (!app.querySelector('.demo-badge')) {
    const demoBadge = document.createElement('div');
    demoBadge.className = 'demo-badge';
    demoBadge.textContent = '演示模式 · 模拟数据（步骤3）';
    app.appendChild(demoBadge);
  }

  // 真实数据链路（步骤4起启用）：此处为模拟指数
  scanState.indices = seededIndices();
  const durationScale = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.02 : 1;
  radar.start(scanState.indices, { onComplete: renderResult, durationScale });
}

function renderResult() {
  // 结果态：收敛扇区（10.9 结果态收敛），展示 Top-3 推荐卡（模拟）
  setState('result');
  radar.canvas.remove();
  const badge = app.querySelector('.demo-badge');
  if (badge) badge.remove();

  const best = scanState.indices
    .map((v, i) => ({ i, v }))
    .sort((a, b) => a.v - b.v)
    .slice(0, 3);
  // 8.3 相对排序口径：节省 = 最热方向指数 − 本方向指数（演示模式口径一致）
  const worst = Math.max(...scanState.indices);

  const cards = document.createElement('div');
  cards.className = 'result-cards';
  cards.innerHTML = best.map(({ i, v }, rank) => `
    <div class="rec-card" data-sector="${i}">
      <div class="rec-rank">推荐${rank + 1}</div>
      <div class="rec-title">${SECTOR_NAMES[i % SECTOR_NAMES.length]}方向 · ${DEMO_COUNTIES[i % DEMO_COUNTIES.length]}</div>
      <div class="rec-num">节省 <span class="num">${Math.max(1, Math.round(worst - v))}</span> 分钟</div>
      <div class="rec-meta">指数 ${v}/100 · 距离 ${30 + i * 5}km（模拟）</div>
    </div>
  `).join('');
  app.appendChild(cards);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = '「节省X分钟」为错峰方向与热门方向的ETA对比，用于取舍方向（规划书 8.3）';
  app.appendChild(hint);
}

btnScan.addEventListener('click', () => {
  // 17.1：仅点击时采集定位；失败走手动选点兜底
  if (!navigator.geolocation) {
    useManualFallback();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const wgs = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      scanState.userGcj = wgs84ToGcj02(wgs); // 9.4 全链路 GCJ-02
      renderScanning();
    },
    () => useManualFallback(),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
  );
});

/** 手动选点兜底（定位失败/超时，10.7） */
function useManualFallback() {
  const city = window.prompt('定位失败：请输入城市/县区名（演示原型为静态占位）', '杭州');
  if (!city) return;
  scanState.userGcj = { lng: 120.1552, lat: 30.2741 }; // 杭州占位（演示模式明示）
  renderScanning();
}

renderIdle();
