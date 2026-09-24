/**
 * 走啊 · 高德底图主舞台封装（规划书 10.2 地图主舞台）
 * 职责：异步加载 AMap JS API → 初始化底图 → 提供 用户蓝点 / 推荐 pin / 居中聚焦。
 * Key 安全（9.3）：JS key 由 dev-server 注入为 window.__AMAP_JS_KEY__，静态托管下回退
 *                 /api/amap/jskey 下发；均不入 git、不落静态源码。
 */

const LOADER_URL = 'https://webapi.amap.com/loader.js';

let loadPromise = null;

/**
 * Key 获取顺序：① dev-server 注入的 window.__AMAP_JS_KEY__（本地）
 *              ② 回退 /api/amap/jskey（Vercel 等静态托管，见 serverless/api/amap/jskey.js）
 */
async function resolveJsKey() {
  if (window.__AMAP_JS_KEY__) return window.__AMAP_JS_KEY__;
  try {
    const resp = await fetch('/api/amap/jskey');
    if (!resp.ok) return '';
    const data = await resp.json();
    return data && data.key ? data.key : '';
  } catch {
    return '';
  }
}

function loadAMap() {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (loadPromise) return loadPromise;
  loadPromise = resolveJsKey().then((key) => new Promise((resolve, reject) => {
    if (!key) {
      resolve({ missingKey: true });
      return;
    }
    const s = document.createElement('script');
    s.src = LOADER_URL;
    s.onload = () => {
      window.AMapLoader.load({
        key,
        version: '2.0',
        plugins: ['AMap.Scale', 'AMap.ToolBar', 'AMap.Geocoder']
      }).then(() => resolve(window.AMap)).catch(reject);
    };
    s.onerror = () => reject(new Error('LOADER_FAILED'));
    document.head.appendChild(s);
  }));
  return loadPromise;
}

/** 深色底图样式（夜间/早间出发情境，10.3 parse）：内置 dark 深色，让热力面清晰可辨 */
export function darkStyle() {
  return 'amap://styles/dark';
}

export class ZouaMap {
  constructor(container) {
    this.container = container;
    this.amap = null;
    this.dot = null;      // 用户蓝点
    this.pins = [];       // 推荐 pin
    this.ready = false;
  }

  /** 初始化底图并挂到容器 */
  async init(center) {
    const AMap = await loadAMap();
    if (!AMap || AMap.missingKey) {
      // 无 JS key 时降级：容器保留给热力画布，不抛错（导出层由调用方提示）
      return false;
    }
    this.amap = new AMap.Map(this.container, {
      zoom: 11,
      center: center ? [center.lng, center.lat] : undefined,
      mapStyle: darkStyle(),
      showLabel: true,
      resizeEnable: true
    });
    this.ready = true;
    return true;
  }

  /** 画用户定位蓝点（高德标准蓝点，17.1 仅本次采集展示） */
  setUserDot(lnglat) {
    if (!this.amap || !lnglat) return;
    const AMap = window.AMap;
    if (this.dot) { this.dot.setPosition(lnglat); return; }
    // 自定义蓝点：白圈 + 蓝圆心（覆盖默认，保证沟通范围提示一致）
    this.dot = new AMap.Marker({
      position: lnglat,
      anchor: 'center',
      content: '<div class="user-dot"></div>',
      zIndex: 40
    });
    this.amap.add(this.dot);
    this.amap.setCenter(lnglat);
    this.amap.setZoom(10);
  }

  /** 打推荐 pin（编号 badge + 景区名·距离标签，10.12.3 / 设计稿） */
  addPin(lnglat, { index, name, km, sector, rank }) {
    if (!this.amap) return;
    const cont = document.createElement('div');
    cont.className = 'rec-pin';
    cont.dataset.sector = sector;
    cont.dataset.rank = rank;
    const label = name ? `${name}${km != null ? ` · ${km}km` : ''}` : '';
    cont.innerHTML = `
      <span class="pin-badge">${rank + 1}</span>
      ${label ? `<span class="pin-label">${label}</span>` : ''}`;
    if (name) cont.title = `${name}${index != null ? ` · 顺畅度 ${index}/100` : ''}`;
    const m = new window.AMap.Marker({
      position: lnglat,
      anchor: 'bottom-center',
      content: cont,
      zIndex: 30 - rank
    });
    this.amap.add(m);
    this.pins.push({ marker: m, el: cont, sector, rank, index });
    return m;
  }

  /** 高亮指定 pin（卡片联动，10.12） */
  highlightPin(sector) {
    this.pins.forEach(p => {
      const on = p.sector === sector;
      p.el.classList.toggle('active', on);
    });
  }

  /** 清除所有推荐 pin */
  clearPins() {
    if (!this.amap) return;
    this.pins.forEach(p => this.amap.remove(p.marker));
    this.pins = [];
  }

  /** 相机飞到某个点（结果态聚焦，10.12.4 flight 300ms） */
  focus(lnglat, zoom = 11) {
    if (!this.amap) return;
    this.amap.setZoomAndCenter(zoom, lnglat, false, 300);
  }
}