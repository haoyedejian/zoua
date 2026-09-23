/**
 * 走啊 · 交通态势代理（占位）
 * 规划书 12.4 实测：交通态势为「高级服务接口」需商务咨询，个人开发者不可免费调用。
 * 本路由保留：若高德商务开通（覆盖 40 大城市，无连云港），可作为升级路径接入；
 * 当前数据主路线为路线级代理（serverless/api/amap/route.js，见 8.4）。
 * 未开通时返回明确错误，禁止伪造数据（7.3 下界）。
 */

import { guardOrigin } from './_guard.js';

const AMAP_KEY = process.env.AMAP_WEB_KEY;
const AMAP_TRAFFIC_URL = 'https://restapi.amap.com/v3/traffic/status/rectangle';

export default async function handler(req, res) {
  if (!guardOrigin(req, res)) return;
  const { rectangle, level } = req.query;
  if (!AMAP_KEY) {
    res.status(500).json({ status: 0, info: 'SERVER_KEY_MISSING' });
    return;
  }
  // 注意：rectangle 对角线不得超过 10km（官方限制）
  const params = new URLSearchParams({
    key: AMAP_KEY,
    rectangle,
    level: level || '6',
    output: 'JSON',
    extensions: 'base'
  });
  try {
    const resp = await fetch(`${AMAP_TRAFFIC_URL}?${params.toString()}`);
    const data = await resp.json();
    if (data.status === '0' && /高级服务|permission|权限/i.test(data.info || '')) {
      res.status(403).json({ status: 0, info: 'TRAFFIC_UNAVAILABLE_FOR_PERSONAL_DEV' });
      return;
    }
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: 0, info: 'PROXY_ERROR' });
  }
}
