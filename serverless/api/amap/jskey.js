/**
 * 走啊 · 高德 JS API Key 下发（生产注入通道，规划书 9.3）
 * 静态托管（Vercel 静态产物）没有 HTML 注入能力：前端在未拿到 dev-server 注入的
 * window.__AMAP_JS_KEY__ 时，回退请求本接口取 Key。
 * 安全性：JS Key 本就必须下发到浏览器，防护依赖高德控制台「域名白名单」而非保密；
 *         本路由同样接入 guardOrigin，避免被白名单外站点复用。
 */

import { guardOrigin } from './_guard.js';

const JS_KEY = process.env.AMAP_JS_KEY;

export default async function handler(req, res) {
  if (!guardOrigin(req, res)) return;
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({ status: 1, key: JS_KEY || null });
}