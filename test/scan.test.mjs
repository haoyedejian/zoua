// 走啊 · scan.js 单元测试（步骤4/6 审计：8.4 算法正确性 + 两阶段推荐区县聚合）
// 运行: node test/scan.test.mjs
import { bearing, assignSector, scanSectors, aggregateRegions, kmDistance } from '../src/utils/scan.js';

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

const HZ = { lng: 120.1552, lat: 30.2741 };

// 1) bearing 基准
const north = bearing(HZ, { lng: 120.1552, lat: 30.35 });
assert(north >= -1 && north <= 1, `正北≈0 (got ${north.toFixed(2)})`);
const east = bearing(HZ, { lng: 120.32, lat: 30.2741 });
assert(east > 88 && east < 92, `正东≈90 (got ${east.toFixed(2)})`);

// 2) 扇区归组（12 扇区，每扇区 30°）
const mo = assignSector({ lon: 119.8644, lat: 30.5503 }, HZ, 12); // 莫干山：杭州西北
assert(Number.isInteger(mo.sectorIdx) && mo.sectorIdx >= 0 && mo.sectorIdx < 12, `莫干山归组 [0,12) (idx=${mo.sectorIdx}, deg=${mo.deg.toFixed(1)})`);

// 3) 全流程：注入可控 router，验证指数高=慢、指数低=快
const fakeRouter = async (o, d) => {
  // 对"东偏南"锚点给慢速（拥堵），其余给快速
  const deg = bearing(o, d);
  const slow = deg > 90 && deg < 180;
  return { avoid: { distance: slow ? 30000 : 30000, duration: slow ? 3600 : 1500 } };
};
const dests = [
  { id: 'a', name: '东慢', lon: 120.40, lat: 30.10 },  // 南
  { id: 'b', name: '北快', lon: 120.15, lat: 30.60 },  // 北
  { id: 'c', name: '西快', lon: 119.80, lat: 30.30 },  // 西
  { id: 'd', name: '东快2', lon: 120.40, lat: 30.25 }  // 东
];
const res = await scanSectors(HZ, dests, 12, fakeRouter);
assert(res.ok === true, `扫描 ok=true`);
const idxArr = res.sectors.map(s => s.index);
assert(idxArr.every(i => i == null || (i >= 0 && i <= 100)), `指数均在[0,100]`);
const slowDeg = bearing(HZ, { lng: 120.40, lat: 30.10 });   // 东慢（拥堵）
const fastDeg = bearing(HZ, { lng: 120.15, lat: 30.60 });   // 北快
const slowIdx = idxArr[Math.floor(slowDeg / 30) % 12];
const fastIdx = idxArr[Math.floor(fastDeg / 30) % 12];
assert(slowIdx != null && fastIdx != null, `慢/快方向均有数据 (slowDeg=${slowDeg.toFixed(0)}, fastDeg=${fastDeg.toFixed(0)})`);
if (slowIdx != null && fastIdx != null) {
  assert(slowIdx > fastIdx, `慢方向指数 > 快方向 (慢=${slowIdx}, 快=${fastIdx})`);
} else {
  fail++; console.error('  ✗ FAIL: 无法比较慢/快指数');
}

// 4) 全失败 → ok=false
const failRouter = async () => { throw new Error('boost'); };
const res2 = await scanSectors(HZ, dests, 12, failRouter);
assert(res2.ok === false, `全失败时 ok=false, mode='no-data'`);

// 5) kmDistance：已知两坐标距离量级正确（杭州→莫干山 ~65km 量级）
const sog = kmDistance(HZ, { lng: 119.8644, lat: 30.5503 }); // 莫干山
assert(sog > 30 && sog < 60, `杭州→莫干山直线约40km量级 (got ${sog.toFixed(1)})`);
assert(kmDistance(HZ, HZ) === 0, `同点距离为0`);

// 6) aggregateRegions：两阶段推荐·阶段1的区县聚合正确性
const fakeSectors = [
  // 余杭区：人少（低指数），两个扇区聚合 → 均值(10+20)/2=15
  { index: 10, distanceKm: 12.3, durationMin: 25, anchor: { county: '余杭区', adcode: '330110', lon: 119.98, lat: 30.42 },
    detail: [
      { name: '良渚古城遗址', county: '余杭区', lon: 119.98, lat: 30.42, km: 12.3, eta: 25 },
      { name: '西溪湿地', county: '余杭区', lon: 120.05, lat: 30.27, km: 6.2, eta: 15 }
    ] },
  { index: 20, distanceKm: 9.0, durationMin: 18, anchor: { county: '余杭区', adcode: '330110', lon: 120.05, lat: 30.27 },
    detail: [
      { name: '西溪湿地', county: '余杭区', lon: 120.05, lat: 30.27, km: 6.2, eta: 15 }, // 与上重复应去重
      { name: '良渚博物院', county: '余杭区', lon: 120.02, lat: 30.40, km: 11.0, eta: 22 }
    ] },
  // 富阳区：人多（高指数）
  { index: 80, distanceKm: 30.5, durationMin: 55, anchor: { county: '富阳区', adcode: '330111', lon: 119.95, lat: 30.05 },
    detail: [
      { name: '富春江', county: '富阳区', lon: 119.95, lat: 30.05, km: 30.5, eta: 55 }
    ] }
];
const regions = aggregateRegions(fakeSectors);
assert(regions.length === 2, `聚合成2个区县 (got ${regions.length})`);
assert(regions[0].county === '余杭区', `排序后余杭区在前（人少先排，got ${regions[0].county}）`);
const yuhang = regions[0];
assert(yuhang.index === 15, `余杭区指数为两扇区均值15 (got ${yuhang.index})`);
assert(yuhang.spots.length === 3, `区内景点去重后3个（got ${yuhang.spots.length}）`);
assert(yuhang.spotNames.includes('西溪湿地') && yuhang.spotNames.includes('良渚古城遗址'), `spotNames含代表景点`);
assert(yuhang.km === 12.3, `区县距取代表锚点公里数12.3 (got ${yuhang.km})`);
assert(yuhang.rep && yuhang.rep.county === '余杭区', `代表锚点为县内最顺锚点`);
const fuyang = regions[1];
assert(fuyang.index === 80 && fuyang.county === '富阳区', `富阳区指数80、排后`);
// 区内景点按车程由近及远排序：西溪6.2 < 良渚博物院11 < 良渚古城12.3
assert(yuhang.spots[0].name === '西溪湿地', `区内景点按车程由近及远（首=${yuhang.spots[0].name}）`);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);