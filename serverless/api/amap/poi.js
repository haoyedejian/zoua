/**
 * 走啊 · POI 代理（规划书 9.7 单一数据源）
 * Vercel Function：GET /api/amap/poi
 * 目的地卡片信息（名称/评分/营业时间/门票等），仅用户点击卡片时按需查询，
 * 前端按 poiid 本地缓存复用（配额纪律 9.2）。
 */

import { guardOrigin } from './_guard.js';

const AMAP_KEY = process.env.AMAP_WEB_KEY;
const AMAP_POI_URL = 'https://restapi.amap.com/v5/place/detail';

export default async function handler(req, res) {
  if (!guardOrigin(req, res)) return;
  const { poiid } = req.query;
  if (!poiid) {
    res.status(400).json({ status: 0, info: 'MISSING_POIID' });
    return;
  }
  if (!AMAP_KEY) {
    res.status(500).json({ status: 0, info: 'SERVER_KEY_MISSING' });
    return;
  }
  const params = new URLSearchParams({
    key: AMAP_KEY,
    poiid,
    output: 'JSON'
  });
  try {
    const resp = await fetch(`${AMAP_POI_URL}?${params.toString()}`);
    const data = await resp.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: 0, info: 'PROXY_ERROR' });
  }
}
