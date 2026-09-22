/**
 * 走啊 · 雷达扫描动画（扫描态，Canvas）
 * 规划书 10.12.4：扇区逐区点亮，每扇区时长 = 该扇区指数/100 × 800ms（越堵点亮越慢）；
 * 颜色 = 指数经 10.9 感知均匀色阶映射（绿#16A34A→黄#FACC15→橙#FB923C→红#E8463A）。
 * 数据诚实：颜色/时长全部由真实（或演示明示的模拟）指数驱动，无随机表演。
 */

import { sectorBearings } from '../utils/sector.js';

const HEAT_SCALE = [
  [22, 163, 74],   // 绿 #16A34A
  [250, 204, 21],  // 黄 #FACC15
  [251, 146, 60],  // 橙 #FB923C
  [232, 70, 58]    // 红 #E8463A
];

/** 指数 0~100 → 四色连续插值 */
export function heatColor(index) {
  const t = Math.min(100, Math.max(0, index)) / 100 * 3; // 0~3
  const seg = Math.min(2, Math.floor(t));
  const f = t - seg;
  const c = HEAT_SCALE[seg].map((v, i) =>
    Math.round(v + (HEAT_SCALE[seg + 1][i] - v) * f)
  );
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export class RadarScanner {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number} k 扇区数
   */
  constructor(canvas, k = 12) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.k = k;
    this.bearings = sectorBearings(k);
    this.indices = [];       // 每扇区指数（由扫描过程注入）
    this.activated = 0;      // 已点亮的扇区数
    this.timers = [];
  }

  /** 按指数逐区点亮（动画时长 = 指数/100 × 800ms × durationScale，逐区连续） */
  start(indices, { onComplete, durationScale = 1 }) {
    this.indices = indices;
    this.activated = 0;
    this.stop();
    this.drawBase();
    let cursor = 0; // 前序扇区累计时长
    indices.forEach((idx, i) => {
      const delay = cursor;
      cursor += (idx / 100) * 800 * durationScale;
      const t = setTimeout(() => {
        this.lightSector(i, idx);
        this.activated++;
        if (this.activated === this.k && onComplete) onComplete();
      }, delay);
      this.timers.push(t);
    });
  }

  /** 点亮单个扇区（60° 扇形） */
  lightSector(i, idx) {
    const ctx = this.ctx;
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    const r = Math.min(cx, cy) * 0.92;
    const color = heatColor(idx);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, (-this.bearings[i] - 15) * Math.PI / 180, (-this.bearings[i] + 15) * Math.PI / 180);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.restore();
  }

  /** 绘制底圈 */
  drawBase() {
    const ctx = this.ctx;
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    const r = Math.min(cx, cy) * 0.92;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}
