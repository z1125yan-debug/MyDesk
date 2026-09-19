# Worklog — MyDesk 个人行情工作台

## 任务：把旧的克隆包重构为原创的个人本地工具

用户目标：保留功能能力（AI 图表分析、智能助手、看板、追踪、MCP、自定义 AI 接口、浏览器扩展），
但界面 / 文案 / 数据 / 命名全部原创，仅个人本地使用，不复用任何第三方产品的 UI、文案与品牌。

### 已完成

- 删除旧复刻层：`src/lib/kairo`、`src/components/kairo`、`/api/copilot`、`/api/market`、
  旧扩展包、z-ai-web-dev-sdk 依赖、旧 mock MCP 服务器。
- 保留通用技术层并迁移到 `src/lib/desk`：zustand 持久化 store、MCP stdio 管理器（global key
  改为 `__mydeskMcp`）、`/api/ai/proxy`（OpenAI 兼容 / Anthropic / Gemini 三协议，Key 仅走请求头）、
  `/api/mcp/*`（servers/tools/call）、`/api/extension/pending`（32 条环形缓冲）。
- 原创数据层 `src/lib/desk/data.ts`：确定性伪随机演示数据（板块池 / 报价 / K 线随机游走 /
  枢轴点支撑阻力聚类 / 收盘价线性回归），MD 前缀演示代码，全部本机生成。
- 原创深色 UI（sky 强调色、A股红涨绿跌习惯）：
  - AppShell / Sidebar / TopBar（搜索直达、AI 状态章、刷新周期章）
  - CandleChart（自绘 SVG 蜡烛图：十字光标、最新价、支撑/阻力虚线、回归通道）
  - BubbleFlow（资金气泡图）、Sparkline
  - 8 页面：总览、数据看板、AI 分析、追踪、历史、智能助手、扩展、设置
- AI 分析页（用户指定最高优先级）：品种搜索 + 8 档周期 + 支撑/阻力/趋势通道开关 +
  「开始分析」→ 模型 JSON（结构解读/关键价位/偏差/入场/止损/目标/风险）→
  结构化卡片渲染 + 一键加入追踪弹窗 + 自动存历史；AI 未配置时给出引导。
- 「副驾驶」按用户要求全部改名「智能助手」（导航、页标题、分析页侧栏、提示词），
  系统提示改为分析师风格：先结论，再 结构/关键位/思路参考/风险提示 四段。
- 设置页：AI 服务商预设 + 测试连接；MCP 管理（手动添加 / JSON 导入 / trust 门控 /
  启动停止 / 工具列表，8 秒轮询状态）；通用刷新周期。
- 浏览器扩展 `public/mydesk-extension`（MV3 原创实现：popup 配置回传地址与配对码、
  content 脚本在 TradingView 图表页加悬浮按钮、background 转发以绕过页面 CSP）。
- MCP 演示服务器 `scripts/mcp/demo_market.py`（stdio JSON-RPC：initialize → tools/list →
  tools/call，提供 get_quote / list_hot_sectors 两个演示工具，纯标准库）。
- `启动.bat` 保留已验证的启动流程，仅改标题与报错文案；`使用说明.txt` 全部重写。

### 验证记录

- `npx tsc --noEmit`：0 错误。
- `next dev` 冒烟：首页 200 且 SSR 含全部导航（总览/数据看板/AI 分析/智能助手）；
  `/api/extension/pending` 200；`/api/mcp/servers` 200。
- MCP 全链路（API 实测）：POST 同步配置 → PUT start（发现 2 工具）→ tools/list →
  tools/call get_quote 返回演示报价。
- 注意：本机 `python` 指向损坏的 venv（No pyvenv.cfg），MCP 默认命令改用 Windows
  `py` 启动器（Python 3.14 实测通过）。
- 端口提示：验证时曾发现 3000 端口被旧版遗留 node 进程占用（已结束），新版正常启动。

### 交付

- 唯一交付包：`D:\MyDesk-Windows.zip`（109 文件，不含 node_modules/.next）。
- 按用户要求：包内中文文件名经系统 GBK 编码写入，中文 Windows 资源管理器显示正常；
  交付包放在 D 盘，C 盘不落任何产物（C 盘临时暂存已清理）。
- 源码工作副本保留在 ZCode 工作区（C 盘 workspace，含 node_modules，约几百 MB，
  如 C 盘紧张可整目录删除，不影响 D 盘交付包）。

## 追加：接入本地真实 A 股行情（2026-09-18）

- 新增 src/lib/desk/em.ts（服务端）：本机直连腾讯行情（实时批量报价 qt.gtimg.cn、
  分时 minute、K线 fqkline/mkline）与东财接口（searchapi 搜索、push2/delay 镜像板块资金榜、
  push2his 个股/板块 14 日主力净额），带 TTL 缓存（搜索 5 分/报价 15 秒/榜单 30 秒）防限流。
- 新增 /api/market/{search,quote,kline,board,board-detail} 五个路由（force-dynamic）。
- 新增 src/lib/desk/market.ts（客户端）：真实数据优先、失败自动回退本机演示数据；
  旧自选符号（XAU/USD 等）保持演示渲染，显式 missing 状态不冒充实数。
- 四页改造：AI 分析页（真实搜索支持代码/名称/拼音，真实 K 线 8 周期 + 实时报价）、
  顶栏搜索直达、总览自选卡片（分时缩略图 + 搜索式添加）、数据看板
  （实时个股/行业/概念/地域资金榜 + 14 日主力明细）。
- 默认自选改为 上证指数/沪深300/寒武纪；回归通道宽度改为随价格区间缩放。
- 验证：tsc 0 错误；搜索寒武纪 → 688256.SH；报价/分时/K线（日/60分/周/月）/板块榜
  全部返回真实数据。已知降级：push2his 被限流期间 14 日主力明细只有最新 1 天（delay 镜像），
  限流解除后自动恢复。

## 追加：MyDesk 完整需求 P0 落地（2026-09-19）

依据《D:\MyDesk完整需求_最终完整版.md》实施 P0（用户确认：四套 mockup 风格全部作废，按文档来）。

### 后端新增

- 因子字段目录与计算引擎 `src/lib/quant/factors/fields.ts`：44 个可计算因子（估值市值/量能/趋势均线含RPS/动量形态 MACD/KDJ/RSI/主力成本/VWAP/支撑阻力），全部标 `verified:false`（未验证，符合文档五）；快照口径字段显式区分、不参与历史匹配。
- 历史条件概率引擎 `probability.ts`：1/5/20 日胜率 + 样本数 + 实际统计区间 + 均值/中位/最好/最差；样本<30 标「样本不足」；快照条件剔除并警示。
- `POST /api/quant/screener`：全A漏斗（快照粗筛→K线子集流动性Top-K→K线条件→排序分页→include_stats 胜率），漏斗各层数量+口径警示全部返回。
- `GET /api/market/sentiment`：全A涨跌家数/涨停跌停/成交额/主力净额合计/中位涨幅/指数 + 风险等级（仅用有真实数据源的指标，缺失指标显式列出）。
- `GET /api/market/allstocks`：全A快照分页/搜索/排序。
- `GET /api/stock/profile`：个股资金画像（报价/五档/内外盘资金/东财主力流/技术指标/板块强度/快讯/历史概率/市场风险），每块带来源+状态，缺失块显式列出。
- `POST /api/ai/chat`：AI 交易员工具调用循环（10 个工具：市场情绪/板块榜/快照/五档/主动买卖/技术状态/资金流/快讯/条件选股/历史概率），系统提示强制「不编造数据/缺失显式/事实推断风险分层/不给买卖建议」，返回证据链 trace。
- `src/lib/quant/data/hybrid.ts`：取K线混合层（eltdx 带量额 ~30ms/只 优先，腾讯兜底，连续失败熔断）；`tdx.ts` 新增 tdxDayBars/tdxDepth/tdxTradesMoney（主动买卖改用快照内外盘×成交均价的全日口径，逐笔翻页口径不完整已弃用）。

### 前端新增（导航重排为前台+后台结构）

- 侧边栏分组：实时选股（AI首页/AI实时选股/因子选股器）· 市场（大盘情绪/全A列表/个股画像/自选股）· 行情工具（旧五页保留）· 研究后台（量化研究）· 系统。
- 新六页：AiHomePage（大输入框+四模式+推荐问题+真实市场状态摘要）、ScreenerPage（因子pill+条件chips可编辑+胜率表格悬停明细）、AiScanPage（扫描入口+自然语言→条件（AI解析/关键词映射降级）+漏斗+结果+冻结候选池，冻结池存 localStorage 不可覆盖）、ProfilePage（结构化画像+降级说明+AI条件式解读）、MarketPage、AllStocksPage。
- 共享：SourceBadge（LIVE/HISTORICAL/DEGRADED+来源+时间）、PctText/NumText（红涨绿跌）。

### 关键坑（重要）

1. **Turbopack 模块双实例**：`./data/index.ts`（带扩展名）与 `@/lib/quant/data/index` 被视为两个模块，bootstrap 注册进 A 实例、路由从 B 实例读取 → 全部 quant API 报「EM Provider 未注册」。修复：bootstrap.ts 与所有新模块统一用无扩展名/别名导入。node:test 纯逻辑模块仍可用 `.ts` 相对导入（无全局状态不受影响）。
2. **Next 16 dev 拦截 IAB**：默认 blockedDevOrigins 拦截来自内置浏览器的 /_next/hmr 与字体 → 客户端 hydration 完全不执行（页面是死 SSR DOM：点击无效、fetch 不发）。修复：next.config.ts 加 `allowedDevOrigins: ["127.0.0.1","localhost"]` 并重启。
3. **北京时间**：`new Date().toISOString()` 是 UTC，北京凌晨日期会退回前一天；统一用 `session.ts` 新增的 `shanghaiDate()/shanghaiStamp()`（Intl formatToParts）。
4. 腾讯 fqkline 日K无成交额字段（只有6列）→ VWAP 类因子必须走 eltdx bars.get（带 amount）。

### 验证记录

- `npx tsc --noEmit` 0 错误；judge 视觉验收 8 张页面 PNG：7 pass，1 fail（主力净额图在仅 1 日数据时渲染成无信息色带）→ 已修复为显式降级说明，复检通过。
- 真实数据端到端：情绪（5554只/涨停97/2.09万亿）、全A列表、选股漏斗（5916→2663→120→92）、华天科技胜率（53%/样本228/区间2024-10~2026-09）、画像全块、冻结候选池 2026-09-19-全A-001。
- AI 对话/优中选优需用户在「设置→AI接口」配置 OpenAI 兼容 Key 后可用（本会话浏览器档案未配置，界面已给引导）。
- 已知口径限制：RPS 为K线子集内百分位（非全A）；主动买卖=内外盘×均价代理指标；历史胜率不含快照口径条件的时点匹配（均已在前端警示）。

## P1-1 候选池冻结 + 次日自动验证（2026-09-19）

- Prisma 新增 `CandidatePool` 模型（`candidate_pool` 表）：pool_id / as_of / universe / conditions(JSON) / source / rows(JSON，冻结后永不覆盖) / verify(JSON，次日回填可重算覆盖)。
- 新增 4 个 API 路由：`POST /api/pool/freeze`（落库+返回 YYYY-MM-DD-universe-序号）、`GET /api/pool/list`、`GET /api/pool/[id]`（冻结原始 rows + verify 回填）、`POST /api/pool/[id]/verify`（fetchBarsHybrid 取 asOf 后真实日K，计算 ret1d/ret5d/mfe/mae；不足1交易日返回 pending）。
- 前端新增 PoolPage（候选池列表 + 详情对照表，红涨绿跌，汇总胜率/MFE/MAE）；注册进 PageKey / Sidebar「实时选股」组 / AppShell 分支。
- AiScanPage「冻结候选池」按钮改调 POST /api/pool/freeze，服务端失败降级 localStorage 并提示「离线模式」。
- 冒烟：freeze→list→[id]→verify 全链路通过；verify 同日返回 pending（符合预期：asOf 之后无新日K）。`npx tsc --noEmit` 0 错误。

## P1-1 尾巴 + P1-2/3/4/5 一次性交付（2026-09-19 第二轮）

### P1-1 收尾（历史池真实回填实测）

- quant-api.ts 补封装：`freezePoolApi/fetchPoolList/fetchPoolDetail/runPoolVerify` + 类型（PoolRowClient/PoolSummaryClient/PoolVerifyClient/PoolDetailClient）；AiScanPage 冻结改走封装。
- **实测发现并修复真 bug**：verify 路由原来 `fetchBarsHybrid(symbols, pool.asOf, 60)`——该函数内部按 `date<=asOf` 截断，asOf 之后的K线永远为空，历史池会永远 pending。修复：拉取时传 `shanghaiDate()`（今天），再在结果里过滤 `> pool.asOf`。同日池回归仍正确返回 pending。
- 回填实测：直插 `candidate_pool` 一行（asOf=2026-09-11，3只真实股票）→ POST verify 返回 verified，ret1d/ret5d/mfe/mae 全部为 9/14~9/18 真实日K计算值；PoolPage 详情「冻结原始 vs 验证回填」对照+汇总渲染正常（浏览器实测）。

### P1-2 行业板块排行（SectorsPage）

- `GET /api/market/sectors`：fetchBoardReal(in)+fetchBoardReal(out) 合并去重按涨幅排序；RPS=榜单内百分位（前端已注明非全市场口径）；数据源不含的列（成交额/上涨家数/涨停家数/持续天数）显式「暂无数据」+原因，不做演示兜底。
- `GET /api/market/sectors/[code]`：板块成分（emProvider listUniverse industry 口径，含成交额/换手/主力净额/ST/停牌）。
- SectorsPage：榜单表→点行展开成分→点个股跳画像。侧边栏「市场」组新增「行业板块」。

### P1-3 自选股增强（WatchlistPage）

- 新页接管 tracker 路由位：批量 `GET /api/market/quote?symbols=`（30只/批上限），列=现价/涨跌幅/昨收/今高/今低/成交额/分时sparkline/AI分析/移除；取不到显式「暂无数据」。
- 原 TrackerPage 未改动，作为「交易计划」区块嵌入页尾（P0 视觉零改动）。

### P1-4 因子有效性测试台（FactorLabPage）

- Prisma 新增 `FactorTest` 表（已 generate+db push）：每次测试全量落库可追溯。
- 引擎 `src/lib/quant/factors/tester.ts`：全A剔ST/停牌→流动性Top-N→fetchBarsHybrid 长历史→buildFieldPanel→复用 Phase-2 `evaluateFactorMetrics`（t日因子↔t+h前向收益防泄漏）→ 月度RankIC（方向调整）胜率 + 最优档1日组合最大回撤。快照口径字段明确拒绝测试。
- 通过标准（文档五硬性）：样本充足 且（|ICIR|>0.5 或 |单调ρ|≥0.9）且 月度胜率>60% → passed → `markFieldVerified` 落盘 `data/factor-verified.json`（mtime 缓存，跨 Turbopack 模块实例一致），factorCatalog() 读取覆盖 verified 标志。
- `POST/GET /api/quant/factor-test`（同步执行，maxDuration 600）。
- 实测（150只×514交易日，2024-08~2026-09）：rps_50 未过（ICIR -0.14、单调0.79、月胜率61%）；macd 未过（单调0.97✓但月胜率58%✗）；above_ma_144 未过。当前 0/45 已验证——结论如实呈现，「已验证」徽章机制待首个通过因子自动点亮。
- 已知限制：ScreenerPage 顶部「未验证」提示为 P0 静态文案（不在白名单），未自动隐藏；因子目录/测试台已按字段级 verified 展示。

### P1-5 存为策略 → 回测接线

- quant-api.ts 新增 `saveScanAsStrategyApi`（POST /api/quant/strategies，kind=rule、status=Candidate、版本化 insert-only）。
- AiScanPage 结果态新增「存为策略」按钮：strategyKey=`aiscan-<asOf>-<序号>`，factorRefs=条件字段去重，selection 记录 universe+条件+来源+命中数；成功提示并给「去量化研究」跳转。
- 冒烟：POST 返回 version:1、factorRefs 规范化（weight/direction 默认值齐）✓。

### 验收

- `npx tsc --noEmit` 0 错误（最终全量）。
- curl 冒烟全过：pool list/verify（pending+verified 双路径）、sectors（40板块）、sectors/BK1036 成分、quote 批量、factor-test POST×3+GET 历史、factors catalog、strategies POST。
- 浏览器实测：行业板块/候选池（含已验证详情）/因子测试台（目录+3条记录）/自选股（3只真实行情+追踪嵌入）四页渲染无报错，控制台无 error。
- 未动：P2 全部、原版 D:\Zai\kairotrend、P0 页面视觉逻辑、next.config.ts、依赖包（零新增）。测试数据保留：candidate_pool 的 2026-09-11-all_a-901（回填实测样本）、策略 aiscan-2026-09-19-901。

---

## P0 补齐（用户授权新增）· 任务A 炸板率 + 任务B 涨停梯队（2026-09-19）

### 任务A 炸板率（sentiment.ts + MarketPage）

- 白名单偏差披露：任务A 需要快照 high/prevClose，对 `src/lib/quant/data/em-provider.ts` 与 `src/lib/quant/types.ts` 做了最小加性改动——UNIVERSE_FIELDS 追加 f15(最高)/f18(昨收)（同一次 clist 请求加两个字段，**未新增任何网络请求**）；AssetMeta 加可选字段 high?/prevClose?（mcp-provider 等不受影响）。其余仍限于白名单文件。
- 精确口径：涨停价 = round(昨收×(1+比例),2)；比例按名含ST→5%、代码300/301/688/689→20%、.BJ→30%、其余10%。触板=今高≥涨停价；封板=现价≥涨停价；炸板=触板且未封板。N/C 开头新股（注册制次新无涨跌幅限制，任务书只说 N，实测 C沈鼓 盘中+300% 佐证需一并排除）不参与统计。
- SentimentResult 新增 touched_limit/limit_up_broken/break_rate；风险触发：炸板率>40%→「偏高」（证据文案含触板/炸板只数）。
- 实测（2026-09-19 盘中）：触板 115 · 封板 83 · 炸板 32 · 炸板率 27.8%（<40% → 风险维持「正常」，行为正确）。
- 口径差备注：旧实现按涨跌幅≥9.8% 判涨停得 97 只；新精确价口径 83 只——旧法把 +9.8~10% 未封板收盘误计为涨停（假阳性）。与公开涨停复盘核对（ jrj 涨停复盘/同花顺，2026-09-18/19 报道）：锡华科技(603248) 4连板 ✓、华瓷股份(001216) 4连板 ✓、三羊马(001317) 首板 ✓；差几只属盘中/收盘口径差，正常。

### 任务B 涨停梯队（limitup.ts + /api/market/limitup + MarketPage）

- 新文件 `src/lib/quant/screener/limitup.ts`：先取全A快照筛出封板名单（十~百只），**只对名单**逐只 `fetchBarsHybrid(symbol, asOf=今日, 20)` 取日K（em-provider 自带缓存/节流，未拉全市场K线），自后向前数「收盘≥当日涨停价」（历史日用 昨收=前一日收盘 推涨停价，比例−0.5pct 容差，兜底腾讯前复权口径已在 note 注明）→ 连板数。
- 输出：最高板/3连板+/2连板/首板 四梯队 + limit_up/touched/broken/break_rate + max_boards；新路由 GET /api/market/limitup（maxDuration 180）。
- MarketPage 新增「涨停梯队」区块：梯队行 + 个股 chip（点击 setFocusSymbol→跳画像），点「锡华科技4板」实测落到 603248.SH 画像页（+9.98%、今日涨停=是）✓。
- 实测：83 涨停 → 最高板 2（锡华科技4板/华瓷股份4板）+ 3连板+ 4 + 2连板 8 + 首板 71 = 83 ✓ 内部一致。
- 首版曾把 C 开头次新（C沈鼓 +2xx%「涨停」）计入首板，扩展 /^[NC]/ 排除后 85→83。

### 验收

- `npx tsc --noEmit` 0 错误。
- curl /api/market/sentiment：break_rate 27.8 实数、触发列表无炸板项（<40%）✓；curl /api/market/limitup：四梯队真实名单 ✓。
- 浏览器：大盘情绪页「涨停/炸板」卡（83/32/28%）与「涨停梯队」区块渲染正常，红涨绿跌、SourceBadge 保留，无新样式破坏；个股 chip 跳画像实测 ✓。
- missing 文案已去掉「连板梯队（涨停历史未建库）」「炸板率（无盘中开板数据源）」两项（均已实现）。

## P0 补齐 · 任务C 因子扩军第一批（fields.ts 纯公式，2026-09-19）

- 新增 32 个 kline 因子，全部 verified:false（只有 P1-4 测试台可翻 true），命名/分组按需求文档三：
  - 缠论(6)：chan_top/bottom_fractal（包含处理合并→标准3-K分型，确认日记1）、chan_third_buy/sell、cz_break_up/down（中枢简化口径：已完成最近6根处理K区间重叠 [ZD=max(low),ZG=min(high)]，ZG>ZD 成立；全部公式口径写在函数注释里）。
  - TD序列(5)：td_buy/sell_seq（连续 close vs 4根前close 计数）、td_signal（Setup 首次=9）、td13_buy/sell_qualified（Setup完成后倒计时「close vs 2根前 low/high」，达13且距Setup≤21根；清零规则见注释）。
  - 江恩(3)：gann_support_sig_1_1/1_2/2_1（时方格简化：120根内首个最低点锚定，线=L×(1+r×k)，r=1%/0.5%/2%每日；信号=当日low入线±1%带且收阳收回线上）。
  - 高斯通道(7)：gauss_mid/upper/lower（win=40 高斯加权均线 ±2×加权std，零滞后近似）、trend_up(3日中轨上行)、flip_up/flip_down（上行状态翻转日）、overheat（收盘破上轨）。
  - VWAP体系(5新增+1复用)：vwap20(成本价原值)、vwap20_slope3、vwap_score(站上+上斜+偏离≤8% 三项0~3)、allow_long(站上且VWAP上行)、entry_signal(当日上穿且三日上斜)；vwap_pos 已存在→复用不重复。
  - 支撑阻力(6)：support_near/bounce_60/144、resistance_breakout_60/144（线=滚动N日低/高不含当日；突破需「上穿事件」，与既有 breakout_high_*（含当日窗口≥判定）口径不同）。
- 去重确认：above_ma_90/above_ma_144/ma_struct/ema14_gt_ema26 均已存在于 FACTOR_FIELD_DEFS，未重复添加。
- 成交额纪律：vwapCalc 加「amount<=0 视同缺失」——腾讯日K无量额时 VWAP 系（含既有 vwap20_filter/above_cost_20）输出 null 而非假值（旧实现 amount??0 会把无额K线算成 vwap=0、above_cost_20 恒真——这是顺带修正的真实缺陷）；eltdx bars.get 带额时正常出数。
- 白名单偏差披露：新增测试文件 tests/quant/phase5-p0fields.test.ts（10 用例：包含/分型/中枢三买、Setup9/Countdown13、高斯带、江恩1x1 精确命中与 1x2/2x1 不命中、VWAP 宁缺勿假、buildFieldPanel 集成）——任务书要求「纯逻辑可被 node:test 直跑」，故新增文件，未改动任何既有测试。
- 未做（按任务书）：zsb 庄家宝体系——需通达信公式原文，禁止凭名称猜公式，等用户提供。
- 验收：tsc 0 错误；node --test tests/quant/*.test.ts 53/53 全过（含既有 43）；curl catalog 77 字段（新 32 全出现、verified 仍 0/77）；POST screener allow_long>=1 → 漏斗 {5563→5012→40→17} 真实出数；chan_top_fractal=1 → 5/60 命中；因子选股器页 pill 分组（缠论/TD序列/江恩/高斯通道）渲染确认。

## P0 补齐 · 任务D 北向资金文案（2026-09-19）

- 事实：沪深港通北向每日净买入自 2024-08-19 起不再披露（实时额度数据 2024-05-13 起停更），无官方数据源可接入；不接第三方「北向资金」估算接口冒充官方口径。
- 改动：sentiment.ts missing 首项 → 「北向净流入：交易所自2024-08-19起不再披露，无官方数据源」。前端（AI首页摘要条/大盘情绪页）均渲染 sent.missing 动态文案，无需改文件（grep 全仓「北向」仅 sentiment.ts 两处：注释+本条）。
- 验收：tsc 0 错误；curl /api/market/sentiment → missing[0] 新文案 ✓（break_rate 27.8% 等实数不受影响）。

## P0P1 验收修复 + ZSB 庄家宝因子实现（任务书 §一~§九，2026-09-19）

- §一 Git：工作区自 0a5dbb4 起承载 P0/P1/补齐/本轮全部未提交改动（25 修改 + ~30 新增），无临时/生成物混入源码；design-mockups/ 判为临时物不入 commit，data/factor-verified.json 判为运行时状态（缺失安全回退）不入库；本轮改动按文件清单正式 commit（见文末 hash）。
- §二 测试数据隔离：硬编码价格冒充行情 → 未复现（日期常量仅在显式 demoProvider 单测内）；REAL_DATA_ONLY 服务端无 demo 回退路径（getProvider 仅显式 id=demo 才用演示源）；candidate_pool 缺数据来源口径 → 确认存在，已修：schema 增 dataSource 列（db push + generate）、freeze API 透传 screener source.provider、list/[id] 回读 data_source；hist-backfill-test → 确认存在（DB 池行而非代码 fixture），保留 + PoolPage 显式「测试/回填样本·非正式结果」标识（含 verify_test/smoke_test 等 test 字样池；乱码旧池 101 来源字节已损不可恢复，不猜测改写）。
- §三 涨停态：is_limit_up 依赖最后一根K线涨幅≥9.85 → 确认存在，修复为快照优先（fields.ts evalLimitSnapshot：涨停价=round2(prevClose×(1+比例))，price/high 封板/触板；N/C 新股期与缺字段 → null=UNKNOWN 剔除并显式计数，绝不冒充 false）；K线 lastBar 早于快照日 → bar_time<snapshot_time 警示；历史回放匹配口径未动（回归用例不受影响）。
- §四 复权口径：收益/胜率计算均在单一K线序列内 → 数学口径未复现问题；元数据标注缺失 → 已修：screener 响应 source.price_basis、pool/[id] 返回 price_basis，PoolPage 表头与说明块明示「冻结时=真实未复权价 / 验证=K线序列口径（eltdx 原始价、腾讯兜底 qfq），除权附近跨口径不一致属正常，禁止改数据凑数」。
- §五 验证状态文案：ScreenerPage 静态「全部因子未验证（P1）」→ 确认存在，改为 catalog+factor_verify 动态（库 N·选用 M·已验证 V·排除 E）；run.ts 警示改为「本次涉及 X 因子、Y 未验证」分支；AiScanPage 同步；FactorLabPage 本已动态。
- §六/§七 ZSB 庄家宝体系：按公式整理文档实现 11 因子（zsb_dealer 庄家线=EMA(J(RSV81),6)、zsb_retail 散户线(M=34)、zsb_rsi_v(SMA递归,N=14占位)、acc_dif/dea/macd(与 macdCalc 口径一致→复用同序列)、zsb_rsi_reduce/accum/attack/trigger(0/1)、zsb_bdw(N=20占位)）；新增 tdxSma 递归（严禁与简单均线 sma() 混用）；SMA 口径全部走 tdxSma/kdjCalc；4 项登记不实现（zsb_height_control 需 WINNER/COST 筹码分布；acc_base/strong_acc_conds_met/strong_acc_pick 无公式原文）→ implemented=false/status=pending_dependency，定义保留不计算；registry 防护：factorCatalog 分类不含 pending、screener/probability 显式忽略+警示、tester 明确拒绝、前端 pill 不出现在自定义条件中 disabled+「· 未实现」。
- 顺带修正（真实缺陷，测试时间炸弹披露）：selection/engine.ts todayStr() 用 UTC ISO 日期 → 北京 00:00~08:00 会把合法「昨天」回放误拒；改 shanghaiDate()。phase4-11「拒绝今天」用例硬编码 2026-09-18（写作当日=今天），跨日后必然失败（断言本身未动）→ 拒绝用例 asOf 改为动态 shanghaiDate()，仍断言 /早于今天/ 拒绝，未删除未降低。
- §八 测试：新增 tests/quant/zsb-factors.test.ts 18 用例（tdxSma 递归精确/retail 手算40与hh==ll拒绝/rsiV 单调量100·0·恒定null/dealer 平坦通道=50/acc_*与macdCalc逐点相等/0-1信号值域/bdw N参数化默认20/registry 11+4状态/factorCatalog 分类/panel 不产出pending/evalLimitSnapshot A-D回归/涨跌停比例）；未删除未改动其余既有测试文件（除上条披露的 phase4-11 日期修正）。
- §九 验收：tsc 0 错误；node --test tests/quant/*.test.ts 71/71 全过；curl catalog=11 分类项+92 字段+pending 4 项 verified:false；POST screener zsb_attack=1 → 漏斗 {5916→5353→40→13} 真实出数、factor_verify={92,7,0,7}；zsb_height_control 条件 → 显式忽略警示；factor-test 提交 pending → 明确拒绝；is_limit_up=1 → bar_time 警示正常；pool freeze→list/[id] data_source+price_basis 回读通过（冒烟池已清理）；浏览器：庄家宝体系 11 pills、动态验证文案「库 92 · 选用 0 · 已验证 0」、pending 仅 disabled 选项、候选池 3 测试池 amber 徽标；dev server 重启 + npx prisma generate 成功（此前 EPERM 因 DLL 被锁）。
- P2（风险页/概率页/主线发现/主动发现/事件雷达）按任务书继续冻结未动。

## P2 剩余因子包（任务书 D:\DoubaoData\P2下一步执行指令_剩余因子包.md，2026-09-19）

### Step 1：全库因子批量 IC 验证闭环（真实数据，未降低阈值）

- 新增 `runBatchFieldTests()`（tester.ts）：universe/K线/面板只构建一次，逐因子走 `testFieldOnPanel()`，与单因子测试台同一口径同一判据；新增路由 `POST /api/quant/factor-test/batch`（每条落 `db.factorTest`，`persist:false` 可只算不写）。
- 判据仍为需求文档§五原式（未为凑数放宽）：`enoughSample(validPairs≥60 且 monthlyIc≥4)` 且（`|ICIR|>0.5` 或 `|monotonicity|≥0.9`）且 `monthlyWinRate>0.6` → 才写 verified=true。任务书提到的 `|RankIC|>0.03 且 |ICIR|>0.3` 单独作为 loosePass 列报告，不参与 verified。
- 真实批量结果（`data/factor-verify-report.json`，as_of 2026-09-19）：样本池=成交额 Top 300，实际入面板 287 只 × 515 个交易日（2024-08-07~2026-09-18），horizon=5，lookback=500（任务书 250 会让 250 日窗口因子无值，取更长更严口径并披露）。
  - requested 108 / tested 108 / passed **33** / failed 0；loosePass 11（任务书线在此数据下比§五单调性通道更严，33 条里多数 |ICIR|≈0.24~0.28）。
  - 33 条通过项 RankIC 全为负 → 本区间（2024-08~2026-09，流动性前 287）以反转效应为主：verified=true 的含义是「有预测力且跨月稳定」，不是「做多信号」，方向必须结合 rankIc 符号读。
- `data/factor-verified.json` = 33 个 true 键（只有测试台可写；pending 因子不进账本，测试断言已绑定）。
- 执行披露：期间因误判后台任务状态重复触发过一次全量批量（两次结果逐条一致，均为 33/108），DB `factorTest` 表多出 111 条重复历史行（共 219），属 insert-only 历史，UI 按 field 取最新一条，不改写不删除。

### Step 2：任务书 A 组纯日线因子实现 + B 组仅登记 pending

- 严格照任务书原始公式参数实现（未自行「优化」参数）；去重后不重复注册 vwap_pos/vwap_score/gauss_overheat 等既有键。
- 注册表 137 键：可测 kline 因子 108，`implemented:false` pending 19（zsb_height_control、acc_base、strong_acc_conds_met、strong_acc_pick、candle_patterns_text、pe_dynamic、sector_rps_*、in_sector_rps_*、concept_rps_*、concept_lead_strength、bidding_* 5 项、super_resonance_week、zsb_super_buy）。pending 只登记（含 data_requirements/原因），无计算体，UI 显示「未实现」。
- candle_patterns_text 披露：纯函数 `candlePatternCalc` 已实现且有单测，但输出为字符串标签，当前因子面板/IC 框架只支持数值列 → 保持 pending，不做数字编码假接入。
- 新增单测 tests/quant/p2-factor-pack.test.ts（公式手算/边界/注册状态/pending 防护）。

### Step 3：契约补齐（§二/§四/§六/§二十二）

- 操作符：`CondOp` 扩 `in` / `not in`；新增唯一实现 `cmpWithOp()`（probability.ts），选股引擎 run.ts 与概率引擎共用同一份（原 run.ts 内重复的 switch 已改为引用，消除两引擎口径漂移）。多值来自 `listOf()`：数组或 `, ， / ; 、 |`/空白分隔串；数值项按数值容差比较，非数值按字符串相等；空列表 / null / NaN → false（UNKNOWN 不判真）。回测 `rebalanceEvery` 提升为 BacktestConfig 正式字段。
- 胜率统计：每个持有期新增 `max_drawdown`（命中样本按时间复利净值回撤，≤0，样本<2 → null）、`benchmark_return`/`benchmark_sample_size`/`excess_return`（基准=沪深300 000300.SH，按「命中日→t+h」日期对齐取同期收益；基准K线缺失或日期不可对齐 → null + 显式警示，绝不以 0 代替）。
- 交易日：新增 `GET /api/quant/screener/trade-dates`（真实上证指数日线，倒序 N 条，失败 502 明确报错不伪造）；screener/probability 均接受 `trade_date`，历史日期 → K线重放口径（快照条件剔除 + 警示、行情展示值由当日K线重建、`is_limit_up` 回退K线定义、响应带 `trade_date_is_historical`），非法/未来日期回落当日并警示。
- 结果表：`order_by=win_rate_1/5/20` 真正生效（先按 statsCap 计算胜率再排序再分页，非命中页不浪费请求）；ScreenerPage/ProbabilityPage 加交易日下拉（当日 + 真实交易日）、「历史回放」徽标、胜率排序选项、条件值输入走 parseCondValue（in/not in 列表不被 Number() 吞掉）；结果表新增「5日回撤」「基准·超额」两列，悬停含三档回撤与基准。
- 回测成本：`TransactionCost.spreadRate`（默认 0.001）双边各承担半点差——买入执行价 ×(1+s/2)、卖出 ×(1-s/2)，与 slippage/commission 分列；涨跌停改分板真实比例（复用 `limitRatio`：主板10% / 创业板300·301、科创板688·689 为20% / 北交所 .BJ 30% / ST 5%），删除引擎内 0.095 近似，panel 带 `names`（validation.ts、strategy-jobs.ts 已补），封锁原因文案带比例。
- 新增单测 tests/quant/p2-contract-fixes.test.ts 10 用例（in/not in 解析与容差、两引擎同实现等价、回撤可解析验证（单调 -1%/日 → (0.99^n-1)）、样本<2 → null、基准缺失/错位/半对齐三种 null 路径、分板比例、+15% 开盘主板拒买而创业板/北交所放行、买卖两侧点差执行价 11.51/11.39）。
- 既有测试调整（未删除、未降低断言）：p2-factor-pack 的「新因子 verified 初始 false」硬编码断言在 Step 1 真实验证后与事实不符 → 改为更强的账本一致性断言（全库 `catalog.verified === (factor-verified.json[key]===true)`，且 pending 键不得出现在账本、账本只存 true）。
- 验收：`npx tsc --noEmit` 0 错误；`node --test tests/**/*.test.ts` 103/103 全过。

### Step 4：P2 五页面浏览器实机验收（真实数据，无改动公式）

- 前置缺陷（阻塞验收，非页面逻辑问题）：`#/radar` 报 `Failed to execute 'json' on 'Response': Unexpected end of JSON input`，`curl /api/radar` → `http=500 size=0`，dev 日志 `The table 'main.radar_finding' does not exist in the current database`。根因：schema 里 RadarFinding/GlobalEvent 模型已登记、Prisma Client 已生成，但 SQLite 库从未建表（P2 WIP 未 db push）。处理：`npx prisma db push`（仅建表，非破坏性；顺带的 generate 因 dev server 锁住 query_engine DLL 报 EPERM，Client 无需重新生成故不影响）。
- 小修（属错误处理，不是页面大改）：`GET /api/radar`、`GET /api/events` 补 try/catch，失败时返回 `{ok:false,error}` + 502，避免空 body 让前端抛出无法定位的 JSON 解析异常（POST 原本已有）。
- 风险监控 `#/risk`：正常渲染，市场风险等级「正常」，炸板率 28% / 涨跌比 3.68 / 主力净额 399 亿，历史参考区块给出上证相似涨跌幅环境 1/5/20 日（样本 113/112/106、均值 -0.03%/-0.06%/-0.12%）；「暂缺」如实列出北向净流入停披与 1 只新股触板跳过。
- 主线发现 `#/themes`：主线/次主线/轮动卡片渲染正常（集成电路制造 +4.59%/12.4亿/扩散100% 等）；板块日K无返回处显示「连续强势 — 日」，未以 0 或猜测值填充。
- 概率实验台 `#/problab`：条件 pill、交易日下拉（当日 + 120 个真实交易日，来自上证指数日线）、批量结果表格、最大回撤/沪深300基准/超额列与「基准数据缺失 → — 不以 0 代替」文案均按 Step 3 实现生效。
- AI 主动发现 `#/radar`：「立即扫描」按钮实机可用，扫描后 10 条真实发现入库并按类型渲染（FUND 3 / THEME 4 / NEWS 2 / RISK 1），页面底部「口径」行完整披露 6 项限制（板块日K缺失、RPS 为榜单内百分位、事件分级为关键词规则、产业链映射来自起步表、北向停披、1 只新股触板跳过）。
- 事件雷达 `#/events`：`POST /api/events` 扫描后 2 条真实事件落库并渲染（日本核心CPI→券商/银行/房地产/黄金；宁德时代锂盐项目→汽车/电力设备/有色金属），含时间、分级、映射板块与板块资金核验（涨幅/主力净额/排名，涨跌用红涨绿跌）。
- 因子测试台 `#/factorlab`：清单按分类渲染 137 键、pending 项仅显示不计算，顶部计数「已验证 33/137」直接读 factor-verified.json 账本。
- 控制台：仅 React DevTools 提示与 `[HMR] connected`，无 error/warn；五页均无白屏。

### Step 5：全量回归 + 目标核对（commit 等人工确认）

- `npx tsc --noEmit` → 0 错误；`node --test tests/**/*.test.ts` → 103/103 通过（未删除既有用例、未降低断言）。
- 注册表逐键核对（脚本比对 HEAD 版与本版，用后即删）：92 → 137，新增 45 键、删除 0 键。
  - 任务书 A 组 34 项：vwap_pos、vwap_score 旧表已有 → 复用不重复登记；其余 32 项新登记（其中 candle_patterns_text 因面板只支持数值列 → 仅 pending）。
  - 任务书 B 组 18 项：zsb_height_control、acc_base、strong_acc_conds_met、strong_acc_pick 上一批已登记为 pending；其余 14 项新登记，但 pe_dynamic 同时出现在 A5 与 B 清单，只登记一次 → B 实际新增 13。
  - 合计 32+13=45，与逐键 diff 一致；144−137=7 全部为去重复用（A 2 + B 4 + pe_dynamic 重复 1），非漏做。
  - 状态分布：pending 19（旧 4 + 新 15），快照口径且已实现 10（不参与 IC 测试），可测 K 线口径 108；批量真实验证 108/108 完成、通过 33，`data/factor-verified.json` 33 条 true 与报告 passed 集合逐键一致（双向差集为空）。
- 待确认后才 commit。`git status` 42 项：本次改动（fields/probability/run/engine/types/tester/quant-api/ScreenerPage/ProbabilityPage 等 + 2 个新测试 + factor-verified/factor-verify-report 数据）；另一会话未提交的 P2 WIP（RiskPage/ThemesPage/RadarPage/EventsPage/AppShell/Sidebar/schema 模型/radar.ts/events*.ts/theme*.ts/similar-env.ts/theme-chain-map.json、design-mockups/）也在同一副本工作区内，提交范围需人工确认；`prisma/db/custom.db` 为二进制库文件，是否入库需决策。

### 补记：`data/factor-verify-report.json` 移出版本库（2026-09-19，人工确认后）

- 定性核查：全仓（排除 node_modules/.next/.git）除本 worklog 外无任何代码读写该文件；batch 路由只 `db.factorTest.create()` 落库并返回 JSON，文件顶层字段 `{ok, persisted, unavailable, rows}` 正是接口响应形状 → 属人工 curl 快照，非研究资产。只读查库交叉核对：`factor_test` 219 行 / 去重 108 因子 / 每因子最新行 passed=1 共 33 个，与 `data/factor-verified.json` 的 33 键一致 → 正式测试历史在库表，verified 真源是 `factor-verified.json`（`tester.ts` 的 `markFieldVerified()` 写、`factorCatalog()` 读、p2-factor-pack 断言绑定）。
- 处理：按仓库既有约定（`data/quant-config.json` 就地忽略）执行 `git rm --cached data/factor-verify-report.json`（本地文件保留 44993 字节作证据），`.gitignore` 新增 `data/factor-verify-report*.json` 防同类快照再入库；`factor-verified.json` 已确认未被忽略、仍在版本库。未改公式、未改测试逻辑、未动数据库、未动其他会话的 P2 WIP（24 项保持原样）。

## P2 收尾（2026-09-19 第二轮：八项收口，commit 等人工确认）

基线 `8c6cdd1`。本轮只做任务书§一 的 8 项收尾，未重新开发任何已完成页面。开工前 `git status --short` 24 项 P2 WIP 全部保留。

### 决策取证（只读）

- `custom.db`：`.env` 为 `DATABASE_URL=file:./db/custom.db`（`.env*` 被忽略，`启动.bat:51` 会重建）；仓库无 `prisma/migrations`、无 seed 脚本。只读查库（`node:sqlite` DatabaseSync）得 10 张业务表：`factor_test` 219、`quant_knowledge` 67、`quant_jobs` 14、`radar_finding` 10、`candidate_pool` 5、`quant_factors` 8、`quant_strategies` 5、`quant_experiments` 7、`global_event` 2、`User/Post` 0 → 它是研究账本与 P2 归档的唯一载体，且自 `aaafc06` 起一直被跟踪（最近 `aedefe9`）。人工选择：A 保留入库。
- `design-mockups/`：`src/` 零引用；`eltdx-验证-实时与五档.md:58` 记载 4 套风格页「全部是手写死的示例数据，仅用于视觉选型」；本 worklog 第 204 行既有判定为临时物。人工选择：B 加入 `.gitignore`（文件保留在磁盘，未删除）。

### 逐项落地

1. `.gitignore` 追加 `design-mockups/`（含理由注释与 `git add -f` 逃生说明）；未跟踪目录不删文件即从提交候选中移除。
2. `EventsPage` SourceBadge：原硬编码 `LIVE · 快讯+映射表` 与真实数据链（读 `global_event` 库行）不符 → 改为 `HISTORICAL`，并按来源分两种文案：GET 读回标「global_event 当日库行」、POST 扫描后标「本次扫描写入 global_event 后回读」（新增 `origin` 状态）；副标题补「手动扫描落库（非后台自动更新）」。浏览器实测两态文案均正确切换，未映射 23 条仅计数不入库。
3. 能力边界文案：`RadarPage` 副标题补「当前无后台自动扫描」；`AiHomePage` 原「AI 主动发现（每日自动推送）」→「（当前需手动扫描，尚无后台自动推送）」（这是仓库内唯一把 P2 写成自动推送的地方；`P1P2_任务书.md:125` 属需求原文，不改）。
4. 幂等策略定稿：`schema.prisma` 两个模型注释写明「当日先删后插、跨日历史不触碰、刻意不设唯一键」，并把不变式指向测试文件。未改路由业务逻辑、未加唯一键。
5. `boardDayStreak` 保持 missing：实测 `/api/market/themes` 卡片 `streakPct: null` 且 `missing` 含「板块日K连续强势天数（东财 kline 无返回，本批全部缺失）」→ 无伪造，维持原状（任务书§九-9）。
6. `ProbabilityPage` 补 SourceBadge（数据块必须有来源标注的既有约定）：`HISTORICAL · K线回放 三大指数 · 基准 沪深300（520 根）`，实测渲染并显示真实结果（h=1 53%、样本 898/3 只、最大回撤 −24.1%、基准 0.07%、超额 +0.08%）。
7. `AppShell` 增加 `hashchange` 监听：挂载即同步一次 + 监听前进/后退与手改 hash，无效 hash 回写为当前页保证 URL 与渲染一致。浏览器实测 `#/risk`、`#/themes` 即时切换、`#/bogus-page` 被回写为 `#/themes`；控制台仅 HMR 日志，无 error。

### 新增测试（不删既有用例、不降断言）

- `tests/quant/p2-archive-db.test.ts`（5 例，只读真实库、无网络、默认执行）：asOf 必须为 `YYYY-MM-DD`、radar `kind` 与 event `level` 取值受控、`evidence/mappedSectors/relatedStocks/fundCheck` JSON 可解析、同日无 `(asOf,kind,title)`/`(asOf,title)` 重复、每个交易日行数等于去重后行数（越界即说明当日 deleteMany 失效）。库/表不存在时按 skip 处理而非伪造通过。
- `tests/quant/p2-scan-loop.test.ts`（4 例，需 `MYDESK_INTEGRATION=1` + `MYDESK_BASE_URL`，默认 skipped）：Radar 扫描→落库→GET 读回三者一致且同日重扫条数不变、多次扫描只动当日（直连库比对非当日行数）、Events 同链路 + 未映射计数、五接口响应契约（`live` 布尔、四个主线桶、`scanned` 布尔、概率三档且不可计算为 null 不以 0 代替、`streakPct` 必须为 null 或数值）。
- 本轮实跑（本地 3010 端口服务，`MYDESK_INTEGRATION=1`）：4/4 通过。过程发现并修正的是测试自身对 themes 响应字段的假设（真实为 `main/sub/rotation/watch` 四桶），未改动业务代码。
- 口径披露：闭环测试会按既有幂等策略重写当日归档，实测期间 `radar_finding` 由 10 → 9、`global_event` 由 2 → 1（周六非交易日，真实快讯流与板块数据本身变化），属真实数据波动而非丢历史；跨日历史行数经断言确认未变。

### 全量回归

- `npx tsc --noEmit` → 0 错误。
- `node --test tests/quant/*.test.ts` → 112 例：108 通过、4 skipped（即 `p2-scan-loop`，需显式开启）、0 失败。
- 待人工确认提交范围后再 commit：本轮改动 = `.gitignore`、`EventsPage`、`RadarPage`、`AiHomePage`、`ProbabilityPage`、`AppShell`、`schema.prisma`（注释）、2 个新测试 + 其他会话 P2 WIP（含 `custom.db`）；`design-mockups/` 已被忽略规则排除。

## P2 第二阶段 后台自动化（2026-09-19：清单第 9–13 项，触发机制=服务端进程内调度，服务形态=常驻生产服务）

### 实现与取舍

- **9/10 后台扫描不依赖网页**：`src/instrumentation.ts` 的 `register()`（Next 16 钩子，`NEXT_RUNTIME==="nodejs"` 才生效）在服务进程启动时调用 `startScheduler()`；定时器与浏览器无关。
  边界如实写入 API/页面/记录：`任务随服务端进程运行：网页可关闭，但服务未启动时不会执行`。不写「无人值守 / 每天自动运行」。
- **11 收盘后自动触发**：`src/lib/quant/scheduler/rules.ts`（纯函数、可单测）定义窗口 = 交易日北京 15:00 收盘 + 20 分钟等待（`DESK_SCHEDULER_DELAY_MIN` 可调），每 60s tick 一次；
  交易日只认「上证指数（`000001.SH`）真实日线的最后一根日期」（`judgeTradingDay`）：相等=交易日、更早=休市、拿不到数据=**不可确证**（记 skipped，不猜）。
  周末不排班；执行链路 = 判定 → `archiveRadarScan/archiveEventScan`（扫描→当日先删后插→回读）→ 写 `task_run`。
- **12 防重复执行**：`decideRun(rows, cfg, now, successSince)` 四类拦截 `already_success / running / max_attempts / non_trading_day`。
  关键口径：**自动任务只认「完成时刻不早于当日收盘窗口」的成功**——盘中 10:00 的手动扫描不会挡掉 15:20 的收盘扫描（盘中数据不等于收盘数据）；
  手动补跑接口默认仍受「当日已有成功」拦截，只有显式 `force=true` 才绕过，且绕过时 note 写「强制补跑，不计入自动重试次数」；
  `running` 行 30 分钟内互斥、超过 30 分钟视为进程崩溃遗留自动放行（任务恢复）；失败按 `maxAttempts`（默认 3）有限重试；
  休市一旦确证，当天不再重复探测数据源；确证不了则最多每 15 分钟再问一次。被拦截的触发**不写业务表也不写 task_run**，避免无意义重复数据。
- **13 任务运行记录**：新表 `task_run`（`prisma/schema.prisma` 的 `TaskRun`，`prisma db push` 已同步）：
  `kind / tradeDate / status(running|success|failure|skipped) / trigger(schedule|manual) / startedAt / finishedAt / scanned / results / missing(JSON) / error / basis / note`。
  `error` 对 skipped 行存机器码（`non_trading_day` / `trading_day_unconfirmed`），供 `decideRun` 判定；`basis` 存数据来源与交易日判定依据。
  查询接口 `GET /api/tasks/status`（调度器是否启用/在跑、下次窗口、当日汇总、当日与最近 20 条记录、能力边界），手动触发 `POST /api/tasks/run {kind, force?}`。
  **只允许跑当日**：传历史 `trade_date` 直接 400——扫描器读的是当前实时行情，标成历史日期会造出对不上的记录。
- 落库逻辑抽出 `src/lib/quant/screener/persist.ts`（唯一实现），`/api/radar`、`/api/events` 的 POST 改走 `scheduler.runTaskTracked(kind,"manual",{force:true})`，
  响应字段保持不变并新增 `task`；因此手动点击同样留痕，且 `trigger=manual` 与自动可区分。事件 POST 现在也会先 `quantBootstrap()`（原先没有，走统一入口）。
- 页面可见性：新组件 `src/components/desk/AutoTaskLine.tsx`（Radar/Events 各一条），文案完全由 `task_run` 真实行推导：
  「今日收盘后已自动扫描」只有 `trigger=schedule` 的 success 行才出现；手动扫描显示「手动」；休市依据、扫描/落库条数、最近错误、失败次数一并展示；
  Radar/Events/AI 首页副标题从「当前无后台自动扫描」改为「交易日收盘后由服务进程内的调度器自动扫描一次」（不再与实际能力不符）。

### 过程中发现并修复的真实缺陷

- **EM Provider 在生产构建下未注册**：切 `next build` + `next start` 后 `GET /api/quant/data/bars` 返回 `EM Provider 未注册（仅服务端可用）`。
  根因：`quantBootstrap()` 的幂等标记放在 `globalThis`，而 Provider 注册表 `loaders` 是模块级变量；同一份 `data/index.ts` 在生产 bundle 里因说明符不同被打成两个实例，
  先跑的（现在是 instrumentation）置位标记，后加载的路由实例永远不会再注册。dev 下不复现，故此前未暴露。
  修复：`src/lib/quant/data/index.ts` 的 `loaders` 改为挂在 `globalThis.__quantProviderLoaders`（注册表与其守卫必须同作用域）。修复后接口恢复真实数据（上证日线最后一条 `2026-09-18`）。
- 状态接口字段 `done_after_close` 更名 `settled`：非交易日窗口为 0 时它会对「手动扫描」也为 true，名字会误导；页面仍用 `trigger` 区分自动/手动。
- `note` 曾写出「第 ? 次尝试」（force 绕过幂等时无序号）：改为强制补跑单独措辞，普通路径按「当日失败数 + 1」给序号。

### 实测（生产服务 `npx next build` + `npx next start -p 3010`）

- 启动日志：`[scheduler] 已启动：每 60s 检查；执行窗口=交易日北京 15:20；下次 2026-09-21 15:20（2026-09-21T07:20:00.000Z）；任务 radar、events`。
- `GET /api/tasks/status`：`enabled=true running=true tick_seconds=60 today=2026-09-19 due_now=false slot_at=null next=2026-09-21T07:20Z`；
  无浏览器交互时 `last_tick_at` 仍从 `04:01:40Z` 推进到 `04:03:40Z`，`last_outcome=未到执行窗口（2026-09-19，当日不排班）` → 定时器确实在服务进程内跑。
- 交易日闸门（真实周六）：`POST /api/tasks/run {kind:"radar"}` → `status=skipped`，记录 `error=non_trading_day`、
  `basis=上证指数日线最新交易日 2026-09-18 早于目标日 2026-09-19：休市/节假日，当日无新数据`、`note=未执行扫描，未产生任何数据`（events 同）。
  期间还验证了「确证不了」→「确证休市」会升级同一条 skipped 记录而不新增行。
- 手动闭环：`POST /api/radar` → `ok=true items=8 task={status:"success",results:8}`，落库 8 条与读回一致；
  `POST /api/events` → `scanned=24 unmatched=24 results=0`（周六真实快讯全未命中映射，未入库、未编造产业链）。
- 幂等：随后 `POST /api/tasks/run {kind:"radar"}`（不带 force）→ `skipped(non_trading_day)`，`task_run` 行数不变、当日条数不变；带 `force=true` 才真的再跑一次。
- 页面（浏览器实机）：Radar / Events 两条状态行分别显示「今日未运行（等待 09/21 15:20 窗口）；当日最近一次为 手动 触发 · 扫描 8 条 / 落库 8 条；…休市/节假日…；最近记录 成功/手动 09/19 12:01」，
  徽章仍为 `HISTORICAL`（radar_finding / global_event 当日库行）。
- `npx tsc --noEmit` → 0 错误；`node --test tests/quant/*.test.ts` → 123 例：118 通过、5 skipped（均需 `MYDESK_INTEGRATION=1` 显式开启的真实闭环）、0 失败；
  `MYDESK_INTEGRATION=1` 实跑 `p2-scan-loop` → 5/5 通过（新增第 5 例：手动扫描必须留 `task_run` 行、条数与接口一致、重复触发不产生新行、历史日期必须 400）；
  新增 `tests/quant/p3-scheduler-rules.test.ts`（10 例纯规则：北京时区、周末顺延、窗口、四类幂等拦截、盘中手动不挡收盘自动、陈旧 running 恢复、失败上限、休市终止、交易日不可确证）。
- 未做/待验：真实交易日 15:20 的自动执行只能等 2026-09-21（周一）当天服务在跑时观察；`task_run` 的历史清理策略属第五阶段，保留天数待人工决定。
- 服务形态变更需人工知晓：本副本原 3010 端口的 `next dev` 进程已停止，改为 `next build` + `npx next start -p 3010`（日志 `.prod-server.log`）；
  `next start` 会提示 `does not work with "output: standalone"`，实测功能正常（standalone 只影响容器化部署路径），未改动 `next.config.ts`。
- 提交：人工确认后以 `7fd829d`（19 文件，+1082/−81，含 `prisma/db/custom.db`）单独形成 P2 第二阶段正式 commit，工作树干净。
  周一（2026-09-21）15:20 的真实自动触发按用户决定作为「后续运行验收」，不再阻塞提交。

## 启动脚本改为生产模式（2026-09-19，P2 第二阶段收尾后追加）

- 需求来源：人工确认「p1 副本日常启动方式改成生产模式启动」。原 `启动.bat` 仍是 `npx next dev -p 3000`。
- 实测前提：先在 3005 临时起 `next dev` 验证 `instrumentation` 在 dev 下同样注册调度器
  （日志 `[scheduler] 已启动…下次 2026-09-21 15:20`，`/api/tasks/status` → `enabled/running=true`），
  随后结束该测试实例；`task_run` 行数前后一致（11 行），去重生效，未污染数据。
- 改动 `启动.bat`（130 增 / 14 删）：
  - 默认端口改为 **3010**（3000 被冻结的原 `D:\Zai\kairotrend` 实例长期占用，双击会撞端口并让人误看旧副本页面），
    顶部 `set "PORT=3010"` 单行可改；支持 `启动.bat rebuild`（强制重构建）/ `启动.bat dev`（回开发模式）/ `启动.bat 3011`（换端口）。
  - 新增步骤 [3/5]：`.next\BUILD_ID` 不存在才 `npx next build`；[8] 由 `next dev` 改 `next start -p %PORT%`。
  - 新增端口占用检测：已在监听则不再启动、提示多半是重复双击并给出换端口办法（避免两个实例各自调度、同一分钟竞态重复扫描）。
  - 保留原有 Node/npm 镜像/依赖/prisma generate/代理/通达信网关步骤；未新增任何依赖，未改 `next.config.ts`。
  - 文案边界：写清「关本窗口 = 服务与自动扫描一起停止」「自动提示的 output standalone 警告可忽略」。
- 踩到的真实坑（重要，留档）：`启动.bat` 是 GBK 批处理，cmd 对 **行尾结构** 极敏感。
  用 `sed 's/$/\r/'` 生成 CRLF 但保持单空行的版本，`cmd /c` 跑会出现 `rorlevel`、`NG" >nul` 这类**词中间断开**的误解析；
  而对仓库里原始文件做同样转换也会坏。把结构统一为 **每行后面再跟一个空行（即 `\r\n\r\n`）+ CRLF + GBK**（正是原脚本在磁盘上的字节结构）后，
  解析错误行数 = 0。结论：改这个文件必须保持「双空行」结构，别用普通单换行写回。
- 实测（真实 `cmd /c` 跑改造后的脚本副本）：
  - 分支 A 端口占用：3010 在跑 → 正确打印「端口 3010 已经有服务在监听，不再重复启动」并退出，0 解析错误；
  - 分支 B 真实启动：`启动.bat 3011` → 跳过安装/生成、检测到 `.next\BUILD_ID` 跳过构建、通达信网关已在运行、`next start` 起来，
    `/api/tasks/status` 返回 `enabled=true, running=true, started_at=2026-09-19T04:30:32Z, next=2026-09-21T07:20:00Z`；验证后结束该测试实例，
    3010 生产服务与 3000 原副本均未受影响。
  - 未改任何 TS/TSX，故本轮不重跑 tsc 与测试（代码零改动）。
- 同步 `使用说明.txt`：启动章节改 5 步 + 端口 3010 + 四种用法，常见问题补「3010 已被监听」「构建要几分钟」「关黑窗口自动扫描就停」，
  并明确不会把「手动扫描」写成「自动完成」。
- 负向对照（同轮）：把同一份内容去掉空行只留单换行（LF 或 CRLF 皆试过），`cmd /c` 报 5~12 处词中间断开的误解析；
  恢复「每行 + 一个空行 + CRLF + GBK」后为 0。最终落盘文件用 ASCII 名副本原样跑通（0 解析错误，端口占用分支行为正确）。

## P2 第三阶段 增量扫描（2026-09-19：Radar / Events 增量口径 + 游标断点恢复 + 重复扫描幂等）

### 实现与取舍
- 拆成两层：`screener/incremental-core.ts`（纯函数：自然键、内容指纹、增量规划、口径判定、游标推进）
  与 `screener/incremental.ts`（读写 `scan_cursor` / 回填历史行键 / 事务内落库）。
  拆开的原因只有一个：纯内核能在无网络、无伪造行情的情况下把「不重复、不丢、失败不推进」全部证死（REAL_DATA_ONLY）。
- 自然键：Radar 用 `kind|标的代码||事件键||级别|归一化标题`（无可依赖 id 时把数字压成 `#`，避免实时数值每刷一次就多一行）；
  快讯用 `ev|HH:MM|归一化标题`（上游没有 id），超长键压成定长。键与指纹的计算只有一份实现，
  新扫描与「给 P2 老行回填键」调用同一函数（单测对拍 JSON round-trip 一致）。
- 游标 `scan_cursor(kind, tradeDate)`：记录数据基准水位线（整批候选的集合指纹）+ 已确认键→指纹 + 未命中快讯键。
  **只在成功写库后推进**；失败路径不调用 `advanceCursor`，因此下一次仍会重新处理同一批数据（不做「失败也算扫过」）。
  键集合上限 3000，超限按插入顺序丢弃最早的键——丢的只是「跳过优化」，下次靠库内键比对识别为未变，不会漏数据。
- 权威判据是**库内已有行的键**，游标只当快速路径：`cursorCommitsNothing` 要求「水位线一致 且 库内 live 行数==游标键数且>0」
  才整批跳过，任一条件不成立就回到逐行规划。这样游标被裁剪、被人工删除、进程重启都不会造成重复或漏写。
- Radar 消失不删除：本次算不出来的旧行只标 `state="superseded"`（当天真实出现过的信号留给第四阶段复盘），
  GET/POST 读回一律过滤 `state="live"`，页面另有「标记消失 N 条」的如实说明。
- Events 不做 supersede：上游是滚动「最近 24 条」窗口，滑出窗口不代表它错了，抹掉等于丢历史。
  增量只判定「库里没有、且游标里也没记为未命中」的快讯；未命中结论带上产业链映射表指纹，
  改 `data/theme-chain-map.json` 后旧结论自动失效重新判定。窗口内无新增快讯时**连 4 次板块资金榜请求都不发**、零写入。
- 调度器、幂等拦截、交易日门控一行未改（`scheduler/rules.ts` 仍被 p3-scheduler-rules 测试锁死）。
  口径选择放在落库层：手动 `force` → 全量（点了就必须真跑，不被游标跳过）；收盘后自动 → 当日已有成功游标则增量；
  `/api/tasks/run` 可显式 `mode:"incremental"` 做增量补跑。游标由两种口径共同写入，所以「上午手动扫过一次」
  就能让「下午 15:20 自动那次」走增量——不需要为了增量去改用户的幂等策略。
- task_run 如实记录：`basis` 写「口径 全量/增量…」（文案与页面解析共用 `modeBasisLabel` / `modeFromBasis`），
  `note` 写「写入：新增 / 更新 / 未变 / 标记消失|保留」；失败行的 `missing` 明确「失败不推进增量游标」。
- 前端只做如实呈现：`AutoTaskLine` 多一行「增量游标（当日）：已确认 N 条键 → 下一次自动执行按增量口径…（手动点「立即扫描」仍按全量重刷）」，
  口径文案从 `task_run.basis` 读回（读不出就写「未记录（该次扫描早于增量口径上线）」，不拿历史行冒充）；
  Radar/Events 页扫描后显示「本次口径 + 候选/新增/更新/未变/标记消失|保留」，全部来自服务端返回的 `delta`。
- 性能口径（不夸大）：增量的省下的部分是**写库与二次验证**，不是候选计算——雷达候选仍按原公式全量算一遍（这正是发现「变化」的方式），
  事件增量在无新增快讯时可以完全跳过映射与 4 次板块榜请求。不加载全市场历史 K 线：本轮没有新增任何全量历史 K 线读入内存的路径。

### 过程中踩到/修掉的真实问题
- `hash12` 用 BigInt 字面量（`0xcbf2…n`）在本项目 tsconfig（target < ES2020）下是编译错误 TS2737 → 改 `BigInt("0x…")` 构造写法，散列结果不变。
- `prisma generate` 在 Next 服务运行时会因 `query_engine-windows.dll.node.tmp` 被占用而 EPERM → 先停 3010 服务再 `db push` + `generate`，完成后重启。
- 快速路径把同一批 8 条候选同时记进「未变 8」和「游标跳过 8」，页面按字段相加会算出 16 条候选 → 快速路径只记一次（`unchanged`），
  把「整批靠游标跳过」这个事实移到 `scan_cursor.note`，实测已核对。

### 验收拆分：真实数据验收 vs 机制验收
- 真实数据验收（生产服务 `npx next build` + `npx next start -p 3010`，行情/快讯来自真实数据源，2026-09-19 为休市日）：
  - 首次扫描（全量）：`POST /api/radar` → `mode=full`、8 条真实信号落库，游标建立 `watermark=2d40cd909f88`、`done_keys=8`；
    `task_run.note` = 「写入：新增 8、更新 0、未变 0、标记消失 0」。
  - 重复扫描（增量）：`POST /api/tasks/run {kind:radar, force:true, mode:incremental}` → `mode=incremental`、
    「新增 0、更新 0、未变 8、标记消失 0」，库内 live 行数仍 8，`COUNT(*)==COUNT(DISTINCT dedupeKey)`，无重复自然键。
  - Events：全量后 `unmatched_keys=24`（当日 24 条真实快讯未命中产业链映射，结果 0 条入库，符合既有口径）；
    再走增量 → 「游标跳过 24、新增 0」，`source` 明确「上游窗口无新增快讯（沿用上次成功入库结果）」，板块资金榜零请求。
  - `/api/tasks/status`：`today_summary[].cursor` 正常返回；页面（生产构建、真实浏览器）显示
    「写库口径 增量（只写新增与内容变化的行）」「增量游标（2026-09-19）：已确认 8 条键 → 下一次自动执行按增量口径…」。
  - 既有 P2 闭环断言全部继续通过（含「同批两次扫描条数一致」「GET 与 POST 标题一致」「历史交易日行数不变」「非当日日期 400」）。
- 仅机制验收（无法安全地用真实行情触发，未伪造数据）：
  - 失败不推进游标 / 断点恢复（单测：抛错路径不调用 `advanceCursor`，下次仍处理同一批；见 p3-incremental「游标只在成功后推进」）。
  - 游标裁剪只丢优化不丢数据、Radar 消失后复活、同批撞键合并、映射表变更后旧「未命中」结论失效（均为纯内核单测）。
  - **收盘后自动扫描走增量口径本身尚未在真实交易日发生过**（今天是休市日，下次窗口 2026-09-21 15:20），
    本轮只做到「手动强制走同一代码路径」，不把它写成「后台自动增量扫描已完成验收」。

### 提交
- 本阶段已按人工确认方案提交：`1ed82b6 feat(P3): Radar/Events 增量扫描（游标断点恢复 + 自然键幂等 + 口径可见）`
  —— 17 个文件、1596 插入 / 92 删除（逐个 `git add <路径>`，未用 `git add .`），提交后 `git status` 干净。

## P2 第四阶段 历史信号查询与复盘（2026-09-19：只读回看，不重算、不改写）

### 做了什么
- 新增**只读历史层**，与 P2/P3 的写库层完全隔离：
  - `src/lib/quant/screener/history-core.ts`（纯函数内核：日期解析/清单聚合形状/行整形/口径文案，无 DB、无 value import，`node --test` 直接可加载）
  - `src/lib/quant/screener/history.ts`（DB 读取：`dayCounts` / `dateBuckets` / `readRadarDay` / `readEventDay` / `readDayRuns`，client 由调用方注入，仅 `import type PrismaClient`）
- 新增两个接口：`GET /api/radar/history?date=&state=all|live|superseded`、`GET /api/events/history?date=`。
  两者都**只读现有库行**：不触发扫描、不重算指标、不写 `task_run`、不动 `scan_cursor`。
- 页面（`RadarPage` / `EventsPage` + 共用 `HistoryBar`）：查询范围三入口（今天 / 最近有数据 / 指定日期）+ 明确「当前查看日期」+
  历史视图徽章 `ARCHIVED 历史归档`、`view_basis` 口径句、雷达 live/已消失计数、当日 `task_run` 运行记录、`missing` 缺失口径黄条。
- `quant-api.ts` 增加 `fetchRadarHistory` / `fetchEventsHistory` 与配套类型，前端不自己算任何条数或口径。
- 运行记录分三层如实报：`runs_total`（库里 `taskRun.count` 的当日总条数）/ `runs`（倒序最近 20 条）/ 页面展示前 5 条，
  并明说「更早的记录不在返回范围里，真正落过库的那次可能在其中」——不假装列全，也不因少列就说那天没扫过。

### 关键取舍与拒绝冒充的做法
- `parseQueryDate` 直接拒绝：格式错、非法日历日（`2026-02-30`）、未来日期 → **400**，不"顺手"回退到最近有数据的那天。
- 指定日期无数据 ⇒ `items:[]` + `emptyDayNote`，并区分**三种空**（查今天=当前库里 0 行；那天有扫描记录但没留下行；那天根本没扫过），
  绝不写成同一句话，也绝不拿今天的数据顶上。
- `viewBasis` 历史分支的文案里禁止出现「实时 / LIVE」；今天分支改称「当日库行视图…不是行情实时推送」（浏览器实测时发现原文案把库行说成实时视图，已改）。
- 日期入口的归档清单只来自服务端 `groupBy`（`asOf`+`state`）聚合，不把行读进内存；元信息未回来前按钮写「归档清单读取中…」，
  不提前断言「库内暂无归档」（实测发现过这个谎，已修）。
- 雷达行**没有逐行来源列** ⇒ `radarSourceOf(kind, evidence)` 只按 `kind`+证据推导，并同时给出推导依据 `source_basis`；认不出就写
  「未知（库内该行没有来源字段）」，不猜。事件的来源/映射/资金验证都是入库时的真实列，原样读回；`mappedSectors` 为空时写
  「未命中映射表（入库时即为空，未编造板块）」。
- P3 机制一行未改：`dedupeKey` / `contentHash` / `state` / `scan_cursor` / 幂等拦截 / 调度规则全部原样；schema 无变更。

### 验收拆分
- 真实数据验收（`npx next build` + `npx next start -p 3010`，真实浏览器 + curl）：
  - `GET /api/radar/history`（无 date）→ `date=2026-09-19`、8 条 live、0 superseded，与 `GET /api/radar` 同批行同源一致；
  - `?date=2026-09-18` → 空 + 「库里没有 asOf=2026-09-18…不会用别的数据顶上、也不会重新计算那一天」；
  - 页面实测：今天视图显示「当前查看日期：今天（2026-09-19）…不是行情实时推送」；点「最近有数据（2026-09-19）」出 8 条归档卡（类型/asOf/状态/来源推导/首次入库北京时间）+ 8 条 task_run 记录；「只看已消失」出「共有 8 行，但都不在当前筛选里」；console 零报错。
  - 事件页实测：当前 `global_event` 真实为 0 行 ⇒ 徽章/清单如实写「库内暂无归档」，指定 2026-09-19 与 2026-09-18 均返回空 + 缺失口径。
  - 真实链路回归 `node --test tests/quant/p2-scan-loop.test.ts`（`MYDESK_INTEGRATION=1`）9/9 pass，含新增两条 P4 只读用例；
    纯函数/机制 `tests/quant/p4-history.test.ts` 10 条；全量 `node --test tests/quant/*.test.ts` 152 tests / 143 pass / 0 fail / 9 skipped（跳过项为需 `MYDESK_INTEGRATION=1` 的集成用例）；`npx tsc --noEmit` 0 错误。
- 仅机制验收（真实库现在演示不了，未伪造数据）：跨日不串、`superseded` 过滤与"消失行仍可查"、空日不回退、事件 `superseded` 恒 `null`
  —— 用真实库的 OS 临时副本插入前缀为「〔机制测试行·非行情数据〕」的行完成断言，用例结尾校验真实库 `size`/`mtimeMs` 完全未变。
- 已知现状（真实数据决定，不是缺陷）：库内可查询历史日期 = **radar 1 天（2026-09-19）/ events 0 天**；
  今天是休市日（`task_run` 里有 `non_trading_day` 说明），本阶段不做第五阶段清理，历史行一律保留。
- 顺带记录：`scan_cursor.doneKeys` 是**当日累计确认**（实测 9 条键 vs 当前 8 行 live），P3 的游标快速路径另有 `liveCount` 一致性校验兜底，
  因此键多于行不会导致跳过未落库数据 —— 本阶段未触碰该逻辑。

### 验收过程中出现的一次真实数据变化（必须留痕，不是我删的）
- 本阶段验收开始时 `global_event` 里有 1 条当日事件（19:19 那次扫描落库）。随后按用户既有纪律重跑真实链路回归
  `MYDESK_INTEGRATION=1 node --test tests/quant/p2-scan-loop.test.ts`，其中「Events 闭环」用例会走 `POST /api/events`
  的**手动全量口径**（P2 定稿：当日先删后插）。那一次重跑时真实快讯窗口已滚动，24 条里 0 条命中产业链映射 ⇒
  当日事件行数从 1 变成 0。此后我又单独 `curl -X POST /api/events` 复核一次，结果同样是「扫描 24 / 落库 0 / 未映射 24」。
- 结论：事件归档清空是**既有全量口径的既定行为 + 真实上游窗口变化**共同造成的，P4 的只读层没有写库；
  历史查询如实呈现「库里当前一行事件都没有」，没有回补、没有拿旧截图冒充。
- 这件事同时说明第四阶段的价值：`task_run` 里 19:19 那 8 次「落库 1 条」的记录仍然在库里
  （`/api/events/history?date=2026-09-19` 返回 `runs`（倒序最近 20 条）+ `runs_total`（当日总条数，验收时已 41 条），
  页面按「当日共 N 条 / 接口返回最近 M 条 / 这里展示前 5 条」三层如实说明，并明说「真正落过库的那次可能在更早的记录里」），
  只是明细行已经不在了 —— 「哪天扫过、扫出几条」与「现在库里有多少行」是两件不同的事，页面分开显示。
- 本阶段已按人工确认方案提交：`dd0fe18 feat(P4): Radar/Events 历史查询与复盘（只读 asOf 取数，空日不回退，不冒充实时）`（12 文件 +1452/−52，含 `custom.db`：相对 `1ed82b6` 仅 task_run 41→102 与 radar 游标 doneKeys 8→9，机制测试行 0 条入库）；第四阶段到此停止，未进入第五阶段。

## P5 第五阶段 数据生命周期：旧信号清理 + 三页每日留档（2026-09-19）

### 用户拍定的四项口径（本阶段写死，API 不提供可改参数）
1. **保留 180 天**：`asOf` 严格早于「今天 − 180」才进候选（`RETENTION_DAYS = 180`，改天数只能改这个常量并留 worklog 记录）；
2. **先导出、再物理删除**：候选日的全部明细行先写成 `data/lifecycle/*.json` 并回读复核行数，导出失败或行数对不上 ⇒ 一行都不删；
3. **dry-run 预览 + 人工确认后手动执行**：不挂调度器，项目里没有「到点自动清理」这回事；
4. **Risk / Themes / Probability 各一张每日快照表 + 手动「留档今天」**：同样不挂调度器，不点就没有那天的行，也不会自动补。

### 做了什么
- 三段分层与既有阶段一致（纯内核 / 注入 client 的 DB 层 / 用 `@/lib/db` 的粘合层）：
  - `src/lib/quant/screener/lifecycle-core.ts`（过期判定、清理计划、FNV-1a 计划指纹、四道执行闸门、导出封套与口径文案，无 DB 无别名 value import）
  - `src/lib/quant/screener/lifecycle.ts`（`dayCounts` / 按整天删 / 导出行数复核，只 `import type { PrismaClient }`）
  - `src/lib/quant/screener/lifecycle-service.ts`（生产用的 `@/lib/db` 粘合）
  - `src/lib/quant/screener/snapshot-core.ts` + `snapshot.ts`（三张快照表的列提取/摘要/回看整形，纯内核可 `node --test` 直跑）
- schema 新增三张表：`risk_snapshot` / `theme_snapshot` / `probability_snapshot`（`prisma/schema.prisma` +73 行；未触碰 P2/P3/P4 任何既有表与列）。
- 接口：`GET /api/lifecycle/preview`（dry-run，只读）、`POST /api/lifecycle/purge`（唯一能删真实数据的口子）、
  `POST /api/snapshot/{risk,themes,probability}`（写入＝服务端当场重算）、`GET /api/snapshot?kind=&date=`（只读回看）。
- UI：`src/components/desk/LifecyclePanel.tsx`（挂进设置页：四张计数卡 + policy_notes + 候选表 / 无候选说明 + 受保护 `<details>` + run_tables 报告 + 红色执行块）、
  `src/components/desk/SnapshotBar.tsx`（三页共用留档条：留档今天 / 留档日 chips / 指定日回看 / 每条摘要+当次缺失+来源 / 固定口径「本页没有调度器」）、
  `src/lib/desk/quant-api.ts` 增加对应客户端封装（全部沿用既有 `fetch`，**未新增任何依赖**）。

### 关键取舍与防误删/防冒充的做法
- **四道闸门**：确认串逐字 `PURGE_CONFIRM_TEXT="PURGE_EXPIRED_ROWS"` → 必须有候选 → 必须带回预览的 `plan_hash` → 执行时重算的指纹必须一致（不一致 409）。前端按钮禁用只是提示，服务端同样四条各跑一遍，不依赖前端。
- **按「整天」删**：当日行、以及 `asOf` 判不出年龄的行永不进候选；route 里再加一道 `c.date >= today` 兜底。`superseded`（已标记消失）与 `live` 走同一条 asOf 保留规则，不存在「消失的先删」。
- **`task_run` / `scan_cursor` 只报告条数，不在清理范围内**（预览里单独一块说明为什么不动它们）。
- **留档不收前端的数字**：点「留档今天」POST 里没有任何行情数值，服务端调**页面同源**的 route handler 当场重算（themes 用 `?force=1` 绕开 45 秒内存缓存），把当次完整响应原样存进 payload；概率页额外带上「这次用的是哪一组条件」，没有条件就不留（离开条件的胜率没有意义）。
- 同日多次留档**各成一行、互不覆盖**；算不出的量保持 `null`，回看摘要显示「炸板率 算不出（当日触板 0）」而不是 0%；`warnings`/`missing` 随留档一起存回，不事后丢口径。
- **修掉一个真实源码缺陷**（不是测试问题）：`snapshot-core` 原先用 `DATE_RE` 判回放日，`2026-13-45` 这种格式对、日历非法的值能透传。改为复用 `lifecycle-core` 的 `isValidDate`（UTC 回读校验），全项目只保留一份日历合法性判定；对应断言原样保留。
- `policyNotes()` 去掉了与响应 `basis` 字段重复的那一条，避免同一条口径在面板上显示两遍。

### 验收拆分
- **真实数据验收**（`npx next build` + `npx next start -p 3010`，真实浏览器 + curl）：
  - `GET /api/lifecycle/preview` → `retention_days: 180`、`cutoff: 2026-03-23`、`candidates: 0`、`detail_rows_in_db: 8`（随后跑真实链路回归又扫进新行，最后一次复跑为 20）、`plan_hash: fnv1a-6a4e38120000`、`can_execute: false`、`policy_notes` 4 条、
    `missing`：「库里共 8 条明细行，但没有一条 asOf 早于 2026-03-23…本轮可清理 0 行。这是真实数据还没有那么旧，不是清理机制没生效 —— 未执行任何删除。」
  - 三条 purge 拒绝路径实测均 `HTTP=400` 且 `deleted: 0, rows_deleted: 0, export: null`（确认串错 / 缺 plan_hash / 指纹过期）；
  - 真实点了三次「留档今天」并落库：`risk` id `cmu8e33i00000v6n4n5shib5e`、`themes` id `cmu8e3gel0001v6n422c5ls5h`、`probability` id `cmu8e3ln50002v6n4ke85rgqr`（耗时 27.9s / 6.3s / 0.23s，都是服务端当场重算）；
  - 回看 `GET /api/snapshot?kind=…` 三表各 `counts {total:1, days:1, returned:1}`，payload 完整（23 / 9 / 10 个键），headline 与当次缺失都读得回来（例：风险页「炸板率 28% … 计算时非交易时段（收盘/休市值）」，概率页「1日 36.1%（n=61）/ 5日 48.3%（n=60）/ 20日 52.5%（n=59） · 样本量达标（≥30）」并保留三条「样本不足」警示）；
  - 空留档日 → `items: []` + 明确说明「没留过的那天不会自动补出来，查询也不会拿别的日子顶上」（HTTP 200）；`date=2026-02-30` → 400「date 不是存在的日历日」；`kind=whatever` → 400；
  - 页面实测（hash 路由直达 + 可及性树核对）：设置页生命周期面板列表为 4 条 policy_notes + 1 条 state_note（去重后已生效）、执行按钮禁用且 title 写明「预览里没有候选：没有东西可删，接口也会拒绝执行」；
    风险页/主线页留档条各有「已有留档日 2026-09-19(1) 」chips 与 1 条留档卡；概率页未做计算时留档按钮为**禁用**，title「还没有可留档的计算结果：先完成一次计算再留档」。
  - 回归：`npx tsc --noEmit` 退出码 0；`node --test tests/quant/*.test.ts` **167 tests / 158 pass / 0 fail / 9 skipped**（跳过项为需 `MYDESK_INTEGRATION=1` 的集成用例），其中本阶段新增 `p5-lifecycle.test.ts` 8 条 + `p5-snapshot.test.ts` 7 条 = 15 条全绿；
    `MYDESK_INTEGRATION=1 node --test tests/quant/p2-scan-loop.test.ts` **9/9 pass**（含 P4 只读用例，P5 未破坏既有链路）。
- **仅机制验收（真实库现在演示不了，未伪造数据）**：物理删除这条路径只能在真实库的 OS 临时副本上验收 ——
  副本里插入 `asOf` 为过去日期、前缀「〔机制测试行·非真实计算结果〕」的行，断言「过期日整天被删、未满期与当日一行不少、删除前行数与导出文件完全一致、计划被改后旧指纹失效」。
  用例结束删副本并校验真实库 `size` 与 `mtimeMs` 完全未变。正式库唯一归档日就是今天 ⇒ 候选 0 条，因此**本轮真实库里没有删过任何一行**，`data/lifecycle/` 至今没有任何导出文件。
  快照机制用例同样跑在副本上，且因正式库已有真实留档行，断言前提改为「基线 + 增量」精确比对（行数/条数/倒序顺序仍逐条核对，只是不再假设库是空的）。
- **已知缺口（如实记下）**：
  1. `take_screenshot` 在本机浏览器连接下报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`（内置视口不可见），本阶段 UI 只做了**结构与文案**验收（可及性树 + 接口返回），**视觉截图未覆盖**；
  2. purge 的 **409「计划已过期」路径只在副本单测覆盖**：真实库无候选时服务端先返回「无候选」的 400，生产 HTTP 侧无法单独触发过期指纹分支；
  3. 「每天自动留档 / 到点自动清理」本阶段**有意不做**（口径 3、4 就是手动），所以也不存在无人值守式验收；
  4. 留档回看目前只能按单页 `kind` 查询，跨页时间线（例如「某天三页各留了什么」的合并视图）不在本阶段范围。

### `prisma/db/custom.db` 的变化（本轮真实运行产生，机制行 0 条入库）
- 新增三张空→有真实数据的快照表：`risk_snapshot` 1 行、`theme_snapshot` 1 行、`probability_snapshot` 1 行（就是上面三条 id，全部来自点击「留档今天」的服务端真实重算）。
- 运行时增长（P4 提交 `dd0fe18` 之后）：`task_run` 102 → 112（本轮真实扫描与回归测试的运行记录）、`radar_finding` 8 → 13、`global_event` 0 → 7、`scan_cursor` 2 行、`candidate_pool` 5 行 —— 均为既有 P2/P3/P4 链路的真实数据，本阶段没写它们的代码路径去造数。
- 删除行数：**0**。库里没有任何 `asOf` 早于 2026-03-23 的明细行。
- **指纹覆盖的是「要删的那批」**：`planHash` 只吃 `cutoff` + `retention_days` + 候选日明细（表/日期/行数/成立数/消失数/距今），
  因此本轮实测中受保护行从 8 涨到 20 时 `plan_hash` 保持 `fnv1a-6a4e38120000` 不变（这是设计意图：闸门要防的是「待删集合在预览后被改动」，
  而当天新落的库行都在候选之外）；任一候选日的行数或构成一变，旧指纹就失效并被拒（副本单测覆盖）。
- 顺带留痕：`global_event` 从 0 变回 7 是**跑 P2 真实链路回归**（`POST /api/events` 的手动全量口径：当日先删后插）+ 真实快讯窗口滚动共同造成的，
  与 P5 无关——本阶段的两个清理接口在验收里全部走「拒绝执行 / 0 行删除」，留档接口只写快照表。
- 本阶段已按人工确认方案提交：`adf2d68 feat(P5): 数据生命周期（180 天 dry-run + 先导出再删 + Risk/Themes/Probability 手动每日留档）`（25 文件 +2327/−2，含 `prisma/db/custom.db` 与 `.gitignore` 新增 `data/lifecycle/` 一条）。与计划的实际差异如实记下：① 真实库里**一行都没删过**——唯一归档日就是今天，候选 0 条，物理删除只在真实库的 OS 临时副本上验收（含 409「计划过期」分支），`data/lifecycle/` 至今无导出文件；② 快照机制用例的前提从「库是空的」改成「基线 + 增量」精确比对（正式库当时已有真实留档行，行数/条数/倒序顺序仍逐条核对，不是放宽断言）；③ 顺带修了一个真实源码缺陷：留档回放日原用 `DATE_RE` 只校格式，`2026-13-45` 能透传，已改为复用 `lifecycle-core` 的 `isValidDate`；④ UI 因 `take_screenshot` 报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` 只做了结构与文案（可及性树 + 接口返回）验收，视觉截图仍是缺口。验收数字：`tsc --noEmit` 退出码 0、`node --test tests/quant/*.test.ts` 167 tests / 158 pass / 0 fail / 9 skipped（P5 新增 15 条）、`MYDESK_INTEGRATION=1` 的 P2 真实链路回归 9/9 pass、三条 purge 拒绝路径均 `HTTP=400 deleted:0`、三页各 1 条真实留档已落库并可回看。
