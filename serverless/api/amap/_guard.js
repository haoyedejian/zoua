/**
 * 走啊 · Serverless 来源白名单校验（安全纪律 15.1 / 17.1）
 * 防止任意站点通过浏览器直间调用代理、盗用 AMAP_WEB_KEY（高德 Key 域名白名单之外的入口）。
 * 规则：配置了 ALLOWED_ORIGINS（逗号分隔的域名前缀）才强校验；未配置时放行（本地/初配阶段），
 *       生产务必通过 Vercel 环境变量 ALLOWED_ORIGINS 指明预发布域名（如 https://zoua.xxx.com）。
 */

export function guardOrigin(req, res) {
  const allowed = process.env.ALLOWED_ORIGINS || '';
  if (!allowed) return true; // 未配置白名单：开发/初配放行（生产必须配置）

  const origin = req.headers['origin'] || req.headers['referer'] || '';
  // 无来源（非浏览器直接调用，如服务端/测试）放行
  if (!origin) return true;

  const list = allowed.split(',').map(s => s.trim()).filter(Boolean);
  const ok = list.some(prefix => origin.startsWith(prefix) || prefix.startsWith(origin));
  if (!ok) {
    res.status(403).json({ status: 0, info: 'FORBIDDEN_ORIGIN' });
    return false;
  }
  return true;
}