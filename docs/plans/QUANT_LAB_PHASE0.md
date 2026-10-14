# Phase 0 审计报告 — Quant Research Lab 增量扩展前置调查

日期：2026-09-18 · 状态：只审计，零代码修改（本报告文件为新增文档，不动任何现有文件）

## 1. 项目概况

- 项目：**MyDesk 个人行情工作台**（`D:\Zai\kairotrend`），本地单机 Next.js 应用
- 技术栈：Next.js 16.1.1（App Router）+ React 19 + TypeScript 5 + Tailwind 4 + Radix/shadcn UI + Zustand 5（持久化）+ Prisma 6.19.3 / SQLite
- 运行方式：`启动.bat` → 检查 Node → 确保 `.env`（`DATABASE_URL=file:./db/custom.db`）→ npm 国内镜像装依赖 → `prisma generate` → `npx next dev -p 3000`；AI 走本机代理（HTTPS_PROXY=127.0.0.1:10808），国内数据源域名在 NO_PROXY 白名单直连
- 验证基线（Phase 0 实测）：`npx tsc --noEmit` = **0 错误**；Node v24.20.0；`py` 启动器 Python 3.14.7；3000 端口当前无服务监听

## 2. Existing Architecture（现有架构）

### 分层

```
UI（src/components/desk/）  hash 单页路由，AppShell 按 PageKey 渲染 8 个页面
      │  fetch
API（src/app/api/）  ai/proxy · mcp/{servers,tools,call} · market/{search,quote,kline,board,board-detail,news} · extension/pending
      │  import
LIB（src/lib/desk/）  em.ts(服务端数据源) · market.ts(客户端取数+回退) · data.ts(演示数据)
                      ai.ts(客户端AI辅助) · mcp-manager.ts(stdio MCP) · store.ts(zustand) · types.ts
DB  Prisma + SQLite（db/custom.db）— schema 仅脚手架默认 User/Post 模型，实际业务数据全在浏览器 localStorage
```

### 关键事实

- **数据层核心 `src/lib/desk/em.ts`（383 行，仅服务端）**：本机直连腾讯行情（qt.gtimg.cn 批量实时报价、ifzq.gtimg.cn 分钟线 mkline 与日线/周/月前复权 fqkline）+ 东方财富（searchapi 搜索、push2delay/push2 clist 板块与全A资金榜、push2his 个股/板块 14 日主力净额、7x24 快讯）。带 TTL 缓存（搜索 5 分/报价 15 秒/K线 20 秒/榜单 30 秒）。符号约定：`688256.SH / 000001.SZ / 000001.SH=上证指数 / 920819.BJ / 90.BKxxxx=板块`，`symbolToSecid()` 已导出
- **客户端 `market.ts`**：真实数据优先、失败自动回退演示数据；含技术快照（多周期趋势线性回归、RSI、支撑/阻力、区间位置）
- **MCP**：`mcp-manager.ts` stdio JSON-RPC 管理器（全局单例 `__mydeskMcp`，配置落 `data/mcp-config.json`，trust 门控）；演示服务器 `scripts/mcp/demo_market.py`
- **AI**：Key 只存浏览器 localStorage，经 `/api/ai/proxy` 请求头转发，不落库不进日志；支持 OpenAI/Anthropic/Gemini/DeepSeek/Moonshot/OpenRouter/Ollama/自定义
- **状态**：zustand persist（key `mydesk-state`），自选/追踪/历史/会话全在浏览器
- **UI**：AppShell + Sidebar（NAV 数组）+ TopBar + 8 页面（总览/看板/AI分析/追踪/历史/智能助手/扩展/设置）+ 自绘 SVG CandleChart / BubbleFlow / Sparkline
- **已有量化相关能力**：仅技术指标快照（RSI/趋势/关键位）、板块资金流向榜、AI 图表分析。**无因子、无回测、无策略、无选股、无实验跟踪**

### Git 状态（重要）

- **该目录不是 Git 仓库**（`git status` 报 not a git repository）。
- 用户 Git 安全要求（记录 status、每 Phase 独立 commit、可独立回滚）因此必须先做使能动作：
  **Phase 1 开工前执行 `git init` + 全量基线 commit**（纯新增操作，不改任何文件内容，可随时删除 `.git` 回到现状）。

### 测试现状

- **无任何测试框架与测试文件**（无 jest/vitest 配置、无 *.test.*）。"现有测试"基线 = `tsc --noEmit` 0 错误 + `next dev` 冒烟（首页 200、/api/mcp/servers 200、/api/extension/pending 200，见 worklog）。
- 新测试建议用 Node 24 内置 `node --test`（Node ≥23.6 原生直跑 .ts，零新依赖，不引入新技术栈）。

## 3. Reusable Components（可复用组件）

| 组件 | 复用方式（全部 import，不改源码） |
|---|---|
| `em.ts` 各 fetch 函数 | Quant Data Provider 的行情实现底座：K线（日/分钟，前复权）、实时报价（含高低价/昨收/成交额）、搜索、全A/行业/概念 clist 榜、主力资金流 |
| `em.ts` TTL 缓存模式 | Quant 数据层照此模式自建独立缓存，防限流，不与现有缓存互相污染 |
| 符号约定 / `symbolToSecid` | 全 Quant 模块沿用 `688256.SH` 约定，secid 供东财接口 |
| `data.ts` 确定性演示数据 | DemoDataProvider：离线/断源时量化流程可用、单元测试可复现 |
| `mcp-manager.ts` | Quant 能力可作为新 MCP 服务器注册（Phase 11 可选），管理器零改动 |
| `/api/ai/proxy` + `ai.ts` 请求头带 Key 模式 | Agent 自主研究（Phase 11）的 LLM 调用沿用同模式：Key 由前端每次请求携带，不落库 |
| `globalThis` 单例模式 | 长任务 Job Registry（进度/暂停/恢复）照此实现 |
| shadcn `components/ui/*` | QuantPage 的表格/Tabs/Dialog/Progress 等 |
| Prisma + SQLite | 以追加模型方式扩展（同栈，非替换） |

## 4. Extension Points（扩展点）

1. **新 API 路由**：`src/app/api/quant/**`（App Router 文件路由天然支持增量，不碰现有 route）
2. **新核心库**：`src/lib/quant/**`（全新目录，与 `src/lib/desk` 平级，只 import 不改）
3. **新 UI 页面**：`src/components/desk/pages/QuantPage.tsx` + 子组件目录（新文件）
4. **数据库**：`prisma/schema.prisma` **追加**模型 + `prisma db push`（只加表，不动 User/Post 与现有数据；db 当前无业务数据，风险为零）
5. **MCP**：新增 `scripts/mcp/` 下的 quant 服务器脚本（可选，Phase 11 再定）
6. **演示回退**：沿用"真实优先、失败回退演示"的成熟模式
7. **长任务**：Next.js dev 常驻进程 + globalThis 注册表，轮询进度

## 5. Potential Conflicts（潜在冲突与对策）

| 冲突 | 说明 | 对策 |
|---|---|---|
| 数据源限流 | 全A扫描/历史回放会高频访问腾讯/东财公开接口，可能触发限流，**殃及现有看板/报价功能** | Quant 层独立 TTL 缓存 + 请求节流/分批 + 失败退避；历史研究尽量单次拉取批量缓存；不并发轰炸 |
| em.ts 内部函数未导出 | `fetchJson/cached` 为私有 | 不改 em.ts：Quant 数据层自建同模式抓取（新文件），或只用 em.ts 已导出的函数 |
| K线深度有限 | 腾讯日线单次约 160 根、分钟线约 320 根 | IC/回测窗口按可用深度自适应并在结果里记录 data_range；多窗口分段拼接（新代码实现，不动 em.ts） |
| 基本面/市值/换手等字段 | 现有 em.ts 未提供 | 东财 clist 支持字段扩展（f20/f21 市值、f10 换手、f5/f6 量额等），在 Quant Provider 新文件中实现；取不到的字段明确降级并在选股输出标注，不伪造 |
| dev 单进程阻塞 | 长研究任务阻塞事件循环会卡 UI | 任务分片 + await 让出；Job Registry 异步轮询；支持暂停/恢复/失败原因 |
| localStorage 容量 | 因子/实验结果不能进 zustand persist | 全部落 SQLite（服务端），前端只存轻量 UI 偏好 |
| `db:push` 带 `--accept-data-loss` | 激进 schema 变更可能丢表 | Quant 只追加模型；push 前记录 git commit 可回滚 |
| 3000 端口占用 | 历史曾发生旧进程占用 | 启动前检查（Phase 0 实测当前空闲） |
| 因子被覆盖 | 用户红线 | 因子记录 insert-only + version 递增；状态/生命周期单独字段更新，指标与表达式不可变 |

## 6. Required New Modules（必须新增的模块）

```
src/lib/quant/
  types.ts                    # 因子/策略/实验/生命周期/选股结果类型
  data/provider.ts            # DataProvider 接口（数据原则：不绑定具体源）
  data/em-provider.ts         # A股真实数据实现（复用 em.ts 导出 + 同模式扩展字段）
  data/demo-provider.ts       # 确定性演示数据实现（离线与测试）
  factors/                    # Phase 2：算子、候选生成、组合、参数搜索、IC/RankIC/IC_IR/
                              #        分组收益/多空/稳定性/衰减/相关性/冗余/泄露检测
  factors/library.ts          # Phase 3：版本化因子库（insert-only，9 类目 × 6 生命周期）
  strategies/                 # Phase 4/5/6：Strategy Lab、组合回测、12+ 项绩效评估、生命周期状态机
  selection/                  # Phase 7：唯一 Selection Engine（规则/因子/多因子/策略选股 + 排名 +
                              #        股票池过滤 + 历史回放与实时共用同一实现）
  backtest/                   # Phase 5：组合回测（成本/滑点/涨跌停/停牌/流动性/量约束）
                              #        + Walk-forward/OOS/Regime/参数稳定性/反过拟合检查
  research/                   # Phase 9/10/11：实验跟踪（指纹去重）、知识库、自主研究流水线
                              #        （漏斗分级/进度/暂停/失败归因）
  jobs/registry.ts            # 长任务注册表（progress/pause/resume/failure）
src/app/api/quant/…           # factors · mining · strategies · selection · selection/replay
                              # · backtest · experiments · knowledge · research · data · health
src/components/desk/pages/QuantPage.tsx + quant/ 子组件   # 单页多 Tab：因子库/挖掘/选股/回测/实验/研究
prisma/schema.prisma          # 追加模型：QuantFactor, Strategy, StrategyVersion, Experiment,
                              # KnowledgeEntry, JobRun 等（只加不改）
tests/quant/…（node --test）  # 因子计算/泄露检测/选股/回测/生命周期/API 契约测试
```

## 7. Files That MUST NOT Be Modified（红线清单）

- `src/lib/desk/em.ts`（数据源核心）、`data.ts`、`market.ts`、`store.ts`、`ai.ts`、`mcp-manager.ts`
- `src/app/api/` 下全部现有路由（ai/proxy、mcp/*、market/*、extension/pending）
- `src/components/desk/` 下全部现有页面与组件（8 页面、CandleChart、TopBar 等）、`src/components/ui/*`
- `src/lib/db.ts`、`src/lib/utils.ts`
- `public/mydesk-extension/*`、`public/logo.svg`、`scripts/mcp/demo_market.py`
- `prisma/schema.prisma` 中已有的 User/Post 模型（只允许追加）
- `package.json` 现有依赖（零新增运行时依赖；测试用 Node 内置 runner，如确需 devDependency 将另行提前申报）
- `启动.bat`、`使用说明.txt`、`.env`、`data/mcp-config.json`、`db/custom.db` 现有表

## 8. 预先申报：唯一需要的旧文件最小修改（经必要性证明）

按用户规则，在 Phase 1 中对以下 3 个文件做**纯追加式**最小修改，理由申报如下：

**为什么必须修改**：MyDesk 是 hash 单页路由，页面由 `PageKey` 联合类型 + `PAGE_TITLES` + Sidebar `NAV` 数组 + AppShell 条件渲染四处注册；无任何插件式页面发现机制，不注册则 Quant Lab UI 无法出现在工作台中。除此之外的所有功能（核心库、API、DB、MCP）全部走新增文件，零改动。

**修改哪些文件 / 改什么**：
1. `src/lib/desk/types.ts` — `PageKey` 联合类型追加 `"quant"`；`PAGE_TITLES` 追加 `quant: "量化研究"`（2 行追加）
2. `src/components/desk/Sidebar.tsx` — `NAV` 数组追加 1 项（图标 + 标签）
3. `src/components/desk/AppShell.tsx` — 追加 1 行 import + 1 行条件渲染

**影响哪些功能**：无。均为追加，不删除不改写任何现有行；现有 8 页面路由、导航、标题不受影响。验证手段：`tsc --noEmit` 0 错误 + 逐页冒烟（8 个旧页面全部可打开）+ 旧 API 回归（/api/mcp/servers、/api/market/quote、/api/extension/pending 返回 200）。

**如何回滚**：每个 Phase 独立 git commit（Phase 1 前 `git init` 建基线），`git revert <该 Phase commit>` 即可整体回滚该阶段全部改动（含上述 3 文件）；因是追加式修改，revert 无残留。

## 9. Phase 1 起的既定方针（依据本审计）

- 数据原则落地：`DataProvider` 接口 + `EmProvider`（现有腾讯/东负能力）/ `DemoProvider`（演示数据）双实现，量化模块不感知具体源
- 存储：Prisma 追加模型落 SQLite；因子 insert-only 版本化；实验指纹去重；知识库先行查询
- 选股引擎唯一实现，历史回放按"截至当时可得数据"切片调用同一引擎
- 反过拟合检查（未来函数/数据泄漏/幸存者偏差等）作为回测与验证的强制关卡
- 资源控制：Candidate → 初筛 → 精筛 → 回测 → 验证 漏斗逐级收敛，长任务支持进度/暂停/恢复
- 第一版不做自动下单；不做数据中心建设
