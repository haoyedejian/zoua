/**
 * 走啊 · 三态决策画布（定位态/扫描态/结果态，规划书 10.2）
 * 步骤5：高德真实底图主舞台 + 用户蓝点 + 推荐 pin + 卡片联动。
 * 数据诚实（7.3）：扫描用 scanSectors 的真实 ETA；无数据处显式降级，不填假指数。
 *
 * 合规（17.1）：定位仅在点击「走啊」时采集，进页面不请求；采集仅用于本次扫描。
 */

import { wgs84ToGcj02 } from './utils/geo.js';
import { RadarScanner } from './components/radar.js';
import { HeatmapRenderer, heatColor } from './components/heatmap.js';
import { scanSectors, aggregateRegions, bearing, kmDistance } from './utils/scan.js';
import { fetchRoute, fetchPois, fetchRegeo } from './utils/api.js';
import { ZouaMap } from './components/map.js';

const SECTOR_NAMES = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];

const app = document.getElementById('app');
const btnScan = document.getElementById('btn-scan');
const mapContainer = document.getElementById('map-container');

const scanState = {
  userGcj: null,    // GCJ-02 定位点
  cityName: null,   // 出发城市名（定位失败手动选择/输入时记录，供动态拉取风景区）
  indices: [],      // 扇区指数（真实）
  sectors: [],      // 扇区明细（含代表锚点）
  regions: [],      // 区县聚合（阶段1）
  demo: false,
  fetching: false,
  keepHeat: true,
  best: []          // 推荐 [{sector,index,save,anchor:rep}]
};

const radar = new RadarScanner(createScanCanvas());
const zouaMap = new ZouaMap(mapContainer);

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
  mapContainer.replaceChildren();
  initMap().then(ok => {
    if (!ok && !app.querySelector('.map-warn')) {
      const w = document.createElement('div');
      w.className = 'map-warn';
      w.textContent = '地图底图加载失败（检查 JS key 或网络）；已回退热力画布模式。';
      mapContainer.appendChild(w);
    }
  });
}

async function initMap() {
  if (zouaMap.ready) return true;
  const ok = await zouaMap.init(scanState.userGcj);
  return ok;
}

function renderScanning() {
  setState('scanning');
  mapContainer.appendChild(radar.canvas);
  // 用户蓝点落到地图（17.1 仅本次采集展示）
  if (scanState.userGcj) {
    zouaMap.setUserDot([scanState.userGcj.lng, scanState.userGcj.lat]);
  }
  // 实时数据模式：扫描态显示热力底图（核密度连续面，9.6 收敛线 + 热力）
  const heatCanvas = createHeatCanvas();
  mapContainer.appendChild(heatCanvas);
  scanState.heatRenderer = new HeatmapRenderer(heatCanvas);
  scanState.heatRenderer.setCenter(scanState.userGcj);
}

function createHeatCanvas() {
  const c = document.createElement('canvas');
  c.id = 'heat-canvas';
  c.width = mapContainer.clientWidth || window.innerWidth;
  c.height = mapContainer.clientHeight || window.innerHeight;
  c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:var(--z-heat);pointer-events:none;';
  return c;
}

/** 用当前地图投影重绘热力画布（图层融合核心：任何地图变动后调用） */
function paintHeat() {
  const hr = scanState.heatRenderer;
  if (!hr || !zouaMap.amap) return;
  hr.resize();
  hr.render();
}

let heatBound = false;
/** 绑定地图 move/zoom + 窗口 resize → 重绘热力，保证两图层缩放/平移不脱节 */
function bindHeatToMap() {
  if (heatBound || !zouaMap.amap) return;
  heatBound = true;
  const events = ['mapmove', 'zoomchange', 'moveend', 'resize'];
  events.forEach(ev => zouaMap.amap.on(ev, paintHeat));
  window.addEventListener('resize', paintHeat);
}

/** 真实扫描（8.4）：定位 + 预置景点 + 动态拉取周边景区，逐点调路径规划，产出扇区指数与区县聚合 */
async function runScan() {
  if (scanState.fetching) return;
  scanState.fetching = true;
  setState('scanning');
  try {
    // 真机定位成功且无城市名：逆地理编码自动识别出发城市（供动态拉取该城风景区）
    if (scanState.userGcj && !scanState.cityName) {
      try {
        const rz = await fetchRegeo(`${scanState.userGcj.lng},${scanState.userGcj.lat}`);
        const comp = rz && rz.regeocode && rz.regeocode.addressComponent;
        const raw = (comp && ((Array.isArray(comp.city) && comp.city[0]) || comp.city || comp.province)) || '';
        scanState.cityName = normalizeCity(raw);
      } catch { scanState.cityName = null; }
    }
    const destinations = await loadDestinations(scanState.userGcj, scanState.cityName);
    // 先挂载雷达 + 热力画布（扫描态视觉），再启动真实扫描
    renderScanning();
    const res = await scanSectors(scanState.userGcj, destinations, 12, fetchRoute);
    if (res.ok) {
      scanState.sectors = res.sectors;
      scanState.indices = res.sectors.map(s => s.index);
      scanState.scannedAt = Date.now(); // 12.1：结果卡标注数据测算时间，随缓存命中正确刷新
      // 两阶段推荐·阶段1：按区县聚合出「哪里人少」
      scanState.regions = aggregateRegions(res.sectors);
      // 展示真实热力：方向场 + 区县色斑，随地图缩放/平移重绘（步骤6 图层融合）
      if (scanState.heatRenderer) {
        scanState.heatRenderer.attachMap(zouaMap.amap);
        scanState.heatRenderer.setData(res.sectors);
        scanState.heatRenderer.setRegions(scanState.regions);
        bindHeatToMap();
        paintHeat();
      }
      const durationScale = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.02 : 1;
      radar.start(scanState.indices.map(v => v == null ? 0 : v), {
        onComplete: () => renderResult(),
        durationScale
      });
    } else {
      // 规划失败降级（10.7 分支三）
      renderDegraded(
        '真实数据不可用：' + (res.message || '所有方向均无路径数据') + '。已停止，未作模拟填充。',
        { icon: '🗺️', title: '这次没扫出方向' }
      );
    }
  } catch (err) {
    // 配额耗尽 / 代理异常 / 网络中断降级（10.7 分支二）
    const qps = /QPS|EXCEEDED|FREQUENT|LIMIT/i.test((err && err.info) || (err && err.message) || '');
    renderDegraded(
      qps
        ? '高德路线配额暂时告罄（QPS 限流），稍等片刻再试。数据未填充伪造值。'
        : '扫描失败（' + (err && err.message ? err.message : '网络异常') + '）。请检查 Serverless 代理是否运行。',
      { icon: qps ? '🕒' : '⚠️', title: qps ? '请求太快，稍缓一下' : '扫描没成功' }
    );
  } finally {
    scanState.fetching = false;
  }
}

/** 目的地底库 = 预设（静态 json）+ 动态拉取（出发城市风景区 POI，方案1），按 poi_id/名称去重 */
async function loadDestinations(origin, cityName) {
  let presets = [];
  try {
    const resp = await fetch('/data/destinations.json');
    const data = await resp.json();
    presets = data.destinations || [];
  } catch { /* 预设缺失不阻断，仅用动态 */ }

  // 动态拉取：城市名可用（预置城市/逆地理识别）时按 city 拉高质量风景区；
  // v5 radius 模式类型过滤不可靠，弃用，无城市名时仅用预设底库
  const BAD = /停车场|入口|出口|游客中心|售票|服务区|酒店|民宿|餐厅|垂钓|农家乐|打卡|门店|杂货铺|码头|牌楼|装置|围栏|坐台|台阶|背景|规划馆|纪念馆|博物馆|图书馆|科技馆|体育馆|滑雪场|游乐场|纪念碑|烈士|清真寺|教堂|医院|学校|政府|派出所|机关/;
  let remote = [];
  const city = origin && typeof cityName === 'string' && cityName ? cityName : '';
  if (city) {
    try {
      // 关键词 OR + 风景区类型：覆盖 景区/古镇/度假区/名胜/公园/湖/山/湿地（v5 该查询仅 1 页有效）
      const KWS = '风景区|景区|古镇|度假区|名胜|公园|湖|山|湿地|森林公园';
      const page1 = await fetchPois({ city, keywords: KWS, page: 1 });
      const poiList = (page1 && page1.pois) || [];
      remote = poiList
        .filter(p => p && p.location && p.name && !BAD.test(p.name))
        // 候选按直线距离取前 30：覆盖近郊各区县且控制路线规划配额（QPS≤3）
        .map(p => {
          const [lon, lat] = p.location.split(',').map(Number);
          return {
            name: p.name,
            county: p.adname || p.district || '',
            adcode: p.adcode || '',
            category: '风景名胜',
            lon, lat,
            poi_id: p.poi_id || p.id || '',
            tags: [],
            intro: `${p.name}，位于${p.adname || city}，由高德风景区数据发现。`,
            _dist: origin ? kmDistance(origin, { lng: lon, lat }) : 0
          };
        })
        .sort((a, b) => a._dist - b._dist)
        .slice(0, 30)
        .map(({ _dist, ...r }) => r);
    } catch { /* 动态拉取失败 → 仅预设兜底 */ }
  }

  // 合并去重（优先预设：文案更完整）
  const seen = new Set(presets.map(p => p.poi_id || p.name));
  remote.forEach(r => {
    const k = r.poi_id || r.name;
    if (!seen.has(k)) { seen.add(k); presets.push(r); }
  });
  return presets;
}

/** 城市名规范化（去 市/省/自治区 等后缀，兼容直辖市）：供 regeo/输入 判断可用城市名 */
function normalizeCity(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[市省自治区特别行政区地区]/g, '');
  if (!s || s.length > 12) return null;
  return s;
}

/**
 * 显式降级态（7.3 下界 / 10.7 四分支兜底）：
 * 明确提示原因，绝不伪造数据；提供「重新试一次」出口回到定位态。
 * @param {string} message 主说明
 * @param {object} [opt] { title, icon, retry=true }
 */
function renderDegraded(message, opt = {}) {
  // 清理扫描/结果浮动层（雷达、热力、底部 sheet、图例）
  const heat = app.querySelector('#heat-canvas');
  if (heat) heat.remove();
  const radarCanvas = app.querySelector('#scan-canvas');
  if (radarCanvas) radarCanvas.remove();
  app.querySelectorAll('.result-sheet').forEach(el => el.remove());
  app.querySelectorAll('.heat-legend').forEach(el => el.remove());
  app.querySelectorAll('.city-picker').forEach(el => el.remove());

  const icon = opt.icon || '⚠️';
  const title = opt.title || '这次不太好扫';
  const retry = opt.retry !== false;
  const c = document.createElement('div');
  c.className = 'degraded';
  c.innerHTML = `
    <div class="degraded-card">
      <div class="degraded-icon" aria-hidden="true">${icon}</div>
      <div class="degraded-title">${title}</div>
      <div class="degraded-msg">${message}</div>
      ${retry ? '<button type="button" class="degraded-retry">重新试一次</button>' : ''}
    </div>`;
  mapContainer.replaceChildren(c);
  app.dataset.state = 'degraded';

  if (retry) {
    c.querySelector('.degraded-retry').addEventListener('click', () => {
      // 回到定位态：重建底图与初始按钮壳
      renderIdle();
    });
  }
}

/** 断网静态兜底（10.7 分支四）：离线时点击不发起任何网络请求，直接说明并提示联网 */
function renderOffline() {
  renderDegraded(
    '当前无网络连接，暂时扫不了方向。联网后再试，出发地定位需在线完成。',
    { icon: '📡', title: '离线中，先连个网', retry: true }
  );
}

/**
 * 结果态 · 两阶段推荐（产品设计补充）
 * 阶段1：只呈现「定位点周边 2~3 小时车程里哪里人少」——按区县聚合的推荐卡 + 区县级热力色斑；
 * 阶段2：用户选定某个区县后，再推送该区县的简介与可玩目的地描述。
 */
function renderResult() {
  setState('result');
  radar.canvas.remove();
  const heat = app.querySelector('#heat-canvas');
  if (heat && !scanState.keepHeat) heat.remove();

  const regions = scanState.regions && scanState.regions.length > 0 ? scanState.regions : null;
  if (!regions) { renderDegraded('未取得任何方向数据，无法推荐'); return; }
  const top = regions.slice(0, 3);

  // 区县 pin 落到「县内最顺代表锚点」（阶段1 唯一打点对象）
  zouaMap.clearPins();
  top.forEach((rg, rank) => {
    if (rg.rep && rg.rep.lon != null) {
      zouaMap.addPin([rg.rep.lon, rg.rep.lat], {
        sector: rank, index: rg.index, name: rg.county, km: rg.km, rank
      });
    }
  });
  // 结果态地图圆心保持 = 用户定位点（不替用户做选择；点推荐卡才飞向对应区县）
  if (scanState.userGcj && zouaMap.amap) {
    zouaMap.focus([scanState.userGcj.lng, scanState.userGcj.lat], zouaMap.amap.getZoom());
  }

  // 底部面板：阶段1（区县列表）+ 阶段2（区县详情，带返回）
  const sheet = document.createElement('div');
  sheet.className = 'result-sheet';
  sheet.innerHTML = `
    <div class="sheet-view sheet-list">
      <div class="sheet-head">
        <span class="sheet-title">哪里人少？可以走这些方向<em>按当前出行顺畅度</em></span>
        <span class="sheet-more" aria-hidden="true">↔ 滑动</span>
      </div>
      <div class="result-cards">
        ${top.map((rg, i) => regionCardHTML(rg, i)).join('')}
        <span class="cards-spacer" aria-hidden="true"></span>
      </div>
      <div class="sheet-foot">数据由高德路线实时测算 · ${scanTimeText()}</div>
    </div>
    <div class="sheet-view sheet-detail" hidden></div>`;
  app.appendChild(sheet);

  // 图例组件（10.9 常驻角落；设计稿左上角）
  mountLegend();

  // 阶段1 → 阶段2：点区县卡 → 地图聚焦 + 区县详情
  sheet.querySelectorAll('.rec-card').forEach(card => {
    const idx = Number(card.dataset.region);
    card.addEventListener('click', () => {
      const rg = top[idx];
      if (!rg) return;
      if (rg.rep && rg.rep.lon != null) zouaMap.focus([rg.rep.lon, rg.rep.lat], 11);
      zouaMap.highlightPin(idx);
      openRegionDetail(sheet, rg);
    });
  });
  if (top[0]) zouaMap.highlightPin(0);
}

/** 人少/正常/人多：指数语义映射（阶段1卡片与阶段2标签共用） */
function crowdLabel(index) {
  if (index == null) return '未知';
  return index < 34 ? '人少' : index < 67 ? '正常' : '人多';
}

/** 结果卡数据测算时间（12.1：mm:ss，随 scannedAt 正确刷新） */
function scanTimeText() {
  if (!scanState.scannedAt) return '本地测算';
  const d = new Date(scanState.scannedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 阶段1 · 区县推荐卡（发现导向：区县 + 人少/正常/人多 + 区内代表景点） */
function regionCardHTML(rg, rank) {
  const dirName = rg.rep
    ? SECTOR_NAMES[Math.round(bearing(scanState.userGcj, { lng: rg.rep.lon, lat: rg.rep.lat }) / 45) % SECTOR_NAMES.length]
    : '';
  const [cr, cg, cb] = heatColor(rg.index);
  const tags = [];
  if (rg.km != null) tags.push(`距你${rg.km}km`);
  if (rg.eta != null) tags.push(`车程约${rg.eta}分钟`);
  const spotsPreview = (rg.spotNames || []).slice(0, 2).join('、') + ((rg.spotNames || []).length > 2 ? ' 等' : '');
  return `
  <div class="rec-card" data-region="${rank}" style="--rec-accent:rgb(${cr},${cg},${cb})">
    <div class="rec-head">
      <span class="rec-rank">推荐${rank + 1}</span>
      ${dirName ? `<span class="rec-dir">${dirName}方向</span>` : ''}
    </div>
    <div class="rec-title">${rg.county}</div>
    <div class="rec-sub">${crowdLabel(rg.index)} · ${spotsPreview || '区内好去处'}</div>
    ${tags.length ? `<div class="rec-tags">${tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : ''}
    <div class="rec-more">看这个区县能去哪</div>
  </div>`;
}

/** 阶段2 · 区县详情：区县简介 + 可玩目的地描述（景点列表，带导航） */
function openRegionDetail(sheet, rg) {
  const list = sheet.querySelector('.sheet-list');
  const detail = sheet.querySelector('.sheet-detail');
  const crowd = crowdLabel(rg.index);
  const spots = rg.spots || [];
  const dNames = spots.slice(0, 3).map(s => s.name).join('、');

  const crowdTip =
    crowd === '人少' ? '这条路现在很顺，人还不多，是错峰出行的好选择。'
    : crowd === '正常' ? '这条路现在一般，不算挤，周末可接受。'
    : '这条路现在偏堵，人比较多，建议稍晚或换一天再出发。';
  const intro =
    `${rg.county}${rg.km != null ? `，距你约 ${rg.km} 公里` : ''}${rg.eta != null ? `、开车约 ${rg.eta} 分钟` : ''}。` +
    crowdTip +
    (spots.length ? `区内给你挑了 ${spots.length} 处好去处${dNames ? `：${dNames} 等` : ''}。` : '附近暂未收录成熟景区，去看看周边县城的风土人情也不错。');

  detail.innerHTML = `
    <div class="detail-head">
      <button type="button" class="detail-back">← 返回列表</button>
    </div>
    <div class="detail-title">${rg.county}</div>
    <div class="rec-tags">
      <span class="tag">${crowd}</span>
      ${rg.km != null ? `<span class="tag">距你${rg.km}km</span>` : ''}
      ${rg.eta != null ? `<span class="tag">车程约${rg.eta}分钟</span>` : ''}
      <span class="tag">${spots.length}处好去处</span>
    </div>
    <p class="detail-intro">${intro}</p>
    <div class="region-spots">
      ${spots.map(sp => `
        <div class="spot-row">
          <div class="spot-main">
            <div class="spot-name">${sp.name}</div>
            <div class="rec-tags">
              ${sp.km != null ? `<span class="tag">距你${sp.km}km</span>` : ''}
              ${sp.eta != null ? `<span class="tag">车程约${sp.eta}分钟</span>` : ''}
            </div>
          </div>
          <button type="button" class="spot-go">去这里</button>
        </div>`).join('')}
    </div>
    <div class="detail-actions">
      <button type="button" class="act-btn act-nav">去这里（导航）</button>
      <button type="button" class="act-btn act-share">分享这个区县</button>
    </div>`;

  list.hidden = true;
  detail.hidden = false;
  detail.querySelector('.detail-back').addEventListener('click', () => {
    detail.hidden = true;
    list.hidden = false;
  });
  // 区县级动作：导航到「最顺代表锚点」
  const navSpot = spots[0] || (rg.rep ? { name: rg.county, lon: rg.rep.lon, lat: rg.rep.lat } : null);
  detail.querySelector('.act-nav').addEventListener('click', () => openNavigation({ anchor: navSpot }));
  detail.querySelector('.act-share').addEventListener('click', () => buildShareCard({
    anchor: navSpot || { name: rg.county, lon: null, lat: null },
    index: rg.index,
    sector: 0,
    shareTitle: rg.county
  }));
  // 景点行：导航
  detail.querySelectorAll('.spot-go').forEach((btn, i) => {
    const sp = spots[i];
    btn.addEventListener('click', () => openNavigation({ anchor: sp }));
  });
}

/** 图例组件（10.9：色带 + 人少/人多 语义，常驻地图角落；设计稿左上角） */
function mountLegend() {
  if (app.querySelector('.heat-legend')) return;
  const el = document.createElement('div');
  el.className = 'heat-legend';
  el.innerHTML = `
    <div class="heat-legend-title">出行拥挤度</div>
    <div class="heat-legend-bar"></div>
    <div class="heat-legend-scale"><span>人少</span><span>正常</span><span>人多</span></div>`;
  app.appendChild(el);
}

/** 输出层 · 跳转高德导航（10.11 主按钮）：携带目的地 GCJ-02 坐标与名称 */
function openNavigation(b) {
  if (!b || !b.anchor || b.anchor.lon == null) { toast('暂无该目的地的坐标，无法发起导航'); return; }
  // uri 高德导航：to=经度,纬度,名称；mode=car 驾车
  const lon = b.anchor.lon, lat = b.anchor.lat;
  const name = encodeURIComponent(b.anchor.name || '目的地');
  const url = `https://uri.amap.com/navigation?to=${lon},${lat},${name}&mode=car&callnative=0`;
  window.open(url, '_blank');
}

/**
 * 输出层 · 分享卡片（15.2 / 10.12.2）：离屏 Canvas 绘制 ≥1080px
 * 大字三行（方向 / 县区目的地 / ETA）+ 副标语 + 版权标注，白底、深字、等宽数字。
 * 生成 PNG 后新标签页打开，供长按/下载分享到家庭群。
 */
function buildShareCard(b) {
  if (!b || (!b.shareTitle && !(b.anchor && (b.anchor.name || b.anchor.lon != null)))) { toast('暂无可分享的目的地'); return; }
  const W = 1080, H = 1440; // 4:5，社交分享比例
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // 白底 + 顶部品牌块
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0B1220';
  ctx.fillRect(0, 0, W, 8);

  // 品牌 / 副标语（15.2：宣传名带叹号）
  ctx.fillStyle = '#1F2937';
  ctx.font = '700 64px "PingFang SC","HarmonyOS Sans",sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('走啊！', 72, 150);
  ctx.fillStyle = '#6B7280';
  ctx.font = '34px "PingFang SC","HarmonyOS Sans",sans-serif';
  ctx.fillText('走啊，哪个方向不堵？', 72, 212);

  // 区县级分享：主标题为区县名；景点级分享保留方向行
  if (b.shareTitle) {
    ctx.fillStyle = '#1F2937';
    ctx.font = '700 120px "PingFang SC","HarmonyOS Sans",sans-serif';
    ctx.fillText(`${b.shareTitle}`, 72, 400);
    ctx.fillStyle = '#6B7280';
    ctx.font = '40px "PingFang SC","HarmonyOS Sans",sans-serif';
    ctx.fillText(`周边 2~3 小时车程 · 现在出发人少`, 72, 470);
  } else {
    ctx.fillStyle = '#1F2937';
    ctx.font = '700 120px "PingFang SC","HarmonyOS Sans",sans-serif';
    ctx.fillText(`${SECTOR_NAMES[b.sector % SECTOR_NAMES.length]}方向`, 72, 400);
  }

  // 目的地（县区/名称）
  const dest = b.shareTitle || (b.anchor && b.anchor.name) || '附近目的地';
  ctx.fillStyle = '#374151';
  ctx.font = '56px "PingFang SC","HarmonyOS Sans",sans-serif';
  ctx.fillText(dest, 72, 560);

  // 拥挤度大数字（等宽大字，10.12.2）
  ctx.fillStyle = '#16A34A';
  ctx.font = '700 200px "SF Mono","Roboto Mono",monospace';
  ctx.fillText(`${b.index}`, 72, 780);
  ctx.fillStyle = '#1F2937';
  ctx.font = '700 56px "PingFang SC","HarmonyOS Sans",sans-serif';
  ctx.fillText('/100 出行顺畅度', 72 + ctx.measureText(String(b.index)).width + 40, 750);
  ctx.fillStyle = '#6B7280';
  ctx.font = '40px "PingFang SC","HarmonyOS Sans",sans-serif';
  ctx.fillText(`${crowdLabel(b.index)} · 现在出发正当时`, 72, 870);

  // 分隔 + 版权 / 数据来源标注
  ctx.strokeStyle = '#E5E7EB';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(72, H - 220);
  ctx.lineTo(W - 72, H - 220);
  ctx.stroke();
  ctx.fillStyle = '#9CA3AF';
  ctx.font = '28px "PingFang SC","HarmonyOS Sans",sans-serif';
  ctx.fillText('走啊 · 高德路线实时测算 · 数据仅供参考', 72, H - 140);
  ctx.fillText('指数由真实路径规划 ETA 换算 · 相对指数 ' + b.index + '/100', 72, H - 96);

  cv.toBlob((blob) => {
    if (!blob) { toast('分享卡生成失败'); return; }
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  }, 'image/png');
}

/** 轻提示：输出层操作反馈 */
let toastTimer = null;
function toast(msg) {
  let el = app.querySelector('.z-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'z-toast';
    app.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

btnScan.addEventListener('click', () => {
  // 17.1：仅点击时采集定位；失败/不支持走应用内城市选择兜底（均接真实扫描，不再用系统 prompt——内嵌环境会拦截）
  if (scanState.fetching) return;
  // 断网静态兜底（10.7 分支四）：离线时不发任何网络请求，先提示联网
  if (!navigator.onLine) { renderOffline(); return; }
  if (!navigator.geolocation) { showCityPicker(); return; }
  toast('正在定位…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const wgs = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      scanState.userGcj = wgs84ToGcj02(wgs); // 9.4 全链路 GCJ-02
      runScan();
    },
    () => { hideToast(); showCityPicker(); },
    { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }
  );
});

/** 应用内出发地选择浮层（10.7 定位失败兜底）：预设城市快捷选择 + 自由输入出发地（地理编码） */
function showCityPicker() {
  if (app.querySelector('.city-picker')) return;
  const picker = document.createElement('div');
  picker.className = 'city-picker';
  picker.innerHTML = `
    <p class="city-picker-title">定位不可用，怎么出发？</p>
    <div class="city-input-row">
      <input class="city-input" type="text"
        placeholder="输入出发地（如：西湖区文二路 / 湖州市）"
        maxlength="60" autocomplete="off" />
      <button type="button" class="city-go">确定</button>
    </div>
    <div class="city-chips">
      ${QUICK_CITIES.map(c => `<button type="button" class="city-chip" data-city="${c}">${c}</button>`).join('')}
    </div>
    <button type="button" class="city-close" aria-label="关闭">关闭</button>`;
  app.appendChild(picker);

  const input = picker.querySelector('.city-input');

  // 前端 Geocoder（8s 超时防挂起）→ 服务端代理兜底；预置城市在进入前先零网络命中。
  function geocodeFrontend(q) {
    return new Promise((resolve) => {
      if (!window.AMap || !window.AMap.Geocoder) { resolve(null); return; }
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 8000);
      try {
        const geocoder = new window.AMap.Geocoder({ city: '' });
        geocoder.getLocation(q, (status, result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (status === 'complete' && result && result.geocodes && result.geocodes.length) {
            const g = result.geocodes[0];
            if (g.location && g.location.lng != null) resolve({ lng: g.location.lng, lat: g.location.lat });
            else resolve(null);
          } else resolve(null);
        });
      } catch { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
    });
  }
  async function geocodeProxy(q) {
    try {
      const resp = await fetch(`/api/amap/geocode?address=${encodeURIComponent(q)}`);
      if (!resp.ok) return { ok: false, found: false };
      const data = await resp.json();
      const geo = data && data.geocodes && data.geocodes.find(g => g.location);
      if (!geo) return { ok: true, found: false };
      const [lng, lat] = geo.location.split(',').map(Number);
      if (lng == null || lat == null) return { ok: true, found: false };
      return { ok: true, found: true, gcj: { lng, lat } };
    } catch {
      return { ok: false, found: false };
    }
  }
  async function applyAddress() {
    const q = input.value.trim();
    if (!q) { toast('先输入出发地名称'); return; }
    toast('正在解析出发地…');
    const goBtn = picker.querySelector('.city-go');
    goBtn.disabled = true;
    let gcj = null, frontendOk = false, proxyOk = false;
    // 1) 预置城市表（含市/省名规范化）：零网络，直接命中
    gcj = matchPresetCity(q);
    // 2) 前端高德 Geocoder（具体地址/区县，需浏览器可访问高德地理编码）
    if (!gcj) {
      const fr = await geocodeFrontend(q);
      if (fr) { gcj = fr; frontendOk = true; }
    }
    // 3) 服务端代理兜底（本地 dev-server 才提供）
    if (!gcj) {
      const pr = await geocodeProxy(q);
      proxyOk = pr.ok;
      if (pr.found) gcj = pr.gcj;
    }
    goBtn.disabled = false;
    if (gcj) {
      // 记录城市名（预置城市命中 → 供动态拉取该城风景区；非预置 → 仅用预设底库）
      scanState.userGcj = gcj;
      const presetKey = (CITY_PRESETS[q] || CITY_PRESETS[q.replace(/[市省自治区特别行政区地区县区镇街道办]/g, '')]) ? q.replace(/[市省自治区特别行政区地区县区镇街道办]/g, '') : q;
      scanState.cityName = CITY_PRESETS[presetKey] ? presetKey : null;
      picker.remove();
      runScan();
      return;
    }
    if (!frontendOk && !proxyOk) toast('解析服务暂不可用，请稍后再试');
    else toast('没找到这个地点，换个更具体的描述试试');
  }
  picker.querySelector('.city-go').addEventListener('click', applyAddress);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyAddress(); });

  picker.querySelectorAll('.city-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const city = btn.dataset.city;
      scanState.userGcj = CITY_PRESETS[city] || CITY_PRESETS.杭州;
      scanState.cityName = city;
      picker.remove();
      runScan();
    });
  });
  picker.querySelector('.city-close').addEventListener('click', () => picker.remove());
  input.focus();
}

function hideToast() {
  const el = app.querySelector('.z-toast');
  if (el) el.classList.remove('show');
}

/** 常用城市中心（GCJ-02，高德 geocode 实测）：定位失败兜底；输入城市名可直接命中，零网络依赖 */
const QUICK_CITIES = ['杭州', '北京', '上海', '广州', '深圳', '成都'];
const CITY_PRESETS = {
  杭州: { lng: 120.1552, lat: 30.2741 },
  北京: { lng: 116.407394, lat: 39.904211 },
  上海: { lng: 121.4737, lat: 31.2304 },
  广州: { lng: 113.2644, lat: 23.1291 },
  深圳: { lng: 114.0579, lat: 22.5431 },
  成都: { lng: 104.0665, lat: 30.5723 },
  南京: { lng: 118.796624, lat: 32.059344 },
  苏州: { lng: 120.585294, lat: 31.299758 },
  无锡: { lng: 120.311889, lat: 31.491064 },
  常州: { lng: 119.974092, lat: 31.811313 },
  徐州: { lng: 117.283752, lat: 34.204224 },
  扬州: { lng: 119.412834, lat: 32.394404 },
  镇江: { lng: 119.424441, lat: 32.188141 },
  泰州: { lng: 119.922883, lat: 32.456692 },
  南通: { lng: 120.894522, lat: 31.981269 },
  盐城: { lng: 120.16263, lat: 33.348176 },
  连云港: { lng: 119.221487, lat: 34.596639 },
  宿迁: { lng: 118.275228, lat: 33.963186 },
  淮安: { lng: 119.113166, lat: 33.551495 },
  宁波: { lng: 121.62454, lat: 29.860258 },
  温州: { lng: 120.699279, lat: 27.993849 },
  嘉兴: { lng: 120.755623, lat: 30.746814 },
  湖州: { lng: 120.086881, lat: 30.894178 },
  绍兴: { lng: 120.582886, lat: 30.051549 },
  金华: { lng: 119.647265, lat: 29.079195 },
  衢州: { lng: 118.859307, lat: 28.970229 },
  舟山: { lng: 122.207395, lat: 29.985578 },
  台州: { lng: 121.42079, lat: 28.655716 },
  丽水: { lng: 119.923249, lat: 28.467694 },
  合肥: { lng: 117.227267, lat: 31.820567 },
  芜湖: { lng: 118.433065, lat: 31.352614 },
  蚌埠: { lng: 117.388566, lat: 32.91682 },
  马鞍山: { lng: 118.50685, lat: 31.668765 },
  黄山: { lng: 118.337643, lat: 29.714886 },
  天津: { lng: 117.201509, lat: 39.085318 },
  重庆: { lng: 106.551787, lat: 29.56268 },
  武汉: { lng: 114.304569, lat: 30.593354 },
  长沙: { lng: 112.938882, lat: 28.228304 },
  郑州: { lng: 113.625351, lat: 34.746303 },
  西安: { lng: 108.939645, lat: 34.343207 },
  济南: { lng: 117.120128, lat: 36.652069 },
  青岛: { lng: 120.382665, lat: 36.066938 },
  福州: { lng: 119.296411, lat: 26.074286 },
  厦门: { lng: 118.08891, lat: 24.479627 },
  南昌: { lng: 115.857972, lat: 28.682976 },
  昆明: { lng: 102.833669, lat: 24.88149 },
  贵阳: { lng: 106.628201, lat: 26.646694 },
  南宁: { lng: 108.366407, lat: 22.8177 },
  海口: { lng: 110.200162, lat: 20.046316 },
  哈尔滨: { lng: 126.53505, lat: 45.802981 },
  长春: { lng: 125.323643, lat: 43.816996 },
  沈阳: { lng: 123.464675, lat: 41.677576 },
  石家庄: { lng: 114.514976, lat: 38.042007 },
  太原: { lng: 112.549656, lat: 37.870451 },
  呼和浩特: { lng: 111.748814, lat: 40.842127 },
  兰州: { lng: 103.834228, lat: 36.060798 },
  西宁: { lng: 101.758249, lat: 36.676027 },
  银川: { lng: 106.230977, lat: 38.487783 },
  乌鲁木齐: { lng: 87.616824, lat: 43.825377 },
  拉萨: { lng: 91.171924, lat: 29.653491 },
  洛阳: { lng: 112.453895, lat: 34.619702 },
  东莞: { lng: 113.751884, lat: 23.021016 },
  佛山: { lng: 113.121586, lat: 23.021351 },
  珠海: { lng: 113.576892, lat: 22.271644 },
  中山: { lng: 113.392517, lat: 22.517024 },
  惠州: { lng: 114.415587, lat: 23.112368 },
};

/** 城市名规范化后查预置表（去「市/省/自治区」等后缀） */
function matchPresetCity(q) {
  if (!q) return null;
  const norm = q.replace(/[市省自治区特别行政区地区县区镇街道办]/g, '');
  if (CITY_PRESETS[q]) return CITY_PRESETS[q];
  return CITY_PRESETS[norm] || null;
}

renderIdle();

// 断网全局反馈：离线时若正处定位态则转兜底页；恢复联网后回到定位态以便重试
window.addEventListener('offline', () => {
  if (app.dataset.state === 'idle' || app.dataset.state === 'degraded') renderOffline();
});
window.addEventListener('online', () => {
  if (app.dataset.state === 'degraded') renderIdle();
});
