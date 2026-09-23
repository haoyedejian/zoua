// 走啊 · 多城市场景模拟测试（步骤9 · 12.2 特色城市回归的免配额替身）
// 用注入 router 覆盖三类场景，验证真实数据链路与降级，不消耗高德配额。
// 运行: node test/scenario.test.mjs

import { scanSectors, assignSector, bearing } from '../src/utils/scan.js';

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

const HZ = { lng: 120.1552, lat: 30.2741 };

// 绕中心 8 个方向的锚点（距中心约 0.2°≈22km，在 100km 半径内）
const DIST = 0.2;
const dests = [
  { id: 'n', name: '北', county: 'A县', lon: HZ.lng, lat: HZ.lat + DIST },
  { id: 'ne', name: '东北', county: 'A县', lon: HZ.lng + DIST * 0.707, lat: HZ.lat + DIST * 0.707 },
  { id: 'e', name: '东', county: 'B区', lon: HZ.lng + DIST, lat: HZ.lat },
  { id: 'se', name: '东南', county: 'B区', lon: HZ.lng + DIST * 0.707, lat: HZ.lat - DIST * 0.707 },
  { id: 's', name: '南', county: 'C县', lon: HZ.lng, lat: HZ.lat - DIST },
  { id: 'sw', name: '西南', county: 'C县', lon: HZ.lng - DIST * 0.707, lat: HZ.lat - DIST * 0.707 },
  { id: 'w', name: '西', county: 'D区', lon: HZ.lng - DIST, lat: HZ.lat },
  { id: 'nw', name: '西北', county: 'D区', lon: HZ.lng - DIST * 0.707, lat: HZ.lat + DIST * 0.707 }
];

// ---- 场景1：堵城 vs 空城（绝对车速真实反映拥堵水平）----
const DISTANCE_M = 30000; // 30 km
function makeRouter(durationSec) {
  return async () => ({ avoid: { distance: DISTANCE_M, duration: durationSec } });
}
const jamRouter = makeRouter(7200);   // 30km/7200s = 15 km/h → 堵
const freeRouter = makeRouter(1200);  // 30km/1200s = 90 km/h → 空

async function medianSpeed(router) {
  const r = await scanSectors(HZ, dests, 8, router);
  const speeds = r.sectors.map(s => s.speed).filter(s => s != null);
  const s = [...speeds].sort((a, b) => a - b);
  return (s[Math.floor(s.length / 2)] + s[Math.ceil(s.length / 2) - 1]) / 2;
}
const jamMed = await medianSpeed(jamRouter);
const freeMed = await medianSpeed(freeRouter);
assert(jamMed < 40, `堵城中位车速低（实测 ${jamMed.toFixed(1)} km/h，预期≈15）`);
assert(freeMed > 60, `空城中位车速高（实测 ${freeMed.toFixed(1)} km/h，预期≈90）`);
assert(jamMed < freeMed, `堵城车速 < 空城车速（真实拥堵水平可区分）`);

// ---- 场景2：方向差异化 → 最堵方向指数高 ----
// 给“正东”方向注入明显拥堵，其余畅通
const diffRouter = async (o, d) => {
  const deg = bearing(o, d);
  const east = deg > 80 && deg < 100;
  return { avoid: { distance: DISTANCE_M, duration: east ? 9000 : 1200 } };
};
const rDiff = await scanSectors(HZ, dests, 8, diffRouter);
const dirIdx = (deg) => {
  const s = rDiff.sectors[assignSector(dests.find(x => Math.abs(bearing(HZ, { lng: x.lon, lat: x.lat }) - deg) < 10), HZ, 8).sectorIdx];
  return s.index;
};
const eastIdx = dirIdx(90);
const westIdx = dirIdx(270);
assert(eastIdx != null && westIdx != null, `东/西方向均有指数（东=${eastIdx}, 西=${westIdx}）`);
assert(eastIdx > westIdx, `最堵的东部指数(${eastIdx}) > 畅通的西部指数(${westIdx})`);

// ---- 场景3：跨城远景过滤（maxKm 半径之外不参与，防相对指数偏差）----
// 全部锚点移出 100km 半径 → 无有效数据 → 显式降级 no-data
const farDests = dests.map(d => ({ ...d, lon: HZ.lng + 2.0, lat: HZ.lat + 2.0 })); // ~300km 外
const rFar = await scanSectors(HZ, farDests, 8, freeRouter);
assert(rFar.ok === false && rFar.mode === 'no-data', `跨城远景全部过滤 → ok=false, mode='no-data'`);

// 部分跨城（一半在半径内，一半在外）→ 仅近处参与，扇区计数正确
const halfFar = dests.map((d, i) => i < 4 ? d : { ...d, lon: HZ.lng + 2.5, lat: HZ.lat + 2.5 });
const pHalf = await scanSectors(HZ, halfFar, 8, freeRouter);
const okCounts = pHalf.sectors.filter(s => s && s.speed != null).length;
assert(okCounts >= 3 && okCounts < 8, `近处锚点参与、远处被最大半径过滤（有数据扇区=${okCounts}，近处4点扇区可能有界点合并，应在[3,8]）`);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);