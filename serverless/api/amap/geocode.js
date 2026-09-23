/**
 * 走啊 · 地理编码代理（定位失败 → 用户自行输入出发地）
 * Vercel Function：GET /api/amap/geocode?address=西湖区文二路
 * 文字地址 → GCJ-02 坐标（高德 v3/geocode/geo 返回即 GCJ-02，全链路一致 9.4）。
 * 与 dev-server.js 的 /api/amap/geocode 同口径，保证本地/生产行为一致。
 */

import { guardOrigin } from './_guard.js';

const AMAP_KEY = process.env.AMAP_WEB_KEY;

export default async function handler(req, res) {
  if (!guardOrigin(req, res)) return;
  const { address } = req.query;
  if (!AMAP_KEY) {
    res.status(500).json({ status: 0, info: 'SERVER_KEY_MISSING' });
    return;
  }
  if (!address) {
    res.status(400).json({ status: 0, info: 'MISSING_ADDRESS' });
    return;
  }
  const params = new URLSearchParams({
    key: AMAP_KEY,
    address,
    output: 'JSON'
  });
  try {
    const resp = await fetch(`https://restapi.amap.com/v3/geocode/geo?${params.toString()}`);
    const data = await resp.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: 0, info: 'PROXY_ERROR' });
  }
}