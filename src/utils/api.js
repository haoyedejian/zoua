/**
 * 走啊 · API 请求队列（规划书 10.6 / 12.4）
 * 规则：QPS ≤ 3，请求队列化；失败显式降级，禁止静默假数据（7.3 下界）。
 */

const MAX_CONCURRENCY = 3;

class RequestQueue {
  constructor() {
    this.active = 0;
    this.queue = [];
  }

  /** 入队并执行（自动限流） */
  async enqueue(fn) {
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

export const routeQueue = new RequestQueue();

/**
 * 调用路线级代理（8.4）：origin/destination 均 GCJ-02
 * @returns {Promise<{avoid:{distance:number|null,duration:number|null}, fastest:{distance:number|null,duration:number|null}}>}
 */
export async function fetchRoute(origin, destination) {
  const params = new URLSearchParams({
    origin: `${origin.lng},${origin.lat}`,
    destination: `${destination.lng},${destination.lat}`
  });
  return routeQueue.enqueue(async () => {
    const resp = await fetch(`/api/amap/route?${params.toString()}`);
    if (!resp.ok) throw new Error(`ROUTE_PROXY_${resp.status}`);
    return resp.json();
  });
}
