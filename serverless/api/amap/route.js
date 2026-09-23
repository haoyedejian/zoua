/**
 * 走啊 · 路线级代理（数据主路线，规划书 8.4 / 12.4-第2项）
 * Vercel Function：GET /api/amap/route
 * 服务端持有 AMAP_WEB_KEY（环境变量），转发高德驾车路径规划。
 * 双策略：strategy=12（躲避拥堵，主口径）+ strategy=2（常规最快，基准对照）
 * 安全：Key 绝不出现在前端；调用方只接受 origin/destination 坐标。
 */

import { guardOrigin } from './_guard.js';

const AMAP_KEY = process.env.AMAP_WEB_KEY;
const AMAP_DRIVING_URL = 'https://restapi.amap.com/v3/direction/driving';

const STRATEGIES = { AVOID_TRAFFIC: 12, FASTEST: 2 };

/**
 * 单策略路径规划
 * @returns {{status:number, distance:number|null, duration:number|null, info:string}}
 */
async function driving(origin, destination, strategy) {
  if (!AMAP_KEY) {
    return { status: 0, distance: null, duration: null, info: 'SERVER_KEY_MISSING' };
  }
  const params = new URLSearchParams({
    key: AMAP_KEY,
    origin,
    destination,
    strategy: String(strategy),
    extensions: 'base',
    output: 'JSON'
  });
  const resp = await fetch(`${AMAP_DRIVING_URL}?${params.toString()}`);
  const data = await resp.json();
  if (data.status !== '1') {
    return { status: 0, distance: null, duration: null, info: data.info || 'AMAP_ERROR' };
  }
  // 取最优（第一条）路径
  const path = data.route?.paths?.[0];
  return {
    status: 1,
    distance: path ? Number(path.distance) : null, // 米
    duration: path ? Number(path.duration) : null, // 秒
    info: 'OK'
  };
}

export default async function handler(req, res) {
  if (!guardOrigin(req, res)) return;
  // 仅允许 GET + 坐标入参
  if (req.method !== 'GET') {
    res.status(405).json({ status: 0, info: 'METHOD_NOT_ALLOWED' });
    return;
  }
  const { origin, destination } = req.query;
  if (!origin || !destination) {
    res.status(400).json({ status: 0, info: 'MISSING_ORIGIN_OR_DESTINATION' });
    return;
  }

  try {
    const [avoid, fastest] = await Promise.all([
      driving(origin, destination, STRATEGIES.AVOID_TRAFFIC),
      driving(origin, destination, STRATEGIES.FASTEST)
    ]);
    res.setHeader('Cache-Control', 'no-store'); // 路况动态，不缓存（前端 TTL 5min 由业务层控制）
    res.status(200).json({ status: 1, avoid, fastest });
  } catch (err) {
    res.status(500).json({ status: 0, info: 'PROXY_ERROR' });
  }
}
