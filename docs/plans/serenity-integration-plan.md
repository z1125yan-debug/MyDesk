# Serenity（白毛股神）Skill × Kairo 量化台 —— 接入方案

> 状态：**方案文档，未开工**。本轮只读代码与上游仓库，不改 `src/`、不 clone、不动 3010。
> 上游对象：<https://github.com/muxuuu/serenity-skill>（GitHub API 实测于 2026-09-29 14:50）
> 撰写日期：2026-09-29　｜　本文件**取代** 2026-09-28 的 `serenity-adaptation-plan.md`（旧文件保留作历史，不再作为施工依据）

---

## 0. 一页结论

1. **上游已换版，且换的方向对我们有利。** 现在 GitHub 上的 `SKILL.md` 是 **v1.1.0**，CHANGELOG 第一条就是「默认工作流改为 **A 股科技与先进制造**，跨市场请求显式指定时才切换」。它默认就是 A 股 —— 跟本项目同一条赛道，不需要再为「美股语料」做隔离。
2. **它的本质仍然不是指标、不是因子，是一套提问纪律 + 证据分级。** 零代码、零 API key，全部内容是一张六步研究路径 + 四档证据分级 + 一份输出模板。这和本项目 `REAL_DATA_ONLY` / `missing[]` 不冒充的口径是同一套哲学，冲突面很小。
3. **最有价值的融合点没变：`chain`「产业链挖掘」组。** 本项目已经有 4 条现成问句在问「哪个环节最紧缺、最容易涨价、谁真受益」——**只有问题，没有流程、没有证据纪律**。Serenity 补的正好就是这两样。
4. **本轮的核弹级发现：项目里有两份同源提示词库，改纪律必须两处同改。**
   - `src/lib/desk/prompt-library.ts`（15 组 50 条）→ 只喂「高价值提问」面板，点一下填进输入框；
   - `src/lib/llm/analysis-frames.ts`（14 类 50 条）→ **作为系统 Prompt 随每个对话入口下发**（`src/lib/desk/ai.ts:255`、`src/app/api/ai/chat/route.ts:208`）。
   只改面板那份 = 用户看到新问法，模型拿到的还是旧纪律。这是旧方案没点破的坑。
5. **能让纪律真正生效的只有一处：把已有接口接进技能注册表。** 项目自己的注释已经把教训写死（`skills-core.ts:79-81`、`:110-112`）：「只把工具开放给模型，模型基本不会自己调，系统必须替它取到」。Serenity 要的「板块成分股」「主营/产品构成」**两个接口后端都已经有了**，只是没进 `TOOLS`。
6. **最大硬缺口没变：项目里没有任何产业链关系数据。** 全库只有 `industry-map.ts` 的行业归属 + 东财概念板块 `BKxxxx` 成分股；供应商-客户、认证周期、产能、资本开支**都没有源**。所以第 2 步「沿供应链分层」只能由 LLM 在「概念成分 + 主营构成」上做**软拆解**，并严格标成推断。
7. **它不产出可回测因子，别当 alpha 接进 FactorLab。** v1.1.0 甚至显式写「不使用综合数字评分」——卡点判据要量化，先得有链关系数据。本轮列为**非目标**。
8. **有一处真口径冲突要你拍板**：上游禁 `执行指令 / 个性化仓位建议`，而本项目 `prompt-library.ts:28-32` 现成文案问的正是「值得参与 / 需要等待确认 / 左侧右侧趋势加速高位博弈」。处理建议见 §6.4（分组隔离，不删你的文案）。

---

## 1. 上游核查（本次实测，2026-09-29 14:50）

### 1.1 仓库元数据

| 项 | 实测值 |
|---|---|
| full_name | `muxuuu/serenity-skill` |
| 描述 | Serenity-inspired Agent Skill for supply-chain bottleneck stock research |
| Stars / Forks | **4,042** / 629 |
| License | **MIT**（`LICENSE` 1061 B） |
| created / updated / pushed | 2026-05-04 / 2026-09-28 / **2026-09-16** |
| default_branch | `main` |
| 体积 | 71 KB（纯文本仓库，无构建产物） |
| language / topics | Python（仅 `scripts/validate_skill.py`）/ agent-skills, investment-research, stock-research, supply-chain |
| open issues | 2 |

> 注意 `updated_at`(09-28) 晚于 `pushed_at`(09-16)：说明近期只有元数据/社交动作变化，**代码本体停在 09-16**。旧方案引的「最近更新 2026-09-27」是元数据时间，不是内容时间。

### 1.2 文件清单（28 个 blob，逐条实测）

```
SKILL.md                                7,485 B   ← v1.1.0 正文
README.md                              11,999 B  ← 中文主入口
README.en.md                            8,348 B
CHANGELOG.md                            1,159 B  ← 有 1.1.0（Unreleased）与 1.0.0
CONTRIBUTING.md                         1,360 B
LICENSE                                 1,061 B   MIT, Copyright (c) 2026 muxu
.gitignore                                 41 B
references/deep-research-workflow.md    5,303 B
references/evidence-ladder.md           4,339 B
references/market-source-playbook.md    3,752 B
references/risk-and-compliance.md       2,413 B
references/serenity-dialogue-protocol.md 2,201 B
references/output-style-and-language.md  2,098 B
references/public-profile-and-evaluation.md 2,046 B
references/research-sources.md            924 B
assets/thesis-template.md               1,404 B   ← 已是中文模板
assets/research-prompt-pack.md          1,862 B   ← 5 个可复制 prompt
examples/a-share-ai-semiconductor-demo.md 7,817 B ← 真实公开资料案例（截至 2026-09-14）
examples/cpo-company-challenge.md       5,880 B
examples/demo-conversation.md           1,095 B
evals/test-cases.md                     2,241 B
scripts/validate_skill.py               1,963 B   ← 只查名称/描述/目录结构，不验结论
agents/openai.yaml                        416 B
```

### 1.3 SKILL.md 六步路径（原文要点，逐条译述）

`SKILL.md` 的 `## Follow the investment logic` 是 **6 条**（旧方案记的「五步」对应的是 `references/deep-research-workflow.md`，两份口径略有出入，施工以 SKILL.md 为准）：

| # | 步骤 | 关键要求 | 对 A 股可执行度 |
|---|---|---|---|
| 1 | **System change** | 什么需求/技术变化造成压力，哪条物理或经济约束真正要紧 | **高**（纯提示词） |
| 2 | **Supply-chain position** | 受影响的是元件/工艺/设备/材料/基础设施哪一类，客户有什么替代方案 | 中（分层靠 LLM 软拆） |
| 3 | **Company exposure** | 它到底卖什么、卖给谁、处于什么商业阶段；**开发/送样/客户测试/认证/量产/订单/交付/确认收入 必须分开** | 中高（主营构成接口已有） |
| 4 | **Earnings capture** | 这业务有多大分量，需求能否变成收入/毛利/现金流/股东利润 | 中（财报三表接口已有） |
| 5 | **Valuation and timing** | 用带日期的行情与明确盈利期，判断已 price in 了什么；价格数据缺失就说「价格吸引力未决」 | 中高 |
| 6 | **Counterargument** | 什么证据/变化会让优先级下降 | **高**（纯推理，专治题材吹） |

外加两条硬纪律：**层级优先级要先于个股排序讲**；**上游位置、冷门名字、不受欢迎的观点，本身不构成更高优先级**。

### 1.4 四档证据分级（`evidence-ladder.md`）

- **Confirmed disclosure**：打开的材料在所述范围内直接这么说；公司自己的说法即使缺外部印证也归此档。
- **Supported inference**：观察到的事实支持某解读，但没直接这么说；**必须同时写推理链和竞争性解释**。
- **Unverified lead**：关键证据缺失/拿不到，或只来自转述与社交讨论。
- **Contradicted claim**：有适用来源直接冲突；**必须记冲突点与日期**。

配套还有一张「材料 → 能证明什么 → 还缺什么」的表（财报 / 投资者问答 / 客户披露 / 专利论文 / 项目批文 / 产品页 / 行业研究 / 社交帖子），以及一条红线：**证据置信度 ≠ 研究优先级**（证实的商业事实不等于好价格；未证实的叙事也不自动剥夺研究注意力）。

### 1.5 输出面（可直接借用）

- `assets/thesis-template.md`：已是**中文**「投资研究备忘录」——先说判断 → 产业链与公司位置 → 证据与推理（表）→ 从业务到利润 → 比较与反方理由 → 下一步查什么 → 资料范围。
- `assets/research-prompt-pack.md`：5 个可复制模板（A 股主题扫描 / 公司挑战 / 候选比较 / 研究备忘录 / 引导式学习）。
- `references/risk-and-compliance.md`：**给好了中英文可用措辞**，如「我会按优先研究价值排序。买卖动作由你自己决定。」「这个现在还只是线索，缺客户认证和收入结构证据。」
- `references/market-source-playbook.md` 的 A 股取数路径：年报/半年报/季报/临时公告 → 交易所问询函 → **互动易 / 上证 e 互动** → 招投标中标 → **环评/能评/地方项目备案** → 专利/标准/行业协会 → **海关数据、上下游上市公司交叉验证**。其中大半本项目**没有数据源**（见 §3）。

---

## 2. 与旧方案（2026-09-28）的差异

| 项 | 旧方案读到的 | 本次实测 |
|---|---|---|
| 版本 | 未标版本 | **v1.1.0（CHANGELOG 标 Unreleased）** |
| 默认市场 | 「A 股可执行度」逐条评 | **v1.1.0 已把默认 universe 定为 A 股科技/先进制造** |
| 投资逻辑步数 | 五步 | SKILL.md **六步**；`deep-research-workflow.md` 仍是五段结构 |
| 证据档 | 四档 | 四档不变，但新增「材料→能证明什么」对照表 |
| 中文资产 | 无 | `thesis-template.md` / `research-prompt-pack.md` / `risk-and-compliance.md` 均**已提供中文口径措辞** |
| 新增文件 | 未列 | `CHANGELOG.md` / `CONTRIBUTING.md` / `README.en.md` / `evals/test-cases.md` / `agents/openai.yaml` |
| 项目侧最大遗漏 | 未提 | **两份同源提示词库**（`prompt-library.ts` 面板 50 条 vs `analysis-frames.ts` 系统 Prompt 50 条）必须同改 |

---

## 3. 取证需求 vs 项目现状（全部实读核对）

状态三档：**已接通**＝现成能用；**有接口未进技能表**＝后端已实现、模型却调不到（**最划算的改造点**）；**没有数据源**＝本轮造不出来。

| Serenity 需要 | 项目现状（实读位置） | 状态 |
|---|---|---|
| 主题/概念板块资金榜 | `sector_rank`（`chat-tools.ts:934`，`phase: local_data`） | 已接通 |
| **板块 → 成分股** | `GET /api/market/sectors/[code]`（`src/app/api/market/sectors/[code]/route.ts`：`BK\d+` 校验 `:25`、进程内 TTL 60s `:20`、返回 `symbol/name/industry/price/changePct/amountYi/turnover/mainNetYi/st/suspended` `:39-45`） | **有接口未进技能表**（`TOOLS` 里没有 `sector_constituents`） |
| **它卖什么（主营/产品构成）** | `fetchMcpProductInfo`（`src/lib/quant/data/mcp-provider.ts`）已被 `/api/stock/fundamental` 调用（`route.ts:48`），缺失时如实进 `missing`（`route.ts:67`「产品/业务构成」）；`get_stock_basic_info.主营业务` 在 `ProfilePage.tsx:314` 已渲染 | **有接口未进技能表** |
| 财报三表 / 财务指标 | `fetchMcpBalanceSheet/IncomeStatement/CashFlow/FinancialMetrics`（`fundamental/route.ts:34-38`） | **有接口未进技能表** |
| 券商研报 / 业绩预测 | `fetchMcpResearchReport` / `fetchMcpProfitForecast`（`fundamental/route.ts:46-47`） | **有接口未进技能表** |
| 公告 / 订单 / 交付线索 | `stock_news`（`chat-tools.ts:943`，`phase: external_data`，东财新闻+公告含栏目） | 已接通（**仅标题/摘要级，读不到公告全文 PDF**） |
| 涨价 / 毛利 / 现金流 / 资本开支 | 经 `china-stock-mcp` 财务三表可达；因子目录 `src/lib/quant/factors/fields.ts` | 部分接通，字段名需逐个对齐 |
| 热度是趋势还是炒作 | `factor_screener`（`:949`）/ `candidate_pool`（`:950`）/ `historical_probability`（`:951`）/ `run_backtest`（`:954`） | 已接通 |
| 供应商-客户 / 产业链关系图 | **无**。仅 `industry-map.ts` 行业归属 + `data/industry-map.json` + `ths.ts` 同花顺概念资金流 | **没有数据源** |
| 认证周期 / 良率 / 产能预订 / 扩产难度 | **无结构化字段** | **没有数据源** |
| 全球供应链证据 | 仅 `market_overseas`（`chat-tools.ts:932`）+ `market_news`（`:940`） | 只能到「有全球消息线索」，到不了全球供给数据 |
| 通用网页搜索 / 公告全文解析 | `TOOLS` 里无 web search | **没有该能力** |
| 互动易 / 招投标 / 环评能评 / 海关数据 | **无** | **没有数据源** |

**结论**：第 1、3、5、6 步可立刻落地（纯提示词 + 已有接口）；第 2、4 步的强度取决于 §3 两项接口能否进技能表；卡点判据在拿到链关系数据前只能是「LLM 推断 + 明确留空洞」。

---

## 4. 接入形态选型

| 形态 | 做法 | 评价 |
|---|---|---|
| **A. 只当提示词纪律** | 只改 `chain` 组文案 + 输出形状 | 成本最低，但模型拿不到主营构成，「分层」只能靠先验 → 半成品 |
| **B. 纪律 + 把已有接口接进技能表** | A + `sector_constituents` / `stock_business_composition` 进 `TOOLS` 与 `BUILTIN_SKILLS` | **推荐**。唯一能让纪律真取到数 |
| C. 独立页面 / 新子菜单 | 新建「产业链研究」页 | **违反既定红线**（不加一级菜单、不加子菜单）；且 `themeoverview` 血缘总览已能承接展示 |
| D. 把整包 vendor 挂成运行期 Skill 目录 | 把 `SKILL.md + references` 拷进项目当 skill 运行期加载 | 与「对话层统一管理、与模型解耦」口径冲突；本项目没有运行期 skill 加载器（全仓搜 `SKILL.md` 只有两处注释提及），要做等于新建一套机制，**不推荐** |

**推荐 B**，分三个落点，按性价比排序见 §5。

---

## 5. 三个融合落点（按性价比排序）

### 5.1 落点①：`chain` 组升级为「六问纪律 + 四档证据」

- **位置（两处，必须同改）**：
  - `src/lib/desk/prompt-library.ts:54-64`（`key: "chain"`，🏭，现 4 条）
  - `src/lib/llm/analysis-frames.ts:50-58`（`title: "产业链挖掘"`，现 4 条）
- **为什么两处**：前者喂「高价值提问」面板（`AssistantPage.tsx:547` 渲染），后者由 `renderAnalysisFrames()`（`analysis-frames.ts:153-166`）拼进系统 Prompt，注入点 `src/lib/desk/ai.ts:255` 与 `src/app/api/ai/chat/route.ts:208`。只改一处 = 用户看到新问法、模型还在旧纪律上答。
- **改法**：
  1. 组内新增 1 条**流程型**文案，形状照 SKILL.md Step 3 的商业阶段拆分写，例如：「先别给名单。把我说的这个题材拆成 6 个环节（终端需求/系统集成/模块/芯片器件/工艺封装/设备材料），每个环节写清『卡在哪、谁认证过、谁在量产、订单有没有披露』，再把 A 股候选挂回环节上。」
  2. 现有 4 条保留，给「哪个环节最紧缺」那条加一句约束：「紧缺判定必须给证据档次；没有披露就写『未知』，不许用概念标签冒充主营。」
  3. 输出形状固定四段：**分层地图 → 卡点候选 → 标的挂回（含证据档次）→ 证伪条件与未知项**；第四段非空，否则视为没做完。
  4. 文案对着本项目字段名写（`mainNetYi`/`amountYi`/`changePct` 那套），**不照抄英文原句**，避免模型引用不存在的字段。
- **成本**：纯文案 + 1 条形状拦门测试。**风险**：低。**收益**：直接改研报观感与「题材吹」过滤力。

### 5.2 落点②：把两项已有接口接进技能注册表（唯一让纪律真取到数的地方）

- **位置**：
  - `src/lib/desk/chat-tools.ts`：`TOOLS`（`:930-972`，19 个内置项）与 `ChatTool.phase`（`:927`，P35 起内置工具**一律显式标注**）。
  - `src/lib/desk/skills-core.ts`：`SkillArgs`（`:16`）、`SkillReason`（`:18`）、`BUILTIN_SKILLS`（`:60-135`，13 项）、`registerSkill()`（`:206-208`，自称「给扩展方的唯一注入口」）。
  - `src/lib/desk/intent-core.ts`：`argsOf`（`:532` 起，参数拼装唯一出处）、`planDispatch`（`:498`）。
- **改法**：
  1. `chat-tools.ts` 新增两个工具本体：
     - `sector_constituents`（包 `GET /api/market/sectors/[code]?kind=concept`，返回 `BK...` 成分股），`phase: "local_data"`；
     - `stock_business_composition`（包 `fetchMcpProductInfo` + `get_stock_basic_info.主营业务`），`phase: "external_data"` 或 `"research"`（二选一，按 `chat-tools.ts:913-927` 的阶段定义定）。
  2. `skills-core.ts` 新增 1 条 `Skill`，`plan` 挂 `scene: "sector"`（`sector_constituents`）与 `scene: "stock_analysis"`（`stock_business_composition`）。**不新增 scene**（`Scene` 是联合类型 `intent-core.ts:24-32`，扩它要同步 `SCENES`、`SCENE_LABELS`、`SCENE_DISPATCH_CONFIG`、`SCENE_PREFERS` 五处，爆炸面大）。
  3. `SkillArgs` 新增 `board_code`；`argsOf` 里加对应分支（板块代码从用户提问里抽 `BK\d+` 或从上一轮 `sector_rank` 结果里取，需要一个纯函数 `extractBoardCodes()`，与 `extractSymbols()`（`intent-core.ts:146`）同族）。`SkillReason` 新增键，`SCENE_LABELS` 之外的文案键同步。
  4. **不标 `required`**（照 `stock_depth`/`stock_trades` 先例 `skills-core.ts:82-91` 与其测试 `p8-skills-loop.test.ts:41-46` 的口径）：MCP 网关没起就进 `missing[]` 留痕，不拖垮整轮。
- **成本**：中（动两张注册表 + 调度断言 + 参数拼装）。**风险**：中——表驱动改动必须逐字保住既有编排。**收益**：这是**唯一**能让「纪律」变成「系统真的替模型取到主营构成」的落点。

### 5.3 落点③：输出面复用现成容器（不新建页）

- `CandidatePool`（`/api/pool/freeze`、`/api/pool/[id]/verify`）承接「卡点研究清单」；`ResearchReport`（`/api/research` + `/api/research/prompt`）承接四段式研报；`ThemeSnapshot` 承接分层快照。
- 展示候选位（**本轮只列不做**）：`themeoverview` 主题血缘总览。你已拍过红线——要「一张跨页血缘总览看完一件事」，不是每页塞一张卡、不是加子菜单。Serenity 的「主题→环节→标的→证据」与血缘图同构，是最自然的展示位。
- 若要 agent 化执行（多步带预算）：`/api/agent/run|tool|tools|finalize` + `AgentRun.budgetJson` / `AgentToolCall` 已就绪；Serenity 流水线可以是一个 agent run，而不是一个前端按钮。留到落点①②验收后再议。

---

## 6. 口径冲突与红线（必须先认）

1. **全文披露 vs 只有摘要。** 上游要求「读完整文件而非搜索摘要」。本项目 `stock_news`（`chat-tools.ts:943`）是东财新闻 + 公告列表**标题级**。→ 提示词里写明「本项目公告证据止步于披露标题/摘要，凡需读正文才能确认的一律记 `Unverified lead`」。宁可降级也不冒充，正好是 `missing[]` 的语义。
2. **全球证据要求 vs A 股取数。** 上游明说「即使最终候选是 A 股公司，也要用全球供应链证据」。本项目只有 `market_overseas`（指数/ETF/期货读数）与 `market_news` 快讯。→ 全球层写成「必做但允许留空洞」，输出里出现 `全球层：未取到（缺 xxx 数据）` 而不是省略。
3. **上游断源风险。** 概念板块成分股依赖东财 `push2`/`push2delay`，本项目有断源史（P8 接腾讯、P9 接新浪备胎；2026-09-29 实测东财全 A 全量扫描仍退腾讯兜底）。断源时第 2 步整条分层会空。→ 必须走「轮询失败只报错不清屏、旧数标旧时」，**不许静默退化成 LLM 凭空分层**。
4. **禁给仓位建议 vs 现有交易决策文案。** 上游禁 `execution directives / individualized allocation guidance`；本项目 `prompt-library.ts:28-32`（`worth-buying` 组）与 `analysis-frames.ts:29-31` 现成的「值得参与 / 等待确认 / 暂时没有机会」「左侧/右侧/趋势加速/高位博弈」正是这类问法。→ **不删你的文案**，而是划清边界：`chain`（卡点研究）组的输出只到「研究优先级清单 + 证伪条件」；交易类问法继续留在 `worth-buying` / `signal` 组，两组文案不互抄、不混排。若同一份研报里既给分层又给参与判断，需明示「后半段属交易决策语境，非本方法论结论」。
5. **45 倍战绩不可复制。** 上游自己在 `public-profile-and-evaluation.md` / `risk-and-compliance.md` 里把这类战绩标为**未经核实的外部说法**。→ 本项目引用时口径写「第三方提炼的公开方法论，非官方、非业绩背书」。
6. **新增红线：不打分。** v1.1.0 显式「Replaced the numerical scorecard with the existing research memo template」「不使用综合数字评分」。本项目已有 `risk` / `market_score` 一类分数（`screener/sentiment.ts`、`top-risk-core.ts`）。→ 两者必须分开标：Serenity 的**研究优先级**（高/中/低 + 文字解释）不得与本项目的**情绪温度/压力分**混成一个数。

---

## 7. 非目标（本轮明确不做）

- 不做卡点因子进 FactorLab / 不进回测（缺链关系数据；上游自己也不打分）。
- 不引入 `yan-labs/serenity-aleabitoreddit`（6,592 条推文 + 4 篇长文语料，**美股语料**、第三方归档他人推文）与 `lanfuli/aleabito-serenity-skills`（需 `X_BEARER_TOKEN`）。
- 不新增一级菜单、不新增子菜单、不新增依赖包、不新加 `.env` 变量。
- 不动 3010（重启授权已用掉）。
- 不把 vendor 内容写进 Prisma 迁移或入库（DB 永不入库约束）。
- **不接东财**（你 2026-09-29 已拍板：暂时保持现状，全 A 列表继续腾讯兜底）。

---

## 8. 分轮落地计划

| 轮 | 交付 | 验收闸 |
|---|---|---|
| **R20** | vendor 引入：`git clone` 到 `vendor/serenity-skill/`（保留 `LICENSE` 与 MIT 版权行——MIT 要求附版权声明），并在 `references/` 基础上写一份**中文口径卡**：四档证据 → 本项目 `origin` / `missing[]` 的映射表 | `node --test "tests/quant/**/*.test.ts"` 与 `tsc --noEmit` 不受影响（vendor 是纯文本，不进编译图）；vendor 是否入 git 见 §9 第 1 问 |
| **R21** | 落点①：`chain` 组**两处同改**为四段式流程纪律（对着自有字段名写） | 新增 1 条形状拦门钉（输出必含 分层/卡点/挂回+档次/证伪与未知 四段，末段非空）；**旧钉只放宽不收紧**；基线见 §8.1 |
| **R22** | 落点②：`sector_constituents` + `stock_business_composition` 进 `TOOLS` 与 `BUILTIN_SKILLS`，并加 `board_code` 参数通路，不标 `required` | `p8-skills-loop.test.ts:30` 的 `BUILTIN_SKILLS.length === 13` **必须同步改成 15 并说明**；`p35-wz-phase-key.test.ts` 新工具必须标 `phase`；`p7-intent.test.ts` / `p7-dispatch.test.ts` 逐字保住既有调度；新增 2 条纯核测试（`BK` 代码非法 / MCP 未配置 → `missing[]` 不冒充）；实机走查一次「产业链挖掘」出研报 |
| **R23**（后话） | 落点③：主题血缘总览承接分层图；或 agent run 化 | 另开轮 |

每轮按既有协议收口：报告 → 验收 → 两笔提交（代码一笔 / worklog 一笔）。

### 8.1 本轮实跑的测试基线（2026-09-29 14:55）

```
node --test "tests/quant/**/*.test.ts"
# tests 1910 | pass 1898 | fail 3 | skip 9 | duration 50.2s
```

**3 条失败全部与 Serenity 无关，是今日改动留下的旧钉未同步**（施工前必须先决定怎么处理，否则无法用「不许变差」当验收闸）：

| # | 位置 | 断言原文 | 现状 | 性质 |
|---|---|---|---|---|
| 1 | `tests/quant/p15-r13-session-ttl.test.ts:65` | 正则钉 `store.ts` 源码形状 `pruneStaleChats: () => set((s) => { const sessions = pruneStaleCore(s.sessions);` | `newSession` 里已改为建会话时裁剪到 3，源码形状变了 | **旧钉过期**（建议改为行为断言，不再钉字符串形状） |
| 2 | `tests/quant/p20-sidebar-recent.test.ts:26` | `.slice(0, 5)`「必须限到 5 条，参考平台就是最近 5 条」 | `Sidebar.tsx:54` 已是 `.slice(0, 3)` | **口径被你改了**（要 3 条），测试须跟着改 |
| 3 | `tests/quant/p50-ui-scale.test.ts:40` | `rounded-lg px-3 py-2 text-left text-[14px]` | 已是 `rounded-lg py-2 pl-3 pr-8 text-left text-[14px]`（为 ❌ 删除按钮留右侧位） | **旧钉过期** |

> 说明：`node --test tests/quant/` 这种传目录的写法在 Node 22.22.2 会报 `MODULE_NOT_FOUND`，必须用 glob：`node --test "tests/quant/**/*.test.ts"`。

---

## 9. 需要你拍板的四件事

1. **vendor 目录的 git 处理**：`vendor/serenity-skill/` 提交进仓库（含 MIT 版权行，便于追溯），还是加 `.gitignore` 只留本地？（你已有「DB 与 P1P2 删除永不入库」的习惯，第三方原文可能同样不想入库）
2. **R21 与 R22 是否同一轮做**，还是 R20 让你先看 vendor 内容再放行。
3. **`chain` 组输出允不允许附带参与/等待判断**——即 §6.4 的边界怎么划（纯研究清单 / 允许附带但必须标语境）。
4. **是否允许新增 `board_code` 参数通路**（动 `intent-core.ts` 的 `argsOf` 与 `SkillArgs`）——这是落点②里影响面最大的一处；若不许动，落点②就退化为「只把两个工具开放给模型自取」，实测模型基本不会自己调，收益接近于零。

---

## 10. 取证记录

**上游（本次实测）**
- `GET https://api.github.com/repos/muxuuu/serenity-skill`：4,042★/629 fork/MIT/created 2026-05-04/updated 2026-09-28/pushed 2026-09-16/default main/71 KB/topics 7 项。
- `GET .../git/trees/main?recursive=1`：28 个 blob，路径与字节数逐条列于 §1.2（`truncated: false`）。
- 逐字读取：`SKILL.md`（7,485 B，v1.1.0）、`README.md`、`references/deep-research-workflow.md`、`references/evidence-ladder.md`、`references/risk-and-compliance.md`、`references/market-source-playbook.md`、`assets/thesis-template.md`、`assets/research-prompt-pack.md`、`CHANGELOG.md`。

**项目侧（实读位置）**
- `src/lib/desk/prompt-library.ts`（15 组 50 条；`chain` 组 `:54-64`）
- `src/lib/llm/analysis-frames.ts`（14 类 50 条；产业链挖掘 `:50-58`；`renderAnalysisFrames()` `:153-166`）
- `src/lib/desk/ai.ts:255`、`src/app/api/ai/chat/route.ts:208`（两处注入点）
- `src/lib/desk/skills-core.ts`（`SkillArgs:16`、`SkillReason:18`、`BUILTIN_SKILLS:60-135`、`registerSkill:206`、`DISPATCH_MAX_SYMBOLS/ANALYSIS_MAX:54-56`）
- `src/lib/desk/chat-tools.ts`（`TOOLS:930-972`、`ChatTool.phase:927`、`registerChatTool:984`、`phaseOfTool:1012`）
- `src/lib/desk/intent-core.ts`（`Scene:24-32`、`SCENES:34`、`SCENE_LABELS:45-54`、`scenePrompt:338`、`toolsForScene:441`、`planDispatch:498`、`argsOf:532`）
- `src/app/api/market/sectors/[code]/route.ts`（全文件 51 行）
- `src/app/api/stock/fundamental/route.ts`（`:34-51` 十六路并发、`:53-69` missing 清单）
- 测试闸：`tests/quant/p7-intent.test.ts`（35 个 `test()`）、`p7-dispatch.test.ts`（21 个）、`p8-skills-loop.test.ts:30/41-50/53-60`、`p35-wz-phase-key.test.ts:35`、`p15-r13-session-ttl.test.ts:65`、`p20-sidebar-recent.test.ts:26`、`p50-ui-scale.test.ts:40`
- 基线命令与结果：§8.1

**未核实项（诚实标注，不作结论用）**
- `china-stock-mcp` 各工具（`get_product_info` / 券商研报 / 业绩预测 / 筹码）**本轮未实机探测**是否可用；`/api/stock/fundamental` 是否会因某块上游挂掉而整路 502 需另测。
- `factors/fields.ts` 里「资本开支 / 毛利率 / 产能利用率」的确切字段名**未逐个对齐**。
- `evals/test-cases.md`、`references/serenity-dialogue-protocol.md`、`references/output-style-and-language.md`、`references/research-sources.md`、`references/public-profile-and-evaluation.md`、`examples/*.md`、`scripts/validate_skill.py`、`agents/openai.yaml` **只取到字节数与路径，正文未读**（施工前若要引用措辞需补读）。
- 官方市场 `search_extensions` 与 skills.sh 是否已收录该仓库**本轮未复查**；引入路径按第三方 GitHub 仓库处理，属第三方代码，需你授权才动。

---

## 11. 落点① 已落地（2026-09-29 15:05，用户拍板「就按照这个来，必须保证数据真实」）

### 11.1 实际改了四处（全是现成件；未新建页、未动模式、未动存档）

| # | 文件 | 改了什么 |
|---|---|---|
| 1 | `src/lib/desk/modes.ts` | 新增导出 `CHAIN_RESEARCH_SKELETON`（1,251 字），与 `MARKET_OUTLOOK_SKELETON` 并列。**故意不进 `MODE_NOTES`**——`p8-mode-anywhere.test.ts:22` 钉死「风格句与四模式同键同序」 |
| 2 | `src/app/api/ai/chat/route.ts` | ① import；② 系统提示词数组里挂在 `MARKET_OUTLOOK_SKELETON` 之后；③ 同时进 `lastUserEcho` 回显语料（弱指令模型整段抄回时由输出护栏剥掉） |
| 3 | `src/lib/desk/ai.ts` | `assistantSystemPrompt()` 里挂在 `renderAnalysisFrames()` 之后（覆盖纯对话端点与浏览器凭据直连两路） |
| 4 | `src/lib/desk/prompt-library.ts` | `chain`「产业链挖掘」组 4 条 → **6 条**（新增「六环拆解 + 四档证据」与「上下游各走一层 + 八个商业阶段 + 反方理由」）；面板总数 50 → **52** |

### 11.2 「必须保证数据真实」是怎么钉进提示词的（三道闸）

1. **四档证据**：每条结论必须挂「已披露事实 / 支持性推断 / 未证实线索 / 与事实冲突」；支持性推断必须同时写推理链与竞争性解释。
2. **未知项必须非空**：第四段「证伪条件与未知项」为空视为没做完，必须写清「还缺什么数据才能把某条从线索升到事实」。
3. **数据真实性硬纪律 + 硬缺口白名单**：链上每一环、每个候选都必须是**本轮工具真取到**的（板块成分股 / 主营构成 / 行情 / 资金 / 快讯）；供应商-客户关系、认证周期、产能与良率、互动易与上证 e 互动、招投标、环评能评、海关数据——一律写「暂无数据」，**不许拿推断填坑、不许拿概念板块涨跌冒充产业事实**。

### 11.3 验证（全部实跑）

```
npx tsc --noEmit                       → 0 错误
node --test "tests/quant/**/*.test.ts" → tests 1910 | pass 1898 | fail 3 | skip 9
```

- 与施工前基线（§8.1）**逐项一致**，**零新增失败**；3 条 fail 仍是那三条旧钉。
- 施工中撞了一次钉：`p52-no-echo.test.ts:40` 禁用反例字样「用户问的是」，骨架首句原写「当用户问的是…」→ 改写为「当问题落在…这一档时」；该文件 + p7-dispatch + p8-mode-anywhere + p15-r20-modes-cards + p55-context-echo + p7-llm-config 共 **123 测全过**。
- 交付验证脚本 `D:/WorkBuddy/2026-09-29-12-15-54/verify-serenity.mjs`：16 项断言（骨架要素齐全 / 真的进了两条链路的提示词 / chain 组 6 条 / 总数 52 / 50 框架段与 MISSING 段未被挤掉）。

### 11.4 本轮未做

- §9 四件拍板项（vendor 入库口径、R21/R22 是否合轮、`chain` 组是否允许附带参与判断、是否开 `board_code` 参数通路）。
- **落点②**（把 `sector_constituents` / `stock_business_composition` 接进 `TOOLS` + `BUILTIN_SKILLS`）未做——要动 `intent-core.argsOf` 与一串钉测，属第 4 件拍板项。

---

## 12. 缺的数据去哪找：开源 / 公开数据源调研（2026-09-29 15:10）

> 取证口径：**「我实测」= 本轮亲自取到仓库元数据或接口事实；「检索所得」= 来自公开检索，未实机跑通**。凡标「检索所得」的，接入前必须自己打通一次，别直接进代码。

### 12.0 最重要的发现：六问里最缺的「商业阶段 / 产能 / 认证」其实有源

**互动易（深交所，irm.cninfo.com.cn）+ 上证 e 互动** 就是这些信息的法定出口。实例（检索所得）：三安光电在互动易答复里逐条给了「1.6T 光芯片已向客户送样验证」「光技术产能 2,750 片/月、外延扩产至 6,000 片/月」「SiC MOSFET 已在国内头部电动车企通过验证」「安意法现有产能 2,000 片/周、已进入风险量产」——正是六问第 3 步要的「八个商业阶段」与第 2 步要的产能口径，且是**公司自己披露的原文**，够得上「已披露事实」这一档。

| 缺口 | 候选数据源 | 取证状态 | 关键限制 |
|---|---|---|---|
| 互动易 提问 / 回答 | `akshare.stock_irm_cninfo()` / `stock_irm_ans_cninfo()`（源 irm.cninfo.com.cn） | 检索所得 | 按个股逐只取；解析式接口，源站改版即失效，须锁版本 + 每日校验 |
| 上证 e 互动 | `akshare.stock_sns_sseinfo()` | 检索所得 | 同上 |
| 机构调研 / 投资者关系活动记录表 | `akshare.stock_jgdy_tj_em()`（统计）/ `stock_jgdy_detail_em()`（明细，每家机构一行，`date` 是 `>=` 过滤不是精确匹配） | 检索所得 | 明细量大；东财数据中心口径 |
| 主营介绍（同花顺口径，可交叉核对已有东财主营构成） | `akshare.stock_zyjs_ths()` | 检索所得 | 项目已有 `fetchMcpProductInfo`，这条是第二家口径 |

**结论**：第 3 步「公司暴露度（八个商业阶段）」与第 2 步「产能口径」**不必再留空洞**，接两个接口就有源；但只能采「公司原文表述」，不许把互动易里的定性话升格成产能事实。

### 12.1 供应商-客户关系（硬缺口第一项）

| 候选 | 性质 | 取证状态 | 关键限制 |
|---|---|---|---|
| 年报「前五名客户 / 前五名供应商」附注 | 法定披露原文 | 检索所得 | **无现成结构化 API**，要从巨潮年报 PDF 抽表 |
| `liuhuanyong/ChainKnowledgeGraph` | 开源知识图谱（A股 4,654 家 / 行业 511 / 产品 95,559 / 上游材料 56,824 / 下游产品 390） | **我实测**：778★ / 181 fork / Python / created 2021-10-26 / pushed 2025-12-22 / **license: null** | **无许可证**，商用引用有风险；建的是「行业-产品」边而非公司-公司合同边；基础数据世代偏旧 → 只能当**先验骨架**，不得当「已披露事实」 |
| CnOpenData「A股上市公司供应链数据」/ DataSeed「上下游供应商客户数据集」 | 商业数据集（前五客户/供应商明细，2001-2025） | 检索所得 | **付费**；字段齐（客户名称/销售额/占比），接进来六问第 2、3 步就有真数据 |
| `legeling/Annualreport_tools`（含 `mda_extractor.py`） | 开源自建：巨潮年报爬取 → PDF→TXT → MD&A 段落抽取（SQLite+DuckDB） | 检索所得 | 自建成本最高但可控；抽「前五名客户/供应商」表要再补一层表格解析 |

### 12.2 招投标

| 候选 | 性质 | 取证状态 | 关键限制 |
|---|---|---|---|
| 中国政府采购网 / 中国招标投标公共服务平台（cebpubservice.com） | 政府公开数据 | 检索所得 | 无官方 API，各站结构不一，须控频率 |
| `yipkingcn/BidInsight` | 开源多站爬取 + 归一化 + 去重（Apache-2.0） | **我实测**：**0★ / 0 fork，仓库体量仅 83 KB，created 2025-11-14、pushed 2025-11-27** | 太新且极小，**大概率只是骨架**，不能当可用系统；价值在它的字段模型（tenders/purchasers/suppliers + `hash_key` 去重策略） |
| `handaas/bidding-mcp-server` | MCP 服务（中标/招标/采购统计、拟建项目） | **我实测**：11★ / 1 fork / 无 license / pushed 2025-08-12 | 需注册 handaas.com 拿 `INTEGRATOR_ID/SECRET_ID/SECRET_KEY`（**商业服务**），远程 MCP 走 token |

### 12.3 环评能评

| 候选 | 性质 | 取证状态 | 关键限制 |
|---|---|---|---|
| 省市**公共数据开放平台**的环评审批 API | 政府开放接口 | 检索所得（例：烟台市公共数据开放网「环评审批项目信息」，GET + `X-Client-Id/Timestamp/Nonce/Signature` HmacSHA256 签名） | 需申请令牌；**一城一接口**，全国铺开要逐省对接 |
| `chrox/ecolect` | 开源 Scrapy 环评公示采集（Redis+Mongo，支持增量） | 检索所得 | 年代较早，种子站点需自行维护 |
| `dz1984/eia_crawler` | 开源 Scrapy 环评书件采集（MIT） | 检索所得 | **台湾环保署**口径，非大陆；只作架构参考 |

### 12.4 海关数据

| 候选 | 性质 | 取证状态 | 关键限制 |
|---|---|---|---|
| 海关总署「统计数据在线查询平台」（stats.customs.gov.cn） | 官方、免费、可导出 CSV | 检索所得 | 按**商品/贸易伙伴/贸易方式/收发货人注册地**汇总，**没有企业级明细**；2017 年后为主 |
| `akshare.macro_china_hgjck()` | 月度进出口总量 | 检索所得 | 只有全国总量，做不了链上验证 |
| UN Comtrade API | 全球商品贸易（免费） | 检索所得 | 国别 / HS 商品级，同样无企业级 |

**结论**：企业级进出口明细（谁买谁卖）公开渠道拿不到，要买商业库。所以六问里「海关数据」这一档**维持「暂无数据」，不要拿总量数据顶**。

### 12.5 建议接入优先级（等落点②放行后可一批做）

1. **互动易 + 上证 e 互动**（一次补上「商业阶段 / 产能 / 认证」三样，成本最低、法定位阶最高）；
2. **机构调研明细**（「客户 / 订单 / 认证」的第二来源，可与互动易互证）；
3. **供应商-客户**：先上免费开源图谱当**先验骨架并强制标注「行业-产品边、非合同事实」**；付费库作为后续选项；
4. **招投标**：自建轻量爬取（政府采购网为主），不要依赖那个 83 KB 的仓库；
5. **环评**：只接你关心的 1–2 个省，全国铺开无性价比；
6. **海关**：**维持「暂无数据」，明确不做**。

> 六个候选里，「互动易 / e 互动 / 机构调研」是**唯一的即插即用档**；其余四项要么付费、要么自建、要么颗粒度不够。

---

## 13. 落点② 已落地（2026-09-29 15:35，用户拍板「可以」）

### 13.1 实际改了四处

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/lib/desk/chat-tools.ts` | 新增 `toolSectorConstituents` / `toolStockBusinessComposition` 两个执行本体 + 两条 `TOOLS` 登记（phase：`local_data` / `external_data`）。**顺带修一处真缺陷**：`sector_rank` 原来只报板块名，模型拿着榜单也没法调成分股接口（那边只认 BK 代码）——现在行里带 `板块代码`，并注明同花顺兜底行是 `THS` 前缀、取不了东财成分 |
| 2 | `src/lib/desk/skills-core.ts` | `SkillArgs += "board_code"`；`SkillReason += "sector_constituents" / "business_composition"`；`SkillGate += "board_code" / "chain"`；`BUILTIN_SKILLS` 13 → **15** 条（两条都不标 `required`） |
| 3 | `src/lib/desk/intent-core.ts` | 新增纯函数 `extractBoardCodes()` 与 `wantsChain()`；`argsOf` 加 `board_code` 分支、`reasonOf` 加两条说辞、`gateOk` 加两道条件闸 |
| 4 | `tests/quant/p8-skills-loop.test.ts` | 计数钉 13 → 15（施工前就写明必须同步），附口径迁移说明 |

**新增测试**：`tests/quant/p60-serenity-chain-tools.test.ts`（12 条）——触发口径纯函数、两道闸真的接进 `planDispatch`、既有调度逐字未动、必读集不变、工具形状与取数纪律（非法代码 / 接口报错 / 名单为空三种事实分开写）。

### 13.2 两道闸的设计（为什么不无条件预取）

| 闸 | 触发条件 | 为什么收窄 |
|---|---|---|
| `board_code` | 提问里出现 `BK\d+` | 没点代码就不知道取哪个板块，硬猜一个＝替用户决定看什么。不触发时**不留 `skipped`**（与 `news` 同口径：没触发不是取数失败，不该画一个不存在的步骤） |
| `chain` | 提问命中 `产业链 / 供应链 / 上游 / 下游 / 卡点 / 国产替代 / 卡脖子 / 环节` | 上游是 china-stock-mcp 云调用（每股一次），普通「日K怎么看」用不到主营构成；`wantsChain` **不参与场景判定**——为取一份主营就把「AI 算力产业链谁受益」从通用问答掰成别的场景，是另一种说谎 |

### 13.3 dashboard 实测（三次真机提问，非模拟）

**① 产业链 + 个股（`688256 的技术面怎么看？它在 AI 算力产业链里处于什么环节、到底卖什么？`）**
- 判定 `stock_analysis`，预取 **7 项全部 ok**：`stock_snapshot / stock_depth / stock_trades / stock_kline_summary / stock_fund_flow / **stock_business_composition** / stock_news`
- 数据核对：K 线末值（09-29 收 1046 / 高 1053.2 / 低 1013）与真实接口**逐位一致**；MA5/10/20 = **1076.31 / 1092.53 / 1082.22** 与本地复算**完全相同**；主营构成原文来自 `get_product_info`（AI 核心芯片研发设计销售）
- ⚠️ 但模型把「MA 在价上」**读反了**（写成「均线均在价下」「现价高于 5 日均价」，与它自己引的 1076.3 > 1046 自相矛盾）。**这是模型推理错，不是数据错**——数据给对了，它结论说反了

**② 纯链研究（六环节拆解 + 挂回 + 证伪 + 未知项）**
- 判定 `sector`（命中「题材」），只预取 `sector_rank`
- ✅ **六问纪律真的接管了**：输出严格是「一、分层地图 / 二、卡点候选 / 三、标的挂回（带证据档次）/ 四、证伪条件与未知项」，且**全程拒绝编造**——六行「卡在哪/谁在量产/订单有没有披露」如实写「暂无数据」
- ⚠️ 代价是**答得很空**：模型当时拿不到成分股与主营，四段里三段是空的。判据：纪律生效（没编），但**数据供给还差一层**——见 13.4

**③ 链研究 + 板块资金（`AI 算力产业链现在哪一环最热？结合今天的板块资金说`）**
- 判定 `sector`，预取 `sector_rank`
- ✅ 全部读数与实时榜单**逐位一致**：元件 涨幅 **4.42%** / 净额 **44.14 亿** / 排名 1 / 领涨 **迅捷兴**；半导体 涨幅 **0.49%** / 净额 **14.79 亿** / 排名 5 / 领涨 **聚辰股份**；软件开发领涨 **大智慧**
- ⚠️ 三处需要注意：① 标题出现「AI算力产业链（无）请问哪一环最热？」这种**脚手架回显残留**；② 把「行业榜行」直接当作「产业链环节的卡点证据」（元件的 44.14 亿被当成「芯片与器件最紧缺」的依据——板块资金不等于链上卡点，这是**档次拔高**）；③ 领涨股被当成「标的挂回」的代表标的，但领涨≠链上地位

### 13.4 本轮实测暴露的两个真问题（下一轮再动）

1. **数据供给还差一层**：链研究落 `sector` 场景时只拿到板块榜（名称+涨幅+净额），拿不到**成分名单**与**主营**，于是四段里三段只能写「暂无数据」。
   根因不是闸写错，而是：① `board_code` 闸要求用户手打 `BK` 代码（现实中几乎不会）；② 东财 `b:BKxxxx` 成分接口此刻从 dev server 侧**持续 `fetch failed`**（东财板块榜也已退同花顺兜底）——`/api/market/sectors/BK0475` 三次重试全失败。
   可行改法（需你拍板）：让链研究场景在拿到榜单后用**榜首板块自动追一层成分**（两阶段预取），或先把成分接口加一条非东财备胎。
2. **模型把「板块资金」当「链上卡点证据」**：骨架里「卡点候选必须给证据档次」拦住了编造，但没拦住**把 A 类证据套到 B 类问题上**。建议在 `CHAIN_RESEARCH_SKELETON` 的「二、卡点候选」加一句：「板块资金净额只能证明**市场关注度**，不能证明产能/认证/订单层面的紧缺；两者不能互相顶替」。（纯文案改动，等你点头）

### 13.5 验证

```
npx tsc --noEmit                          → 0 错误
node --test "tests/quant/**/*.test.ts"    → 1921 tests | pass 1909 | fail 3 | skip 9
```
与施工前基线（1910 / 1898 / 3 / 9）**逐项对齐**：新增 11 条测试全过，3 条失败仍是今日会话上限与侧栏改动的旧钉，与 Serenity 无关。

⚠️ **诚实边界**：`stock_business_composition` 的上游 `get_product_info` **只给「卖什么」**（主营业务 / 产品类型 / 产品名称 / 经营范围），**不含按产品的收入占比**。这条口径已写进工具返回值（`口径说明` 字段），模型不许自行拆分比例；要「哪块业务赚多少」必须回落年报，本仓暂无该通路。

## 14. 落点② 遗留两项已修（2026-09-29 15:55，用户拍板「按照思路顺序来」＝先①后②）

### 14.1 ① 两阶段预取：链研究顺榜首板块自动追一层成分

改 3 处：

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/lib/desk/intent-core.ts` | 新增纯函数 `chainFollowUpCalls(firstRound, question)`：第一棒跑完，若这一问落在链研究档、且用户没自己点板块代码，就顺着**榜首板块**生成一条 `sector_constituents` 调用（只追一次、只追一个，`size: 20`） |
| 2 | `src/lib/desk/scene-dispatch.ts` | `prefetchForScene` 在第一棒之后插第二棒（共用同一个 `execute` 闭包、步骤号接着编），rows/missing/steps/trace 四路合流；`PREFETCH_STEP_LABELS` 加 `sector_constituents` 标签 |
| 3 | `tests/quant/p60-serenity-chain-tools.test.ts` | +4 条（纯核判定 + 三条不追口径 + 服务层确实接线） |

三条收窄口径（写进函数注释与测试）：
1. **只在 `wantsChain` 命中时追**——普通「哪个板块最强」不需要成分名单；
2. **只追榜首个**——链研究要的是「代表性的一批」，追前 15 个板块＝把覆盖面伪装成重要性，还是 15 次取数；
3. **只追东财 BK 代码**——同花顺兜底行是 `THS` 前缀，东财 `b:BKxxxx` 成分接口不认，硬发就是一次注定失败的调用。也正因如此，**东财断源、榜单退同花顺时本函数不产生任何调用**，时间线里不会多一个必然失败的步骤（真机已验证：`trace` 只有 `sector_rank`，无失败步骤）。

### 14.2 ② 骨架红线：板块资金 ≠ 链上卡点证据

`src/lib/desk/modes.ts` 的 `CHAIN_RESEARCH_SKELETON`「二、卡点候选」补一句：

> **板块资金净额只证明「市场关注度」，不能证明产能/认证/订单层面的紧缺——两者不能互相顶替**（把行业榜的资金当成链上卡点的证据＝档次拔高）。

### 14.3 真机验证（重启 dev server 后）

⚠️ **必须重启**：本会话第 3 次踩到「dev server 没热更新、旧模块继续服务」——重启前后同一问法输出差异明显。

- **重启前**（旧提示词）：把「元件板块 44.14 亿」当成链上卡点依据，并**编造商业阶段**（「迅捷兴处于样机验证阶段」「聚辰股份已进入量产阶段」——本轮并无任何此类数据）。
- **重启后**（新提示词）：同一问法——**编造消失**，板块资金被标成「资金数据」，每条推演后紧跟「但要成立还得看到元件板块内部是否有 AI 算力相关个股（缺失数据）」；「行情 / 技术 / 基本面 / 消息」四栏都如实写「暂无数据」。

⚠️ 重启后仍存在的两个模型层问题（非 ①② 引入，登记待办）：
- **仍给买卖动作**（「可考虑短线做多（买入）」「建议减仓或观望」）——与链骨架红线②（只说研究价值、不给动作建议）冲突；根因是 `MARKET_OUTLOOK_SKELETON` 的「两种情形 + 可验证触发条件」也在同一轮注入，两套骨架对「要不要给动作」口径不一。
- 标题仍出现脚手架回显残留（`AI算力产业链（）今天的行业…`）。

### 14.4 当前唯一拦路：东财 push2 断源（① 暂时休眠）

实测（15:52–16:05 多次）：`/api/market/board?kind=industry|concept` 的 `source` 全是 `ths`（同花顺兜底），行代码是 `THS881270` / `THS308642` 这类；`/api/market/sectors/BK0448|BK0475|BK0483` 三次重试全是 `成分股获取失败：fetch failed`。
⇒ **东财 push2（板块榜 + `b:BKxxxx` 成分）此刻整体不可达**，而东财是本仓唯一现成的板块成分源（`em-provider.fetchBoardMembers` 只走 `b:BKxxxx`；同花顺只有榜单页、无成分接口；china-stock-mcp 只有 `get_stock_board_industry_summary` 汇总、无成员）。所以 ① 现在**一个调用都不会产生**（设计如此，不算故障）——等东财恢复、榜单重新带 `BK` 代码，它会自动生效。

**已探明的备胎（下一步可做，需你拍板）**：`data/industry-map.json`（本地快照、无网络；源自 china-stock-mcp `get_stock_technical_rank` 的「所属行业」，4281/5569 ≈ 77% 覆盖、89 个行业名）里的行业名与同花顺板块名**高度吻合**：

| 同花顺榜行 | 本地行业名 | 命中只数 |
|---|---|---|
| 元件 (THS881270) | 元件 | 45 |
| 半导体 | 半导体 | 148 |
| 房地产 | 房地产 | 84 |
| 文化传媒 | 文化传媒 | 70 |
| 工业金属 | 工业金属 | 33 |
| 银行 | 银行 | 34 |

即可给 `sector_constituents` 加一条**按行业名反查本地归属快照**的备胎（仅行业板；概念板无源），输出必须标注「本地行业归属快照（非东财板块成分）」。**未做**——语义与东财板成分不同（口径差异 + 77% 覆盖 + 快照时点），要你点头再动。

### 14.5 验证

```
npx tsc --noEmit                        → 0 错误
node --test "tests/quant/**/*.test.ts"  → 1925 tests | pass 1913 | fail 3 | skip 9
```
较本轮前（1921 / 1909 / 3 / 9）**净增 4 测全过**；3 条失败仍是今日会话上限与侧栏改动的旧钉。
另同步更新两处「轮次计数钉」（本轮取数从 2 轮变 3 轮）：`p8-skills-loop:252`（`execute,` 2→3）、`p15-r10b-stock-news:112`（`labelFor: prefetchLabel` 2→3）——钉的是「几轮共用同一 execute / 同一标签」，意图不变。

交付验证脚本更新到 21 条：`D:/WorkBuddy/2026-09-29-12-15-54/verify-serenity.mjs`（新增 ② 红线、① BK 路径 / THS 不追、服务层接线共 5 条）。

## 15. 落点 A 已落地（2026-09-29 16:20，用户拍板「东财断流先不管 先A」＝先给行业板一条本地成分备胎）

### 15.1 实际改了五处（东财侧一行未动——用户明说断流先不管）

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/lib/quant/data/industry-constituents.ts`（新） | 读 `data/sector-constituents.json`（mtime 缓存，与 `industry-map.ts` 同手法）。导出 `industrySnapshotMeta()` / `industryNames()` / `constituentsOfIndustry(name)`。**只认行业名**：精确匹配优先，退一步去掉 `板块/行业/概念/指数/产业` 后缀再比一次；匹配不上回 **null**（不返回空数组——空数组会被读成「这个行业没有成分股」）。文件缺失/损坏回 null，不编造覆盖数 |
| 2 | `src/lib/desk/chat-tools.ts` | `toolSectorConstituents` 从一个入口拆成三条路：① `code=BK…` → 东财真板块成分（原样）；② `name=行业名`（或没给 code）→ 本地行业归属快照；③ 给了代码但不是 BK → 如实说清为什么用不了（THS 前缀单独一句，指向 name 用法）。返回值带 `数据源`（写明「本地行业归属快照（非东财板块成分）· 生成于 YYYY-MM-DD」）/`口径`（「不是同一口径」）/`时效说明`（「不含实时行情…不是今天」），涨跌幅键名写死 `涨跌幅快照日`，档位译成人话（龙头/核心/二线）。**TOOLS 登记**加 `name` 参数、去掉 `required: ["code"]` |
| 3 | `src/lib/desk/intent-core.ts` | `chainFollowUpCalls` 加第三个可选入参 `knownIndustries`（服务层递进来的「本地认得的行业名」事实）。四条收窄口径：链研究才追 / 只追榜首 / 东财 BK 优先 / **东财行没有且榜首行业名本地认得**才改带 `name` 走本地备胎。不递事实＝不启用该路（老行为逐字不变） |
| 4 | `src/lib/desk/chain-followup.ts`（新）+ `scene-dispatch.ts` | 事实注入层：`planChainFollowUps(raws, question)` = `chainFollowUpCalls(raws, question, industryNames())`。放 desk 层是为了**不破** `p7-dispatch` 的「分层不破」闸（scene-dispatch 里 `@/lib/quant` 依赖只许 hybrid + decision 两个入口）；scene-dispatch 只把 `chainFollowUpCalls` 换成 `planChainFollowUps`，`prefetchLabel` 补一条「带行业名时标出是哪个行业」 |
| 5 | `tests/quant/p60-serenity-chain-tools.test.ts` | +3 测（东财断源按行业名追/不认得就不追；`industry-constituents` 精确命中与「概念名不硬凑」；落点 A 口径钉）。旧「THS 不追」一条改成「服务层没递事实时不追」，语义不变 |

`skills-core.ts` 的 `sector_constituents.desc` 一并更新（仍在 `board_code` 闸下：用户手打 BK 代码走东财真成分；行业名那条是第二棒现算，不进计划表）。**BUILTIN_SKILLS 仍 15 条**，注册项数未变。

### 15.2 三条纪律（为什么这样写而不是「东财挂了就用名字顶上」）

1. **口径不许混**：本地快照是「行业归属」不是「东财板块成分」（≈77% 覆盖、无市值个股已剔除、无实时行情），返回值里逐条写明，并明确「快照涨跌幅不是今天」——不写这句，模型会把 09-28 的 -9.03% 当今天的读数报出去。
2. **纯层不查字典**：`knownIndustries` 由服务层（`chain-followup.ts`）从快照读出后递给纯核，与 `IntentInput.nameHits` 同一条纪律。榜首行业名本地不认得 → 不追，不画一个注定失败的步骤。
3. **概念板仍然无源**：备胎只管行业板；`AI芯片` 这类概念名一律回 null + missing，绝不拿 `半导体` 近似顶上。

### 15.3 真机验证（重启 dev server 后；东财 push2 仍断，榜单 `source=ths`）

**问法 A**：`AI 算力产业链现在哪一环最热？结合今天的板块资金说`

| 步骤 | 状态 | 内容 |
|---|---|---|
| 1 | ok | 取板块资金榜（行业）— 同花顺兜底榜，榜首 元件 / +4.42% / 44.14 亿 |
| 2 | ok | **取板块成分股真实名单 · 元件** — 数据源「本地行业归属快照（非东财板块成分）· 生成于 2026-09-28」，1ms |
| 3 | ok | 校验本轮取数完整性（1 项必读齐） |

模型回答里真的用上了第二棒的数据（点名 东山精密 ‑9.03% / 深南电路 ‑6.06%），且**如实标注「在快照中」**——口径件生效，没把它当今日读数。

**问法 B**：`AI算力产业链上游的卡点环节在哪？结合今天的行业资金流向答`

- 判定 `sector`，预取 **6 步全 ok**：板块榜 → **成分股真实名单 · 元件** → 完整性校验 → **个股实时快照 · 迅捷兴 / 东山精密 / 深南电路**
- 关键变化：**模型在自己那一侧接着用第一棒+第二棒的数据去查了 3 只票的实时快照**——说明「榜单 → 成分 → 个股」这条链在断源期真的走通了（此前只能三段写「暂无数据」）

### 15.4 仍未做（登记，不属本轮）

- **模型仍给买卖动作**（「可考虑短线做低吸」「建议观望或减仓」）：与链骨架红线②口径冲突，根因是 `MARKET_OUTLOOK_SKELETON` 同轮注入。这是上一轮登记的选项 B，本轮用户明确「先 A」。
- 链研究只在场景落 `sector` 时才有预取（判成 `general` 的纯链问法不取数）——属既有编排，未动。
- 东财 `push2` 断源（用户明说先不管）：恢复后 BK 路径自动接上，两条路并存、BK 优先。

### 15.5 验证

```
npx tsc --noEmit                        → 0 错误
node --test "tests/quant/**/*.test.ts"  → 1928 tests | pass 1916 | fail 3 | skip 9
```

较本轮前（1925 / 1913 / 3 / 9）**净增 3 测全过**；3 条失败全是今日会话改动的旧钉（store 形状 / 侧栏 slice(0,5) / 侧栏字号），与 Serenity 无关。

交付验证脚本 `verify-serenity.mjs` 更新到 **32 条**（PASS 32 / FAIL 0），新增落点 A 的 13 条。

## 16. 第二轮：把「有数据却写成暂无数据」补干净（2026-09-29 17:30，用户六条不满 + 「重新生成 发给我原文」）

用户读了 §15 的真机原文后逐条点名六处问题，本轮**全部处理**，并做了三轮真机复测。

### 16.1 用户点名的六条 → 落点

| 用户原话 | 判定 | 落点 |
|---|---|---|
| 「可以给买卖动作建议 这恰恰是我后期最需要做的」 | 旧红线写死「不给动作建议」 | 链骨架红线②改成正向要求：**动作建议要给，而且要具体**（方向/条件/节奏/止盈止损/失效条件），每条注明挂在哪档证据、什么信号算成立/作废 |
| 「需要观察今日实际成交和买卖盘（缺失）…五档盘口都有怎么会没有」 | 编排根本没取 | 第二棒给代表个股补 `stock_depth`（五档盘口 + 委买卖比），速览里落到「盘口：委买卖比 X（委买 Y 手 / 委卖 Z 手）」 |
| 「行情/技术/基本面/消息：暂无数据 还有这个我们也是有的」 | 同上 | 第二棒补 `stock_snapshot` / `stock_kline_summary` / `stock_business_composition` / `stock_news`（3 只 × 5 工具 = 15 份） |
| 「还需看到该板块内AI相关子行业占比（缺失）…跟着数据源头去取数据就行」 | 板块 → 产业链映射没接进对话 | 新 `src/lib/quant/data/sector-chain.ts`：读 `data/sector-industry-map.json`，`chainOfSector(name)` 给 `{domain,上游,中游,下游}`；`fundamentalsOfSector(name)` 给板块利润/订单/存货/资本开支同比。两项随成分股返回值一起给出（`sectorContextOf`） |
| 「（可观察 sector_rank 主力净额变化）这个英文去掉」 | 模型把工具名抄进正文 | `renderDispatchBlock` 块头带人话标签；骨架红线③**正文里不许出现工具名或英文字段名**；`sector_rank` 的 `板块代码`**只放东财 BK**（同花顺兜底行给 null + 说明），杜绝 `THS881270` 被当板块名抄进标题 |
| 「元件板块整体市值：本轮未获取全板块市值（暂无数据）你确定这个暂无数据吗？」 | 编排没算 | `sectorContextOf` 合计成分股总市值 → `板块整体市值亿` / `板块整体市值口径`；并压进置顶速览 |
| 「反方理由缺了那么多数据真的补不上？去都补上」 | 同 2/3 | 硬缺口收敛为**真无数据源**那七类（供应商-客户关系、认证周期、产能良率、调研纪要、招投标金额、环评能评、海关明细） |

### 16.2 代码改动

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/lib/quant/data/sector-chain.ts`（新） | 板块 → 产业链节点 / 板块财务快照（mtime 缓存，精确名匹配，查不到回 null）。返回值自带 `口径`，写明「非市值加权 / 月度快照不是实时行情」 |
| 2 | `src/lib/desk/chain-digest-core.ts`（新） | **置顶速览**：把本轮已取到的数据压成「【板块段】一行 + 【代表个股段】一只票一行」放在注入块**最前面**。字段逐条抄自工具结果、缺就写「缺」，**不跨字段推算**；纯核零依赖，可 `node --test` 直跑 |
| 3 | `src/lib/desk/intent-core.ts` | `chainFollowUpCalls` 重写为**两棒**：未跑成分股 → 第一棒（`{code,name,kind,size:30}`；东财断源时 `{name,...}` 走本地备胎）；已跑且未跑代表个股 → 第二棒（3 只 × 5 工具 = 15 条）；跑完再问一次就停（最多两棒，不自转）。`renderDispatchBlock` 加 `label` 与「已有数据的维度不许写成暂无数据」一句 |
| 4 | `src/lib/desk/scene-dispatch.ts` | 补数层改 `for (let round = 0; round < 2; round++)` 循环，四路（steps/rows/missing/trace）+ notRun 逐棒合流；合流后把速览作为 `chain_rep_digest` 一行**插到 rows 最前** |
| 5 | `src/lib/desk/chat-tools.ts` | 新增 `sectorContextOf()`（板块整体市值 / 链上位置 / 板块财务分量 / 补数说明）；`toolSectorConstituents` 三条路都带上它；`toolSectorRank` 的 `板块代码` 只放 BK |
| 6 | `src/lib/desk/modes.ts` | `CHAIN_RESEARCH_SKELETON` 重写：第 2 问锚死「产业链归属」节点名、第 1 问禁自造数、输出**五段**（插「五、动作与观察条件」）、红线扩到三条 + **两条数值红线**（价位只能引代表个股并指名、证据档次不许拔高）、硬缺口清单收敛。**新增 `CHAIN_MODE_OVERRIDE` + `modeNoteFor(mode, chainResearch)`** |
| 7 | `src/app/api/ai/chat/route.ts` | 链路档成立（`wantsChain`，与预取层同源）时：① `MODE_NOTES[mode]` 整段不发，改发 `CHAIN_MODE_OVERRIDE`；② `MARKET_OUTLOOK_SKELETON` 整段不发。回显语料跟着换成**实际下发的那份** |

### 16.3 本轮最关键的一条：**叠层说不动 → 就换成不下发**

三轮真机下来，只改文本没用：链骨架第 227 行早就写了「不要套那张五类表」，模型照抄了 `MODE_NOTES.deep` 的「🧠 先摆数据：行情 / 资金 / 技术 / 基本面 / 消息 五类分列」，把「技术：暂无板块技术指标」写进正文。两条矛盾指令同时在场时，模型选了**更结构化、更靠前**的那条。

成法沿用工程里既有的「触发式叠加」，但在骨架层做了扩展：**命中原子的那一轮，把会被顶掉的那份骨架整段抽掉**（模式骨架 + 大盘骨架），改发 `CHAIN_MODE_OVERRIDE`。判定用代码（`wantsChain`），不靠模型自己认。

### 16.4 真机复测（重启 dev server 后连问 4 次有效样本）

问句：`AI算力产业链上游的卡点环节在哪？结合今天的行业资金流向答，并给出具体操作建议`

| 指标 | 补数前（§15 口径） | 本轮终版 |
|---|---|---|
| 「暂无数据」次数 | 1~3（技术/消息/基本面整栏） | **0~5**（只剩真硬缺口那几项，且单独标出） |
| 英文工具名泄漏 | 有（`sector_rank` 进正文） | **0 / 4** |
| 内部代码泄漏（`THS…`/`BK…`） | 2/3 次 | **0 / 4** |
| 大盘示例区间串台（3800 点 / 1.5–1.8 万亿） | 有 | **0 / 4** |
| 板块整体市值 | 0/4 | **4 / 4**（22836.84 亿元，带「= 本轮成分股总市值之和」口径） |
| 产业链归属 | 0/4 | **4 / 4**（AI算力域 · 中游：PCB/CCL） |
| 板块财务同比 | 时有时无 | **4 / 4** |
| 代表个股 行情/技术/盘口 | 1/4 | **4 / 4** |
| 动作建议 | 无（被红线禁止） | 4/4 具体（进场条件 + 止盈止损 + 失效信号） |

**残留（诚实登记）**：`光模块 / 光芯片 / 光纤` 仍出现 4/4 次，但语境已不是「把板块链上位置改写掉」——多数是**引用东山精密自己披露的主营**（「电子电路、光模块（含光芯片）」）或在「缺失信息」里举原材料例子，属正当引用；仅 1 次出现在分层地图的填充格里（该行自己标了「本轮无数据」）。这类词来自代表个股主营原文，模型把它当环境词的倾向还在，属模型层，文本约束已到边际。

另：4 次里有 1 次返回为空，原因是**上游 LLM 403**（与代码无关），补跑即恢复。

### 16.5 验证

```
npx tsc --noEmit                                 → 0 错误
node --test "tests/quant/p60-serenity-chain-tools.test.ts"  → 25 tests | pass 25 | fail 0
node --test "tests/quant/**/*.test.ts"           → 见 §16.6
node verify-serenity.mjs                         → PASS 53 / FAIL 0
```

`p55-context-echo`（回显语料钉）、`p8-mode-anywhere`（风格句单一出处钉）两条既有测试按新口径同步更新：语料从「一定含 `MODE_NOTES[mode]`」改成「含的必须是真下发的那一份」。

### 16.6 全量回归

```
node --test "tests/**/*.test.ts"  → 1935 tests | pass 1923 | fail 3 | skip 9 | duration 63.8s
```

3 条失败全是**今日会话之前的既有旧钉**，与 Serenity / 本轮改动无关：

- `not ok 171` store 接线（动作只调纯核 + 收口 activeSessionId）
- `not ok 560` Sidebar：最多 5 条 + 只保留有消息的会话
- `not ok 828` Sidebar 次级菜单与「最近」区字号同步放大（14px）

较本轮前（1932 / 1920 / 3 / 9）**净增 3 测全过**（p60 新增的模式骨架替换件断言 + 板块段速览断言 + 分层地图断言），失败数不变。
