/**
 * 走啊 · 动态景区 POI 代理（两阶段推荐·阶段1数据源）
 * Vercel Function：GET /api/amap/pois?city=杭州&page=1
 * v5 place/text：city（出发城市名）+ keywords（风景区词）+ types(110200) 拉取高质量景区，
 * 前端用 adname 字段做区县聚合；替代全量预置底库。配额纪律见 9.2。
 */

import { guardOrigin } from './_guard.js';

const AMAP_KEY = process.env.AMAP_WEB_KEY;

export default async function handler(req, res) {
  if (!guardOrigin(req, res)) return;
  const { city, keywords, page = '1' } = req.query;
  if (!AMAP_KEY) {
    res.status(500).json({ status: 0, info: 'SERVER_KEY_MISSING' });
    return;
  }
  const params = new URLSearchParams({
    key: AMAP_KEY,
    types: '110200', // 风景名胜
    page_size: '25',
    page: String(Math.max(1, parseInt(page, 10) || 1)),
    output: 'JSON'
  });
  if (city) { params.set('city', city); params.set('city_limit', 'true'); }
  if (keywords) params.set('keywords', keywords);

  try {
    const resp = await fetch(`https://restapi.amap.com/v5/place/text?${params.toString()}`);
    const data = await resp.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: 0, info: 'PROXY_ERROR' });
  }
}