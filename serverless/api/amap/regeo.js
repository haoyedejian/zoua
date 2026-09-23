/**
 * 走啊 · 逆地理编码代理（真机定位成功 → 自动识别出发城市）
 * Vercel Function：GET /api/amap/regeo?location=经度,纬度
 * 返回 regeocode.addressComponent（province/city/adcode），供前端判断出发城市后动态拉取景区。
 */

import { guardOrigin } from './_guard.js';

const AMAP_KEY = process.env.AMAP_WEB_KEY;

export default async function handler(req, res) {
  if (!guardOrigin(req, res)) return;
  const { location } = req.query;
  if (!AMAP_KEY) {
    res.status(500).json({ status: 0, info: 'SERVER_KEY_MISSING' });
    return;
  }
  if (!location) {
    res.status(400).json({ status: 0, info: 'MISSING_LOCATION' });
    return;
  }
  const params = new URLSearchParams({
    key: AMAP_KEY,
    location,
    extensions: 'base',
    output: 'JSON'
  });
  try {
    const resp = await fetch(`https://restapi.amap.com/v3/geocode/regeo?${params.toString()}`);
    const data = await resp.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: 0, info: 'PROXY_ERROR' });
  }
}