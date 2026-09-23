/**
 * 走啊 · 核密度连续面热力渲染（规划书 10.9）
 * 全图覆盖版：以定位中心为原点，把 12 扇区真实指数按「角度加权插值」延展成
 * 覆盖整个视野的连续密度面（低清网格 → 放大平滑），叠加各代表锚点的 bloom 热斑；
 * 地图 move/zoom/resize 时用最新投影重绘，两图层不脱节。
 * 渲染规范（10.9）：
 *  - 连续密度面覆盖全视野，禁用孤立色块；重叠累积变亮
 *  - 感知均匀色阶：绿#16A34A→黄#FACC15→橙#FB923C→红#E8463A 连续插值（禁彩虹断层）
 *  - 双编码：密度=亮度+颜色同向；高拥堵核心 bloom 提亮
 *  - 全扇区无数据时不绘制任何色块（不伪造），仅显示空态提示
 *  - 图例为 DOM 组件（由 main.js 挂载），canvas 不再绘制
 */

/** 锚点 bloom 热斑的地理半径（米）：真实景区位置的路况色斑，随缩放自适应 */
const HEAT_RADIUS_M = 10000;
/** 区县聚合色斑的地理半径（米）：两阶段推荐·阶段1「人少的区县」块状热力 */
const REGION_RADIUS_M = 22000;
/** 方向场网格步长（CSS px）：低清绘制后放大，兼顾性能与平滑 */
const FIELD_CELL = 10;

// 感知均匀色阶关键帧（0,25,50,75,100）→ 绿→黄→橙→红
const HEAT_STOPS = [
  [22, 163, 74],   // #16A34A 绿 (0)
  [130, 214, 39],  // 绿黄过渡 (25)
  [250, 204, 21],  // #FACC15 黄 (50)
  [251, 146, 60],  // #FB923C 橙 (75)
  [232, 70, 58]    // #E8463A 红 (100)
];

export function heatColor(index) {
  const t = Math.min(100, Math.max(0, index));
  const pos = (t / 100) * (HEAT_STOPS.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(HEAT_STOPS.length - 1, lo + 1);
  const f = pos - lo;
  const c = HEAT_STOPS[lo].map((v, i) => Math.round(v + (HEAT_STOPS[hi][i] - v) * f));
  return c;
}

/** 地理米→像素：以 center 为参考（修复旧版用 sector[0].anchor 在无锚时退化的 bug） */
function pixelsPerMeter(amap, lng, lat, meters = 1000) {
  try {
    const p1 = amap.lngLatToContainer([lng, lat]);
    const dLng = (meters / 111320) / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    const p2 = amap.lngLatToContainer([lng + dLng, lat]);
    const px = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    return px > 0 ? px / meters : 0;
  } catch {
    return 0;
  }
}

export class HeatmapRenderer {
  /**
   * @param {HTMLCanvasElement} canvas 覆盖地图容器的画布（inset:0）
   * @param {Object} amap 高德地图实例（可后置注入 attachMap）
   */
  constructor(canvas, amap = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.amap = amap;
    this.sectors = null;
    this._center = null;       // 定位中心（GCJ-02）
    this._fieldCanvas = null;  // 低清方向场离屏画布
    this.resize();
  }

  /** DPR 高清适配：buffer 按像素比放大，绘制坐标用 CSS 像素 */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || window.innerWidth;
    const ch = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || window.innerHeight;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  attachMap(amap) {
    this.amap = amap;
    this.resize();
  }

  setData(sectors) {
    this.sectors = sectors;
  }

  /** 注入区县聚合结果：热力以「区县人少」块状色斑呈现（两阶段·阶段1） */
  setRegions(regions) {
    this.regions = regions || null;
  }

  setCenter(center) {
    this._center = center;
  }

  /**
   * 任意方位角的方向指数：对有效扇区做角度余弦平方加权插值。
   * @returns {{index:number, support:number}} support∈[0,1]：该方向被多少有效扇区支撑。
   *   支撑不足（如远离所有有数据扇区）→ 调用方用无数据淡底，不拉均值造假黄（7.3）。
   */
  static bearingSupport(valid, deg) {
    let wSum = 0, vSum = 0, wMax = 0;
    for (const v of valid) {
      let d = Math.abs(deg - v.deg);
      if (d > 180) d = 360 - d;
      if (d >= 90) continue;
      const w = Math.cos(d * Math.PI / 180) ** 2;
      wSum += w;
      vSum += w * v.index;
      if (w > wMax) wMax = w;
    }
    // support 归一化到「最强单扇区支撑=1」：12 扇区下相邻双扇区≈0.5，
    // 正好落在阈值上，保证有数据扇区之间的方向场连续覆盖全图
    if (wMax < 1e-6) return { index: 0, support: 0 };
    return { index: vSum / wSum, support: wSum / wMax };
  }

  /**
   * 可视化对比度拉伸：把 [50±Δ] 拉宽，强化绿/红两端反差提高可读性。
   * 只拉伸显示色阶，不改变指数排序与相对关系（不篡改数据，7.3）。
   */
  static stretch(idx) {
    const s = 1.6; // 拉伸系数
    return Math.max(0, Math.min(100, Math.round(50 + (idx - 50) * s)));
  }

  /**
   * 全图方向场：低清网格逐格算方向指数+径向强度 → ImageData → 放大平滑。
   * 强度按「地理距离」而非屏幕像素驱动（修复缩放脱节）：
   *   中心 0~12km 淡入 → 12~70km 满档 → 70~140km 渐弱 → 更远保持弱覆盖。
   * 这样地图缩放/平移时，色块的几何形状锚定在真实地理上，与底图严格同步；
   * 无锚点支撑的方位保持透明（7.3 不填假色），避免「整片同色」的误导观感。
   */
  renderField(CW, CH) {
    const sectors = this.sectors;
    const valid = sectors
      .map((s, i) => (!s || s.index == null) ? null : ({ index: s.index, deg: i * (360 / sectors.length) + (360 / sectors.length) / 2 }))
      .filter(Boolean);
    if (valid.length === 0) return false;

    // 中心像素（定位点投影；无地图时取画布中心）
    let cx = CW / 2, cy = CH / 2;
    if (this.amap && this._center) {
      const cp = this.amap.lngLatToContainer([this._center.lng, this._center.lat]);
      if (cp) { cx = cp.x; cy = cp.y; }
    }
    // 地理距离标尺：1km 对应的屏幕像素（无地图时退化为屏幕像素模式）
    const ppM = this.amap && this._center
      ? pixelsPerMeter(this.amap, this._center.lng, this._center.lat)
      : 0;
    const kmToPx = ppM * 1000;
    // 地理强度分段（km）——与缩放无关，色块随底图伸缩；
    // 收敛在「周边游主范围」（规划书 SCAN_RADIUS≈60km）内满色，更远快速变淡，
    // 避免「整片区域同色」的误导观感——颜色只说明真实可达的目的地带。
    const R_FADE_IN = 8, R_FULL = 60, R_FADE_END = 120;

    const gw = Math.max(2, Math.ceil(CW / FIELD_CELL));
    const gh = Math.max(2, Math.ceil(CH / FIELD_CELL));
    if (!this._fieldCanvas) this._fieldCanvas = document.createElement('canvas');
    const fc = this._fieldCanvas;
    if (fc.width !== gw || fc.height !== gh) { fc.width = gw; fc.height = gh; }
    const fctx = fc.getContext('2d');
    const img = fctx.createImageData(gw, gh);
    const data = img.data;

    for (let gy = 0; gy < gh; gy++) {
      const py = (gy + 0.5) * FIELD_CELL;
      for (let gx = 0; gx < gw; gx++) {
        const px = (gx + 0.5) * FIELD_CELL;
        const dx = px - cx, dy = py - cy;
        const dist = Math.hypot(dx, dy);
        const km = kmToPx > 1 ? dist / kmToPx : 0; // 地理距离（km）
        // 方位角（正北=0 顺时针；屏幕 y 向下）
        let deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
        const { index, support } = HeatmapRenderer.bearingSupport(valid, deg);
        // 径向强度：按地理距离分段（缩放无关），中心淡入、目的地带满档、外围渐弱
        let radial;
        if (km < R_FADE_IN) radial = 0.55 + 0.45 * (km / R_FADE_IN);
        else if (km < R_FULL) radial = 1;
        else if (km < R_FADE_END) radial = Math.max(0.22, 1 - (km - R_FULL) / (R_FADE_END - R_FULL) * 0.78);
        else radial = 0.22;
        // 支撑不足的方向：直接透明（无数据不填假色，7.3）；有数据方向如实着色 + 对比拉伸
        // 方向面是低饱和背景：真正的高辨识色斑由「锚点 bloom」承担（renderAnchors）
        if (support >= 0.5) {
          const [r, g, b] = heatColor(HeatmapRenderer.stretch(index));
          const alpha = Math.round(255 * Math.min(0.45, (0.14 + (index / 100) * 0.3) * radial));
          const o = (gy * gw + gx) * 4;
          data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = alpha;
        }
      }
    }
    fctx.putImageData(img, 0, 0);

    // 放大到全画布：smoothing 得到连续面；普通透明混合，保住深色底图不被提亮发灰
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fc, 0, 0, gw, gh, 0, 0, gw * FIELD_CELL, gh * FIELD_CELL);
    ctx.restore();
    return true;
  }

  /** 代表锚点 bloom 热斑（真实坐标投影，半径随缩放自适应） */
  renderAnchors(CW, CH) {
    const ctx = this.ctx;
    const sectors = this.sectors;
    if (!this.amap || !this._center) return 0;
    const ppM = pixelsPerMeter(this.amap, this._center.lng, this._center.lat);
    const blur = Math.max(24, HEAT_RADIUS_M * (ppM || 0.002));
    let drawn = 0;
    sectors.forEach(s => {
      if (!s || s.index == null) return;
      const an = s.anchor;
      if (!an || an.lon == null || an.lat == null) return;
      const p = this.amap.lngLatToContainer([an.lon, an.lat]);
      if (!p) return;
      const px = p.x, py = p.y;
      if (px < -blur * 2 || px > CW + blur * 2 || py < -blur * 2 || py > CH + blur * 2) return;
      const [r, g, b] = heatColor(s.index);
      const alpha = 0.3 + (s.index / 100) * 0.5; // 双编码：拥堵→亮
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      const loose = blur * 1.6; // 外围柔散层，与方向面连续
      const grad = ctx.createRadialGradient(px, py, 0, px, py, loose);
      grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
      grad.addColorStop(0.45, `rgba(${r},${g},${b},${alpha * 0.55})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, loose, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      drawn++;
    });
    return drawn;
  }

  /** 区县聚合色斑：以县内最顺代表锚点为中心的大色块（阶段1「哪里人少」），弱化孤立锚点小斑 */
  renderRegions(CW, CH) {
    const ctx = this.ctx;
    const regions = this.regions;
    if (!this.amap || !this._center || !regions || !regions.length) return 0;
    const ppM = pixelsPerMeter(this.amap, this._center.lng, this._center.lat);
    const blur = Math.max(40, REGION_RADIUS_M * (ppM || 0.002));
    let drawn = 0;
    regions.forEach(rg => {
      if (!rg || rg.index == null || !rg.rep || rg.rep.lon == null) return;
      const p = this.amap.lngLatToContainer([rg.rep.lon, rg.rep.lat]);
      if (!p) return;
      const px = p.x, py = p.y;
      if (px < -blur * 2 || px > CW + blur * 2 || py < -blur * 2 || py > CH + blur * 2) return;
      const [r, g, b] = heatColor(HeatmapRenderer.stretch(rg.index));
      const alpha = 0.32 + (rg.index / 100) * 0.42; // 双编码：人多→亮
      const loose = blur * 1.5;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      const grad = ctx.createRadialGradient(px, py, 0, px, py, loose);
      grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
      grad.addColorStop(0.55, `rgba(${r},${g},${b},${alpha * 0.55})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, loose, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      drawn++;
    });
    return drawn;
  }

  /**
   * 重绘：清屏 → 全图方向场 → 区县色斑（阶段1）→ 锚点 bloom。地图 move/zoom/resize 后调用。
   * @returns {number|null} 绘制核数量
   */
  render() {
    const ctx = this.ctx;
    const sectors = this.sectors;
    const CW = this.canvas.clientWidth;
    const CH = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CW, CH);
    if (!sectors || !sectors.some(s => s && s.index != null)) return null;
    if (!this.renderField(CW, CH)) return null;
    this.renderRegions(CW, CH);
    return this.renderAnchors(CW, CH);
  }
}
