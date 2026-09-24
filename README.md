# 走啊！(zoua)

> 高德告诉你"别走这条路"，走啊告诉你"走哪个方向"。
> 临时起意的自驾决策工具：扫一圈，看哪个方向现在不堵。

## 产品说明

- **可接受车程口径**：出发前先选「最远车程」（30 分 / 1 小时 / 2 小时 / 3 小时），既决定扫描半径（粗算），也按真实 ETA 过滤推荐区县，不会推出超出预期的行程
- 定位 → 扇区反向扫描 → 两阶段推荐（先看周边哪个人少 → 再看那个区县能去哪）→ 挑景点 → 跳转高德导航
- 地图数据 © 高德地图
- **全部数据来自高德开放平台真实接口**（驾车路径规划 / 行政区划 / POI / 逆地理编码），无演示假数据

## 技术栈

- H5 前端（移动端优先）+ 高德 JS API + Canvas 热力自绘
- Serverless Proxy（Vercel Functions）中转高德 Key

## 工程亮点

- **数据层依赖注入**：`scanSectors(origin, dests, sectors, router)` 的 router 可注入，测试用替身覆盖「堵城 / 空城 / 跨城远景」三类场景，不消耗真实配额即可回归
- **31 项单测全过**（`npm test`）：扇区指数反演、请求队列并发峰值、多城市场景回归、可接受车程过滤
- **配额纪律**：前端请求队列并发上限 3 + 本地服务端平滑节流 ≥320ms，单次扫描新调用控制在 12 次量级
- **四分支显式降级**：定位失败 → 城市浮层；规划失败 → 「没扫出方向」；配额耗尽 → 「稍缓一下」；断网 → 静态兜底。不伪造数据
- **设计 Token 体系**：色彩 / 字体 / 间距 / 圆角 / 动效 / 图层全部收敛为 CSS 变量，组件层不硬编码
- **密钥纪律**：Web 服务 Key 仅服务端持有，JS Key 经注入或 `/api/amap/jskey` 下发，仓库内无任何真实密钥

## 项目结构

```
zoua/
├─ index.html               # 三态决策画布入口
├─ dev-server.js            # 零依赖本地服务（静态托管 + /api/amap/* 代理）
├─ vercel.json              # 静态产物 + Functions 同仓库部署配置
├─ serverless/api/amap/     # route / district / regeo / geocode / pois / poi / jskey + 来源白名单
├─ src/
│  ├─ main.js               # 三态状态机：定位 → 扫描 → 结果
│  ├─ components/           # map（高德底图）/ radar（雷达动画）/ heatmap（热力自绘）
│  ├─ utils/                # scan（扇区反演）/ sector / geo / api（请求队列）
│  └─ styles/               # variables.css（设计 Token 唯一来源）+ heat.css
├─ test/                    # scan / queue / scenario 三套单测
└─ docs/                    # 产品规划书 + 审计留痕
```

## 本地开发

```bash
# 1. 复制环境变量模板并填写 Key（真实 Key 不入库）
cp .env.example .env

# 2. 启动前端
npm run dev
```

> Key 安全纪律：Web 服务 Key 仅存 Serverless 环境变量；JS API Key 绑定域名白名单；真实 Key 严禁提交。

## 部署到 Vercel（可选，当前仓库未部署线上环境）

静态 H5 + `serverless/` Functions 同仓库部署，前缀 `/api/amap/*` 由 `vercel.json` 的 rewrite 路由到函数。

```bash
# 1. 安装 CLI 并登录
npm i -g vercel && vercel login

# 2. 配置环境变量（生产必配，三项）
vercel env add AMAP_WEB_KEY production    # 高德 Web 服务 Key（仅服务端持有，严禁入库）
vercel env add AMAP_JS_KEY production     # 高德 JS API Key（经 /api/amap/jskey 下发前端）
vercel env add ALLOWED_ORIGINS production # 允许调用代理的来源，逗号分隔，如 https://your-domain.example.com（支持 *.example.com）

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
