/**
 * 走啊 · Serverless 来源白名单校验（安全纪律 15.1 / 17.1）
 * 防止任意站点通过浏览器直间调用代理、盗用 AMAP_WEB_KEY（高德 Key 域名白名单之外的入口）。
 * 规则：配置了 ALLOWED_ORIGINS（逗号分隔的域名/来源，支持 *.example.com 子域通配）才强校验；
 *       未配置时放行（本地/初配阶段），生产务必通过 Vercel 环境变量 ALLOWED_ORIGINS 指明预发布域名
 *       （如 https://zoua.xxx.com）。校验只比对 hostname，不做字符串前缀匹配。
 */

/** 归一化 hostname（保留可选 *. 子域通配前缀）；非法值返回 '' */
function hostnameOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const wildcard = raw.startsWith('*.');
  const target = wildcard ? raw.slice(2) : raw;
  try {
    const { hostname } = new URL(target.includes('://') ? target : `https://${target}`);
    return wildcard ? `*.${hostname}` : hostname;
  } catch {
    return '';
  }
}

/** 白名单命中：精确 hostname 相等，或配置项为 *.example.com 时匹配其子域 */
function isAllowedHost(host, rule) {
  if (!host || !rule) return false;
  if (rule.startsWith('*.')) return host.endsWith(rule.slice(1));
  return host === rule;
}

export function guardOrigin(req, res) {
  const allowed = process.env.ALLOWED_ORIGINS || '';
  if (!allowed) return true; // 未配置白名单：开发/初配放行（生产必须配置）

  const origin = req.headers['origin'] || req.headers['referer'] || '';
  // 无来源（非浏览器直接调用，如服务端/测试）放行
  if (!origin) return true;

  // 只比较 hostname：避免 "https://zoua.vercel.app.evil.com" 之类的前缀拼接绕过
  const host = hostnameOf(origin);
  const rules = allowed.split(',').map(hostnameOf).filter(Boolean);
  const ok = rules.some(rule => isAllowedHost(host, rule));
  if (!ok) {
    res.status(403).json({ status: 0, info: 'FORBIDDEN_ORIGIN' });
    return false;
  }
  return true;
}