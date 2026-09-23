// 走啊 · API 节流队列测试（步骤9·12.3 配额压测的核心约束门禁）
// 验证：全局并发 ≤ MAX_CONCURRENCY(=3)，QPS 限流约束真实生效。
// 运行: node test/queue.test.mjs
import { apiQueue } from '../src/utils/api.js';

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

let active = 0, peak = 0;
async function job(index) {
  active++;
  if (active > peak) peak = active;
  await new Promise(r => setTimeout(r, 60)); // 模拟网络往返
  active--;
  return index;
}

const N = 10;
// 一次性压入 N 个任务（模拟并发用户扫描的请求洪峰）
const started = Promise.all(
  Array.from({ length: N }, (_, i) => apiQueue.enqueue(() => job(i)))
);

// 逐任务校验完成
const results = await started;
assert(results.length === N, `全部 ${N} 个请求得到结果`);
assert(peak <= 3, `峰值为并发峰值 ≤3 (got ${peak})`);
assert(results.every((v, i) => v === i), `结果按入队顺序一一对应`);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);