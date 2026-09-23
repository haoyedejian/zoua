/**
 * 走啊 · API 请求队列（规划书 9.2/10.6/12.4）
 * 规则：全局并发 ≤ 3（命中高德 CUQPS 限流实测，证 8.4/v2.9）；失败显式降级，禁止静默假数据（7.3）。
 */

const MAX_CONCURRENCY = 3;
const MAX_RETRY = 2;

class RequestQueue {
  constructor() {
    this.active = 0;
    this.queue = [];
  }

  /** 入队并执行（自动限流） */
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < MAX_CONCURRENCY && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

export const apiQueue = new RequestQueue();

/** 走队列发起 GET，带轻量重试（限流/网络瞬时错误） */
function queuedGet(pathname, params, retries = MAX_RETRY) {
  const qs = new URLSearchParams(params).toString();
  const url = `${pathname}?${qs}`;
  return apiQueue.enqueue(async () => {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP_${resp.status}`);
        const data = await resp.json();
        if (data && data.status === '0' && /QPS|EXCEEDED|FREQUENT/i.test(data.info || '')) {
          throw { qps: true, info: data.info }; // 限流→外层重试
        }
        return data;
      } catch (err) {
        lastErr = err;
        if (err && err.qps) await new Promise(r => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw lastErr;
  });
}

/**
 * 路线级代理（8.4）：origin/destination 均 GCJ-02
 * @returns {Promise<{status, avoid:{distance,duration}, fastest:{distance,duration}}>}
 */
export function fetchRoute(origin, destination) {
  return queuedGet('/api/amap/route', {
    origin: `${origin.lng},${origin.lat}`,
    destination: `${destination.lng},${destination.lat}`
  });
}

/**
 * 行政区划查询：县区 adcode/center + 可选边界 polyline
 * @returns {Promise<{status, districts}>}
 */
export function fetchDistrict(keywords, { subdistrict = 0, all = false } = {}) {
  return queuedGet('/api/amap/district', {
    keywords,
    subdistrict,
    extensions: all ? 'all' : 'base'
  });
}

/**
 * 动态拉取出发城市风景区 POI（两阶段推荐·阶段1数据源；v5/place/text 风景名胜）
 * @param {{city?:string, keywords?:string, page?:number}} p
 * @returns {Promise<{status, pois:Array<{name, adname, location, adcode, poi_id, type}>}>}
 */
export function fetchPois({ city, keywords, page = 1 } = {}) {
  const params = { page };
  if (city) { params.city = city; params.city_limit = 'true'; }
  if (keywords) params.keywords = keywords;
  return queuedGet('/api/amap/pois', params);
}

/**
 * 逆地理编码：坐标（GCJ-02）→ 行政区组件（province/city/adcode）
 * @param {string} location "经度,纬度"
 * @returns {Promise<{status, regeocode:{addressComponent:{province, city, adcode, district}}}>}
 */
export function fetchRegeo(location) {
  return queuedGet('/api/amap/regeo', { location });
}