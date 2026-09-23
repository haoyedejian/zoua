/**
 * 走啊 · 核密度连续面热力渲染（规划书 10.9）
 * 当前步骤4：无高德 SDK 底图，绘制在覆盖地图容器的 Canvas 上（可独立验证；
 * 步骤5 SDK 接入后改为叠加在地图图层）。
 * 渲染规范（10.9）：
 *  - 感知均匀色阶：绿#16A34A→黄#FACC15→橙#FB923C→红#E8463A 连续插值（禁彩虹断层）
 *  - 核密度累计：多层 radial-gradient + screen 混合实现密度堆积，避免孤立色块
 *  - 双编码：亮度(alpha)+颜色(hue)同向，拥堵方向既亮又红
 *  - 常驻图例：右上角 0-100 渐变条
 *  - 全扇区无数据时不绘制任何色块（不伪造），仅显示空态提示
 */

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

export class HeatmapRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {({lng,lat}|null)[]} anchorPositions 扇区锚点位置（GCJ-02，长度=扇区数）
   * @param {({lng,lat}|null)} center 中心点（扇区0朝正北，顺时针）
   */
  constructor(canvas, center, anchorPositions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.center = center;
    this.anchors = anchorPositions;
  }

  /**
   * 渲染连续热力面
   * @param {({index:number|null, anchorCount:number}|null)[]} sectors
   */
  render(sectors) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;

    const hasData = sectors.some(s => s && s.index != null);
    if (!hasData) return null;

    // 中心辐射定位每个扇区锚点（此处以扇区中线方向 + 固定半径衰减定位，SDK 接入后改为真坐标投影）
    let drawn = 0;
    sectors.forEach((s, i) => {
      if (!s || s.index == null) return;
      const [r, g, b] = heatColor(s.index);
      const alpha = 0.25 + (s.index / 100) * 0.55; // 双编码：拥堵→亮
      // 扇区中线方向（正北=0 顺时针）
      const deg = i * (360 / sectors.length) + (360 / sectors.length) / 2;
      const rad = (deg - 90) * Math.PI / 180; // Canvas 0°=右 转成 0°=上
      const dist = Math.min(W, H) * 0.34;
      const px = cx + Math.cos(rad) * dist;
      const py = cy + Math.sin(rad) * dist;
      const blur = Math.min(W, H) * 0.22;

      // 多层 radial-gradient 核 + screen 混合叠加（10.9 核密度累计）
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const grad = ctx.createRadialGradient(px, py, 0, px, py, blur);
      grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
      grad.addColorStop(0.55, `rgba(${r},${g},${b},${alpha * 0.5})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, blur, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      drawn++;
    });

    this.drawLegend();
    return drawn;
  }

  drawLegend() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const lw = 96, lh = 8, left = W - lw - 14, top = 14;
    const grad = ctx.createLinearGradient(left, 0, left + lw, 0);
    for (let i = 0; i < HEAT_STOPS.length; i++) {
      const c = HEAT_STOPS[i];
      grad.addColorStop(i / (HEAT_STOPS.length - 1), `rgb(${c[0]},${c[1]},${c[2]})`);
    }
    ctx.save();
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(left, top, lw, lh, 4);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('0 通畅', left, top + lh + 13);
    ctx.textAlign = 'right';
    ctx.fillText('100 拥堵', left + lw, top + lh + 13);
    ctx.restore();
  }
}