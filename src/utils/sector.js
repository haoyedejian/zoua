/**
 * 走啊 · 扇区几何工具（规划书 8.4 路线级代理 / 第 8 章主算法共用）
 * 生成 K 个扇区、按方位角归类、距离衰减权重。
 */

/** 距离衰减权重 w(d) = 1/(1+d/20)（远处拥堵与我关系小） */
export function distanceWeight(distanceKm) {
  return 1 / (1 + distanceKm / 20);
}

/**
 * 生成扇区中轴线方位角（度）
 * @param {number} k 扇区数（默认 12，每 30°）
 * @returns {number[]}
 */
export function sectorBearings(k = 12) {
  const step = 360 / k;
  return Array.from({ length: k }, (_, i) => i * step);
}

/**
 * 计算两点方位角（0~360，正北为 0，顺时针）
 * @param {{lng:number, lat:number}} from
 * @param {{lng:number, lat:number}} to
 */
export function bearing(from, to) {
  const rad = Math.PI / 180;
  const dLng = (to.lng - from.lng) * rad;
  const lat1 = from.lat * rad;
  const lat2 = to.lat * rad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/**
 * 目的地方位角 → 扇区编号
 * @param {number} deg 方位角
 * @param {number} k
 */
export function sectorIndexOf(deg, k = 12) {
  return Math.floor(((deg + 360 / k / 2) % 360) / (360 / k)) % k;
}

/**
 * 计算两点球面距离（km，Haversine）
 */
export function haversineKm(from, to) {
  const rad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * rad;
  const dLng = (to.lng - from.lng) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
