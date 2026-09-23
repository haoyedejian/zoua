/**
 * 走啊 · 扇区反向扫描引擎（规划书 8.4 路线级代理算法 / 10.6）
 * 输入：定位点 + 预置景点锚点（GCJ-02）；输出：N 个扇区的各向真实拥塞指数[0,100]。
 * 方法：对落在各扇区的锚点调驾车路径规划（strategy=12 躲避拥堵），
 *       用 distance/duration 反演每锚点平均速率，相对全域中位速率归一为拥塞指数。
 * 真实数据驱动；锚点缺失/请求失败只降权，绝不填假指数（7.3）。
 * 周边短途口径：仅统计距定位点合理的周边锚点（默认 100km），跨省远景不参与（8.4 防偏差）。
 */

import { fetchRoute } from './api.js';

const DEFAULT_MAX_KM = 100; // 周边短途半径（8.4：防跨省远景锚点误导扇区相对指数）

/** 简化球面近似距离（km，GCJ-02 下精度足够做半径过滤） */
export function kmDistance(a, b) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 方位角 0..360（正北=0，顺时针） */
export function bearing(origin, target) {
  const toRad = Math.PI / 180;
  const φ1 = origin.lat * toRad;
  const φ2 = target.lat * toRad;
  const Δλ = (target.lng - origin.lng) * toRad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return deg;
}

/** 锚点归类：返回 { sectorIndex, anchor }，按 ISO 12-扇区方位归组 */
export function assignSector(anchor, origin, sectors = 12) {
  const deg = bearing(origin, { lng: anchor.lon, lat: anchor.lat });
  const sectorIdx = Math.floor(((deg + 360) % 360) / (360 / sectors)) % sectors;
  return { sectorIdx, deg };
}

/**
 * 扫描核心：对每个扇区取锚点求平均速率，反演扇区相对指数。
 * @param {{lng:number,lat:number}} origin 定位（GCJ-02）
 * @param {Array} destinations 预置景点锚点 [{lon,lat,name,county}]
 * @param {number} sectors 扇区数（默认12）
 * @param {(o,d)=>Promise<{avoid:{distance,duration}}>} router 依赖注入，便于测试
 * @param {number} maxKm 周边短途半径（默认100km，跨省远景排除）
 * @returns {Promise<{ok:boolean, mode:string, sectors:Array<{index,anchorCount,speed}>, message?:string}>}
 */
export async function scanSectors(origin, destinations, sectors = 12, router = fetchRoute, maxKm = DEFAULT_MAX_KM) {
  // 1) 归组锚点（周边短途过滤：跨省远景不参与，防 8.4 相对指数偏差）
  const buckets = Array.from({ length: sectors }, () => []);
  for (const d of destinations) {
    if (d.lon == null || d.lat == null) continue;
    if (kmDistance(origin, { lng: d.lon, lat: d.lat }) > maxKm) continue;
    const { sectorIdx } = assignSector(d, origin, sectors);
    buckets[sectorIdx].push(d);
  }

  // 2) 逐扇区并行取路径规划（QPS 由 api 队列锁 ≤3）
  const sectorResults = await Promise.all(
    buckets.map(async (anchors) => {
      const speeds = [];
      const detailed = []; // 该扇区每个成功规划的锚点（区县详情·景点列表数据源）
      let okCount = 0;
      let rep = null; // 代表锚点（首个规划成功的）：带真实 distance/duration，供 pin 标签与卡片
      for (const a of anchors.slice(0, 8)) { // 每扇区最多采 8 锚点（提升区县覆盖）
        try {
          const r = await router(origin, { lng: a.lon, lat: a.lat });
          const path = r && r.avoid;
          if (path && path.duration > 0 && path.distance > 0) {
            const speed = (path.distance / 1000) / (path.duration / 3600); // km/h
            speeds.push(speed);
            okCount++;
            detailed.push({
              anchor: a,
              distanceKm: Math.round(path.distance / 100) / 10,       // 保留1位小数
              durationMin: Math.round(path.duration / 60)
            });
            if (!rep) rep = { anchor: a, distance: path.distance, duration: path.duration };
          }
        } catch {
          /* 单锚点失败降权，不中断 */
        }
      }
      if (speeds.length === 0) return { index: null, anchorCount: 0, speed: null, rep: null, detailed: [] };
      return { index: null, anchorCount: okCount, speed: speeds.reduce((a, b) => a + b, 0) / speeds.length, rep, detailed };
    })
  );

  // 3) 全域中位速率为基准（只用有数据扇区）
  const validSpeeds = sectorResults.map(s => s.speed).filter(s => s != null);
  if (validSpeeds.length === 0) {
    return { ok: false, mode: 'no-data', sectors: sectorResults.map(() => ({ index: 0, anchorCount: 0, speed: null })), message: '所有方向均无有效路径数据' };
  }
  const sorted = [...validSpeeds].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  // 4) 相对中位归一为指数 [0,100]（越高越堵）；并附该扇区代表锚点（供地图 pin 定位）
  const out = sectorResults.map((s, i) => {
    if (s.speed == null) return { index: null, anchorCount: 0, speed: null, anchor: null, distanceKm: null, durationMin: null, detail: [] };
    const ratio = median > 0 ? s.speed / median : 1;
    // ratio∈[0.5,1.5] 映射到 [100,0]；堵(慢)→高指数
    let idx = Math.round((1.5 - Math.min(1.5, Math.max(0.5, ratio))) / 1.0 * 100);
    idx = Math.max(0, Math.min(100, idx));
    // 代表锚点（首个规划成功者）+ 其真实驾车距离/时长（10.11 距离/预计通行时间）
    const rep = s.rep || null;
    return {
      index: idx,
      anchorCount: s.anchorCount,
      speed: s.speed,
      anchor: rep ? rep.anchor : (buckets[i][0] || null),
      distanceKm: rep ? Math.round(rep.distance / 100) / 10 : null, // 保留1位小数
      durationMin: rep ? Math.round(rep.duration / 60) : null,
      detail: s.detailed.map(d => ({
        name: d.anchor.name || '',
        county: d.anchor.county || '',
        lon: d.anchor.lon,
        lat: d.anchor.lat,
        km: d.distanceKm,
        eta: d.durationMin
      }))
    };
  });

  return { ok: true, mode: 'real', sectors: out };
}

/**
 * 区县聚合（两阶段推荐·阶段1）：把「扇区×锚点」结果按行政区(区/县)聚合成区县人少指数。
 * - 区县指数 = 该县全部有数据锚点指数的均值（越低=路越顺=人越少）
 * - 每个区县带代表锚点（去该县最顺的锚点，用于 pin 与车程/距离展示）+ 区内景点名列表
 * @param {Array} sectors scanSectors 输出（含 index/anchor/distanceKm/durationMin）
 * @returns {Array<{county, adcode, index, anchors:Array, spotNames:Array, rep, km, eta}>} 按指数升序（人少优先）
 */
export function aggregateRegions(sectors) {
  const map = new Map();
  sectors.forEach(s => {
    if (!s || s.index == null || !s.anchor || !s.anchor.county) return;
    const county = s.anchor.county;
    let rg = map.get(county);
    if (!rg) {
      rg = { county, adcode: s.anchor.adcode || '', sum: 0, count: 0, rep: null, bestIdx: Infinity, spots: [], seen: new Set() };
      map.set(county, rg);
    }
    rg.sum += s.index;
    rg.count++;
    // 区内景点明细（逐锚点真实车程；去重）
    (s.detail || []).forEach(d => {
      if (d.lon == null || !d.name) return;
      const key = d.name + '|' + d.lon + '|' + d.lat;
      if (rg.seen.has(key)) return;
      rg.seen.add(key);
      rg.spots.push({ name: d.name, county, lon: d.lon, lat: d.lat, km: d.km, eta: d.eta });
    });
    if (s.index < rg.bestIdx) {
      rg.bestIdx = s.index;
      rg.rep = { anchor: s.anchor, km: s.distanceKm, eta: s.durationMin };
    }
  });
  const list = [...map.values()].map(rg => {
    const index = Math.round(rg.sum / rg.count);
    // 该县距离/车程取「最顺代表锚点」的口径；区内景点按车程由近及远展示
    rg.spots.sort((a, b) => (a.eta ?? 1e9) - (b.eta ?? 1e9));
    return {
      county: rg.county,
      adcode: rg.adcode,
      index,
      count: rg.count,
      spots: rg.spots.slice(0, 6),
      spotNames: rg.spots.slice(0, 4).map(sp => sp.name),
      rep: rg.rep ? rg.rep.anchor : null,
      km: rg.rep ? rg.rep.km : null,
      eta: rg.rep ? rg.rep.eta : null
    };
  });
  return list.sort((a, b) => a.index - b.index);
}