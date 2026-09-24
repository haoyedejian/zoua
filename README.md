# 走啊！(zoua)

> 高德告诉你"别走这条路"，走啊告诉你"走哪个方向"。
> 临时起意的自驾决策工具：扫一圈，看哪个方向现在不堵。

## 体验链接

（待部署后填写：Vercel 生产地址，如 https://zoua.vercel.app）

## 产品说明

- 定位 → 扇区反向扫描 → 两阶段推荐（先看周边哪个人少 → 再看那个区县能去哪）→ 挑景点 → 跳转高德导航
- 地图数据 © 高德地图
- **全部数据来自高德开放平台真实接口**（驾车路径规划 / 行政区划 / POI / 逆地理编码），无演示假数据

## 技术栈

- H5 前端（移动端优先）+ 高德 JS API + Canvas 热力自绘
- Serverless Proxy（Vercel Functions）中转高德 Key

## 本地开发

```bash
# 1. 复制环境变量模板并填写 Key（真实 Key 不入库）
cp .env.example .env

# 2. 启动前端
npm run dev
```

> Key 安全纪律：Web 服务 Key 仅存 Serverless 环境变量；JS API Key 绑定域名白名单；真实 Key 严禁提交。

## 部署到 Vercel

静态 H5 + `serverless/` Functions 同仓库部署，前缀 `/api/amap/*` 由 `vercel.json` 的 rewrite 路由到函数。

```bash
# 1. 安装 CLI 并登录
npm i -g vercel && vercel login

# 2. 配置环境变量（生产必配，三项）
vercel env add AMAP_WEB_KEY production    # 高德 Web 服务 Key（仅服务端持有，严禁入库）
vercel env add AMAP_JS_KEY production     # 高德 JS API Key（经 /api/amap/jskey 下发前端）
vercel env add ALLOWED_ORIGINS production # 允许调用代理的来源，逗号分隔，如 https://zoua.vercel.app（支持 *.example.com）

# 3. 部署
vercel --prod
```

- **JS Key 下发链路**：本地由 `dev-server.js` 注入 `window.__AMAP_JS_KEY__`；生产静态产物无注入能力，[map.js](src/components/map.js) 自动回退请求 `/api/amap/jskey`（见 `serverless/api/amap/jskey.js`）。
- **必做校验（Vercel Function 防治盗用）**：`ALLOWED_ORIGINS` 需列全部合法入口域名；校验按 hostname 精确比对（不做字符串前缀匹配）。未配置时函数放行以便初配，上线前务必配置。
- **高德 JS Key 域名白名单**：在 AMap 控制台写入 Vercel 生产域名（及本地 `localhost:5173`）；JS Key 的防护依赖域名白名单，H5 geolocation 依赖 HTTPS（见 17.1）。
- 配额纪律见规划书 9.2（单次扫描 ≤12 次新调用；QPS≤3 由前端队列 + 服务端节流双控）。

## 数据来源声明

| 接口 | 用途 |
|---|---|
| 驾车路径规划（strategy=12 躲避拥堵） | 扇区通行速率反演 + ETA 验证（主数据源） |
| 逆地理编码（regeo） | 定位后自动识别出发城市 |
| 地理编码（geocode） | 定位失败时用户输入出发地 |
| 地点搜索/详情（POI） | 动态拉取风景区 + 目的地信息（仅点击时按需查询） |
| 行政区划查询（extensions=all） | 县区边界 Polygon + 归属反查 |

产品规划书：`docs/走啊_产品规划书_v2.10.md`
