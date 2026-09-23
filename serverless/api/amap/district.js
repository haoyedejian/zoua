/**
 * 走啊 · 行政区划代理（规划书 9.6-方案2 / 12.4-第4项）
 * Vercel Function：GET /api/amap/district
 * 用途：县区 adcode/center/level 与边界 polyline（extensions=all），供热力填色 + 归属反查。
 * 安全：AMAP_WEB_KEY 仅服务端持有；前端只传 keywords 与 subdistrict 档位。
 */

const AMAP_KEY = process.env.AMAP_WEB_KEY;
const AMAP_DISTRICT_URL = 'https://restapi.amap.com/v3/config/district';

export default async function handler(req, res) {
  const { keywords, subdistrict, extensions } = req.query;
  if (!AMAP_KEY) {
    res.status(500).json({ status: 0, info: 'SERVER_KEY_MISSING' });
    return;
  }
  const params = new URLSearchParams({
    key: AMAP_KEY,
    keywords: String(keywords || '中国'),
    subdistrict: String(subdistrict || 0),
    extensions: extensions === 'all' ? 'all' : 'base',
    output: 'JSON'
  });
  try {
    const resp = await fetch(`${AMAP_DISTRICT_URL}?${params.toString()}`);
    const data = await resp.json();
    if (data.status !== '1') {
      res.status(200).json({ status: 0, info: data.info || 'AMAP_ERROR' });
      return;
    }
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: 0, info: 'PROXY_ERROR' });
  }
}