// 走啊 · scan.js 单元测试（步骤4 审计：8.4 算法正确性）
// 运行: node test/scan.test.mjs
import { bearing, assignSector, scanSectors } from '../src/utils/scan.js';

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

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);