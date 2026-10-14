# 见顶预警 · 适配方案（P15-R19 候选轮，只做梳理，未动代码）

> 状态：方案文档。本轮不 clone、不改 `src/`、不动 3010。
> 前置：与 `serenity-adaptation-plan.md` 同形态。轮次编号待与 Serenity 轮（R19–R22）统一排，本文内部称 W1~W4。
> 约束：只要 token、不要 GPU、不新增依赖包、不新增一级菜单、`REAL_DATA_ONLY` + `missing[]` 不冒充、旧钉只放宽。

---

## 0. 一页结论

用户原话：**「结合美股那边新闻、龙头滞涨、期货看空，然后还有 A 股这边风险、滞涨之类的，做一个见顶预警」**。

把它拆成四层信号后，现状是：

| 层 | 内容 | 今天能不能算 |
|---|---|---|
| L1 外盘前瞻 | 美股隔夜（纳指/标普/道指/半导体 SMH·SOXX/英伟达）、A50 期货、恒生 | **数据源现在是 0，但三条免 key 通路实测可用**（见 §5），接进来约一天工作量 |
| L2 A 股内部情绪衰竭 | 炸板率、连板高度、涨跌停比、主力净额、中位涨跌、宽度骤降 | **已接通**，但只有当日快照 + 到 09-24 的离线种子；四档风险里最高档「高风险」从来没人触发 |
| L3 龙头滞涨 / 背离 | 板块龙头 vs 板块 vs 指数；晋级率、赚钱效应（涨停口径）、梯队断层 | **基本没有**。龙头只有 `leader` 字段名，没有任何滞涨/背离度量；晋级率、1进2、梯队断层零命中 |
| L4 消息侧 | 全球事件雷达（197 条在库）、事件→板块映射 | **取数在跑**，但映射表只覆盖约 8%，且只映射到板块/概念名，落不到个股 |

**结论：这个想法能做，但不能一步做成「预测顶部」。可交付的是「风险档位 + 触发证据 + 失效条件」的见顶压力记分，且必须先补两块根：外盘行情接口（小）和逐日自产历史（卡脖子，库里现在 0 行）。**

**最贴的外部对象**：`simonlin1212/vibe-astock`（581★，情绪周期/赚钱效应/晋级率/梯队断层全部纯本地计算、免 key，外盘走腾讯 `qt.gtimg.cn`）；方法论权重结构抄 `tradermonty/claude-trading-skills@market-top-detector`（skills.sh 2.8K 安装，六分量加权 0–100 + 风险预算带）。

**落地状态（截至 P15-R20b，2026-09-28）**：L1 已接（腾讯外盘 + 新浪 A50，免 key、无新依赖）；L2 的「高风险」死档已补活（同拍数「偏高」条数升档）；L3 已落晋级率/梯队断层/赚钱效应 + 龙头滞涨（`limit-up-roster-core.ts` / `top-pressure-core.ts`）；L4 仍缺个股级映射。压力分六分量已出 0–100 + 三档带，但**刻度尚无历史样本可校**，只做「读数齐、话说清」，不做准确率承诺。本文其余章节保留作方案原貌，口径以 `worklog.md` 各轮入册为准。

---

## 1. 想法梳理：四层信号，每条都要有可计算字段

### L1 外盘前瞻（隔夜 + 盘中）

| 信号 | 字段 | 判定用途 | 来源（实测免 key） |
|---|---|---|---|
| 美股隔夜涨跌 | `us_ixic/us_inx/us_dji` 的 `price/change_pct/session` | 半导体链大跌 → A 股科技主线次日承压 | 腾讯 `qt.gtimg.cn/q=usIXIC,usINX,usDJI` |
| 美股半导体链 | `usSMH`（半导体 ETF）、`usNVDA` | A 股算力/存储/封测主线的领先变量 | 同上（`v_usSMH="200~半导体指数ETF-VanEck~SMH.OQ~606.56~...~1.0..."`） |
| 港股同步 | `hkHSI` | 盘中恒指与 A 股同向性最强，可作实时前瞻 | 腾讯 `q=hkHSI` |
| **A50 期货** | `price/涨跌/持仓量/时间戳` | 用户说的「期货看空」——A50 是 A 股唯一能盘前看的期货 | 新浪 `hq.sinajs.cn/list=hf_CHA50CFD`（带 `Referer`） |
| 事件侧 | 已入库的全球事件（197 条）里 `市场/政策/海外` 标签 | 与行情不同拍，只做「为什么」 | 已有（东财 7x24 + 新浪兜底） |

要点：**A50 期货是这套里唯一真正「前瞻」的量**，其余外盘对 A 股是隔夜的、已知信息。所以 L1 的权重不该按「外盘跌多少」直接扣分，而应只在「外盘跌幅 + A 股高位滞涨」同拍出现时才升档——否则等于用昨天的消息解释今天，属于噪声。

### L2 A 股内部情绪衰竭（已有，口径要接上）

现有 `computeSentiment()`（`src/lib/quant/screener/sentiment.ts:103-127`）已在算，且阈值是硬编码在触发规则里的：

| 指标 | 现有阈值 | 出处 |
|---|---|---|
| 涨跌家数比 | `<0.5` → 偏高；`<0.8` → 注意 | `sentiment.ts:114-115` |
| 跌停 vs 涨停 | `跌停>涨停` → 偏高；`跌停≥5` → 注意 | `:116-117` |
| 全 A 主力净额 | `<-500 亿` → 偏高；`<-300 亿` → 注意 | `:119-120` |
| 全 A 中位涨跌幅 | `<-1.5%` → 注意 | `:121` |
| **炸板率** | `>40%` → 偏高（口径 `broken/touched×100`，触板 0 → `null` 不以 0% 顶替） | `:103`、`:123-126` |
| 连板高度 | `max_boards`（20 根日K回溯，`capped` 表示 ≥20 而非恰好 20） | `screener/limitup.ts`，agent 侧 `engine.limitup` |
| 情绪温度四分量 | breadth/momentum/speculation/flow + 权重表 | `sentiment-temperature-core.ts:26-30`、`:95-174` |
| 题材四桶 | 主升/震荡/退潮/修复 | `review/market-inference.ts:61-130` |

**已发现的实锤口径漏洞**：风险档位声明了四档 `"正常" | "注意" | "偏高" | "高风险"`（`sentiment.ts:46`），`/api/market/risk/route.ts:18` 还给了「高风险」的文案，但全文件**没有任何一条规则调用 `worse("高风险")`** —— 最高档是有名无实的死档。见顶预警的第一块砖就该是把这一档配上真触发条件，而不是再加新页面。

### L3 龙头滞涨 / 背离（缺口最大，抄 vibe-astock 的口径）

`vibe-astock/duanxian/emotion_metrics.py` 里的定义可直接作为我们的口径蓝本（逐个字段核过）：

| 指标 | 它的定义 | 我们要不要照抄 |
|---|---|---|
| 赚钱效应 `money_effect` | **昨日涨停股在目标日的表现**：`avg`/`median`/`positive_rate`/`limit_up_again_rate`/`coverage_rate` | 照抄口径；注意它和我们的「MA5 上方占比」是两个不同东西（`market-inference.ts:53` 把 MA5 占比就叫「赚钱效应」，同名不同义，必须先分清） |
| 晋级率 `promotion_rates` | 昨日各档连板中今日仍涨停的比例，分桶 `1进2`/`2进3`/`3板以上晋级` | 照抄；这是「见顶」最有用的单一指标——晋级率断崖=接力资金撤退 |
| 梯队断层 `ladder_gap` | `gaps = [b for b in range(2, highest) if b not in counts]`，高标与低位之间的空档 | 照抄，纯函数、零依赖 |
| 情绪周期分 `cycle_position` | `[涨停家数, 最高连板, 1−炸板率]` 归一化均值；`lookback=10`；给 `trough_date`/`day_n`/`rising`/`trend`/`pctile` | 照抄；**特别抄它那条评论：炸板率必须先取反再平均，否则「炸板率高 → 情绪分也高」** |
| 覆盖率纪律 | `_COVERAGE_MIN=0.5` → `available=False`；`<0.9` → `partial=True` 加警告后缀；`_minmax` 在 `hi==lo` 时返回 0.5 常量 | 与我们的 `missing[]` 同源，直接对齐 |

我们侧要落 L3 还缺两件事：
1. **昨日涨停名单没有被存档**。`market_daily_stats` 只存 `t3/t4/t5/maxBoards` 这些**计数**，不存名单；`stock_daily_close` 只存 `close`，没有涨跌幅、没有涨停标记。→ 晋级率/赚钱效应必须有「昨日哪些票涨停、几板」才能算。
2. **龙头滞涨无任何实现**。全库 `leader` 只是板块行的一个字段（东财 f 列 `em.ts:364`，tdx 兜底填 `""`）。没有任何「龙头 vs 板块 vs 指数」的相对强度或背离度量。个股 `rps_50/rps_120/rps_composite` 已实现（`factors/fields.ts:85-87`），板块 RPS 读稳智种子不重算（`:464-481`）→ **龙头滞涨完全可以用现成 RPS + 板块榜自算，不用新数据源**。

### L4 分级、证伪、失效条件

抄 `market-top-detector` 的骨架（数据源不抄，它要 `FMP_API_KEY`）：

- 六分量加权 0–100：它给 Distribution Day 25% / 龙头健康度 20% / 防御轮动 15% / 宽度背离 15% / 指数技术 15% / 情绪投机 10%。**A 股映射建议**：炸板率+涨跌停 25%、晋级率+梯队断层 20%、龙头滞涨/板块背离 15%、宽度骤降（MA5 上方占比 4 日斜率）15%、主力资金净额 15%、外盘催化（A50+隔夜半导体）10%。
- 分档带 + 配套动作（它的「风险预算」是仓位建议，**这条不能抄**，改成「提示语 + 建议复核的页」）：0–20 绿 / 21–40 黄 / 41–60 橙 / 61–80 红 / 81–100 危。我们的落点是把已有四档（正常/注意/偏高/高风险）补齐，并让「高风险」第一次真能被触发。
- 它的两个值得照抄的工程细节：**data age alerts**（数据陈旧告警）与 **run-to-run variance**（两次跑动差异）；还有 **analogous historical episodes**（找相似历史片段）——对应我们 `review-stats-seed.json` 的 110 个交易日底子，可以直接做「历史上最像的 5 天 → 之后 5/10/20 日实际涨跌」。
- **证伪机制（必写）**：每次升档落一条记录（档位、触发分量、当时读数），T+5/T+10/T+20 回收真实指数与宽度变化，算命中率与误报率。没有回收闭环的预警就是占星。
- 硬边界：只给「压力档 + 证据 + 失效条件」，不给点位预测、不给买卖指令、不做个人化仓位建议（与 `prompt-library.ts:30-31` 那类「现在值得参与/左侧右侧」的问法存在张力，口径上必须以「不给出仓位」收口，Serenity 那轮已登记过同一冲突）。

---

## 2. 找到的项目（逐个核查：是什么 / 能不能直接用 / 要什么）

### 2.1 直接对标（最贴合，建议作为口径蓝本）

| 仓库 | 体量 | 与我们的关系 |
|---|---|---|
| [`simonlin1212/vibe-astock`](https://github.com/simonlin1212/vibe-astock) | 581★/167fork，Python+FastAPI+React，创建 2026-07-29，最近 push 2026-09-27 | **最贴合的一个**：涨停池·连板梯队·晋级率·赚钱效应·梯队断层·情绪周期全部「纯计算直出（不经过 AI）」，AI 只把数据串成研判。免 API key、全本地。`duanxian/` 下 47 个模块，含 `emotion_metrics.py`(23KB)、`risk.py`(29KB)、`breadth.py`(10KB)、`overseas.py`(7.5KB)、`live_emotion.py`、`theme_tree.py`、`at_risk.py`。**它的 `overseas.py` 证明了我们外盘那条路：`https://qt.gtimg.cn/q=` 拿美股指数/恒指/美股大票，无需 key**（不含期货、外汇、商品——A50 得我们另找，见 §5） |
| [`tradermonty/claude-trading-skills`](https://github.com/tradermonty/claude-trading-skills) `@market-top-detector` | skills.sh **2.8K 安装**（同仓 `ftd-detector` 2.7K、`druckenmiller` 2.9K） | 方法论骨架可抄：六分量加权 0–100 + 分档带 + data age 告警 + run-to-run variance + 历史相似片段。**数据源不可用**：要 `FMP_API_KEY`（免费档约 33 请求/次）、要 WebSearch 取 S&P 500 50DMA breadth 与 CBOE Put/Call、拉 ARKK/SOXX/SMH/XLU 等 ETF。输入校验（50DMA breadth 必须 20–100、Put/Call 必须 0.30–1.50）说明它是美股口径，A 股得换成我们的炸板率/晋级率 |
| [`Typedefc/LimitUpLadder`](https://github.com/Typedefc/LimitUpLadder) | 1★，TS + 本地 Express 代理 | 「连板天梯」：自动演算连板梯队、**炸板归因与晋级率**，行情同样从东财/腾讯/新浪取，带磁盘缓存与限流回退。工程套路与我们同源，可参考它的「炸板归因」拆法 |
| [`quantskills/skill-b6-limitup-pool`](https://github.com/quantskills/skill-b6-limitup-pool) | 8★，Python，做成 BUILD 技能（B6） | 技能形态的涨停池管理：首板/连板数/**炸板次数/回封时间**、题材分组、**分层晋级率·赚钱效应** 输出多维表格+HTML。`回封时间`是我们完全没有的字段（需要分钟级/盘口数据，短期做不了，列为非目标） |

### 2.2 可参考（工作台/口径，或纯方法论）

| 仓库 | 体量 | 备注 |
|---|---|---|
| [`rancy777/quantdash-ai-stock`](https://github.com/rancy777/quantdash-ai-stock) | 158★ | A 股看盘+复盘+盘前计划一体，集成情绪周期、板块轮动、MCP Server、飞书机器人。功能面比我们宽，但看不到「见顶」专项评分（未逐文件核） |
| [`dcimring/stockbee-dashboard`](https://github.com/dcimring/stockbee-dashboard) | 4★ | Stockbee（Pradeep Bonde）Market Monitor 宽度法：momentum burst / anticipation / episodic pivot + backtested regime timing。**「宽度背离优于指数」这套思路正是 L2/L3 的学理来源** |
| [`NikolaKovac-debug/a-share-market-analytics`](https://github.com/NikolaKovac-debug/a-share-market-analytics) | 1★ | Tushare+DuckDB+Streamlit，市场宽度/行业结构/成交活跃度/风险监控/风险预警。**要 Tushare token**，与「只吃现有 em/ths/tdx」不一致，仅作指标清单参考 |
| [`icekale/strong-stock-screener`](https://github.com/icekale/strong-stock-screener) | 33★ | 竞价雷达 + 板块资金流 + 短线情绪 + GSGF 复盘模型，依赖 TickFlow（商业源） |
| [`star23/day1global-skills`](https://skills.sh/star23/day1global-skills/us-market-sentiment) `@us-market-sentiment` | skills.sh 570 安装 | 美股市场情绪 skill，形态参考 |
| [`ssurmic/claude-investment-skills`](https://skills.sh/ssurmic/claude-investment-skills/macro-warning) `@macro-warning` | skills.sh 2 安装 | 「宏观预警」命名参考，内容未核 |
| [`morangse/daily-global-market-intelligence-description-skills`](https://github.com/morangse/daily-global-market-intelligence-description-skills) | 31★ | 全球市场日报 skill 包（含盘前/盘后、半导体、资金流向、市场情绪）；产出是文案日报，不是评分 |
| [`andthezhang/astack` `@astack-review`](https://skills.sh/andthezhang/astack/astack-review) | skills.sh | A 股复盘 skill（安装量小，未逐门核对） |

### 2.3 官方市场 / skills.sh 检索结果（如实记录）

- Qoder 官方市场 `search_extensions("见顶预警", kinds=[skill,mcp,plugin])`：**三个源全部 0 结果**（实测，非猜测）。
- skills.sh `find -- 'market-top'`：命中 17 条，去重后实质是 3 个仓（`tradermonty`、`fabio29t/trading-skills`、`ziggy5425/…` 等为同 skill 镜像/fork）。
- skills.sh `find -- 'a-share-sentiment'`：无相关（只返回飞书 lark-shared 噪声）。
- GitHub 检索：`"distribution day" market breadth`、`breadth thrust mcclellan oscillator`、`A50 futures index china`、`limit-up china stock limitup` 均 **0 结果**（英文长串词 + 概念词在 repo 检索里命中很差，中英混搜比纯英搜有效）。

---

## 3. 逐条对照表（已接通 / 有接口没进技能表 / 没有数据源）

| 需要的量 | 现状 | 位置 / 缺口 |
|---|---|---|
| 炸板率、触板、涨停、跌停、涨跌家数比、主力净额、中位涨跌 | **已接通** | `screener/sentiment.ts:103-152`，agent 有 `engine.sentiment` |
| 连板梯队（分档名单 + `boards`）、最高板、capped 语义 | **已接通** | `screener/limitup.ts`，agent `engine.limitup`（`agent-tools.ts:346-361` 已输出 tier 名单） |
| 情绪温度四分量、档位 | **已接通** | `sentiment-temperature-core.ts` |
| 题材四桶 / 退潮判定 | **已接通** | `review/market-inference.ts:61-130`（注意：这不是「五阶段生命周期机」，见顶阶段要另建） |
| 风险四档 | **半通**：四档声明 + 文案齐，但「高风险」无规则可触发 | `sentiment.ts:46/108-127`、`api/market/risk/route.ts:16-18` |
| 板块龙头字段 | **有接口未进技能表**：`board.leader` 有值（东财 f 列），但没有任何消费它的评分逻辑 | `em.ts:364`、`board-rescue.ts:32` |
| 个股 RPS（50/120/composite） | **已接通，可复用** | `factors/fields.ts:85-87`、`:1688` |
| 板块 RPS | **种子读数，不重算** | `data/rps-seed-latest.json`（`data/rps-seed.ts`）→ 龙头滞涨若要逐日自算，得自己补 |
| 全球事件（新闻侧） | **已接通**：`global_event` 197 行在库 | 映射表 `data/theme-chain-map.json` 仅 8 个 theme，覆盖率约 8%，只映射到板块/概念名 |
| 晋级率（1进2/2进3/3板以上） | **没有**，且**缺根**：昨日涨停名单未存档 | 需新增收盘后沉淀（见 §6 W2） |
| 赚钱效应（昨日涨停今日表现） | **没有**（现有「赚钱效应」是 MA5 上方占比，同名不同义） | 同上 + `stock_daily_close` 只有 `close`，无涨跌幅/涨停标记 |
| 梯队断层 | **没有**，但纯函数、可直接自算（连板名单已在内存里） | 最低成本项，W1 就能出 |
| 龙头滞涨 / 板块背离 | **没有**任何实现 | 可用现成 RPS + 板块榜 + 指数自算 |
| 美股指数/半导体/个股 | **没有数据源**，且**演示数据在误导**：`desk/data.ts:170-177` 的 `NDX100/HS300/XAU/BTC` 是 `buildQuote` 伪随机游走 | 腾讯 `qt.gtimg.cn` 实测可用（§5） |
| A50 期货 | **没有**；`em.ts:70-76 symbolToSecid` 只认 `\d{6}.SH/SZ/BJ` 与 `90.BKxxxx`，外盘一律 null | 新浪 `hq.sinajs.cn/list=hf_CHA50CFD` 实测可用（§5） |
| IF/IC/IM 股指期货、VIX、美债 10Y | **没有** | 未实测；VIX/美债可先靠事件侧，不做假接口 |
| 逐日自产历史（宽度收盘价、复盘统计） | **09-28 已补到底子层（R19b）**：`stock_daily_close` 607,036 行（真实日K回填）、`market_daily_stats` 110 行（种子照抄），都覆盖 **2026-04-20~09-24** | 再往后的日子仍要靠每天 15:20 窗口自产。**R20 注意两件事**：① 种子的「站上5日线占比」与本库真实收盘自算对不齐（106 天平均差 4.67 点、最大 14.25、相关 0.983，见 `trio-integration-plan.md` §9），**历史分位取的是本地自算那条序列，且票池是三市全A**（R19c 已把默认口径定回三市：剔北交所只把差值消掉 0.26 点，主因是同步那条在弱市里被压平，不是票池）；宽度三列在种子终点之后也已由收盘价自产，只有微/中/大盘分组仍然只有种子那份有；② 回填起点 = 种子起点 04-20，再往前没有（要更长窗口就得再接） |

---

## 4. 与既有口径的冲突（动手前必须拍板的）

1. **「赚钱效应」一词已被占用两次**：`market-inference.ts:53` = MA5 上方占比；prompt-library `:152` 问的是涨停口径。新指标若也叫赚钱效应，页面上就是两个数打架。→ 建议新指标命名 `接力溢价/涨停次日表现`，并在旧处加一行口径注。
2. **同名不同义的「情绪周期」**：我们有情绪温度（0-100 连续）+ 题材四桶（离散），vibe-astock 有 `cycle_position`（这波从哪天启动、第几天）。三者不是一回事，不能混在一张卡里。
3. **风险提示文案边界**：`risk/route.ts:18` 已写「非买卖建议」，保持；「风险预算 20–35%」这类仓位语言一律不进。
4. **`missing` 必须分态**：外盘/期货新接，失败 vs 休市 vs 无数据 vs 未覆盖不能合并成一个空（`screener/datastatus-core.ts:1-30` 已有 8 类口径，照它分）。
5. **演示数据必须断根**：`data.ts:170-177` 那四个伪随机指数还挂着，接了真外盘之后同屏出现两个「纳指」，就是口径事故。

---

## 5. 外盘/期货的两条路（实测取证，非推测）

免 key 通路已在真实网络验证过（原始输出见 §9）：

| 通路 | 端点 | 覆盖 | 我们已有同款 |
|---|---|---|---|
| 腾讯批量报价 | `https://qt.gtimg.cn/q=usIXIC,usINX,usDJI,hkHSI,usNVDA,usSMH` | 纳指/标普/道指/恒指/美股个股/行业 ETF，返回含时间戳与涨跌 | `tc-universe.ts:32` 就是同域名同拼法，`TextDecoder("gbk")` 已就位（`:39`） |
| 新浪期货/美股 | `https://hq.sinajs.cn/list=hf_CHA50CFD` | **富时中国 A50 期货连续**（价、买卖、昨结、开高低、时间、持仓量） | 新浪 Referer 头已在用（`sina-kline.ts:40`），换 host+path 即可 |
| 东财 push2 外盘 | 未探 | — | `symbolToSecid` 需扩外盘 secid 表，改动面比上面两条大，暂不选 |

→ **不需要新依赖、不需要 GPU、不需要任何新 key**，两条路各约十几行取数 + 一个纯解析函数（照 `tc-snapshot-core.ts` 的「纯文本→结构」分法）。

另一条路（备选）：完全不接行情，只做**「隔夜外盘读数快照 + 手工核对」**——每天把腾讯/新浪一次请求结果落一行，页面上只标注「探测时一口价，不自动刷」。这是 R17 已经确立的诚实口径，W1 可以先用它交付，避免一次接六个源。

---

## 6. 分轮计划（W1→W4，每轮都有验收闸）

**W1｜见顶压力记分 v0（纯 A 股内部 + 梯队断层 + 补「高风险」档）**
- 新建 `top-risk-core.ts`（纯核、零 IO）：输入 `computeSentiment()` + `computeLimitUp()` 输出，产出分量得分、0–100、四档（含真能触发的最高档）、触发证据、失效条件、`missing[]`。
- 梯队断层 `ladder_gap`（纯函数，照抄 `range(2,highest) not in counts` 口径）；连板高度衰减（`max_boards` vs 5 日前）。
- 把炸板率「取反再进情绪分」那条纪律写进注释与测试（vibe-astock 明写：否则炸板率高反而情绪分也高）。
- 落点：**不新增页**，扩 `/api/market/risk` 返回 + `RiskPage` 用现成 `LineageCard` 分节展示（跨页血缘一张看完，符合既有红线）。
- 闸：纯核测试新增；`npx tsc --noEmit` 0；测试基线 1765 / pass 1756 / fail 0 / skip 9 不许变差；旧钉只放宽；实机 `#/risk` 出档位与证据。

**W2｜把历史攒起来（09-28 已推进一半：底子有了，还差「每天落行 + 涨停名单」）**
- ~~查清 0 行~~ 已查清并处理：表没建 + 09-25 中秋休市 + review 那路 09-27 才接线。**种子核对后照抄进 `market_daily_stats`（110 行，`basis` 标外部出身），逐票收盘价用真实日K回填进 `stock_daily_close`（607,036 行）**。剩下一句仍然成立：**每天得有进程把当天那笔落下来**（09-28 起）。
- 新增「昨日涨停名单」收盘后沉淀（symbol + 连板数 + 是否炸板回封），字段级 `null` 与 `missing` 口径同 `market_daily_stats`；**不拿邻近日子顶替**（这一条与 R19b 的回填不冲突：回填用的是真实日线，不是造出来的历史）。
- 闸：连续两个交易日各落 1 行 + 名单行数与当日涨停家数一致；不一致要说清是缺数还是判定分叉。

**W3｜龙头滞涨 / 板块背离（不新接源）**
- 用现成个股 RPS + 板块榜 + 指数自算：龙头 vs 板块 vs 指数 的 5 日相对强度背离；板块内涨停家数不降但成交额萎缩（缩量新高）。
- 明写口径缺陷：板块 RPS 是稳智种子读数、不重算（`fields.ts:464-481`），所以本层只用自算的相对强度，不引种子值参与打分。
- 闸：背离样本要能在 `#/themes`/`#/sectors` 上人工复核到至少一条真实案例。

**W4｜外盘与 A50 + 证伪闭环**
- 腾讯外盘 + 新浪 A50 各一个取数函数 + 一个纯解析；出身标注 `origin`、轮询戳、失败只报错不清屏（沿用 R17 口径）。
- 升档记录落库（可复用 `risk_snapshot` 或新增一张），T+5/10/20 用真指数回收算命中率；断掉 `data.ts:170-177` 演示数据。
- 闸：能出一张「历史上最像的 5 天 → 之后 5/10/20 日实际表现」表，全用种子 110 日 + 自产行；种子止于 09-24 这件事必须在页上写明。

（Serenity 那轮占 R19–R22；本轨若优先，编号由你重排。两轨共用「vendor 不入库 / 3010 不动 / 不新增依赖」边界。）

---

## 7. 非目标

不做点位预测、不做买卖与仓位指令、不做盘中高频预警（现有源是快照+轮询级）；`回封时间`/分钟级炸板归因暂不做（要盘口数据）；不进 FactorLab 当因子回测；不新增一级菜单（走 `RiskPage` + 一张跨页血缘卡）；不装任何第三方仓为运行时依赖——外部项目一律只作口径蓝本，真要 vendor 需你当场授权；不引 Tushare/FMP 这类需另买 key 的源；不动 3010。

---

## 8. 需要你拍板的三件事

1. **先内后外还是先外后内**：W1（纯 A 股内部，最快见顶压力分）先行，还是先把美股+A50 接上（你说的「期货看空」最直观，但没有历史就只是当日读数）？
2. **W2 的存档扩展要不要做**：晋级率/赚钱效应必须有「昨日涨停名单」，这需要新增收盘后沉淀（并承认「首日必无数、从部署日往后攒」）。不做，就永远只能引用到 09-24 的稳智种子。
3. **档位口径怎么命名**：补真「高风险」触发条件（沿用现有四档），还是另立一档「见顶压力」与现有风险档并存？前者更贴我们既有页面观感，后者便于分开展示证据链。

---

## 9. 取证记录

- 免 key 外盘通路实测（本会话真实执行，非引用）：
  - `curl "https://qt.gtimg.cn/q=usDJI,usIXIC,usINX,hkHSI,usNVDA,usSMH"` → 6 条全回；`v_usIXIC="200~纳斯达克~.IXIC~27068.72~26939.37~...~2026-09-25 17:15:59~129.35~0.48~..."`；`v_hkHSI` 时间戳 `2026/09/25 18:31:13`。
  - `curl -H "Referer: https://finance.sina.com.cn" "https://hq.sinajs.cn/list=hf_CHA50CFD"` → `var hq_str_hf_CHA50CFD="14196.500,,14194.000,14196.000,14210.000,14152.000,04:56:57,14181.000,14181.000,449636,3,5,2026-09-26,富时中国A50期货,24193";`
- 库内实测（`prisma/db/custom.db`，只读 URI）：`stock_daily_close` **0 行**、`market_daily_stats` **0 行**、`risk_snapshot` 1 行、`theme_snapshot` 1 行、`probability_snapshot` 1 行、`global_event` **197 行**、`event_interpretation` 39 行。另注：`.env` 是 `file:./db/custom.db`，实际库文件在 `prisma/db/custom.db`（`db/custom.db` 只有 `User/Post`，是残留）——与既有「Prisma 幽灵路径」坑同源，值得单独留一行注记。
  **【同日 R19b 更新】** 前两个 0 行已改：`stock_daily_close` 607,036 行、`market_daily_stats` 110 行（覆盖 2026-04-20~09-24）。这一条留作「当时确实空着」的取证，不当现状读。
- 种子实测：`src/lib/quant/review/review-stats-seed.json` 110 行，首 `['2026-04-20',90,15,3,0,1,6,1814,1286,1545,75.16,71.95,75.59,79.43]`，末 `['2026-09-24',51,13,1,3,1,5,3952,3738,4159,27.56,39.29,21.9,16.37]`。
- 外部项目核查方式：GitHub `search_repositories`（多组中英查询）、skills.sh `find`（`market-top`/`market-internals`/`astock-review`/`a-share-sentiment`）、官方市场 `search_extensions`（0 结果）；`vibe-astock/duanxian/overseas.py`、`emotion_metrics.py`、`market-top-detector/SKILL.md` 取原文核对（端点、字段、阈值逐条见 §1/§2）。
- **未核实项（不作结论用）**：`quantdash-ai-stock`、`LimitUpLadder`、`skill-b6-limitup-pool`、`stockbee-dashboard` 的内部实现细节只读了仓库自述；「白毛股神 45 倍」「45x」类战绩属外部未证实说法；IF/IC/IM、VIX、美债 10Y 的免 key 通路**未实测**，不在 W4 范围内。
