# Serenity（白毛股神）方法论 Skill × Kairo 量化台 —— 适配方案

> 状态：**方案文档，未开工**。本轮不改代码、不装 skill、不动 3010。
> 对象仓库：<https://github.com/muxuuu/serenity-skill>（4,040★ / 628 fork / MIT / 最近更新 2026-09-27）
> 撰写日期：2026-09-28

---

## 0. 一页结论

1. **值得进，但它的正确形态不是「新页面」，而是「一条研究纪律 + 一段取证链」。** 这份 skill 零代码、零 API key，全部内容是一张 5 步工作流 + 一套证据分级规则，跟你项目已有的 `REAL_DATA_ONLY` / `missing[]` 不冒充口径是同一套哲学，重合成本低。
2. **最佳融合点 = `src/lib/desk/prompt-library.ts:55-64` 的 `chain`「产业链挖掘」组。** 你已经有 4 条现成话术在问「哪个环节最紧缺、最容易涨价、谁有控制点」——**只有问题、没有流程、没有证据纪律**。Serenity 的贡献正好是把这三样补齐。这是改深一个已存在的入口，不是加功能。
3. **第二融合点 = `src/lib/desk/skills-core.ts` 的技能注册表。** 你项目自己把教训写死在注释里（`skills-core.ts:79-81`、`:110-112`）：*只把工具开放给模型、模型基本不会自己调，系统必须替它取到*。所以纪律要真生效，必须把卡点取证链缺的两项数据接成预取技能项（板块成分股、主营/产品构成），而这两项**后端接口都已经有了**，只是没进技能表。
4. **最大硬缺口：项目里没有任何产业链关系数据。** 全库只有 `industry-map.ts` 的行业归属 + 东财概念板块 `BKxxxx` 成分股。供应商-客户、认证周期、产能、资本开支**都没有源**。所以 Serenity 第 2 步（沿供应链分层）只能由 LLM 在「概念板块成分 + 主营构成」上做**软拆解**，且必须按你的规矩标成推断，不许涂成事实。
5. **它不产出可回测因子，别接进 FactorLab 当 alpha。** 卡点判据（供应商数、认证周期、扩产难度、纯度规格）要量化就必须先有链关系数据——落回第 4 条。本轮列为**非目标**。
6. **有一处真口径冲突要你先拍板**：muxuuu 明令 `Prohibits execution directives, individualized allocation guidance`，而你 `prompt-library.ts:30-31` 现成的文案问的正是「现在值得参与 / 需要等待确认 / 暂时没有机会」「左侧、右侧、趋势加速、高位博弈」。处理建议见 §4.4（分组隔离，不删你的文案）。

---

## 1. 对象核查：这份 skill 里到底有什么

仓库结构（GitHub API 实测）：`SKILL.md`、`README.md`、`references/`（8 个文件）、`assets/`、`scripts/`、`examples/`、`evals/`、`agents/`、`LICENSE`（MIT，Copyright (c) 2026 muxu）。

触发方式：Codex 里 `$serenity-skill`，Claude Code 里 `/serenity-skill`。装法是 clone 后把 `SKILL.md + LICENSE + references + assets + examples + agents` 拷进 agent 的技能目录（`~/.agents/skills/` 或 `~/.claude/skills/`，Qoder 类客户端按其加载目录同构放置）。

`SKILL.md` 章节（原样）：

```
# Serenity.skill
## Choose the research task
## Work from current evidence
## Follow the investment logic
## Finish with a usable judgment
## Answer in the user's language
## Examples
```

`references/` 清单（大小）：`deep-research-workflow.md` 5.3KB、`evidence-ladder.md` 4.3KB、`market-source-playbook.md` 3.8KB、`serenity-dialogue-protocol.md` 2.2KB、`output-style-and-language.md` 2.1KB、`public-profile-and-evaluation.md` 2.0KB、`risk-and-compliance.md` 2.4KB、`research-sources.md` 0.9KB。

方法论主干（`deep-research-workflow.md` 五步，逐步要点）：

| 步 | 原法要点 | 对 A 股可执行度 |
|---|---|---|
| 1 把问题变成可检验的命题 | 「CPO 核心供应商」至少 5 种含义：供过件 / 完成客户认证 / 已量产交付 / 被点名进平台供应链 / 该业务有实质营收或定价权 / 是唯一合格供应商。支持其中一条的证据不等于支持其他条 | **高**（纯提示词层，不依赖新数据） |
| 2 先映射系统再挑公司 | 主题 → 终端需求 → 系统变化 → 受约束的投入件；比较层：终端需求 / 系统集成 / 模块 / 芯片器件 / 工艺封装 / 设备 / 材料 / 基础设施；卡点判据：认证前置期、良率、扩产难度、供应商集中度、产能预订；判断约束是暂时、正在扩张、还是已在缓解 | **中**（分层靠 LLM 软拆，卡点判据无数据地基） |
| 3 追溯到财报 | 卖什么→产品/分部披露；能不能供货→认证/量产/交付/订单；业务是否重要→分部营收与订单额；稀缺是否变成股东利益→价格/毛利/产能利用率/现金流/资本开支；预期是否已定价→带日期的市值 + 可比盈利。并强调投资收益/公允价值变动/政府补助/股份支付/并表/汇兑会让利润增速与经营进展脱节；不披露客户身份就**保持该字段未知**，多篇文章转述同一披露不算独立确认 | **中高**（`/api/stock/fundamental` 已能拿主营构成、业绩预测、估值、券商研报、筹码） |
| 4 找最优反解释 | 客户可换供应商或改设计绕开 / 供给扩张或良率提升使瓶颈缓解 / 订单是囤货不是终端需求 / 该产品对本司利润贡献很小 / 客户议价压制毛利 / 当前估值已假定爬坡成功 | **高**（纯推理，且正好治「题材吹」） |
| 5 比较与收口 | 先摆最相关分层，再用证据分级讲优先级；**经济重要性、证据置信度、估值三件事必须分开**；查完仍缺的证据要写明查了什么、还不知什么、哪份未来披露能解决；结尾给具体的下一步（「去看更多报告」算不合格） | **高** |

证据分级四档（`evidence-ladder.md`，逐条）：

- **Confirmed disclosure（已证实披露）**——打开的材料在所述范围内直接这么说；公司自己的说法即使缺外部印证也归此档。
- **Supported inference（可支撑推断）**——观察到的事实支持某个解读，但并未直接这么说；必须同时写出推理链和竞争性解释。
- **Unverified lead（未证实线索）**——关键证据缺失、拿不到，或只来自转述与社交讨论。
- **Contradicted claim（被反驳的说法）**——有适用来源直接冲突；必须记明冲突点与日期。
- 跨档红线：**事实置信度与研究/估值优先级严格分离**——证实的商业事实不自动等于好价格，未证实的叙事也不自动剥夺研究注意力。

硬约束（原样要点）：默认基准 universe 是境内交易所；要求读完整文件而非搜索摘要；数据不足只能给「封顶的临时评估」；公开材料查不到就停；**禁止**下指令、给个人化仓位建议、保证收益、无依据估值。

---

## 2. 逐条对照：它的取证需求 vs 你项目现成的东西

状态三档：**已接通** = 现成能用；**有接口未进技能表** = 后端已实现、模型却调不到（最划算的改造点）；**没有数据源** = 本轮造不出来。

| Serenity 需要 | 项目现状 | 状态 |
|---|---|---|
| 主题/概念板块资金榜 | `sector_rank`（`chat-tools.ts:886`）、`/api/market/theme-heat`、`/api/market/themes`、`/api/desk/sector-insights` | 已接通 |
| 板块 → 成分股 | `/api/market/sectors/[code]`（`route.ts:1-40`，`BKxxxx` + `kind=concept`，返回 `symbol/name/industry/price/changePct/amountYi/turnover/mainNetYi/st/suspended`）；`/api/market/sectors?kind=concept` 出板块列表 | **有接口未进技能表**（TOOLS 里没有 `sector_constituents`） |
| 它卖什么（主营/产品构成） | `fetchMcpProductInfo` = `china-stock-mcp · get_product_info`（`mcp-provider.ts:375`）；`get_stock_basic_info` 含 `主营业务`（`:233`、`:260`，`ProfilePage.tsx:314` 已在渲染）；`/api/stock/fundamental` 同时聚合券商研报、业绩预测、估值、筹码（`route.ts:12,48`） | **有接口未进技能表**（TOOLS 里没有基本面/产品构成工具） |
| 订单、公告、交付证据 | `stock_news`（`chat-tools.ts:895`，东财新闻 + 公告含栏目标签，`required: true` 已在个股分析预取） | 已接通（**但只有标题/摘要级**，读不到公告全文 PDF） |
| 涨价、毛利率、现金流、资本开支 | 财务三表经 china-stock-mcp 可达；因子目录 `src/lib/quant/factors/fields.ts`；`historical_probability`（`:903`） | 部分已接通，具体字段需按 `fields.ts` 现名核 |
| 热度是产业趋势还是炒作 | `factor_screener`（`:901`）、`candidate_pool`（`:902`）、`/api/market/limitup`、`/api/market/breadth`、`run_backtest` | 已接通 |
| 供应商-客户 / 产业链关系图 | 无。仅 `industry-map.ts` 行业归属、`data/industry-map.json`、`ths.ts` 同花顺概念资金流 HTML | **没有数据源** |
| 认证周期、良率、产能预订、扩产难度 | 无结构化字段 | **没有数据源** |
| 全球供应链证据（它明确要求即使选 A 股也要看全球竞争） | 只有 `全球事件雷达`/`/api/events` 快讯 + `market_news` | 只能做到「有全球消息线索」，做不到全球供给数据 |
| 通用网页搜索 / 公告全文解析 | TOOLS 无 web search；`market_news`/`stock_news` 是东财定向取数 | **没有该能力**（muxuuu 假设 agent 有 browser + 披露解析） |

结论：**分层与收口两步可立刻落地（纯提示词）**，取证强度取决于 §3.2 那两项接口能不能进技能表，第 2 步的「卡点判据」在拿到链关系数据前只能是 LLM 推断 + 明确留空洞。

---

## 3. 三个融合落点（按性价比排序）

### 3.1 落点①：把 `chain`「产业链挖掘」组升级成「五步流程 + 四档证据」的纪律

- 位置：`src/lib/desk/prompt-library.ts:54-64`（`key: "chain"`，emoji 🏭，现 4 条 prompts）；同组相关文案还有 `:51`（对比组「谁掌握了产业链最核心的价值阶段」）。渲染出口在 `AiHomePage` / `LlmAnalysisPage.tsx`。
- 改法（下一轮）：
  1. 组内新增一条**流程型**文案，形状照它 Step 1 的「把含糊命题拆成 5 种可检验含义」写，例：「先别给名单。把我说的这个题材拆成 6 个环节（终端需求/集成/模块/器件/工艺封装/设备材料），每个环节写清『卡在哪、谁认证过、谁在量产、订单有没有披露』，再把 A 股候选挂回环节上。」
  2. 现有 4 条保留，但把「哪个环节最紧缺」那条加一句约束：「紧缺判定必须给证据档次；没有披露就写『未知』，不许用概念标签冒充主营。」
  3. 输出形状固定为四段：**分层地图 → 卡点候选 → 标的挂回（含证据档次）→ 证伪条件与未知项**。第四段必须非空，否则视为没做完。
  4. 文案要**对着你自己的接口名和字段写**，不照抄英文原句（避免模型引用你项目里不存在的字段）。
- 成本：纯文案 + 1 条形状拦门测试。风险：低。收益：直接改研报观感与「题材吹」过滤力。

### 3.2 落点②：把两项已有接口接进技能注册表，让纪律真的能取到数

- 位置：`src/lib/desk/skills-core.ts`（`BUILTIN_SKILLS:60`、`Skill/Scene/SkillArgs:16-33`、`registerSkill():203-208` 自称「给扩展方的唯一注入口」、`DISPATCH_MAX_SYMBOLS=5`、`DISPATCH_ANALYSIS_MAX=3`）+ `src/lib/desk/chat-tools.ts:884-906`（`TOOLS`，顺序即调度顺序，注释警告别乱动）。
- 改法：
  1. `chat-tools.ts` 新增两个工具本体：`sector_constituents`（包 `/api/market/sectors/[code]?kind=concept`）、`stock_business_composition`（包 `fetchMcpProductInfo` + `get_stock_basic_info.主营业务`）。
  2. `skills-core.ts` 新增一个 `Skill` 项，`scene` 建议挂 `sector` 与新增场景（若 `intent-core` 的 `Scene` 联合类型不便扩展，就先挂 `sector` + `stock_analysis`，**不新增 scene**，减小爆炸面）。
  3. `SkillArgs` 需新增 `board_code`（现只有 `empty/news8/sector_kind/symbol/screener_pool`）；`SkillReason` 需新增两个键，且 `SCENE_LABELS` 文案要同步（它要求与旧 switch 逐字一致，是 p7-intent 25 条调度断言的回归闸）。
  4. **不标 `required`**（照 `stock_depth`/`stock_trades` 的先例）：MCP 网关没起就进 `missing[]` 留痕，不拖垮整轮；符合「轮询失败只报错不清屏」的既有口径。
- 成本：中（动两处注册表 + 调度断言 + 可能动 `intent-core` 拼参）。风险：中——表驱动改动必须逐字保住既有编排（`skills-core.ts:10-12` 的教训就写在这里）。收益：**这是唯一能让「纪律」变成「系统真的替模型取到主营构成」的落点**。

### 3.3 落点③：输出面复用现成的池/研报，不新建页

- `CandidatePool`（冻结池 + 次日验证，`/api/pool/freeze`、`/api/pool/[id]/verify`）承接「卡点研究清单」；`ResearchReport`（`/api/research` + `/api/research/prompt`）承接四段式研报；`ThemeSnapshot` 承接分层快照。
- 展示候选位（**本轮只列，不做**）：`themeoverview` 主题血缘总览。你已拍过红线——要「一张跨页血缘总览看完一件事」，不是每页塞一张卡、不是加子菜单。Serenity 的「主题→环节→标的→证据」链条与血缘图同构，是后续最自然的展示位。
- 若要 agent 化执行（多步带预算）：`/api/agent/run|tool|tools|finalize` + `AgentRun.budgetJson` / `AgentToolCall` 已就绪；`serenity` 流水线可以是一个 agent run，而不是一个前端按钮。这条留到落点①②验收后再议。

---

## 4. 口径冲突（必须先认，不要装看不见）

1. **全文披露 vs 只有摘要。** 它要求 `full-document review rather than search preview reliance`。你的 `stock_news` 是东财新闻 + 公告列表标签级。**降级方案**：档次判定必须在提示词里写明「本项目公告证据止步于披露标题/摘要，凡需读正文才能确认的一律记 `Unverified lead`」——宁可降级也不冒充，这正好是你 `missing[]` 的语义。
2. **全球证据要求 vs A 股为主的取数。** 它明说「即使最终候选是 A 股公司，也要用全球供应链证据」。你只有快讯级全球视野。**处理**：把全球层写成「必做但允许留空洞」的一段，输出里出现 `全球层：未取到（缺 xxx 数据）` 而不是省略。
3. **上游断源风险。** 概念板块成分股依赖东财 `push2`/`push2delay`，你有过断源史（P8 接腾讯、P9 接新浪作备胎）。断源时第 2 步的整条分层会空——**必须走「轮询失败只报错不清屏、旧数标旧时」**，不许静默退化成 LLM 凭空分层。
4. **禁给仓位建议 vs 你现有交易决策文案。** 它禁止 `execution directives / individualized allocation guidance`；你 `prompt-library.ts:30-31` 的「值得参与 / 等待确认 / 没有机会」「左侧/右侧/趋势加速/高位博弈」正是这类问法。**建议不删你的文案**，而是划清边界：`chain`（卡点研究）组的输出只到「研究优先级清单 + 证伪条件」，交易类问法继续留在 `signal`/决策组，两组文案不互抄、不混排。若要在同一份研报里既给分层又给参与判断，需明示「后半段属交易决策语境，非本方法论结论」——`risk-and-compliance.md` 管的就是这类相邻提问。
5. **45 倍战绩不可复制。** 它自己在 `public-profile-and-evaluation.md` 与 `risk-and-compliance.md` 里就把这些战绩标为未经核实的外部说法。本项目引用它时，口径写「第三方提炼的公开方法论，非官方、非业绩背书」。

---

## 5. 非目标（本轮明确不做）

- 不做卡点因子进 FactorLab / 不进回测（缺链关系数据）。
- 不引入 `yan-labs/serenity-aleabitoreddit`（6,592 条推文 + 4 篇长文语料）——那是**美股**语料、只给了 Claude Code 挂载示例、且第三方归档他人推文既非本项目必需也有内容合规面；`lanfuli/aleabito-serenity-skills` 需 `X_BEARER_TOKEN` 才能跑数据层，同样不引入。
- 不新增一级菜单、不新增依赖包、不新加 `.env` 变量。
- 不动 3010（P11-P14 已用掉那唯一一次重启授权）。
- 不把 vendor 内容写进 Prisma 迁移或入库（你的 DB 永不入库约束）。

---

## 6. 分轮落地计划

| 轮 | 交付 | 验收闸 |
|---|---|---|
| R19（本轮已完成） | 本方案文档 | 你看过并拍板 §7 |
| R20 | vendor 引入：`git clone` 到 `vendor/serenity-skill/`（保留 `LICENSE` 与 MIT 版权行，MIT 要求附版权声明），并在 `references/` 基础上写一份中文口径卡（四档证据 → 你项目的 `origin`/`missing[]` 映射表） | `node --test tests/quant/*.test.ts` 与 lint/tsc 不受影响；vendor 目录确认不入 git 追踪之外的处理决定（见 §7 第 3 问） |
| R21 | 落点①：`chain` 组改造成四段式流程纪律（对着自有字段名写） | 新增 1 条形状拦门钉（输出必含分层/卡点/挂回+档次/证伪与未知四段，末段非空）；**旧钉只放宽不收紧**；基线以 2026-09-28 实跑 **1765 / pass 1756 / fail 0 / skip 9** 为准，不许变差 |
| R22 | 落点②：`sector_constituents` + `stock_business_composition` 进 TOOLS 与 `BUILTIN_SKILLS`，不标 `required` | 25 条 p7-intent 调度断言逐字保住；新增 2 条纯核测试（BK 代码非法 / MCP 未配置 → `missing[]` 不冒充）；实机走查一次「产业链挖掘」出研报 |
| 后话 | 落点③：主题血缘总览承接分层图；或 agent run 化 | 另开轮 |

每轮按你的协议收口：报告 → 验收 → 两笔提交（代码一笔 / worklog 一笔）。

---

## 7. 需要你拍板的三件事

1. **R20 之后是否同轮就动 R21（提示词）**，还是 vendor 完你先看内容再放行。
2. **`chain` 组输出允不允许附带参与/等待判断**——即 §4.4 的边界怎么划（纯研究清单 / 允许附带但必须标语境）。
3. **vendor 目录的 git 处理**：`vendor/serenity-skill/` 是提交进仓库（含 MIT 版权行，便于追溯），还是加 `.gitignore` 只留本地（你已有「DB 与 P1P2 删除永不入库」的习惯，第三方原文可能同样不想入库）。

---

## 8. 取证记录

- `muxuuu/serenity-skill`：GitHub API 实测 4,040★ / 628 fork / created 2026-05-04 / updated 2026-09-27；`LICENSE` 为 MIT（Copyright (c) 2026 muxu）；`SKILL.md` 与 `references/evidence-ladder.md`、`references/deep-research-workflow.md` 内容已逐份读取（英文原文，本文引用为译述，关键判据保留原义）。
- 项目侧引用位置全部实读核对：`prompt-library.ts:54-64`、`skills-core.ts:10-21`/`:60-118`/`:203-208`、`chat-tools.ts:884-906`、`api/market/sectors/[code]/route.ts:1-40`、`mcp-provider.ts:233`/`:260`/`:375`、`api/stock/fundamental/route.ts:12`/`:48`、`ProfilePage.tsx:314`。
- 未核实项（诚实标注）：`china-stock-mcp` 各工具（`get_product_info` / 券商研报 / 业绩预测 / 筹码）今日是否可用未实机探测；`fields.ts` 里资本开支/毛利率等字段的确切字段名未逐个对齐；`Scene` 联合类型能否容纳新场景未读；Qoder 市场与 skills.sh 均**未收录**该仓库（`search_extensions` 查 serenity/供应链瓶颈选股 = 0 结果），所以引入只能走第三方 GitHub 仓库，属第三方代码，需你授权才动。
