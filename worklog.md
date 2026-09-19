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
