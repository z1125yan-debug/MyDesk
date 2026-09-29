# 类型 B 方向概率预测 · 实施方案（禁区放行版）

> 承接 `forecasting-direction-unlock-plan.md`（放开条件方案）与 `trio-integration-plan.md`（预测件 = superforecasting）。
> 本文在「用户 2026-09-29 已口头允许放开禁区」的前提下，给出**完整实施方案**：参考仓库清单 + 禁区现状与放行口径 + 分阶段落地 + 验收。
> 微信推送见 `wechat-ai-bot-plan.md`，另案处理。

---

## 0. 定位与现状（动手前先对齐）

**两套「预测」要分清**：

| 件 | 文件/能力 | 现状 |
|---|---|---|
| 类型 A 阶段方向 | `src/lib/quant/screener/top-pressure-core.ts` 0–100 压力分 + 70/50/30 档位带（R20b 落地） | **已具备** |
| 类型 B 方向概率（次日/收盘涨跌概率） | `src/lib/quant/factors/probability.ts` 历史条件概率引擎 | **禁区，当前被剥离** |

**已经搭好的底座（不用从零写）**：
- 历史条件概率引擎 `src/lib/quant/factors/probability.ts`（294 行），`historicalWinProbability()`；
- 对话工具 `historical_probability`（`src/lib/desk/chat-tools.ts:818/1153`），条件字段必须来自因子目录；
- 接口 `/api/quant/probability`、`/api/snapshot/probability`（**前端传的胜率数字不入库**——正好是预测件要的纪律）；
- 冻结池 `pool` freeze/verify（Brier 回收的落点，待接）。

**当前禁区实现（要改的就是这里）**：
- `src/lib/quant/screener/event-interpret-core.ts:228` 的 `PROBABILITY_PATTERNS`（4 条正则，覆盖「时间/方向词 + 概率/涨幅 + 数字%」）；
- 同文件 `stripProbabilityClaims()` 把命中处替换为占位 `（AI 给出的概率或涨幅预测已剔除：本系统禁止 AI 生成概率与预测）`，原话存 `dropped.probability_claims`（不静默删除）；
- 三处路由落库前调用剥离：`/api/events/interpret`、`/api/research`、`/api/agent/finalize`；
- `worklog.md` §九 同记该红线；`PROBABILITY_MIN_SAMPLE=30`、两个概率引擎禁止混算（`worklog.md:770`）。

---

## 1. 参考的 GitHub 仓库（采取了谁的、有什么功能）

> 统一口径（`trio-integration-plan.md:254`）：Serenity 与 superforecasting 两批第三方仓库**只作方法论蓝本**（纯 markdown 进 `vendor/`，不进运行时、不装依赖）。本方案落地**不引入任何外部运行时依赖**，只借鉴口径与算法结构。

### 1.1 预测件（superforecasting）直接蓝本

| 仓库 | ★ / 安装 | 采用了的功能 | 不采用 |
|---|---|---|---|
| **superforecasting 方法论两仓（skills.sh，Tetlock 体系）** | 未逐门核实（R22 前必须做完全文核对，`trio-integration-plan.md:294`） | `reference-classes`（基准率只认真历史数）、`question-design`（把问题拆成可验证、带截止日）、`Brier` 回收思路 | 两仓自带的外部数据源/付费 key |
| **`muxuuu/serenity-skill`**（产业链研究法） | 4,040★ / 628 fork / MIT | 三件套的 Serenity 件：系统图 → 候选公司 → **最优反解释**（链观点最常见的死法，正是预测件需要的「证伪条件」来源） | 运行期 skill 加载器（本项目无此机制，`serenity-integration-plan.md:149`） |

### 1.2 环境闸门（见顶/情绪）蓝本——预测件的前提输入

| 仓库 | ★ / 安装 | 采用了的功能 | 不采用 |
|---|---|---|---|
| **`simonlin1212/vibe-astock`** | 581★ / 167 fork | 情绪周期 / 赚钱效应 / 晋级率 / 梯队断层 / 炸板率**全部纯本地计算免 key**；`duanxian/emotion_metrics.py`、`risk.py`、`breadth.py` 口径蓝本；`overseas.py` 证明外盘走 `qt.gtimg.cn` 免 key 路径 | React 前端、FastAPI 服务（我们只取算法口径） |
| **`tradermonty/claude-trading-skills` @market-top-detector** | skills.sh 2.8K 安装 | **六分量加权 0–100 + 风险预算带**的骨架（R20 后加权分直接抄其结构，`worklog.md:3468`） | 数据源（要 `FMP_API_KEY`、美股口径 50DMA breadth / Put-Call） |
| **`Typedefc/LimitUpLadder`** | 1★ | 连板天梯 + **炸板归因** + 晋级率拆法（工程套路同源） | 本地 Express 代理 |
| **`quantskills/skill-b6-limitup-pool`** | 8★ | 涨停池：首板/连板数 / 炸板次数 / 分层晋级率 / 赚钱效应多维表 | `回封时间` 字段（需分钟级盘口，短期非目标） |
| **`rancy777/quantdash-ai-stock`** | 158★ | A 股看盘+复盘+盘前计划一体（功能面比我们宽，作对照） | 「见顶」专项评分（未逐文件核） |
| **`dcimring/stockbee-dashboard`** | 4★ | **Stockbee 宽度法**：momentum burst / anticipation / episodic pivot + 回测 regime timing——「宽度背离优于指数」是 L2/L3 的学理来源 | 具体实现（只读自述） |

> 注：`vibe-astock` / `market-top-detector` / `LimitUpLadder` / `skill-b6-limitup-pool` / `quantdash-ai-stock` / `stockbee-dashboard` 的字段阈值已逐条核原文（`market-top-warning-plan.md:222`），但后三者内部实现仅读自述，列为「未核实项，不作结论用」（`market-top-warning-plan.md:223`）。

### 1.3 一句话总结「采取了谁」

- **预测件方法论**：superforecasting（Tetlock）两仓 + Serenity 的「最优反解释」；
- **环境闸门**：`vibe-astock`（情绪/晋级率/炸板率口径）为主、`market-top-detector`（六分量加权骨架）为辅、`stockbee-dashboard`（宽度法学理）为补充；
- **代码层面**：**零外部运行时依赖**，全部本地自产；外部仓库只进了「方法论蓝本」这一层。

---

## 2. 禁区（现在允许放行）

### 2.1 当前禁区是什么（现状，逐条）

模型任何「明天/次日/短期上涨概率 X%」「后市涨幅 Y%」类前向判断，在落库前被 `PROBABILITY_PATTERNS` 命中并替换为占位文本，原文进 `dropped.probability_claims`。设计意图（`event-interpret-core.ts:218-226`）：
- 事件数字只能来自库事实字段，模型口里的百分比没有出处；
- **已发生的行情描述**（「航运板块今日上涨 3.2%」）**不剔除**——那是复述市场，不是发明概率；
- 连接词用 `[^。，、；\s0-9]` 而非任意非数字，避免「概率较高，涉及 5 个板块」被整段误删。

### 2.2 放行后的受控格式（允许 ≠ 放开裸概率）

放行**仅限**「带齐三段」的方向判断，且仍由正则拦截裸概率：

```
收跌概率 62% [95%CI 44–78]（N=34，历史样本 2024-08→2026-08）
证伪：若次日未跌且宽度未继续恶化 → 该见顶信号降级
```

正则从「全剥离」改为「允许受控格式」：
- **允许**：`方向 + 概率% + [Wilson CI] + (N=样本数)`，且基准率必须来自 `historical_probability` 真库；
- **仍拦**：缺少 CI / 缺少 N / 模型自编百分数 / 「历史胜率 51% 所以今天涨 51%」这类历史≠当前措辞（`findHistoricalAsCurrentClaims` 继续抓）；
- 占位文本改为：`（该概率判断已受控放行：附真实历史基准率 + 置信区间 + 证伪条件；裸概率/自编百分数仍被剔除）`。

### 2.3 三条硬条件（放开必选项，缺一不可，`forecasting-direction-unlock-plan.md:13`）

1. **必附真基准率**：`条件 X → N 笔样本，1/5/20 日 Y% 同向`，查 `probability.ts` 真库，N<30 强制「样本不足」且**不给数字**（进 `missing[]`）；
2. **必附置信区间**：Wilson 区间，宽度绑定样本量，`N` 低 → 不显示点估计；
3. **必附证伪条件**：每条判断自动写降级/证伪触发，与判断一同留档供 Brier 回测。

### 2.4 放行门槛（gate，未达不放开，`forecasting-direction-unlock-plan.md:33`）

- **样本积累**：新增每日留档（宽度快照 + 风险等级 + 次日涨跌），攒 **3–6 个月**自产数据。「今天这种下杀」需在训练集重复出现多次才训得出预警——物理限制，非加代码可绕过；
- **压力分刻度重校**：70/50/30 档位带现人工拍定，须用留档数据回标（R20b 记「至少两周才谈回测」，建议更长）；
- **Brier 回测流水线**：每条判断 N 天后自动判对错、算校准分，上线后才算「可放开」。

---

## 3. 分阶段实施（落地清单）

| Phase | 目标 | 改动文件 | 验收门槛 |
|---|---|---|---|
| **P0 数据底座** | 每日自产留档 + Brier 回填表 | 新增 `daily_snapshot`（宽度/风险/次日涨跌）、`brier_verify`；定时任务（接现有 `review-daily-collect` 同款 15:20 窗口） | 连续 2 个交易日各落 1 行；行数与当日涨停/宽度一致，不一致说清原因；先跑 3–6 个月再谈放行 |
| **P1 基率引擎强化** | CI + 样本不足标记 | `src/lib/quant/factors/probability.ts` 新增 Wilson CI 计算、`sample_ok=false` 标记 | `historical_probability` 返回值带 `[CI]` 与 `N`；单测钉住 N<30 不输出点估计 |
| **P2 受控放行** | 正则从全剥离改为受控格式 + 开关 | `event-interpret-core.ts:228` 改 `PROBABILITY_PATTERNS`；`/api/ai/chat` 新增「方向预测」输出类型，由 `FORECAST_PHASE=2` 开关控制（默认关） | 默认仍走历史胜率；开关开时带齐三段才放行，裸概率仍被拦；三处路由剥离逻辑同步 |
| **P3 Brier 闭环** | 每条判断自动回填对错与校准分 | 新增 `brier_verify` 回填任务 + 页面「过去 N 次实际准头」表 | `brier_verify` 能对每条判断自动回填；样本不足时明写不足，不给「命中率 80%」无分母数字 |
| **P4 接策略层（R26）** | 情景概率参与 `hold_days` 择一 | `src/lib/desk/intent-core.ts` / 策略层接线 | 143 条带情绪门槛的策略能看到「本档下买入条件成立/不成立」，至少 1 条因档位被挡下可复核 |

> 依赖顺序：P0 与 P1 可并行；P2 依赖 P1（CI 数据底座）；P3 依赖 P0（留档）；P4 依赖 P0+P2+R20。

---

## 4. 验收标准（放开后回放任一历史日）

1. 输出同时含 **[基准率, 置信区间, 证伪条件]** 三段；
2. `N < 30` 的日子正确**拒绝**输出数字、标「样本不足」；
3. `brier_verify` 表能对每条判断自动回填对错与校准分；
4. 裸概率（无 CI / 无 N / 模型自编）仍被截取并留档 `dropped.probability_claims`；
5. 两个概率引擎禁止混算（多份读数/同期限两条 ⇒ 维度 `DEGRADED`，`worklog.md:770`）。

---

## 5. 风险与边界（沿用红线精神，不放行时也不破）

- **不预测点位、不给买卖和仓位指令**；不做盘中高频预警（数据源是快照+轮询级，做不到）；
- **历史≠当前**：「历史胜率 51%」可写，「所以今天涨 51%」不行（`findHistoricalAsCurrentClaims` 继续抓）；
- **已发生行情描述不误删**（「今日上涨 3.2%」不在剔除范围）；
- 不新建一级菜单/新页面，不引入需另外买 key 的服务（Tushare/FMP 类）；
- 不装任何要显卡的模型；同花顺/企查查式逆向站点不稳，不做；
- 21MB 开源产业链图谱（2021 快照、下游关系几乎为空、无许可证）只当候选名单来源，**绝不当事实来源**。

---

*决策记录：用户 2026-09-29 在「先提交、先这样」之后，口头允许放开类型 B 方向概率禁区，要求先出方案（含参考仓库与功能、禁区口径、分阶段落地）再实施。本文为方案，未动代码。*
