# Quant Research Lab — 实施记录与回滚指南

日期：2026-09-18 · 原则：增量扩展，零删除，旧文件最小追加

## Commits（每个阶段可独立回滚）

| Commit | 内容 | 回滚命令 |
|---|---|---|
| `b63c051` | baseline：扩展前现状快照 | —（基线） |
| `aaafc06` | Phase 1 Quant Lab Framework | `git revert aaafc06` |
| `ceb6d9d` | Phase 2 Factor Mining | `git revert ceb6d9d` |
| `47f4dcf` | Phase 3 Factor Library | `git revert 47f4dcf` |
| （最后一个） | Phase 4-11 闭环（回测/评估/选股/生命周期/实验/知识库/自主研究 + API + UI） | `git revert <hash>` |

注：Phase 4-11 的模块相互依赖（回测引擎同时被策略实验室与自主研究流水线调用），
为保证每个 commit 均可编译运行，合并为一个提交。

## 新增文件清单

```
src/lib/quant/
  types.ts                     # 共享类型（因子/策略/选股/回测/验证/实验/知识库/任务）
  store.ts                     # Prisma 存取（版本化 insert-only / 实验指纹 / 知识库 / 任务快照）
  bootstrap.ts                 # 服务端引导（注册 EM Provider、绑定任务持久化）
  data/
    provider.ts                # DataProvider 契约 + 通用过滤器（历史/实时共用）+ 契约自检
    em-provider.ts             # 真实数据源（腾讯/东财；全A/板块成分、带成交量历史K线窗口）
    demo-provider.ts           # 确定性演示数据源（离线/测试/回退）
    index.ts                   # Provider 注册表
  factors/
    panel.ts                   # 面板数据（严格 asOf 截断）
    expression.ts              # 因子表达式 DSL（白名单解析，禁 eval；未来函数审计）
    metrics.ts                 # IC/RankIC/ICIR/分组/多空/换手/稳定性/衰减/相关性/冗余
    templates.ts               # 9 大类目候选模板 + 参数网格 + 组合生成
    mining.ts                  # 挖掘漏斗（生成→初筛→精筛→保存，逐级收敛）
  backtest/
    engine.ts                  # 组合回测（成本/滑点/涨跌停/停牌/量/流动性/冲击；Train/Val/Test 切分）
    validation.ts              # Walk-forward / OOS / 市场环境分段 / 参数稳定性
  strategies/
    evaluation.ts              # 12 项绩效指标 + 比较淘汰（多维度，不只看收益）+ 综合分
    lifecycle.ts               # 策略/因子生命周期状态机（Degraded→Research、Retired 禁信号）
  selection/
    engine.ts                  # 选股引擎（唯一实现；历史回放与实时共用；股票池/过滤/评分/排名/回放）
  research/
    experiments.ts             # 实验指纹（键序无关规范化哈希）
    knowledge.ts               # 研究上下文（避免重复清单）
  jobs/
    registry.ts                # 长任务注册表（进度/暂停/恢复/取消/断点/失败归因）
    runners/mining.ts          # 挖掘任务
    runners/strategy-jobs.ts   # 回测/选股/回放/自主研究任务（统一接入实验+知识库）
src/app/api/quant/
  health/route.ts              # 健康检查
  factors/route.ts             # 因子库列表/录入（自动审计）
  factors/[id]/route.ts        # 详情/状态变更（生命周期校验）
  mining/route.ts              # 挖掘任务
  strategies/route.ts          # 策略实验室（创建/比较/淘汰）
  backtest/route.ts            # 回测任务
  selection/route.ts           # 选股/回放任务
  experiments/route.ts         # 实验列表
  knowledge/route.ts           # 知识库 CRUD + research-context
  research/route.ts            # 自主研究任务
src/components/desk/
  QuantPage.tsx                # 量化研究页面（8 Tab）
  quant/FactorsTab.tsx         # 因子库 UI
  quant/MiningTab.tsx          # 挖掘 UI
  quant/LabTabs.tsx            # 回测/选股/实验/知识库/自主研究 UI
prisma/schema.prisma           # 追加 5 张表（quant_*，User/Post 原样未动）
tests/quant/                   # 43 项测试（node --test 原生 TS）
QUANT_LAB_PHASE0.md            # Phase 0 审计报告
QUANT_LAB_PHASES.md            # 本文件
```

## 修改的旧文件（全部为追加式最小修改，已在 Phase 0 预先申报）

| 文件 | 修改内容 | 理由 | 回滚 |
|---|---|---|---|
| `src/lib/desk/types.ts` | PageKey 加 `"quant"`、PAGE_TITLES 加一项 | 单页 hash 路由必须注册 | revert 对应 commit |
| `src/components/desk/Sidebar.tsx` | NAV 数组加 1 项导航 | 同上 | 同上 |
| `src/components/desk/AppShell.tsx` | import + 条件渲染 2 行 | 同上 | 同上 |
| `tsconfig.json` | 加 `allowImportingTsExtensions: true` | Node 内置测试器直跑 TS 需要 | 同上 |
| `prisma/schema.prisma` | 文件末尾追加 5 个 quant_* 模型 | 存储层（同栈扩展，非替换） | 同上 |

未删除、未覆盖、未重写任何现有模块；现有 API/MCP/UI/扩展/数据层零改动。

## 闭环流程（用户输入"研究一个A股短线选股策略"时）

知识库查询 → 研究空白判断 → 候选生成 → 初筛 → 因子验证 → 淘汰（带原因）→ 因子组合 →
策略生成 → 历史选股回放（同一选股引擎）→ 完整回测 → Walk-forward → OOS → 稳定性分析 →
保存策略 → 入库 → 实时选股（生命周期门禁）→ 监控 → 性能退化 Degraded → 重新 Research。
失败时输出结构化失败报告（原因/数据证据/失败指标/是否过拟合/下一步建议）。

## 已验证

- `tsc --noEmit`：0 错误
- `node --test tests/quant/`：43/43 通过
- 旧功能回归：/、/api/mcp/*、/api/market/*、/api/extension/* 全部 200
- 真实数据链路：全A 5916 只、K线严格 asOf 截断（无未来数据）
- 研究闭环（demo 源）：20 步全流程产出策略并通过验证、实时选股 10 只
- 实验指纹去重：同参数重复回测返回"已完成，跳过"
