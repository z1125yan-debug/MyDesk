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

## P6 第六阶段 P6-A 数据源可靠性 + Data Capability Registry（2026-09-19）

### 这一步要解决的问题（任务书 §三/§六/§七）
P0~P5 里「没有数据」散落成 `null` / `undefined` / `0` / `missing[]` / `catch→null` / `[]` 六种写法，同一个上游 200 + `data:[]` 在 A 页显示「暂无数据」、在 B 页显示 0；AI 上下文里演示价与真实价共用一句「来自本机直连的真实行情接口，视为当前事实」。
P6-A 把这些判定收到一处内核，并让「我现在能查什么 / 这次到底取到了没有 / 还缺什么」变成机器可读的接口（P6-D 的 Agent 要靠它自主挑工具、承认缺口）。

### 落地内容（全部新建文件 + 8 个改动点）
1. **`src/lib/quant/screener/datastatus-core.ts`（新，纯内核，229 行）**：任务书 §三 的 8 类分层逐字进 `DATA_STATUSES`（REAL/DERIVED/HISTORICAL/SNAPSHOT/AI_INTERPRETATION/AI_HYPOTHESIS/MISSING/DEGRADED）；`UNVERIFIED` 属于验证状态，单列 `VERIFY_STATUSES`，不进数据分层；五态观测 `value / real_zero / no_data / request_failed / not_covered` 互不合并，`observeValue` 的判定优先级是「未发起请求 → 未覆盖 → 请求失败 → 无内容 → 真 0 → 有值」（失败优先，因为上游把超时和空返回压成同一个 `null`）；`envelopeOf` 组装时强制自洽（不可用 ⇒ status 只能是 MISSING/DEGRADED）；新鲜度四档 `live 90 / intraday 300 / daily 86400 / static 31536000` 与三态新鲜度判定。
2. **`src/lib/quant/screener/capability-core.ts`（新，纯内核，660 行）**：40 条能力登记，每条都写 `input/output/source/source_type/freshness/availability/data_status/limitations/fallbacks/mutating/examples`，且**逐条对得上当前代码里真实存在的路由或引擎函数**（不登记「设想中」的能力）；三条「没有可靠来源」的（北向净流入、个股公告、板块日K连续强势天数）照样登记、`availability=not_covered` 并写明原因；只读白名单 39 条，唯一 `mutating=true` 的 `mcp_tools` 在 need 候选、兜底链与 `agent_allowed` 三处都被排除；`need→能力` 返回命中词并按命中数排序，匹配不到时只给登记过的分组方向（`needHints`）不猜；登记表自身也被登记为三条元能力（`capability_registry` / `capability_probe` / `ai_context_layering`），`ai_context_layering` 必须标 `AI_INTERPRETATION`。
3. **`src/lib/quant/screener/capability-service.ts`（新，服务端探测，575 行）**：默认只读本地（15 项 SQLite 并发 count + 验证账本元信息 + Provider 注册表 + MCP 运行态），`?live=1` 才真打 7 个小上游请求；`probed:false` 表示「本次没测」，绝不显示成 MISSING 或 0；探测范围写进 `scope`（`direct` 真取了该能力数据 / `channel` 只验证同接口族可达 / `db` / `static` / `local`），不用「通道通了」冒充「有数据」；本层不产出 `VERIFIED`；结果缓存 20 秒且**缓存起点取探测完成时刻**（一次 live 探测本身十几秒，按开始时刻记会刚落盘就过期、页面每次刷新重打上游）。
4. **两个只读接口**：`GET /api/capabilities`（纯静态，不探测不碰网络不读库；`?name=` 给定义+兜底链+`agent_allowed`，未知名字 404 并列出可选名，绝不返回「大概像」的能力；`?need=` 给候选与缺口承认）与 `GET /api/capabilities/probe`（`?live=1 ?force=1 ?only=`，带 `self_check` 出参自检与 `counts_note`）。
5. **`src/components/desk/CapabilityPanel.tsx`（新，251 行）+ 挂设置页**：四张计数卡（本次取到 / 本次取不到（失败与无内容分列）/ 无可靠来源 / 未探测）、分层计数、口径行、「还缺什么」明细、需求查询框、按分组逐条列出三态着色 + 兜底链 + evidence chips + 已知局限；面板不判定任何状态，全部照服务端返回显示。
6. **`src/lib/desk/ai-context-core.ts`（新，纯内核，110 行）+ 助理页/分析页接线**：上下文逐条自带「标签｜层级｜口径」，`guardPriceOf` 只允许 REAL 价做数量级锚点（演示价当锚点与不带锚点必须等价，已有断言），`provenanceOfQuote` / `provenanceOfTechSnapshot` 与徽标同源；`assistantSystemPrompt` 删掉「视为当前事实」，改为要求模型遵守四类内容分层（含「上下文里没有的数字不要补」）。
7. **`src/lib/quant/data/hybrid-core.ts`（新，纯内核，107 行）+ `hybrid.ts` tracked 版本**：把「K线取数失败」与「这只票真的没数据」分开（`BarOutcome` / `summarizeOutcomes` / `outcomeWarning`）；`fetchBarsHybrid` 原签名与所有公式不变，选股器（`screener/run.ts`）、条件概率（`/api/quant/probability`）、AI 的两个 K线工具（`/api/ai/chat`）三处调用点改为分列报错：失败标的**不参与条件判断**、不写进「不符合条件」；熔断与兜底通道都显式记为 DEGRADED 口径。
8. 顺带：`fields.ts` 加 `verifiedLedgerMeta()`（只读元信息，验证账本的唯一写入口径没动）；`types.ts` 的 `QuoteCard` 加 `data_status` / `series_synthetic`，`market.ts` 三条卡片各自标注来源（真实 / 演示合成 / 本次缺失）。

### 与任务书的差异 / 本轮没做（如实记）
- **「数据源增强」只做了一半口径**：本轮做的是「已有源的可靠性与兜底可见化」，**没有新增任何第三方数据源**（龙虎榜、大宗交易、公告、北向替代源都没接）。北向净流入维持 `not_covered`，没有用估算或替代口径顶上去。
- 探测层**不覆盖** `backtest` / `probability` 的全量计算（需要明确策略与回放区间，健康探测不该打满上游），这两条返回 `probed:false` + 原因，而不是「可用」。
- `/api/ai/chat` 的工具链路仍是自己一套 8 个硬编码工具，本轮只把它接到 outcome 分层，**没有**改成从 capability-core 动态生成（那是 P6-D 的活）。
- UI 只做结构与文案（可及性树）验收：`take_screenshot` 在本机连接下仍报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，视觉截图未覆盖。

### 验收（真实数据：`npx next build` + `npx next start -p 3010`，2026-09-19 22:56~23:07）
- `npx tsc --noEmit` 退出码 0；`node --test tests/quant/*.test.ts` **219 tests / 210 pass / 0 fail / 9 skipped**（跳过项全是需 `MYDESK_INTEGRATION=1` 的集成用例）。P6 新增 **52 条**：`p6-capability.test.ts` 25、`p6-hybrid.test.ts` 8、`p6-aicontext.test.ts` 19；非 P6 基线 167 条不变 ⇒ 无回归。
- **本地探测（不碰外网）curl**：`counts {total:40, usable:16, unprobed:20, no_data:1, request_failed:0, not_covered:3, degraded:0, read_only:39, mutating:1}`；`layering` 「REAL 17 / DERIVED 8 / HISTORICAL 7 / SNAPSHOT 3 / AI_INTERPRETATION 1 / MISSING 4」；`self_check.violations: []`；`gateway_note` 「本次未做上游探测：只读了本地库/账本/MCP 运行态；行情类上游能力标 probed:false，不是「没数据」」。
- **带真实上游探测 curl**：`upstream_calls 7`、`gateway_note`「eltdx 本机网关：在线」、usable 33。逐条 evidence 都是当场取到的真值：`index_benchmark {price:3911.87, change_pct:0.9359}`、`stock_kline {bars:30, last_date:"2026-09-18"}`、`sector_rank {boards:5, top:"电子", top_main_yi:198.53959168}`、`fund_flow_stock {symbol:"688256.SH", days:1, last_date:"2026-09-18"}`、`market_news {items:3, latest_time:"22:59"}`、`symbol_search {first:"688256.SH"}`；本地侧 `radar {rows:13, latest_date:"2026-09-19", live_rows:13}`、`events {rows:7}`、`factor_catalog {factors:137, implemented:118, unimplemented:19}`、`factor_test {rows:219, keys:108}`、`factor_verified {verified_keys:33, ledger_mtime_ms:1789780532261}`、`task_status {rows:112, latest_started_at:"2026-09-19 21:05:36"}`。
- **登记表接口 curl**：`GET /api/capabilities` → `total 40`、分组 `行情:13, 信号:7, 研究:7, 历史:6, 运维:7`、`not_covered 3`、`read_only_names 39`；`?need=板块资金` → 首条 `sector_rank`（matched `["资金","板块"]`）+ `order_note`；`?need=天气` → `matches 0` + 「没有任何已登记的只读能力覆盖「天气」：应作为缺口显式承认，不要换个说法硬凑」+ `gap_groups []`；`?name=northbound`（未登记）→ `HTTP 404` 且明确「不是取数失败，是这条路不存在」；`?only=events` → `counts_note` 说明计数按全表 40 条统计。
- **K线失败/无数据分列的真实实测**：`POST /api/quant/probability`（`universe:"custom"` + `symbols:["000001.SH","399006.SZ","999999.BAD"]`）→ `999999.BAD bars=0 error="K线无返回（请求成功但上游没有该标的的日K，例如代码不存在）：本次不纳入统计"`，warnings 同时带出口径行「K线口径：eltdx 直连 3 只；腾讯兜底 1 只（主通道不可用，已降级）；无K线返回 1 只；取数失败与「没有数据」是两回事，不合并统计」；`pooled` 全为 `win_rate:null, sample_size:0`（**没有**用 0 冒充概率）。
- **面板实机核对（`#/settings` 可及性树）**：40 条能力齐全；三条 not_covered 的「还缺什么」原文完整；MCP 行「本次无内容」并带「具体原因：MCP unavailable：已配置 1 个服务器，没有一个 ready（demo-market:stopped）。本层不会假装调用成功」；`capability_registry` evidence `capabilities 40 / read_only 39 / not_covered 3`；`ai_context_layering` evidence `layers 5 / discipline_rules 4 / wired_pages #/assistant,#/analysis`；`capability_probe` 显示未探测 + 自指说明；`task_status` 显示「超出 intraday 口径上限（7123 秒 > 300 秒）：不再算实时」，`radar/events/三张 snapshot/lifecycle_preview` 显示「新鲜度未知（数据源没给出可核对的时刻，不猜是否仍算实时）」——**问号占位 0 条**。
- **只读性核对**：整个验收过程（探测 + 两个 GET + 面板）不写库；`prisma/db/custom.db` 在验收前后 `size 868352 / mtime 2026-09-19T13:05:36.960Z` 完全未变，`data/factor-verified.json` 未被本轮任何路径写过（探测层只读它的元信息）。
- 阶段内自查发现并修掉的三处措辞缺陷（都是 REAL_DATA_ONLY 口径问题，不是外部指出）：
  ① `freshness_s` 为 `null` 时面板写「超出 daily 新鲜度上限（? 秒）：不再算实时」⇒ `fresh` 改为三态（true/false/**null=未知**），措辞收进内核 `freshnessChip` + `FRESHNESS_UNKNOWN_NOTE`，并把「as_of 只到日期且就是今天 ⇒ daily 口径必然在限内」这一条可证结论单独成函数（跨天仍判未知，不猜秒数）；
  ② 未探测行出现「未探测——未探测：回测 需要明确的策略…」双前缀 ⇒ `reason` 只写裸原因，前缀由 `toProbe` 统一加一次；
  ③ 不可用行只剩四态泛化文案，把 MCP「没有 ready 服务器」说成「休市」这类无关解释 ⇒ 新增 `unavailableNoteWith`，标准文案后补「具体原因：<本次原文>」（无覆盖类与重复情形不加）。
  三处都有对应断言（`freshnessChip` / `freshWithinDailyFromDateOnly` / `unavailableNoteWith` 三条用例 + 一条读源码的结构约束，防「内核有了、页面没用」）。
- 本阶段提交：`30f0658 feat(P6-A): data capability and source reliability`（24 文件 +3081/−75，含 worklog 本段；提交前 `git diff --check` 无空白错误、逐路径 `git add`，未使用 `git add .`；工作树提交后 `git status --short` 为空）。

## P6 第六阶段 P6-B AI 事件理解（2026-09-20）

### 这一步要解决的问题（任务书 §八/§九/§十）
P6-A 把「取到了没有」变成机器可读之后，事件层仍然只有快讯原文 + 关键词映射：能看见「入库了这条新闻」，看不出它被理解成什么、这句话是谁说的。
P6-B 加的是**解释层**，不是第二条事实来源：事件仍然只有 `global_event` 一份，AI 本阶段只做任务书 §八 列的 8 件事（分类 / 摘要 / 实体提取 / 行业主题映射 / 潜在影响方向 / 影响范围 / 重要性解释 / 需要进一步验证的数据），**不负责发现不存在的事件**。
两条禁令必须落到代码而不是提示词愿望里：① 模型发明的事件 id 要整条拒收；② 模型自己生成的概率（§九「不得写成该股票明天上涨概率 80%」）要在落库前剥掉、留档并降级。

### 落地内容（8 个新文件 + 6 个改动点）
1. **`src/lib/quant/screener/event-interpret-core.ts`（新，纯内核，644 行）**：§九 的 17 字段按归属三分区（`FACT_FIELDS` 4 项服务端从库行回填 / `AI_FIELDS` 12 项 + `AI_EXTRA_FIELDS` 2 项 / `DERIVED_FIELDS` 6 项服务端派生），提示词与解析共用同一份清单，避免「提示词写了、解析没认」；`buildEventInterpretPrompt` 把 8 项工作与两条禁令原文写进系统提示；`parseEventInterpretations` 逐条做四件事——按自然键白名单拒收发明事件（`unknown_ids` 原文报出，不做近似匹配）、`evidenceGrounded` 要求每条证据能在原标题里找到、`symbolGrounded` 把无出处标的降级进 `hypothesized_symbols`（AI_HYPOTHESIS）并补写进 `unknowns`、`normalizeConfidence` 只接受 0..1（80 不猜成 0.8，缺失落 `null` 而不是 0）；`interpretationStatusOf` 三态（REJECTED / PARTIAL / INTERPRETED）+ `STATUS_TEXT` + `renderInterpretationTrace`（§十 的「原始事件 → AI 提取 → AI 解释 → 状态分层」回溯）+ `summarizeInterpretations` / `fieldCompleteness`（UI 与报告引用同一句话）。
2. **概率剥离（本阶段唯一在验收中自查出的真实缺陷，已修）**：原 `PROBABILITY_PATTERNS[0]` 只吃「涨概率 80%」，实测「明天上涨概率 80%」在正文里留下「明天上」半截残字。改为把前导时间/方向词并入同一区间（`(?:明天|明日|次日|后天|近期|短期|中期|长期|后市)?…(?:上涨|下跌|涨|跌)?…(?:概率|可能性)…\d+%`），并把连接字符类从任意 `[^0-9]` 收紧为排除标点与空白（`[^。，、；\s0-9]`），否则「概率较高，涉及 5 个板块」会被整段误删；新增「时间词 + 涨幅/跌幅 + 数字%」一类（§九 禁的是预测，「航运板块今日上涨 3.2%」这类已发生的行情描述不动正文）。`probabilitySpans` 的区间合并保证同一处只留一条留档，`dropped.probability_claims` 保存原文。
3. **`src/lib/quant/screener/event-interpret.ts`（新，服务层，335 行）**：`loadEventFacts` 只取 `global_event` 当日真实库行（`ids` 同时接受自然键与行 id，limit 上限 50）；`storeInterpretations` 在落库前**重新取一次事实**再解析（不信任客户端传来的事实字段，也不接受页面自己解析的结果），按自然键 upsert，事实字段逐条回填自库行；`loadInterpretations` 回看时把解释表与当日事件行按自然键对照，如实标 `stale`（事件 contentHash 已变）与 `orphan`（原事件行已不在当天库里），并出 `self_check.broken_payload/missing_fields`。
4. **两个接口**：`GET /api/events/interpret/prompt`（只从库里现取事实组装提示词，不写库，`interpretation_status:PROMPT_READY`，`how_to_use` 明写「AI 未配置时不要 POST」）+ `GET/POST /api/events/interpret`（GET 只读回看；POST 是解释层唯一写入口，空 raw → 400、超 `MAX_RAW_CHARS` → 413、解析后 0 条落库 → 422，全部返回同一套 JSON 错误结构）。凭据只在客户端（P6-A 已有口径），所以链路是「服务端出事实与提示词 → 客户端调模型 → 服务端复校验落库 → 页面只读回结果」，没有复制代理逻辑、也没有 mock 一段模型输出。
5. **`prisma/schema.prisma` 新增 `event_interpretation`（`eventKey @unique` = 事件行 `dedupeKey`）**：全量扫描是「当日先删后插」，cuid 每次都变，用自然键才能让解释在重扫后仍指向同一条事件；`eventHash` 记下当时的事件版本；`data_status` 永远是 `AI_INTERPRETATION`。**这张表明确不写进 P5 生命周期清理**（保留期属于用户决定，未定口径前不删），结构测试钉住 `lifecycle-core.ts` 的 `DetailTable` 未被改动 ⇒ §三十四「P6 不改变数据生命周期」成立。
6. **`src/lib/desk/event-interpret.ts`（客户端编排，117 行）+ `EventInterpretation.tsx`（92 行）+ `EventsPage.tsx` 接线**：五种失败各有原文（AI 未配置 / 无事件 / 模型超时 / 落库被拒 / 部分字段没站住），页面不解析模型输出、不判状态；解释卡显示状态徽章、`confidence` 文案写死「这是 AI 对自己这套解释的把握度，不是股票上涨概率」、有出处标的与「AI 假设标的（无出处，未验证）」分列、校验留痕计数、展开可看完整回溯链与字段归属；今日与历史两处事件卡片在无解释时都写「本条…没有 AI 理解…缺失就写缺失，不补默认解释」。
7. **能力登记**：`capability-core.ts` 新增第 41 条 `event_interpret`（`data_status:AI_INTERPRETATION`、`mutating:false`、`fallbacks:["events"]`、6 条 limitations 逐条写明「解释不是事实 / 不产概率 / 无出处标的已降级 / 表可能 0 行 / stale 与 orphan 含义 / POST 是写操作不在只读白名单」）；`capability-service.ts` 的 `dbSignals()` 与 `probeOne` 接上该表，0 行时区分「没人点过」与「失败」。
8. 顺带：`quant-api.ts` 加 `fetchInterpretPrompt / fetchInterpretations / storeInterpretationsApi`（后者不抛 `ok:false`，附 `__status` 供页面区分「模型没配」与「落库被拒」）。
9. **`.gitignore` 的一处真实缺陷（本阶段必须改，否则接口进不了版本库）**：baseline 提交带的两条裸规则 `test` / `prompt` 没有前导斜杠，会忽略**任意层级**的同名目录；新建的 `src/app/api/events/interpret/prompt/route.ts` 因此被 `git add` 静默跳过（`git status` 里连未跟踪项都不显示，只有 `git status --ignored` 才看得见），克隆出去的仓库就不会有这个组装提示词的接口。已改为 `/test`、`/prompt` 并就地写明原因。改动前核对过：全仓库除这个新目录外没有任何名为 `test` / `prompt` 的路径，根目录草稿产物的忽略行为不变。

### 与任务书的差异 / 本轮没做（如实记）
- **没有真实调用过一次模型**：本机 `AI 未配置`（`.env` 只有 `DATABASE_URL`，Key 存在浏览器 localStorage），所以写路径的模型原文是**手工构造的四类越界样本**（发明事件 / 无出处证据 / 无出处标的 / 概率与涨幅预测），只写进副本库 `p6b-ui.db`、`p6b-smoke.db`（验收后已删）。真实模型输出仍未经过链路——这条边界与 P6-A 一样留给用户配置凭据后点一次「AI 理解今日事件」。
- 解释层**没有**接入助理页 / 分析页的 AI 上下文（`renderMarketContext` 目前不含 `event_interpretation`）：§九/§十 只要求 Events 侧可回溯，跨页引用属于 P6-C 的 research 组装范围。
- 不做自动跑：解释只在人点「AI 理解今日事件」时产生，调度器没有新增 interpret 任务（避免「无人值守时 AI 替市场下结论」）。
- `?date=` 只当查询条件，不校验日期格式：`2026-13-99` 返回 `ok:true` + 0 条 + 说明。这与 P4 历史查询既有口径一致（不报错、也绝不回退到别的日期），没有只给新接口单加一套校验；记为已知缺口。
- 概率剥离是正则层面的兜底，不承诺覆盖所有措辞（如「八成分概率」「大概率上涨」这类无量词表述会漏网）；提示词禁令 + 落库前剥离 + `violations` 留痕三层叠加，漏网时人工仍能从 `dropped` 与原文核对。

### 验收（真实数据：`npx next build` + `npx next start -p 3010`，2026-09-20 00:00~00:20）
- `npx tsc --noEmit` 退出码 0；`npx next build` Compiled successfully，两条 interpret 路由进路由表（`ƒ` 动态）。
- `node --test tests/quant/*.test.ts` **256 tests / 247 pass / 0 fail / 9 skipped**（跳过项全是需 `MYDESK_INTEGRATION=1` 的集成用例）。P6-B 新增 **37 条**：`p6-b-event.test.ts` 29（内核）、`p6-b-structure.test.ts` 8（结构约束）；P6-A 收口时的 219 条基线不变 ⇒ 无回归。结构测试专防「内核有了、页面没用」：路由不得对 core 做相对 value import、页面不得自己解析模型输出、`lifecycle-core.ts` 不得出现 `event_interpretation`。
- **登记表接口 curl（生产 3010，只读）**：`GET /api/capabilities?name=event_interpret` → `HTTP 200`、`agent_allowed true`、`data_status AI_INTERPRETATION`、`mutating false`、`fallbacks ["events"]`、limitations 6 条原文完整；`?need=解读` → `matches ["event_interpret", …]`；`?need=这条事件被 AI 解读成什么` → `["event_interpret","events"]`；`GET /api/capabilities/probe?only=event_interpret` → `kind:no_data`、`usable:false`、`status:MISSING`、`evidence {rows:0, events_rows:7}`、note「还没有人对事件点过「AI 理解」，这一层的解释就是空的（不是失败，也不会自动生成）」——**0 行没有显示成失败，也没有显示成 0 条事实**。
- **接口 curl**：`GET /api/events` → `HTTP 200`、`as_of 2026-09-20`、`items 0`（今天没扫，不拿 09-19 的 7 条冒充）；`GET /api/events/interpret?date=2026-09-19` → `rows 0` + 缺失口径「只在有人显式点「AI 理解今日事件」时产生，没做过就是空」；`GET /api/events/interpret/prompt?date=2026-09-19&limit=2` → `PROMPT_READY`、facts 2 条、prompt 1531 字符、含「禁止输出任何概率数字」与「不是股票涨跌概率」两句原文。
- **错误结构（隔离实例 3011 + 副本库）**：空 raw → `HTTP 400` `AI_FAILED`「服务端不会替你生成一段解释」；模型原文不是 JSON → `HTTP 422`、`persisted:0`、逐条 `missing` 带原因「模型回复里没有可解析的 JSON 数组」（**没有产出任何默认解释**）；非法日期 → `HTTP 200` + 0 条 + 说明。全程无 HTML 错误页、无空 body。
- **写路径端到端复校验（隔离实例 3011 + 副本库，手工构造模型原文）**：`persisted 2`、`interpretation_status PARTIAL`，`counts {interpreted:1, partial:1, rejected:0, missing:5, unknown_ids:1, with_probability_dropped:1, violations:3, hypothesis_symbols:2}`；发明的 id 原文报出 `unknown_ids:["ev|99:99|这条新闻系统里根本没有入库过"]`；`dropped.probability_claims ["明天上涨概率 80%","明天涨幅 3%"]` 且正文替换为「（AI 给出的概率或涨幅预测已剔除：本系统禁止 AI 生成概率与预测）」、**无残字**；无出处证据「这是第六舰队的例行部署」被剔除并留档；「航发动力、中远海控」降级进 `hypothesized_symbols`；越界枚举「正面」经 `clampEnum` 落回「未知」；`mapping_agreement` 重合 2 项 / AI 另提 3 项 / 映射表另有 1 项。
- **UI 实机核对（`#/events`，可及性树 + 文本树）**：今日视图（2026-09-20，0 事件）→「AI 理解今日事件」按钮 disabled，tooltip 写「今天没有已入库事件：没有真实事件就没有可理解的东西，本步骤不会去猜一条新闻」；解释层状态条徽章 `AI_NOT_CONFIGURED 缺失`，副文案「本机未配置模型凭据：解释层未运行（事件事实不受影响）」，其后是计数行、分层口径行、缺失口径、读库依据；历史视图 2026-09-19 → 7 条事实卡片（`ARCHIVED 历史归档 · 只读 asOf=2026-09-19 的行`）逐条带「本条没有 AI 理解…不补默认解释」；副本库有解释时卡片显示 `PARTIAL` 徽章、`解释置信度 55%（中等）——不是股票上涨概率`、AI 假设标的单列、`校验留痕：违规 3 条 · 被降级/剔除 5 处（原文在下方回溯里，未静默删除）`，展开回溯链含【原始事件】【AI 提取】【AI 假设标的】【AI 解释】【状态分层】【主题映射核对】【证据】【仍需验证】【下一步该查】【被降级 / 剔除的内容】【校验违规】全段落与字段归属行。事实层徽章仍是 `HISTORICAL` / `ARCHIVED`，未被解释层改写。
- **只读性与库核对**：真实库 `custom.db` 在写路径验收期间未被写入解释（`/api/events/interpret` 回看 `rows:0`、`/api/events` 的 7 条 09-19 归档未被触碰）；提交前按表逐张比对 HEAD 与工作树（仓库外只读副本 + `node:sqlite` 只读打开，未新增依赖）：**17 张表里 16 张行数完全不变，唯一差异是新增 `event_interpretation`（0 行）** ⇒ 冒烟数据没有落进真实库；副本库 `p6b-smoke.db` / `p6b-ui.db` 与冒烟 json、日志均已删除。
- `take_screenshot` 在本机连接下仍报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，视觉截图未覆盖（沿用 P6-A 的结论：UI 只做到结构与文案）。
- 本阶段提交：`56d039d feat(P6-B): AI event understanding`（16 文件 +2141/−33，含 worklog 本段与 `.gitignore` 的 `/test`、`/prompt` 锚定修正；`prisma/db/custom.db` 已按「逐表计数比对」核对后纳入——HEAD 与工作树唯一差异是新增空表 `event_interpretation`，其余 16 张表行数不变；提交前 `git diff --cached --check` 无空白错误、逐路径 `git add`，未使用 `git add .`；提交后 `git status --short` 为空）。

## P6 第六阶段 P6-C AI Market Research（2026-09-20：服务端现取台账 + 七分区研究报告 + 复校验后才落库）

- **本阶段只做一件事**：把 Risk / Themes / Radar / Events / 条件概率留档 / 因子 IC 跑批 / 三张每日留档 / 板块资金榜 / 北向与板块连板（登记为无可靠来源）这几路真实读数，由服务端编成一份带出处的台账，交给本机配置的模型做跨源解释，再交回服务端复校验后才落库、才上页面。按 §十一，研究层不含任何指标公式：MA/MACD/RSI/IC/回测/条件概率一律复用已有引擎的产出，AI 只做 orchestrator / interpreter。
- **交付文件**：内核 `src/lib/quant/screener/research-core.ts`（七层归位、台账编号、提示词组装、复校验、截断、状态判定、口径文案）、服务层 `src/lib/quant/screener/research.ts`（8 个采集器 + 一次 computeSentiment 供四组读数 + prompt/store/load 三入口）、路由 `src/app/api/research/route.ts`、`src/app/api/research/prompt/route.ts`、表 `ResearchReport`（`prisma/schema.prisma`）、能力登记（`capability-core.ts` / `capability-service.ts` 增 `research_report` 轻读数）、客户端编排 `src/lib/desk/research-run.ts`、接口封装（`src/lib/desk/quant-api.ts`）、页面 `src/components/desk/pages/ResearchPage.tsx` 与导航（`types.ts` / `Sidebar.tsx` / `AppShell.tsx`）、测试 `tests/quant/p6-c-research.test.ts`。
- **七层是唯一的实现处**（§十三）：`researchLayerSections()` 返回可辨识联合（FACTS/SIGNALS/HISTORICAL_EVIDENCE 的载荷是服务端台账行，INTERPRETATION/RISKS 是带引用的条目，UNKNOWN/NEXT_CHECKS 是字符串数组），提示词与页面共用同一个函数，前端不能自己重排或合并分区。
- **§十四 的十二条禁止落成机检**：① 台账由服务端现取，客户端传来的事实字段一律不采信；② 引用 id 不在本批台账 ⇒ 剔除并留档进 `dropped.invalid_cites`，该条标 `fully_grounded:false`（保留原文，不算站住）；③ 台账里找不到出处的数字逐条写进 `unsourced_numbers`（不删原文）；④ 概率/涨幅预测在落库前剥离，原话存 `dropped.probability_claims`；⑤ 「历史统计 ⇒ 今天会怎样」这类措辞由 `findHistoricalAsCurrentClaims()` 抓出并降级（§二十二：留档胜率 51.75% 可以写，「所以今天上涨概率 51.75%」不行）；⑥ 台账为空 ⇒ 不给提示词也不落库（`NO_EVIDENCE`），REJECTED 的报告不允许覆盖当天已成立的报告。
- **本轮修掉两个真实缺陷（不是文案问题）**：
  1. `/api/research*` 三个 handler 缺 `quantBootstrap()` ⇒ `market_snapshot` 采集器实测报「EM Provider 未注册（仅服务端可用）」，全市场广度/梯队/指数/风险四组读数整组丢失，台账只有 12 行。按仓库既有入口约定（routes / scheduler / job runner 都先引导）补上后实测 `ok`，台账 12→16 行。这个缺陷只在 `next build + next start` 下暴露，dev 环境看不出来。
  2. `GET /api/research?date=2026-13-99` 返回 **HTTP 200 + 「2026-13-99 还没有报告」** —— 把参数错误说成「那天是空的」，正是本层禁止的 silent failure。新增纯函数 `researchDateError()`（格式 + 真实日历日双重校验，空串=没传才回落当天），GET 路由在读库之前拒为 400，服务层 `loadResearchReport()` 同样拦（给 P6-D 这类直接调用者的同一口径），并把 `as_of` 在错误分支置空、不再把用户传来的串冒充成取数时间。
- **错误结构与成功结构对齐（§三十一）**：`/api/research` 的 GET 成功 200、非法 scope 400、非法日期 400、异常 502 用同一组字段（键集逐条比对为 `true`）；POST 的 400/413/422/502 同样共用 `ResearchStoreResult & { report_status }` 骨架，且两个骨架都改成显式类型标注，字段漂移会在编译期报错。400 的 scope 文案带上收到的原值（`…（收到的值：「stock」）`），避免「参数被拒」被误读成「market 也没跑成」。
- **测试**：新增 P6-C 内核测试 25 条（七层归位、编号稳定性、台账文本、提示词必备条款、复校验五类命中、状态判定、截断与上限、自然键、scope 白名单、日期口径、400 文案），全部为纯内核（不碰网络/库/模型）。全量 `node --test tests/quant/*.test.ts`：**281 tests / 272 pass / 0 fail / 9 skipped**（skip 数与 P6-B 收尾时一致，仍是需要外部网络或真实跑批的那几条）；`npx tsc --noEmit` 0 错误。
- **API smoke（生产 3010，只读 + 参数分支，全部真实响应）**：`prompt 200 / load 200 / badscope 400 / date=2026-13-99 400 / date=today 400 / date=2026-09-18 200 / prompt?scope=stock 400 / POST 缺 raw 400 / POST 非法 scope 400 / POST body 非 JSON 400`；无 HTML 错误页、无 silent failure，4xx 全部发生在写库之前。**写路径 smoke 一律跑在隔离副本**：`cp prisma/db/custom.db prisma/db/p6c-smoke.db` + `DATABASE_URL="file:./db/p6c-smoke.db" DESK_SCHEDULER=0 npx next start -p 3011`，10 类场景（越界夹具 POST 200→`PARTIAL` 落库、只读回看、非 JSON 原文 422、缺 raw 400、超长 413、非法 scope 400、GET 非法 scope 400、prompt 非法 scope 400、空解释 422 且不覆盖前一份、再回看仍是那份且 `available_dates` 只 1 行）。夹具是人工构造的「一次越界模型回复」，不是真实模型产出也不是市场事实，脚本头部已如此声明。
- **真实数据 smoke（台账到底装了真读数）**：本次组装 16 行台账、9 个采集器状态 = `market_snapshot ok / themes ok / sector_rank ok / radar empty / events empty / probability ok / factor_test ok / snapshot_risk ok / northbound_flow not_covered`，8 条缺失口径原文随包进出提示词，例如「北向净流入：交易所自2024-08-19起不再披露，无官方数据源」「板块日K连续强势天数（东财 kline 无返回，本批全部缺失）」「回测（backtest）未进本批台账：它需要明确的策略与区间，属于按需计算，研究层不自行发起（也不得由 AI 触发）」「个股主力资金流（fund_flow_stock）需要明确代码」。radar/events 当天为 0 行被如实写成「真实为空，不是失败」，没有补数据。
- **§三十二 性能口径**：一次组装只调一次 `computeSentiment`（广度/梯队/指数/风险四组读数共用），上游取数沿用 `em.ts` 已有短时缓存；库内读走 P4 只读层与 P5 留档表；台账上限 `MAX_LEDGER_LINES=45`，超出部分按采集顺序截断、条数写进 missing（不静默丢行、不重排）。同一 tool+params 在一次组装内不重复调用。
- **新表说明（§三十三/§三十四）**：`research_report` 之所以要新建——研究报告必须能回到生成那一刻的台账，而台账是现取的、会随下次扫描变化，不留档就无法复核「这句话当时从哪来」。保存：冻结的台账/采集器观测/缺失口径/报告 payload/状态与提示词版本；不保存：模型 Key、任何行情原始行、概率字段。自然键 `reportKey = scope|asOf` ⇒ 每天每范围最多一行，表天然有界；保留期不并入 P5 的 180 天清理（报告是解释层归档，不删 P0~P5 任何数据）；索引 `@@index([asOf])` + `reportKey @unique`，实测三个索引存在（`sqlite_autoindex_research_report_1`、`research_report_reportKey_key`、`research_report_asOf_idx`）。
- **UI 实机核对（`#/research`，可及性树 + 文本树，构建后的 3011）**：顶部 Risk/Themes/Radar/Events 四块各自带徽章与 `as_of` 与缺失口径（风险等级「正常 · 涨 4234 / 跌 1152 / 涨停 83 / 炸板率 28% / 主力净额 399亿」，雷达与事件写「当日 0 条：真实为空」）；七层标题全部渲染，服务端层逐行显示 id / layer / data_status / source / as_of（§二十四），AI 层显示引用 chips 与「引用原文（服务端由台账按 id 回填，前端改不了）」，无引用那条显示「无台账引用：不可回溯」，被剥离的概率写成「（AI 给出的概率或涨幅预测已剔除：本系统禁止 AI 生成概率与预测）」；RISKS/UNKNOWN/NEXT_CHECKS 为空时显示「空就是空，页面不会补一段默认解释」；右侧 Tool Calls 侧栏第一句是「这一栏是服务端本次向哪些能力取了数、取到没有，**不是模型的工具调用**…（Agent 自主调用在 P6-D）」，每个采集器一行状态 + `COLLECTOR_STATUS_TEXT` + 出台账行数。未配置 AI 时点「生成研究报告」：页面出现「本次「生成研究报告」：AI 未配置…服务端没有 Key，也不会替你编一份市场环境报告」，网络面板确认**只发了 GET，没有任何 POST**（未配置时不触碰模型也不写库）。
- **只读性与库核对**：真实库 `custom.db` 在整个验收期间 0 写入。提交前把 HEAD 与工作树各拷一份到仓库外（`D:/Zai/p6c-audit/`，仓库外脚本 `audit.mjs` / `trace-hits.mjs`，用 Node 内置 `node:sqlite` 只读打开，未新增依赖）逐表比对：**18 张表里 17 张行数与按 `asOf` 分组完全一致**（radar 13=13、global_event 7=7、candidate_pool 5=5、factor_test 219=219、task_run 112=112、留档三表各 1 等），唯一差异是新增空表 `research_report`（0 行）。夹具痕迹扫描命中的三条（`quant_factors ~'p6c'`、`quant_strategies ~'smoke'`、`candidate_pool ~'smoke'`）逐条回查 HEAD：**同 rowid、同内容，HEAD 里早就存在**（P1 时期的 `aiscan smoke test` 策略与 `source=smoke_test` 池、因子 id 末尾恰好含 `p6c` 子串），本阶段没有向真实库新增任何一条测试行。
- **未预期事项（§三十五 要求单列）**：① 为给新表跑 `prisma generate`，生产 3010 曾短暂停机，重启后运行的是含 P6-C 的新构建（当前 `next start -p 3010` 正常，日志 `.prod-server.log`，调度器下一次 2026-09-21 15:20）；② `prisma db push` 尾随的 `generate` 因运行中的 next 锁住 query engine DLL 报 `EPERM: rename query_engine-windows.dll.node`，但 client 已与本 schema 同步、全部实测为绿，故未追加处理；③ 本阶段产生过**未跟踪**的冒烟产物 `prisma/db/p6c-smoke.db` 与 `.p6c-smoke/`（夹具 json、run-smoke.mjs、隔离实例日志）：未 `git add`，提交后整体移到仓库外 `D:/Zai/p6c-audit/` 保留为核对证据（P6-D 复用），因此 `git status --short` 在提交后为空；没有为此改动 `.gitignore`（避免 P6-B 记过的「未锚定忽略项吞掉源文件」那类连带风险）。
- **已知缺口（如实记录，不算完成）**：① 真实模型链路未跑通——本机没有 AI 凭据（`.env` 只有 `DATABASE_URL`，凭据只在客户端 localStorage），所以「模型确实按七层 JSON 回话 ⇒ 服务端复校验通过 ⇒ 页面显示 INTERPRETED」这一段目前只有夹具与人工构造回复验证过，真实回复的格式偏离幅度未知；② AI Research 页的「生成」必须由人点，服务端不会自动跑（无 Key 也无法跑），不存在无人值守的研究；③ scope 只实现 `market`，个股/板块研究是 NOT IMPLEMENTED（传别的值直接 400，不偷偷按全市场产出）；④ 回测与个股资金流未进台账（需要明确策略/区间/代码，属按需计算，研究层不自行发起）；⑤ `take_screenshot` 本机仍报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，UI 只核对到结构与文案，视觉截图未覆盖。
- **下一步**：P6-D Agent 自主工具调用（§十五~§十九、§二十七）——本阶段的 Tool Calls 侧栏是「服务端采集器观测」，正是为下一步的真实工具调用预留的对照面：Agent 每调一次工具都要能同样回答「取了什么、取到没有、出处和 asOf」。
- 本阶段提交：`dc2a3fa feat(P6-C): AI market research`（16 文件 +2575/−1，含 worklog 本段与 `prisma/db/custom.db`——已按「仓库外只读逐表比对」核对后纳入：HEAD 与工作树唯一差异是新增空表 `research_report`，其余 17 张表行数与按 `asOf` 分组不变；夹具痕迹三条经 rowid 回查为 HEAD 早有的历史行，本阶段 0 条测试行写入真实库。逐路径 `git add`，未使用 `git add .`；提交前 `git diff --cached --check` 干净；提交后冒烟产物移出仓库、`git status --short` 为空）。

## P6 第七阶段 P6-D Agent 自主工具调用（2026-09-20：第一部分 = 两个纯内核，Tool Registry 与循环控制）

- **本部分只做两件事**：`src/lib/quant/screener/agent-tools-core.ts`（§二十七 Agent Tool Registry：把 P6-A 登记表里的只读能力逐条派生成带 JSON Schema 的工具表）与 `src/lib/quant/screener/agent-loop-core.ts`（§十六/§十七/§十八/§十九：预算、准入判定、碰壁分类、调用日志形状、台账与血缘、提示词组装、最终答案复校验）。两个文件都是纯内核（不取数、不调模型、不写库），所以本部分的验证手段只有 `node --test` 与 `npx tsc --noEmit`，**没有任何生产实测**（服务层与路由在下一部分）。
- **协议口径先钉死（不是实现细节，是边界）**：本项目 AI 凭据只在客户端，`/api/ai/proxy` 只做 `messages→content` 转发，**没有原生 function-calling 通道**（`src/lib/desk/ai.ts`、`src/app/api/ai/proxy/route.ts`）。因此 Agent 的「工具调用」是模型在回复文本里给出的单个 JSON 对象（复用 P6-C 的 `extractJsonObject`），循环由客户端驱动，工具执行、日志与复校验归服务端。内核注释里写死了同一句判据：**模型说它调用过什么不算数，只有本内核记进 log 的才算**。这条口径必须继续写进 UI 文案，不能让页面看起来像服务商原生支持 tools。
- **工具表与登记表 1:1，不重复建模（§二十六）**：`TOOL_DEFS = readOnlyCapabilities().map(...)` ⇒ 41 条 = 登记表 42 条能力 − `mcp_tools`（唯一 `mutating=true`，准入这步就被拒掉并有测试钉住）。34 条 enabled / 7 条 disabled，每条 `enabled=false` 必须带 `disabledReason` 原文（`backtest`/`probability`/`screener`/`ai_context_layering`/`mcp_tools` 由 SPECS 给原因，`northbound_flow`/`stock_announcements`/`board_day_streak` 直接引用登记表的 not_covered 原因）。自检三件套：`unaccountedTools()`（能力与工具不是一一对 ⇒ 报出来）、`readOnlyViolations()`（executor 不在 `gateway.|em.|db.|engine.|static.|probe.` 前缀白名单内，或 `name/executor` 标识符里出现写入/执行类动词 ⇒ 报出来；**只扫标识符不扫中文散文**，因为「交易含义」这类被解释内容会被误伤，这条写进了注释）、测试里再 push 一条脏样本 `em.place_order` 验证自检真的会响（try/finally pop，不留残留）。
- **§二十（AI 与 137 Factors 的关系）落成三条「不开放但给出替代路径」**：`probability` / `backtest` / `screener` 不由 Agent 触发（新算一次要全 universe 回放，属人发起的重计算），但原因文本必须点名只读留档替代工具 `snapshot_probability`（带 `trade_date/sample/horizon`）、`factor_test`、`market_snapshot + radar/candidate_pool`，并有测试断言原因里必须出现这些名字——「不允许」如果不同时写「那该查什么」，Agent 就会在同一条死路上打转。
- **入参与登记表 `input` 字段双向同源**：41 条工具的参数逐条与 `CapabilityDef.input` 互校（表里有的说明里必须有、说明里出现的参数必须有定义），豁免表 4 条各自带 reason（`factor_catalog.catalog` 是输入过滤、三个留档工具的 `kind` 由工具身份固定）。校验器覆盖：缺必填、代码后缀（`.SH/.SZ/.BJ`）、枚举、上下限、数组上限与空数组、多余参数、逗号串 coerce 留痕、布尔 coerce、去重，以及**真实日历日**校验（8 个日期参数全部标 `calendar:true`）：`2026-02-29`、`2026-13-99`、`"today"` 被拒且沿用 P6-C 口径「不会被当成那天是空的、也不会回落到今天」，`2024-02-29` 合法。
- **§十七「必须有明确上限」做成数据**：`DEFAULT_AGENT_BUDGET = {max_steps 6, max_tool_calls 12, max_retries_per_tool 2, max_total_ms 120000, max_evidence_lines 40}`（12 与 2 就是任务书推荐值），`BUDGET_HARD_CAPS = {12, 24, 3, 300000, 60}`；`normalizeBudget()` 对 0/负数/Infinity/非整数/整包非对象一律回落默认并出说明，超上限的钳到上限并出说明——**静默接受「0 次调用」等于没有预算**。测试逐键断言「硬上限 ≥ 默认值且是有限正值」。
- **「受控」不是文案，是 `admitCall()` 的判定顺序**：未知工具 → disabled → 本次运行已停止 → 参数校验 → 同参数缓存 → 步/调用/时长/台账预算 → 同一工具重试上限（`1 + max_retries_per_tool`）。参数错误不产生 `call_key`、不计预算、不打上游；命中缓存 `allowed=false` 但 `failure=null`（重复不是失败）且不计调用数、不重复进台账；总时长用尽按 `timeout` 而不是「没有数据」；重试上限到了必须在原因里指兜底（`请改走兜底：market_snapshot`）。`nextAction()` 另外管连续 3 次无新读数 ⇒ `no_progress`，一次成功即清零。
- **§十六 六类碰壁各归各的措辞**：`bad_params / no_data / source_failed / not_supported / timeout / budget`，`FAILURE_TEXT` 保住了三条老口径（数据源失败不显示为 0、空返回不等于失败、预算用尽后未验证部分必须写进缺口）。`fallback_tools` 一律来自登记表（`risk→snapshot_risk`、`probability→snapshot_probability`、`stock_kline→[]`、`northbound_flow→[]`），有兜底时 `user_note` 必须说「在改用兜底之前不能说无法验证」，全没有时才允许「当前缺少 X 的数据…没有可用的兜底源，因此…无法验证」。
- **§十八 日志字段照任务书逐项落地**：`LOG_FIELDS` = run_id/step/tool/input/output_status/latency/source/as_of/error/fallback/timestamp 十一项，测试对每条 entry 断言「键存在且值不是 undefined」（缺值写 null，不许省键），另加 `thought`（为什么调用）、`attempt`（第几次）、`call_key`（重复检测）、`cached_from`、`degraded_from`、`evidence_id`、`kind`（观测口径与 output_status 正交，避免把「空」和「失败」压成一个值）。四问齐答：调了什么（tool+input）、为什么（thought）、结果（output_status+kind+error+evidence_id）、有没有 fallback（fallback_of/degraded_from）。
- **§十九 血缘**：`recordCall()` 把成功读数交给 P6-C 的 `assignEvidenceIds` 编行（F=FACTS / S=SIGNALS / H=HISTORICAL_EVIDENCE，MISSING 不进台账而进 `missing`），并从 payload 抽白名单业务主键成 `refs`（`theme_id/finding_id/event_id/factor_key/trade_date/sample/horizon/board_code/symbol/report_key/id`）；`lineageOf()` 输出 Answer→Evidence→Tool→Data Source，`verifyAgentAnswer()` 无引用或空结论 ⇒ REJECTED、有违规 ⇒ PARTIAL、全可回溯 ⇒ ACCEPTED，且**不改写模型原文**（只判，违规项并排显示）。概率类措辞必须能回到概率类工具行且带齐 `trade_date/sample/horizon`，缺项点名；模型没回应的服务端缺口以「（服务端标注、模型未回应）」并入 gaps，不悄悄丢。
- **修掉两个真缺陷（本部分唯一动代码的地方，都在新内核内）**：
  1. `extractRefs()` 原来只扫顶层键 ⇒ 真实载荷普遍是 `{items:[{finding_id}]}`，血缘会抽不到任何业务主键（§十九 的「点得回去」落空）。改为白名单键之外继续下探（深度 ≤2、数组每层取前 5、总上限 12 行），并把「嵌套能抽到主键」写成断言。
  2. 引用标记被当成市场数字：`…（过去样本）[H01]` 被 P6-C `MARKET_NUMBER_PATTERNS` 第三条（`样本` 后紧跟数字）扫出一个凭空数字「样本）[H01」=1，把一句完全可回溯的答案误判成 PARTIAL。本层在数字扫描前摘掉 `\[[A-Z]{1,2}\d{1,3}\]`（**不改已提交的 P6-C 判据本身**，注释里写明这是引用语法不是读数），并加反向断言「claims 里不得出现引用标记」。同一假阳性在 P6-C 的调用路径上仍然存在，记为已知缺口，是否统一到 research-core 由用户定。
- **三条我自己写错的测试期望（按内核真实语义改正，不是放宽断言）**：提示词里给模型看的是**剩余**预算（`工具调用 10/12`，不是配额 12）；`probability` 的 not_supported 应当走 `try_fallback` 而不是 `answer_with_gap`（它确有留档兜底）；预算未用满时 `summarizeRun().stop_reason` 必须是 `null`——编一个 `max_steps` 就是本层禁止的伪装。
- **测试与回归**：新增 43 条纯内核测试（`p6-d-agent-tools.test.ts` 20 + `p6-d-agent-loop.test.ts` 23），`node --test --experimental-strip-types` 43/43 通过；全量 `node --test --experimental-strip-types "tests/**/*.test.ts"` **324 tests / 315 pass / 0 fail / 9 skipped**（P6-C 收口基线 281/272/0/9，skip 数不变 ⇒ 无回归）；`npx tsc --noEmit` 退出码 0。本阶段四个新文件均未提交（`git status --short` 只有这四行 untracked）。
- **本部分没做（下一部分的范围，不含任何「已完成」含义）**：工具执行服务层（34 条 `executor` 至今**一次都没有真取过数**）、`GET /api/agent/tools` 与 `POST /api/agent/{run,tool,finalize}`、`agent_run` / `agent_tool_call` 两张表（§三十三/§三十四）、Agent 运行页面、§三十七 的 curl 与真实数据 smoke、§三十 的 10 项真实数据验收。
- **已知缺口**：① 本机无 AI 凭据（`AI 未配置`），循环协议未经过任何一次真实模型回复，`parseAgentDirective()` 目前只被夹具验证过，真实回复的格式偏离幅度未知；② 引用标记假阳性在 P6-C 路径仍在（见上）；③ `take_screenshot` 本机仍报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，UI 核对只能走可及性树 + 文本树。

## P6 第八阶段 P6-D Agent 自主工具调用（2026-09-20：第二部分 = 工具执行服务层、两张表、四个接口与真实数据 smoke）

- **本部分做了什么**：`src/lib/quant/screener/agent-tools.ts`（907 行，执行器派发层：把登记表里的 `executor` id 派到仓库里**已经跑通**的函数）、`src/lib/quant/screener/agent-run.ts`（773 行，服务层：准入 → 执行 → 记账 → 落库 → 下一轮提示词）、`prisma/schema.prisma` 的 `agent_run` + `agent_tool_call`（§三十三/§三十四，含 105 行「为什么要这两张表」的说明块）、四个路由 `GET /api/agent/tools`、`POST /api/agent/{run,tool,finalize}` + `GET /api/agent/run`，以及两份新测试 `tests/quant/p6-d-agent-run.test.ts`（隔离库副本 + 注入假执行器的机制测试）、`tests/quant/p6-d-agent-wiring.test.ts`（静态接线约束）。**至此 34 条 executor 全部真取过数或真被调过**（第一部分「一次都没真取过数」那句已失效）。
- **§二十六「不要重新造一套相同工具」的落地判据**：`agent-tools.ts` 里没有一条新的指标公式、没有一个新的 HTTP 端点、没有一条新 SQL——每个 `case` 调的都是页面同源的那一个函数（`computeSentiment` / `discoverThemes` / `fetchBoardReal` / `readRadarDay` / `listSnapshotRows` / `probeCapabilities` / `verifiedLedgerMeta`…）。`DISPATCHED_EXECUTORS` 34 条与 `dispatch()` 的 34 个 `case` 由测试做**双向差集**（表里有 case 里没有 ⇒ 报「假能力」；case 有表里没写 ⇒ 报「自检漏报」），并另有一条 `unimplemented_executors()` 自检随 `GET /api/agent/tools` 公开返回：目录页自己就说清「哪些 executor 真的接上了」。
- **只读边界是测出来的，不是文案（§二十八）**：wiring 测试逐条断言 ① 执行器层没有 `.create/.update/.upsert/.delete/deleteMany/writeFileSync`；② `agent-run.ts` 的写库出口经正则抽出后必须全部匹配 `^(agentRun|agentToolCall)\.` ⇒ 服务层越界写别的表直接红；③ 四个路由的**代码行**（用 `codeLines()` 先剔整行注释，避免把「不调模型」的口径说明误判成违规）不得出现 `/api/ai/proxy` 或 `fetch(`；④ 不得出现 `cron|setInterval|scheduler` ⇒ 这一格是被客户端一步一格驱动的，不是自动跑的；⑤ `DETAIL_TABLES` 仍等于 `["radar_finding","global_event"]` 且生命周期层不得出现 `agent_run|agent_tool_call`——**新表不进 P5 的 180 天清理口径，保留期属用户决定，未定之前一行都不删**。
- **一格一请求的协议写进了源码注释（不是实现细节，是边界）**：AI 凭据只在客户端，服务端没有模型可调 ⇒ 「下一步做什么」在模型那边、「这一步算不算数」在这里。`agent-run.ts` 的落库判据是同一条：**模型自称调用过而不产生 `agent_tool_call` 行的，库里就没有这次调用**；`stateJson` 只存不可从调用行推导的部分（started_ms/stop/started_at），`steps/toolCalls/evidenceLines/logStatusCounts` 全部从行重建。
- **HTTP 契约下沉到内核（§三十一 要的是结构稳定，不是中文文案）**：`AgentHttp = 200|400|404|409|422|502`，路由只做 `status: r.http`，并测试钉死「不得用正则猜中文错误来定状态码」。语义：**200 = 这一步照常记账**（哪怕上游取数失败，它也是这次运行的真实结果）；400 = 请求体本身不合法（非法 `run_id`、缺 `tool`、缺 `raw`、`raw` 超长）；404 = 库里没有这次运行（本层不替没开过的 run 建账）；409 = 这次运行已收尾，不再接受新调用、坏回复不覆盖已成立结论；422 = 收尾算出来了但结论 REJECTED/PARTIAL 且不落已成立结论（**已落库**，回看能看到原文与违规）；502 = 路由 catch。
- **本轮唯一的结构性改动：一条调用行一个形状**。`POST /api/agent/tool` 的 `call` 原来直接 `row as AnyRow`（Prisma camelCase），`GET /api/agent/run` 的 `timeline` 另写了一份 12 行内联映射（蛇形）⇒ 同一条记录在两个接口上有两种字段名，页面必然漏字段。抽出 `rowToLog()` 作为唯一映射（§十八 蛇形 21 个键），两处调用点共用；并钉进测试：`assert.deepEqual(Object.keys(timeline[0]).sort(), Object.keys(step.call).sort())`（机制测试）+ `assert.match(run, /call: rowToLog\(row\)/)`、`/timeline: rows\.map\(rowToLog\)/`（wiring 测试，防止以后又各写一套）。
- **第二个补齐：不记账的出口也要说清为什么没记账**。三个不落库出口原来只有 `error`，没有 `basis`：非法 `run_id` ⇒「没有建账也没有记账（本层不会替一个不认识的 id 写行，那等于凭空造一次研究）」；404 ⇒「库里没有这次运行：没有记账。「没开过」与「开过但一条读数没取到」是两件事（§十六）」；409 已收尾 ⇒「这一步没有记账（写了就会给已成立的结论多出一条不属于它的血缘）。要继续查请开新的 run_id，旧的那次回看仍然完整可读」。**「没记账」必须是可读事实，不能是静默丢弃。**
- **`admitCall()` 的判定顺序在真实数据上逐条验证过**：未知工具 → disabled → 本次运行已停止 → 参数校验 → 同参数缓存 → 步/调用/时长/台账预算 → 同一工具重试上限。被挡下的请求**照样写一行**（`latency_ms=null` 表示没打上游，真实拒绝原因写在 `error` 原文），所以 §十八 的「刚才请求了什么、为什么没跑」在库里答得出；实测小预算那次 `max_tool_calls=2` 用完后第三次调用记为 `output_status=budget`，`f2.calls.count` 仍是 2（没打上游），而 `agent_tool_call` 行数=3。
- **两张表的设计说明（§三十三 要求先说清，schema 里就是这段的原文）**：为什么要新建——§十八 要事后回答「调了什么/为什么/结果/有没有 fallback」，这些在 `AgentState.log`（内存）里只能活到本次请求结束，进程重启或隔天回看时库里没有就只能重跑，而重跑会再打上游、取到的数与当时不同，「当时的结论从哪来」永久答不上；已有留档表替代不了——`risk/theme/probability_snapshot` 存的是「某个引擎那次算出的完整响应」、`research_report` 存的是「P6-C 固定管线报告」，都没有「哪个工具在第几步被请求、参数是什么、成没成、退没退兜底」这一层（缺它就是把结论变成不可解释黑盒，§十九 明令禁止），`task_run` 的粒度是「一次扫描」且无入参/出处/血缘字段。存什么——运行级问题/实际生效预算/逐步计数/停止原因/答案原文与复校验/台账快照/缺口原文，调用级 §十八 十一项 + 内核额外记的 `kind/data_status/attempt/call_key/cached_from/evidence_id/thought/degraded_from`（共 19 列以上，全部独立成列而不是塞 JSON）。不存什么——API Key 与模型配置、行情原始行（payload 只留业务主键 `refs_json` 与一行 `summary`）、任何未被真实调用产生的记录。自然键与索引——`runId @unique`（同 id 重发是覆盖不是堆行）、`@@unique([runId, step])`（网络重试不产生第二步）、`@@index([startedAt])`、`@@index([runId])`；行数由预算硬上限封顶（调用 ≤24、台账 ≤60），不会无界增长。
- **`agent_run_history` 也进了 P6-A 能力登记表（42 条能力，工具集随之 35 条可执行 / 7 条明确不可执行）**：Agent 的运行记录必须同样能被查询、能被探测，否则「可核」只对页面开放、对模型是黑盒。登记表条目写死四条 limitations：「库里有没有这一行才是调没调过的准绳」「`answer_text` 属 AI_INTERPRETATION 层，不是行情事实」「`status=running` 表示还没收尾，进程重启不影响续跑与回看」「这两张表不在 P5 的 180 天清理口径内，保留期由用户决定」。`capability-service.ts` 的 `probeOne` 新增该 case：`db.agentRun.count()` + `db.agentToolCall.count()` 真数行，0 行写 `emptySig`「还没有跑过 Agent 研究循环（不是失败；服务端不会自动开跑，需要客户端带着 AI 回复逐格调 /api/agent/tool）」。
- **§十七 的软超时有了执行点**：`timed(ms, label, make)` 用 `Promise.race` + `Symbol("timeout")`，超时与「请求成功但返回空」分开报（`timed_out=true` ⇒ 上层写 `output_status=timeout`）；上游把两者压成 `null` 时（`em.ts`/`tdx.ts` 既有约定）一律按**失败**处理，不写成「今天没有数据」；`fetch` 取消不了 ⇒ 给挂赢的 promise 补 `.catch()`，避免未处理拒绝打崩进程。停止原因（8 项常量）与单次碰壁分类（6 项 `AGENT_FAILURE_KINDS` 含 `timeout`）在测试里被明确分开钉住，整轮停止对应 `max_total_ms`，两者不许互相冒充。
- **测试期望写错 vs 产品错，本部分逐条分清（只改过测试自身，没为迁就测试改被测源码）**：wiring 首跑 5 条红全是断言自身问题——`DISPATCHED_EXECUTORS` 同行多条 id 导致正则抓空（改为「抓到数 > 5」的漂移守卫 + 双向差集）、动态 import 的字面量不匹配、LOG_FIELDS 的 `input` 实际列名是 `inputJson`（显式 `ALIAS` 而不是猜映射）、`doesNotMatch(/ai\/proxy/)` 撞上文件头口径注释（引入 `codeLines()`）、期望里放了 `timeout` 而真实清单是 `max_total_ms`（深比较对齐真实常量并写明理由）。机制测试另有一条期望写错：`s1.call.latency_ms` 我期望 `null`，实际假执行器计时 7ms ⇒ 改成「执行过的步是 number，被准入挡下的步是 null」。
- **`npx tsc --noEmit` 退出码 0；全量 `node --test --experimental-strip-types "tests/**/*.test.ts"` = 345 tests / 336 pass / 0 fail / 9 skipped**（第一部分收口 324/315/0/9 ⇒ 本部分新增 21 条，skip 数不变、无回归）。新增测试分布：`p6-d-agent-run.test.ts`（4 条计数）跑机制（隔离库副本 + 假执行器：建账幂等、真记一步、同参数命中缓存不打上游、预算撞墙仍写行、自然键覆盖式重发、状态从行重建、收尾四类判定）+ `p6-d-agent-wiring.test.ts` 9 条静态接线，两份合计 13 条。差额说明（避免数字对不上）：本部分全量比第一部分收口多 21 条 = 这两份新文件的 13 条 + 两份纯内核测试文件在服务层实现过程中补到 51 条（第一部分记录的是 43 条：`p6-d-agent-tools.test.ts` 现 26、`p6-d-agent-loop.test.ts` 现 25，补的都是「执行器真的接上了」「rowToLog 单一映射」这类要有落库/源码对手才能断言的项）。`next build` 退出码 0，产物即当前 3010/3012 正在运行的构建（`.next/BUILD_ID` 时间 2026-09-20 03:47）；P6-D 页面（④）完成后按 §三十七 重跑一次。
- **真实数据 smoke 跑在隔离副本，不在生产库上写**：`cp prisma/db/custom.db prisma/db/p6d-smoke.db` + `DATABASE_URL="file:./db/p6d-smoke.db" DESK_SCHEDULER=0 npx next start -p 3012`（3011 被一个外部进程占用，返回的不是本仓库的响应，未触碰它；隔离实例改用 3012）。脚本 `.p6d-smoke/run-smoke.mjs` 头部三句声明照抄在此：**它扮演客户端**、**指令是人写死的固定序列、不是模型输出**、**真实库必须保持 0 行**。权威日志 `.p6d-smoke/smoke-final.log`（155 行）。
- **真实取数的台账（run A，问题「今天盘面最强的题材是什么？它在雷达与市场情绪里有没有对应的真实记录？」）**：`step=1 themes output_status=ok data_status=DERIVED evidence_id=S01 latency=2433ms as_of=2026-09-20 03:50:39`，观测「主线 2 个（集成电路制造(74.2分)、分立器件(74.1分)）…」；`step=2 sentiment … S02`「全A 5554 只：涨 4234/跌 1152/平 168，中位 1.1%；涨停 83、跌停 1、炸板率 27.8%；成交 20929.1亿、主力净额 +399.3亿」；`step=3 radar output_status=empty kind=no_data data_status=MISSING`「radar_finding 在 2026-09-20 没有行 —— 当天没扫描、或扫描了但规则没命中」（**真实为空写成空，没有补 0，也没有说成失败**）。收尾 `HTTP=200 answer_status=ACCEPTED cites_valid=["S01","S02"] 违规=[] unused=[]`，血缘含 `refs=["trade_date=2026-09-20","theme_id=BK1329",…]` 与 `["symbol=000001.SH","symbol=399001.SZ","symbol=399006.SZ"]`（§十九 的业务主键真的抽出来了）；`log_status_counts "ok=2,empty=1,cached=1,not_supported=1,budget=1"`。
- **§三十二 的重复调用检测与 §十七 的缓存在同一份日志里可核**：`step=4 themes output_status=cached admitted=false evidence_id=S01 cached_from=S01`，附注「命中本次运行的同参数缓存：本次没有打上游」，台账没有多出第二行；`step=5 screener output_status=not_supported` 原样引用登记表的原因；`step=6 stock_quote budget`「本次运行已停止（no_progress…）」。回看接口 `rebuild_check = {"stored":{steps:6,tool_calls:5,evidence_lines:2},"rebuilt":同,"rows":6,"consistent":true,"unknown_layer_rows":[]}` ⇒ **状态能从调用行完整重建**；同一 `run_id` 再开 `resumed=true` 且 `question` 未被换（幂等续开）。
- **不可回溯的三条路径各有各自的出口**：坏回复（要工具而不是结论）⇒ `HTTP=409 persisted=false` 不覆盖已成立结论；收尾后再调工具 ⇒ `HTTP=409` + 上面那条 basis；只引用一个台账里不存在的行 ⇒ `HTTP=422 answer_status=REJECTED persisted=true cites_invalid=["F88"] unused_evidence=["F01"]`，且**结论原文照存**（「已验证因子账本里有 33 个信号键，全部可引用（出处见 F88）。」）——本层不改写、不替它补一份能过检的答案。
- **curl 逐字样本（对 3012 实跑，`.p6d-smoke/curl-final.log`，响应正文 = 当时落盘的 `c*.json` 原文）**：`[1] POST /api/agent/run --data @.p6d-smoke/p-run.json → HTTP=200 resumed=true`；`[2] POST /api/agent/tool（同一 run 的时长预算 120000ms 已在真实墙钟下用尽）→ HTTP=200 admitted=false output_status=timeout error=「本次运行的总时长预算 120000ms 已用尽，停止而不是继续挂着请求」next_turn=stop/max_total_ms basis=「本次没有执行 factor_verified：…（这一条照样写进日志，用于回答「刚才请求了什么、为什么没跑」）」`；`[3] 新开 p6d-curl-3 → HTTP=200 resumed=false，budget max_total_ms 被钳到 300000（硬上限，非法/超界不静默接受）`；`[4] POST tool factor_verified → HTTP=200 step=1 evidence_id=F01 output_status=ok data_status=REAL source=data\factor-verified.json as_of=2026-09-19 latency_ms=3`；`[5] finalize（编造引用 F88）→ HTTP=422`；`[6] GET /api/agent/run?run_id=p6d-curl-3 → HTTP=200`，`mode=run / status=finished / answer_status=REJECTED / elapsed_ms=19779 / timeline 1 行 / ledger 含 F01 全文 / lineage=[]（没引用上就是空，不假装有血缘）/ rebuild_check.consistent=true`。**git-bash 里 curl 内联中文 `-d` 会被 GBK 破坏**（服务端曾回显乱码 question），全部改为 UTF-8 载荷文件 `--data @file` 后回读正常。
- **错误结构矩阵（§三十一 无 HTML 错误页、无 silent failure，全部真实响应原文）**：`[3.1]` 建账 200；`[3.2]` 缺 `thought` 也能跑 ⇒ `thought=""`（空串 = 模型没给理由，页面显示「未记录」）；`[3.3]` body 非 JSON 400；`[3.4]` 缺 `raw` 400「未落库（服务端不会替你生成一份结论再判它成立）」；`[3.5]` `raw` 200001 字符 400（长度上限与 P6-C `MAX_RAW_CHARS` 同源）；`[3.6]` 收尾时 run 不存在 404；`[3.7]` 走一步时 run 不存在 404；`[3.8]` 带空格的非法 `run_id` 400；`[3.9]` 缺 `tool` 400「本层不会猜模型想调哪条工具（猜出来的调用等于伪造一次工具调用）」；`[3.10]` 收尾时模型要工具 409；`[3.11]` 零调用收尾 422。目录自检 `total=42 enabled=35 disabled=7 假能力=[] 越界=[]`。
- **两条待确认的口径事实（本层没有改代码，先如实记录）**：① 命中缓存的行 `latency_ms=0`（本地查表的真实耗时），与「准入直接挡下」的 `latency_ms=null` 语义不同——一个是「没打上游但查了本地表」，一个是「什么都没执行」，两者都写了附注，页面文案必须区分；② 运行停止后再到达的请求因准入顺序（已停止 → 参数校验）而先按停止分支记账，`output_status` 落在 `budget`/`timeout`，真实停止原因写在 `error` 原文里——这不是 bug（没执行是事实，原因也在），但意味着 `output_status` 单独看不足以判断「为什么没跑」，回看接口因此同时返回 `stop_reason` 与 `error`。
- **只读性与库核对（先核对再入库，脚本在仓库外 `D:/Zai/p6d-audit/audit.mjs`，输出留 `audit.out.txt`）**：`node:sqlite` 只读打开 HEAD 与工作树的两份 `custom.db` 拷贝（`git cat-file blob HEAD:prisma/db/custom.db` 取 HEAD 二进制，避免 checkout 干扰工作树）——**表集合差异只有 `only in work: ['agent_run','agent_tool_call']`（两张都是 0 行的新表），`only in head: []`；18→20 张表里原有 18 张逐表计数全部相等**（quant_factors 8、quant_strategies 5、quant_knowledge 67、factor_test 219、candidate_pool 5、task_run 112、global_event 7、radar_finding 13、留档三表各 1、scan_cursor 2、research_report 0…），按日期分组亦逐日一致（radar `2026-09-19:13`、events `2026-09-19:7`、task_run `2026-09-19:112`、三张快照 `2026-09-19:1`）⇒ 差异不是「某天的真实数据被改写」。夹具痕迹扫描（`p6d`/`smoke`/`fixture`/`夹具`/`人工构造`/`manual-smoke-client`/`curl-smoke-client`/`F88`/`999亿`/`X77` 全列 LIKE）：真实库仅 2 条 `smoke` 命中，逐条回查 HEAD 为**同 rowid 同 cuid 的历史行**（`quant_strategies` rowid=5 `aiscan smoke test`、`candidate_pool` rowid=2 `source=smoke_test`，P1 时期所留），`p6d*` 与本轮任何夹具标识在真实库 0 命中。新表实测：`agent_run` 34 列 + 索引 `agent_run_runId_key`/`agent_run_startedAt_idx`、`agent_tool_call` 26 列 + `agent_tool_call_runId_step_key`/`agent_tool_call_runId_idx`，真实库两张均 0 行；隔离副本 `p6d-smoke.db` 7 次运行 / 15 条调用（`p6d-real-a=finished/ACCEPTED`、`p6d-real-b=finished/ACCEPTED`、`p6d-real-c=finished/REJECTED`（错误矩阵用的空台账运行，422 是期望值）、`p6d-real-d=finished/REJECTED`（**脚本里刻意不引用**，日志 `[2.10 收尾 D] HTTP=422 …（期望 REJECTED：本步刻意不引用，验证「没引用就判不成立」在真实数据上同样生效）`）、`p6d-curl-1/2=running`、`p6d-curl-3=finished/REJECTED`）。生产 3010 上直接问接口也印证了空库：`GET /api/agent/run?mode=list → HTTP=200 {"mode":"list","runs":[],"take":20}`（JSON、非 HTML 错误页）。
- **服务状态与冒烟产物的处置**：本部分末尾已停掉 3012 隔离实例（`Stop-Process` 前先用 `Get-CimInstance Win32_Process` 核对 PID 120552 的命令行确实是 `next start -p 3012`，未触碰占用 3011 的那个外部进程 PID 110472）；`.p6d-smoke/` 与 `prisma/db/p6d-smoke.db` **暂时留在仓库内不 `git add`**，因为 ④ 的页面实测要在真实时间线上渲染（生产库 0 行渲染不出步骤/血缘），届时指向这份副本起隔离实例，④ 实测完成后整体移到 `D:/Zai/p6d-audit/` 归档（不改 `.gitignore`，避免 P6-B 记过的「未锚定忽略项吞掉源文件」连带风险）。
- **一次被如实记下的失败与返工**：第一次「重跑」是意外续跑——`rm -f prisma/db/p6d-smoke.db` 因文件被 3012 占用而失败，而我把 `&&` 链的后续写成了 `;`，脚本照跑，于是 run A 以 `resumed=true / status=finished` 被复用、后续每一步都收到 409。先查库确认这是「幂等续开 + 已收尾不再记账」的**正确行为**（不是掩盖），随后正规停掉 3012、重建副本、重跑得到干净的 `smoke-final.log`，三份旧日志改名保留（`smoke-1-v1.log`/`smoke-2-v2.log`/`smoke-3-*.log`）不与权威证据混用。另外 `npx tsc --noEmit | tail` 会把退出码吞成 `tail` 的退出码，改为重定向到文件后 `echo $?`。
- **未预期事项（§三十五 单列）**：① 为 `prisma generate` 新表，生产 3010 曾短暂停机，现已换成含 P6-D 的新构建（`next start -p 3010`，调度器开，下一次 2026-09-21 15:20，日志 `.prod-server.log`）；② 3012 隔离实例（`DESK_SCHEDULER=0`）已在本段收尾时停掉，见上一条「服务状态与冒烟产物的处置」；③ 本部分没有触碰那个占用 3011 的外部进程。
- **本部分没做（不含任何「已完成」含义）**：Agent 运行页面（§三十八 步骤时间线 + 血缘 + 预算余量 + 截断/停止原因显示）、§三十八 六个演示场景、§三十九 20 项最终报告、§三十 的 10 项真实数据验收中依赖页面的部分。§三十六：P6-D 整体只有一个 commit，所以本部分**未提交**（`git status --short`：5 个 `M` = `prisma/db/custom.db`、`prisma/schema.prisma`、`capability-core.ts`、`capability-service.ts`、`worklog.md`；11 个 `??` = 两份内核 + 执行层 + 服务层四个源文件、`src/app/api/agent/` 四个路由、四份 P6-D 测试、`.p6d-smoke/` 与 `prisma/db/p6d-smoke.db` 两项冒烟产物。`git diff --check` 退出码 0，只有仓库既有的 LF→CRLF 提示，无空白错误）。
- **已知缺口（承接第一部分，仍然成立）**：① 真实模型链路仍未经过一次真实回复——本机无 AI 凭据，本轮全部是「人写死的客户端序列」，`parseAgentDirective()` 对真实回复格式的偏离幅度仍未知；② 引用标记 `[H01]` 在 P6-C 路径的数字假阳性仍在；③ `take_screenshot` 仍报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，页面核对只能走可及性树 + 文本树。

## P6 第八阶段 P6-D Agent 自主工具调用（2026-09-20：第三部分 = 客户端循环驱动器 + Agent 运行页 + 一处分类纠正）

- **本部分做了什么**：`src/lib/desk/agent-loop-client.ts`（客户端循环驱动器：一步一格「问模型 → 交服务端执行 → 拿观测 → 再问」）、`src/components/desk/pages/AgentPage.tsx`（约 520 行的运行页）与三处注册（`src/lib/desk/types.ts` 的 `page` 联合类型与 `PAGE_TITLES`、`Sidebar.tsx` 的「Agent 自主研究」项、`AppShell.tsx` 的 import 与分支），`src/lib/desk/quant-api.ts` 补客户端封装（`agentRunApi/agentToolApi/agentFinalizeApi/fetchAgentRunView/fetchAgentRunList/fetchAgentTools` + §十八 的 19 字段蛇形 `AgentCallRowClient`），内核新增 `buildAgentFinalTurnText()` 与四张文案表（`LOG_STATUS_TEXT` 10 / `OBS_KIND_TEXT` 5 / `AGENT_STOP_REASON_TEXT` 8 / 客户端 `AGENT_LOOP_STATUS_TEXT` 9）。**P6-D 的 ①②③④ 到此齐了**（§三十六 的四阶段合并 commit 尚未做）。
- **循环的权力边界（本部分最要紧的一条，全部有接线测试钉住）**：客户端**不判预算、不判重复、不判收尾**。`agent-loop-client.ts` 里出现 `admitCall|recordCall|verifyAgentAnswer|nextAction|classifyDeadEnd` 任一即测试红；它只允许照 `next_turn.action` 走（`continue` 就再问一轮、`stop` 就进收尾轮），并把模型的原文 `raw` 整包交给 `/api/agent/finalize` 由服务端复校验。提示词也不由客户端拼：每轮文本都取自服务端返回的 `step.prompt.turn`，**唯一一次自拼**是「服务端说 stop 之后、给模型最后一次只答不调的步骤」，而那一句也来自内核 `buildAgentFinalTurnText()`——不允许出现第二套协议文本。
- **两套「停」不合并，各自有名**：内核停止原因 8 项（`answered/max_steps/max_tool_calls/max_total_ms/retry_limit/no_progress/invalid_directive/not_run`）与客户端循环状态 9 项（`DONE/UNFINISHED/RUN_CLOSED/RUN_NOT_STARTED/AI_NOT_CONFIGURED/AI_FAILED/CLIENT_GUARD/ABORTED/REQUEST_FAILED`）是两件事：前者说「研究为什么收尾」，后者说「这一格为什么没继续」。测试从常量里正则抽键名与文案表键名做 `deepEqual`（不多不少、九条文案互不相同、`AGENT_STOP_REASONS.length===8`），防止「加一个状态忘写解释」或「一条文案糊两种情况」。
- **页面上的三句事实是硬要求，不是装饰**：头部三行写明「回复文本里的一个 JSON（**无原生 function-calling**，凭据只在浏览器）／这一格一格由**本机浏览器**驱动，关掉页面就停在那里，已记账的步不会丢／模型自称调用过不算数：**只有从 `agent_tool_call` 读回来的行算数**，本层不下单、不改策略、不写任何业务表」。接线测试逐条断言这些字面存在，另断言页面**不得**再 `const` 定义一份同名文案表（文案唯一来源是内核），且必须保留「内核没有这条文案：原样显示，不猜它算什么」的兜底分支——常量将来加值时页面不会静默显示空白。
- **一条调用行一套渲染**：回看时把库行经 `rowToTurn()` 伪装成与实时轮同一形状，两者共用同一个 `StepRow` 模板（§三十一「同一份字段、同一映射」）。每步逐字显示 `output_status` 文案、`evidence_id/cached_from/fallback_of/degraded_from`、HTTP 状态、`latency_ms`（`null` 显示「未记录（没有真的执行）」而不是 0ms）、`kind` 观测口径、`attempt`、executor、`summary`、`error` 原文、`notes`、`dead_end`、模型请求入参与服务端实际生效入参、`refs` 业务主键、`thought`、登记能力与 `basis`。
- **UI 实机核对（隔离副本 3012 + 副本库 `prisma/db/p6d-smoke.db`，构建后的生产形态 `next start`，8 次运行逐个点开）**：`p6d-real-a`（6 步/5 调用/2 台账/3 缺，ACCEPTED）一屏里同时看到四种互不冒充的口径——步 1 `ok` 出台账 S01、步 3 `radar` 显示「请求成功但本次没有内容：真实为空，不是 0，也不是取数失败」并给 `radar_finding 在 2026-09-20 没有行` 原文、步 4 显示「命中同参数缓存…本次没有打上游」+ 复用 S01、步 5 `screener` 显示「该能力不支持由 Agent 走」并附登记表原因、步 6 显示「被预算挡下：本次没有执行」+ 耗时「未记录」；「事后重建核对：库里 6 行 → 重算步数 6／调用 5／台账 2｜与 agent_run 记的计数一致」；血缘两行回到 `theme_id=BK1329…` 与 `symbol=000001.SH…`；缺失三条与「模型自报缺口」并排，其中两条标「（服务端标注、模型未回应）」。`p6d-curl-3`（REJECTED）保留原文「…全部可引用（出处见 F88）」并逐条列出「引用了台账里不存在的行：F88」「结论没有引用任何台账行：无法回溯」，同时点名「已取到但没被引用的台账行：F01（取到不等于用上）」。`p6d-curl-1`（0 步）显示「这次运行 0 条调用记录：没有向服务端请求过任何工具…『0 行』就是真的一次都没请求过」，没有显示成「取数失败」。`p6d-curl-2/5`（running、未收尾）显示「这次运行（…）还没有结论：库里状态 running…本页不会显示一条编出来的答案」。工具目录侧栏显示「35 可调用 / 42 登记，禁用 7」并逐条给禁用原因；两个 disclosure 展开后分别是四张文案表与内核系统提示词骨架。`list_console_messages` 在整轮点击后仍为空（无 React 报错）。截图通道本机仍不可用，视觉核对未覆盖。
- **本部分发现并修掉一个真分类错（不是文案润色）**：`admitCall()` 在「整轮总时长预算用尽」这条分支上返回 `failure="timeout"`，于是那一行落库成 `output_status=timeout`，页面照着 `LOG_STATUS_TEXT.timeout` 说「**这一次调用**超时：按取数失败处理」，而同行的 `notes` 是「本次未执行任何取数（在准入阶段被挡下）」、`latency_ms=null`——一句话里自相矛盾，而内核自己的注释早就写着「budget/timeout 分别是整轮预算与单次超时」。改法：该分支归 `budget`，原因原文补一句「整轮时长，不是某一次调用超时」，页面文案随之变成「被预算挡下：本次没有执行，原因写在 error 原文里」。这是 §四十「发现已有代码存在 bug ⇒ 先判断是否真实可复现 ⇒ 修复 + 回归测试」：复现证据就是副本库里那条 `p6d-curl-2` 行（`output_status=timeout` + `kind=null` + `latency=null`）。回归两处：内核测试把期望从 `timeout` 改成 `budget` 并补断言原因文本必须自带「不是某一次调用超时」；服务层机制测试新增一段（`mech-run-2t`：`max_total_ms=1000`、在 T0+60s 走一步 ⇒ `admitted=false`、`call.output_status="budget"`、`error` 含「总时长预算」、假执行器计数 0、`next_turn.reason="max_total_ms"`）。**旧冒烟行不回改**：`p6d-curl-2` 保留修正前写入的那条 `timeout`，修正后的同一路径由新增的 `p6d-curl-5` 做对照（整轮时长 1ms ⇒ 库里记 `budget`），两者都在副本库、都不进真实库。
- **两处页面措辞按实修正**：台账空态那句原本是病句「还没有取到任何可读数为」，改为「还没有取到任何可读的数」；系统提示词 disclosure 在「回看一次历史运行」时不再说「还没跑过本轮」——那次确实发过 system，只是提示词原文不入库，改成明说「当时确实发过一份 system，但库里只存调用行，下面是内核同一份协议骨架，所以它不等于当时那一份」。
- **验证**：`npx tsc --noEmit` 退出码 0（`.p6d-smoke/tsc-p6d-5.log`）；全量 `node --test --experimental-strip-types "tests/**/*.test.ts"` = **352 tests / 343 pass / 0 fail / 9 skipped**（③ 收口 345/336/0/9 ⇒ +7 = ④ 的 1 条内核收尾轮测试 + 5 条接线测试 + 1 条文案表测试，skip 数不变 ⇒ 无回归；P6-D 四份文件合计 71 条：26+27+4+14）；`npx next build` 退出码 0（`.p6d-smoke/build-p6d-5.log`），页面核对与分类修正后的 curl 复现（`p6d-curl-5`：`output_status=budget`、`next_turn={action:stop,reason:max_total_ms,detail:"已达 1ms 总时长上限"}`、`admitted=false`、HTTP 200）都跑在这份新构建上。
- **本部分没做（不含任何「已完成」含义）**：§三十八 六个场景的真实演示序列尚未按场景逐条走完并组织成报告（工具与落库路径已在 ③ 的 run A/B/C/D 与本轮 run 5 上实测过）；§三十九 的 20 项最终报告未开始；P6-D 的合并 commit 未做（§三十六 规定 ①②③④ 全部完成后一个 commit）。
- **已知缺口（承接前两部分，仍然成立）**：① **循环协议至今没有经过一次真实模型回复**——本机无 AI 凭据（`.env` 只有 `DATABASE_URL`），本轮全部 UI/接口验证用的是「人写死指令 + 真服务端执行」，`parseAgentDirective()` 只被夹具与人工序列验证过，真实回复的格式偏离幅度未知；页面在未配置时显示 `AI_NOT_CONFIGURED` 且按钮 disabled（不会假装跑过）；② 引用标记导致的 MARKET_NUMBER 假阳性在 P6-C 调用路径上仍存在（是否统一到 research-core 属用户决定）；③ `take_screenshot` 本机仍报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`；④ `agent_run`/`agent_tool_call` 的保留期由用户决定，本阶段一行都不删、也不并入 P5 清理口径。

## P6 第八阶段 P6-D Agent 自主工具调用（2026-09-20：第四部分 = §三十八 六个场景的真实演示序列）

- **本部分做了什么**：把 §三十八 要求的六个场景在**真实服务端**上逐格跑完（3012 隔离实例 + 副本库 `prisma/db/p6d-smoke.db`，构建后的生产形态 `next start`），每个场景一份 spec 文件（`.p6d-smoke/scenarios/sc1…sc6.json` + 两份复验 `sc1b.json`/`sc6b.json`），由 `.p6d-smoke/scenarios.mjs` 按「开账 → 逐步交指令 → 收尾 → 回读台账」的顺序驱动，日志逐份留档（`scN-steps.log` / `scN-final.log`）。**产品代码零改动**：本部分只产生演示序列与观测，验证的是 ①②③④ 已有的实现。
- **六个场景的判定结果（这一列是结论，不是计划）**：场景 1 `p6d-sc-1` ⇒ **PARTIAL**（两条违规，见下面「检测器不迁就演示」）；场景 1 改写版 `p6d-sc-1b` ⇒ **ACCEPTED**（5 步 / 5 调用 / 3 台账，引用 S01·S02·F01，未用台账 0，重建核对 5/5/3 consistent）；场景 2 `p6d-sc-2` ⇒ **ACCEPTED**（8 步 / 8 调用 / 7 台账，引用 S01·F01·F02·F03·H01·H02·F04）；场景 3 `p6d-sc-3` ⇒ **ACCEPTED**（8 步 / 8 调用 / 7 台账，引用 H01·F01·S01·F02·F03·H02·H03）；场景 4 `p6d-sc-4` ⇒ **ACCEPTED**（6 步 / 6 调用 / 5 台账，引用 F01·F02·H01·H02·S01）；场景 5 `p6d-sc-5` ⇒ **ACCEPTED**（8 步 / 8 调用 / 3 台账，引用 S01·F01·F02）；场景 6 `p6d-sc-6` ⇒ **ACCEPTED**（3 步 / 3 调用 / 2 台账，引用 F01·F02）；补充场景 `p6d-sc-6b` ⇒ **REJECTED（刻意保留的边界实证）**。合计：六个场景全部按任务书要求的形状跑通，七次收尾里六次 ACCEPTED、一次 PARTIAL、一次刻意 REJECTED。
- **每个场景按任务书要的那几点，在真实数据上各自落在哪一行**：① 场景 1 要 FACTS/SIGNALS/RISKS/UNKNOWN 四段 ⇒ 答案里四段齐备，FACTS 段引用全A快照 F01（东财 push2 clist，5916 只有价 5554、涨 4234/跌 1152、主力净流入前列华天科技 +26.4亿），SIGNALS 段引用风险引擎 S01 与主线判定 S02（主线 2 个：集成电路制造 74.2 分、分立器件 74.1 分），UNKNOWN 段照库内事实写「当日 `radar_finding` 与 `global_event` 都是 0 行 ⇒ 消息面是否驱动本次无法验证」——**不是没有事件发生，也不是取数失败**，这句区分是 §十六 的核心。② 场景 2 要「识别缺失 → 取数 → 给事实/证据/解释/未知」⇒ 第一步 themes 之后 events 真返回空行（missing 一条，gaps 里逐字承认），sector_rank 拿到 80 条行业榜（电子 +198.5亿/+2.8%、半导体 +182.2亿/+4.4%、封测净占比 14.8%），sector_members BK1329 拿到 10 只成分（其中 1 只没有主力资金字段，答案写成「仅 9 只有主力资金字段」而不是补 0），factor_test 的 H02 带齐 `trade_date/sample/horizon` 三项口径。③ 场景 3 要 finding→trigger→factor→报价→K线→题材→事件 的证据链 ⇒ **真实数据里没有个股级 radar 条目**（当日 0 行，归档 13 条全是板块级），所以链条按真实形状写：H01（归档雷达，库里 `fallback_of=radar`）→ F01（板块成分表把华天科技 002185.SZ 排在净流入第 1，+10%/+26.4亿）→ F02（因子目录 137 因子 / 118 已实现 / 19 pending / 33 verified）→ F03（当前报价，DEGRADED）→ H02（60 根日K，区间 2026-06-29→2026-09-18）→ H03（当日归档事件 7 条），并在答案里点明「雷达产出的是板块级条目，个股级 finding 不存在」。④ 场景 4 要「历史统计不能说未来一定有效」⇒ 第三步 `backtest` 被准入挡下（`admitted=false`、`output_status=not_supported`、无兜底、附注「本次未执行任何取数」），答案按「能说的 / 不能说的（三条理由）/ UNKNOWN」三段写，概率数字全部来自 H02 留档行（基准日 2026-09-19：1 日 36.1%（样本 61）、5 日 48.3%（样本 60）、20 日 52.5%（样本 59））并带齐口径。⑤ 场景 5 要「列你还缺什么」⇒ S01 探测结果（43 条能力：32 可用 / 8 不可用 / 3 未探测；分层 REAL 16·DERIVED 7·HISTORICAL 7·SNAPSHOT 3·AI_INTERPRETATION 1·MISSING 8·DEGRADED 1）、F02 provider_health（注册 em/mcp/demo，eltdx 网关不可用，MCP 1 服务器 0 工具）、`northbound_flow` 的 `not_supported` 原文（交易所不再披露官方数据）；第 6 步后内核以 `no_progress` 停止，第 7、8 步记为 `output_status=budget`——**答案的 gaps 逐字带上库内五条缺失串各自的前 12 个字符**（服务端按 `g.includes(m.slice(0,12))` 判「是否承认」，意译会被并进「模型未回应」）。⑥ 场景 6 要 Tool A failed→查 fallback→Tool B ⇒ Tool A（`stock_depth`）真失败（`failed/request_failed`，`retry_same_tool`，`has_fallback=false`），查登记表得「兜底 无」，Tool B（`stock_quote`）成功但整行 **DEGRADED**（`degraded_from=eltdx 网关报价`、`source=腾讯 qt.gtimg.cn`、`fallback_of` 为空），答案据此写清「这是源级降级，不是工具级兜底：该行的 fallback_of 是空的」——两者的区别第一次被真实数据演示出来，而不是写在文案里。
- **检测器不迁就演示（本部分最要紧的一条决定）**：场景 1 首跑判 PARTIAL，两条违规是 `把历史样本写成当前事实的措辞：所以「今天…`（答案原文里那句被引号包住的「今天」被 `HISTORICAL_AS_CURRENT_PATTERNS` 第①条命中）与 `结论里提到概率/胜率，但引用的台账没有一条来自概率类工具…`（答案在 UNKNOWN 段**否定式**提到「上涨概率」，被 `probabilityCheck` 的 `/胜率|概率|可能性/` 命中）。先读源码确认判据语义（`agent-loop-core.ts:711-722`、`research-core.ts:194-198`）再决定怎么办，结论是**不放宽检测器**：这两条都是设计上的宽口径命中（正则不可能区分引号内引用与否定式提及），放宽会连带放走真违规。改法是改演示答案本身（`sc1b.json`：把「所以『今天有没有消息面驱动』」改写成「故消息面是否驱动本次无法验证」，把「不把它写成今天的上涨概率」改写成「只在历史口径下引用，不参与本结论对盘面的判断」），重跑五步后拿到 ACCEPTED。**PARTIAL 那份不删、不改**（副本库里 `p6d-sc-1` 与 `p6d-sc-1b` 两行并存），它现在是这条判据在真实数据上生效的复现证据。
- **一次我自己违反 §四十 的记录（必须留）**：`sc6.json` 第一次写 `final` 时我编了「耗时 201ms」和一条库里并不存在的台账原文（「688256.SH（价与涨幅字段本次没有返回）」）。这属于伪造工具观测，与 §四十「不要伪造工具调用/API response」直接冲突。处置：立刻删掉整个 `final` 块、只跑 `steps` 拿真实观测，再按打印出来的行重写答案；重写后又自查掉一处不可溯源的「耗时 2ms」，并把 `sc4.json` 里数错的「那 4 个胜率数字」改成「那三个」（真实是 3 个）。**规矩：演示答案里的每一个数字、每一句原文，都必须能在同一次运行的日志行里逐字找到；找不到就不写。**
- **`p6d-sc-6b` 的 REJECTED 是刻意的边界实证，不是失败返工**：场景 6 补一条「同一工具重试上限用尽后到底发生什么」的四步序列（同参数 `stock_depth` 连打四次）。真实观测：`retries_left` 2→1→0，前两次 `next_action=retry_same_tool`，第三次归零后翻成 `answer_with_gap`，同时运行以 `no_progress` 停止（原文「连续 3 次调用没有产生新读数：继续只会重复打上游」）；第 4 次请求被准入挡下，`output_status=budget`、`latency_ms=null`（没打上游）、附注「本次未执行任何取数（在准入阶段被挡下）」⇒ **「无限重试打同一条上游」这条路在实现上不存在**。收尾答案诚实写「无法验证」且不引用任何台账行（本次 0 行可读台账），服务端判 `HTTP=422 / persisted=true / answer_status=REJECTED`，违规只有一条「结论没有引用任何台账行：无法回溯到工具与出处」。**这是 §三十六 之前该记下的机制边界**：`verifyAgentAnswer` 的 `!used.length ⇒ REJECTED` 意味着「一条读数都没有」的运行永远拿不到 ACCEPTED——它不是 bug（正确路径已由 `p6d-sc-6` 演示：先查登记表，把「兜底 无」这条**真实读数**作为 F01 引上，就能在诚实说无法验证的同时拿到 ACCEPTED），但它是一道需要写清楚的约束：**要求引用 ≠ 允许编造引用**，模型若为过检去引一条无关台账就是假溯源，正解是像 sc6 那样把「为什么没有兜底」本身作为一个事实取回来。
- **一处我自己查错的差异，已核实并更正**：上一轮记录「`/api/radar?date=2026-09-19` 返回 0 条，而 agent 的 `history_radar` 同日 13 条」疑为不一致。本轮读 `src/app/api/radar/route.ts` 并实跑 curl 核实：`GET /api/radar` **不接收 date 参数**（`asOf = shanghaiDate()` 固定取当日），响应里 `as_of:"2026-09-20"` 就是它实际用的日期 ⇒ 那不是「2026-09-19 的雷达」，而是「今天还没有扫描所以 0 条」，与 agent 结果并不矛盾。按日期查的正确路由是 `/api/radar/history`，实跑 `curl "http://127.0.0.1:3010/api/radar/history?date=2026-09-19"`（真实库、只读）返回 `{"ok":true,"date":"2026-09-19","counts":{"rows":13,"live":13,"superseded":0}}` ⇒ **与 agent 的 `history_radar` 逐条一致（13 条）**，差异不存在。**遗留观察（本层未改代码）**：`GET /api/radar` 对未识别的 `?date=` 静默忽略（返回 200 + 当日结果），调用方若误以为它按日期过滤会把「今天没扫」读成「那天是空的」；它不属于 P6-D 范围（P2 路由）且响应自带 `as_of`，故只记录不改动，留作用户决定。
- **六场景调用行的真实分布（不是抽样，是 `node:sqlite` 只读把副本库 47 条 `p6d-sc-*` 调用行全部聚合出来的）**：`outputStatus` ok=30 / empty=8 / failed=4 / budget=3 / not_supported=2；观测 `kind` value=30 / no_data=8 / request_failed=4；`dataStatus` REAL=12 / MISSING=12 / DERIVED=8 / HISTORICAL=6 / DEGRADED=3 / SNAPSHOT=1；三种「没拿到」的标记各自独立——**工具级兜底只有 1 条**（`p6d-sc-3#2 history_radar` 的 `fallback_of=radar`）、**源级降级 5 条**（`degraded_from` 全是 eltdx 网关报价/日K，`fallback_of` 都为空）、**未打上游 5 条**（`latencyMs=null`：2 条 `not_supported` 准入挡下 + 3 条 `budget` 停止后到达）；命中本次同参数缓存 0 条（该行为已在 ③ 的 `p6d-real-a#4` 演示过，本轮序列没有重复调用同参数）。副本库总计 16 次运行 / 63 条调用行，其中真实库 `agent_run`=0、`agent_tool_call`=0、`runId like 'p6d%'`=0 ⇒ 演示一行都没进真实库（脚本 `D:/Zai/p6d-audit/audit-scenarios.mjs`，输出 `audit-scenarios.out.txt`）。
- **§三十七 本部分固定验收（全部在收口时重跑）**：`npx tsc --noEmit` 退出码 **0**；全量 `node --test --experimental-strip-types "tests/**/*.test.ts"` = **352 tests / 343 pass / 0 fail / 9 skipped / cancelled 0**（与 ④ 收口逐项相同 ⇒ 本部分无源码改动、无回归；日志 `smoke-worktree/tests-p6d-6.log`、汇总 `verify-p6d-6.txt`）；`git diff --check` 退出码 **0**（只有仓库既有 LF→CRLF 提示，无空白错误）；生产 3010 只读 curl `GET /api/agent/tools → HTTP=200`、`{"ok":true,"total":42,"enabled":35,"disabled":7,…}`，`GET /api/agent/run?mode=list → {"ok":true,"runs":[]}`（真实库空，且返回 JSON 不是 HTML 错误页）。构建仍是 ④ 的那一份（`.next/BUILD_ID=ZvGHRY2YerWas2QQ787kn`，2026-09-20 04:45），本部分未改源码 ⇒ 未重跑 `next build`，六场景全部跑在该构建的 `next start` 生产形态上（3012 隔离实例 + 副本库 + `DESK_SCHEDULER=0`）。
- **冒烟产物已按约定移出仓库**：停掉 3012 前先用 `Get-CimInstance Win32_Process` 核对 PID 15812 的命令行确为 `next start -p 3012`（3010 生产 PID 25232 未触碰，仍在服务、调度器开），随后 `mv .p6d-smoke → D:/Zai/p6d-audit/P6D-final/smoke-worktree`、`mv prisma/db/p6d-smoke.db → D:/Zai/p6d-audit/P6D-final/p6d-smoke-final.db`。**因此本条 worklog 里出现的 `.p6d-smoke/…` 路径，现在实际在 `D:/Zai/p6d-audit/P6D-final/smoke-worktree/…`**（未改 `.gitignore`）。移出后 `git status --short` 只剩 P6-D 的 9 个 `M` + 11 个 `??`（全部是本阶段应提交项，无冒烟残留）。
- **本部分没做（不含任何「已完成」含义）**：§三十九 的最终报告（下一条即收口报告，报告本身不新增实现）、P6-D 的合并 commit（§三十六，等人工确认后执行）。

## P6 第八阶段 P6-D Agent 自主工具调用（2026-09-20：第五部分 = 真实模型跑通，真实数据反过来钉出一个判据缺陷）

- **这一部分补的是第四部分留下的缺口 ①**：§三十八 六个场景当时全部由脚本按真实观测驱动，缺的是「模型自己选工具」这一格。本轮用用户自己配置的模型（服务商 OpenAI 兼容、Base URL `https://api.inceptionlabs.ai/v1`、模型 `mercury-2`）在 `next build` + `next start -p 3010` 的生产实例上真跑了三次循环，凭据按设计只在浏览器：客户端逐格问模型、服务端真取数真记账，我没有在服务端放任何 Key。
- **一次 origin 隔离的真实教训（不是 bug，是我连错了窗口）**：browser-use 连到的是另一个 Chrome 实例（只有 1 个标签页，用户那个有 4 个），它的 `mydesk-state` 里 `baseUrl/模型名` 都在但 `apiKey.length=0`，页面顶栏因此仍显示「AI 未配置」——同一个 `localhost:3010` 在不同实例里 localStorage 不共享。核完这一点后在本实例填齐三项并点「测试连接」，页面回 `连接成功：成功`、AI 接口徽标变「已配置」。**凭据事实必须留档**：Key 由用户在回答里主动给出并明确授权我使用；它因此出现在本次对话记录中，已建议事后轮换；它没有写进 worklog、任何仓库文件、`agent_*` 表或服务端日志（`src/app/api/ai/proxy/route.ts` 只把它放在转发上游的请求头里）。
- **三次真实运行的全部结果（`/api/agent/run` 列表原文，不是复述）**：`ui-mu8xng0k-7uxyft` finished/**PARTIAL**，3 步 3 调用 3 台账，19785ms；`ui-mu8xuog5-vu40tx` finished/**ACCEPTED**，3 步 3 调用 3 台账，73213ms；`ui-mu8y1juz-2lc7kx` finished/**ACCEPTED**，1 步 1 调用 1 台账，16742ms。三次 `stop_reason` 都是 `answered`，`model` 都是 `mercury-2`，协议 `p6d.agent.v1`。工具是模型自己挑的：第一次 `market_snapshot → sector_rank → risk`，第二次 `sentiment → sector_rank → risk`，第三次一步到位 `risk`。
- **第一次为什么是 PARTIAL，违规串逐字**：`结论里提到概率/胜率，但引用的台账没有一条来自概率类工具：这属于凭空给概率，按不可回溯处理（概率只能由历史样本算出，也不能拿历史概率当今天的答案）`。而它引用的三行是 F01（全A快照 5916 只、有价 5554、涨 4234/跌 1152、主力净流入前列华天科技 +26.4亿）、F02（行业榜 80 条、电子 +198.5亿/+2.8%、半导体 +182.2亿/+4.4%、封测净占比 14.8%）、S01（风险等级「正常」、炸板率 27.8%、`上证相似环境后续统计：样本 113 个，1日胜率 46.9%（HISTORICAL，不是今天的预测）`）。**模型答案里的 46.9% 就是照抄 S01 的**，其余数字全部命中台账（`unsourced_numbers` 为空、`cites_invalid` 为空、`unused_evidence` 为空）。
- **先读源码再定性：这是判据的假指控，不是模型违规**（§四十「发现真实 bug 先复现再修」）。`probabilityCheck`（`src/lib/quant/screener/agent-loop-core.ts:722`，修复前在 :711）认定「概率出处」只认两样：工具名在 `PROBABILITY_TOOLS={probability,snapshot_probability,factor_test}` 里，或该行的 `source` 串含「概率/胜率」。`risk` 两条都不满足——它的出处串是 `sentiment 引擎风险分项 + 上证相似日统计（similar-env）`——可它**自己的摘要里就写着胜率数字**。数字明明在台账里却判它「凭空给概率」，是判据漏认出处，不是措辞问题。
- **修的是识别面，不是标准（两处，都在 P6-D 自己的文件里）**：① `probabilityCheck` 增加第三个识别条件「该行的台账原文里写着概率/胜率」，并在注释里写明这条来自 `ui-mu8xng0k-7uxyft` 的真实反例；一旦认它做出处，`trade_date/sample/horizon` 三项口径照样要齐，缺任一项仍判不成立——真正一个字都没提概率的台账行，走的还是原来那条「凭空给概率」消息（新增测试的第三段专门钉住这一点，防止这次改动被将来当成放宽的口子）。② 服务层补口径：`riskObs` 的 payload 里 `similar_env` 加上 `horizon: hz.h`（`src/lib/quant/screener/agent-tools.ts:313`），因为 `extractRefs` 只走到第二层（`agent-loop-core.ts:307`，`depth > 2` 即返回），原先 `horizon` 只存在于 `similar_env.horizons[].horizon` 第三层，永远抽不出来——也就是说 **`risk` 行在任何情况下都不可能带齐概率口径**，这是同一个真实运行连带暴露的第二处。
- **回归测试**：`tests/quant/p6-d-agent-loop.test.ts` 新增一条（标题「§十九 真实回归：概率数字写在非概率工具的台账原文里，认它做出处但仍要三项口径」），三段断言分别是：带 `horizon` 的 risk 行被引用 ⇒ `probability_gaps=[]` 且 `ACCEPTED`；同一行去掉 `horizon` ⇒ 违规串变成精确的 `缺口径字段：horizon` 且**不再**出现「没有一条来自概率类工具」；台账原文完全没提概率时答案里冒出胜率 ⇒ 仍然判「凭空给概率」。
- **修复后的端到端真实证据是第三次运行，不是第二次**（这句区分必须写清）：第二次 `ui-mu8xuog5-vu40tx` 虽然 `ACCEPTED`、`violations=[]`，但它的答案里模型自己没引用概率数字，所以它验证的是「真实模型能拿 ACCEPTED」，不构成对该分支的验证。第三次专门问「上证相似环境的 1 日胜率是多少……注明是历史统计还是对今天的预测」，模型一步选 `risk`，台账行 `S01` 的 refs 为 `["trade_date=2026-09-20","sample=225","horizon=1"]`，答案原文 `上证相似环境的 1 日胜率为 52.9%，该数字为历史统计（HISTORICAL），而非对今天的预测。当前风险等级为「正常」。` ⇒ `answer_status=ACCEPTED`、`violations=[]`、`rebuild_check.consistent=true`。同一张 `agent_tool_call` 表里现在同时留着修复前（`ui-mu8xng0k` 的 S01 refs 只有 `trade_date/sample`）与修复后（两行带 `horizon=1`）的真实行，这就是这个 bug 的复现与修复对照。
- **真跑顺带撞到的两条真实路径（都是本机层的，与内核 8 种停止原因两套）**：① `AI_FAILED`——第二次开跑时上游回了空内容，页面原文 `模型调用失败（第 1 格）：上游未返回内容（已走本机代理）。这一步没有走到服务端，所以库里不会多出行；前面已记账的 0 步是真的，可稍后续跑或收尾`，库里那一行仍是 `status=running`、`steps=0`，**没有**凭空多出的调用行；把同一 `run_id` 填回去点续跑，才走到 `ACCEPTED`（`elapsed_ms=73213` 里含这段等待）。② `RUN_NOT_STARTED`——我第三次先把 run_id 格清空了（它 mount 时由 `newRunId()` 预填，是我操作错的），页面照实回 `缺少 run_id：Agent 的每一步都要挂在同一次运行上，没有它无法回答「刚才调用了什么」` + `参数校验未通过：没有写库`，库里确实一行没多。
- **一条没修、留给用户决定的真实观察**：同一台机器、同一交易日，`risk` 的相似环境统计在 5 分钟内从「样本 113 / 1日胜率 46.9%」变成「样本 225 / 52.9%」。06:11 连打三次 `/api/market/risk?force=1` 全部稳定在 `sample=225`、`win_rate=52.888…%`、`period 2024-08-06→2026-08-20`（探针 `D:/Zai/p6d-audit/probe-risk-sample.mjs`，输出留档）。差异只能来自那一次调用拿到的上证日K窗口（`fetchBarsHybridTracked(["000001.SH"], shanghaiDate(), 520)`），但 `agent_tool_call` 26 列里**没有存 payload**，台账 refs 只有 `trade_date/sample/horizon`、没有 `period` ⇒ 事后无法从库里重建第一次的窗口。可选改法是把 `period` 也进 refs 或在摘要里写区间，两者都动到 P2/P5 的引擎与台账口径，本层没动。
- **能力面板随之翻面（同一次探测读回来的）**：`agent_run_history` 从第四部分记录的 `MISSING / agent_run 当前 0 行` 变成 `kind=value, status=REAL`，evidence 为 `rows=3, table=agent_run, tool_call_rows=7, latest_run=ui-mu8y1juz-2lc7kx, latest_status=finished, latest_answer=ACCEPTED, latest_started_at=2026-09-20 06:13:09, probe_scope=db`，note 原文 `已落库 Agent 运行 3 次（调用行 7 条；最新一次状态 finished/ACCEPTED。调用记录属服务端事实，answer 属 AI_INTERPRETATION 层）`，且 `missing` 清单里不再有 `agent_run`。
- **§三十七 固定验收（修复后重跑，全部实测）**：`npx tsc --noEmit` 退出码 **0**；全量 `node --experimental-strip-types --test tests/quant/*.test.ts` = **353 tests / 344 pass / 9 skipped / 0 fail**（比第四部分多 1 条，就是新增的那条真实回归）；`npx next build` 成功后重启 3010（PID 25232 → **21208**，只停进程不动文件，用户那个窗口需要刷新一次才拿到新 chunk）；curl smoke 六个接口全 200 —— `/api/agent/tools` 78345B、`/api/agent/run` 1201B、`/api/capabilities?need=northbound` 242B、`/api/radar/history` 34196B、`/api/snapshot?kind=probability` 5994B、`/api/quant/health` 738B；真实数据 smoke = 上面三次运行本身（`rebuild_check` 三次全 `consistent:true`）；`git diff --check` 干净（只有 autocrlf 提示，无空白错误）；`git status --short` 仍是 **9 个 M + 11 个 ??**，与第四部分收口时同一份清单。
- **真跑没有污染业务表（`node:sqlite` 只读逐表数，脚本 `D:/Zai/p6d-audit/audit-realrun.mjs`，输出 `audit-realrun.out.txt`）**：新增行只落在 `agent_run`（3）与 `agent_tool_call`（7）；`radar_finding=13`、`global_event=7`、`event_interpretation=0`、`research_report=0`、`risk_snapshot=1`、`theme_snapshot=1`、`probability_snapshot=1`、`candidate_pool=5`、`factor_test=219`、`task_run=112`、`scan_cursor=2`，与真跑前一致；库里表数 20。这三条运行是**真实运行记录**，不是夹具，用户已明确批准写入真实库；它们的保留天数属用户决定（与 §四十 那条同口径，本层不自作清理）。
- **本部分没做（不含任何「已完成」含义）**：§三十八 场景 2–6 仍只有脚本驱动的那份真实演示序列，本轮真实模型只覆盖了场景 1 的等价问题（另加一条专门验证概率分支的问题）；`period` 进不进台账 refs 没动；P6-D 的那一个合并 commit（§三十六）仍然没做，等人工确认。

## P6 第八阶段 P6-D Agent 自主工具调用（2026-09-20：第六部分 = 封版提交）

- **提交前只读核对（仓库外，`D:/Zai/p6d-audit`）**：`git cat-file blob HEAD:prisma/db/custom.db > head-custom.db`（901120B）与工作树副本 `work-custom.db`（962560B）用 `node:sqlite` 只读比对，脚本 `audit.mjs`、输出 `audit-final.out.txt`；两份 md5 核对过 `work-custom.db` 与 `prisma/db/custom.db` 完全相同（`9b98e11c…`），即比对的就是将要入库的那份字节。结果：表 18 → 20，新增只有 `agent_run`(34 列/3 行) 与 `agent_tool_call`(26 列/7 行)；原 18 表里计数有差异的只有 `task_run` 112→115、`scan_cursor` 2→4、`radar_finding` 13→21。
- **这三处业务表差异是本日真实扫描产生的，不是夹具、也不是本层新增的写入路径**：三条 `task_run` 全部 `trigger=manual`、`tradeDate=2026-09-20`、`status=success`，note 原文「手动触发（强制补跑，忽略当日已有结果，不计入自动重试次数）」；`radar_finding` 新增 8 行全为 `asOf=2026-09-20` 的真实候选（半导体/先进封装/数字芯片设计资金、风险等级正常、分立器件等 4 条主线次主线），`basis` 照实写明「上证指数日线最新交易日 2026-09-18 早于目标日 2026-09-20：休市/节假日，当日无新数据」——即 9-20 是休市日，这些行来自当日真实上游快照而非编造。脚本 `inspect-task-runs.mjs` 逐行核对过。
- **夹具泄漏扫描**：`quant_strategies` 与 `candidate_pool` 各 1 处 `smoke` 字样在 HEAD 与工作树**同样存在**（本阶段之前就有，本次未新增）；真实库 `agent_run` 命中的 3 处 `p6d` 全部是 `promptVersion/protocolVersion = p6d.agent.v1` 这个协议版本号本身（`inspect-agent-rows.mjs` 逐列定位），不是运行 id；`p6d-real-* / p6d-curl-* / p6d-sc-*` 16 条冒烟运行只存在于仓库外隔离库 `P6D-final/p6d-smoke-final.db`（16 行 / 63 调用行），`F88`、`999亿`、`X77`、`人工构造`、`manual-smoke-client` 在真实库 0 命中。
- **提交前重跑验收**：`npx tsc --noEmit` 退出码 0；全量测试 `353 tests / 344 pass / 9 skipped / 0 fail`。`git diff --cached --check` 第一次报出 `tests/quant/p6-d-agent-wiring.test.ts:254: new blank line at EOF`，遂删掉文件末尾那一个空行（纯空白，不改任何断言或行为），重跑该文件 14/14 通过，再 `git add` 该路径后 `--check` 干净。
- **Key 未进任何代码产物（本阶段自查后确立）**：对暂存文本 diff（排除二进制）以那把 Key 的前缀为字面量 grep，命中 **0**；`.p6c-smoke-server.log` 等日志被 `.gitignore` 的 `*.log` 忽略，冒烟库与审计脚本全部在 `D:/Zai/p6d-audit`（仓库外）。**一处自己制造的问题要记下来**：本行原来把那个前缀字面量写进了 worklog（`grep -c` 反而命中 1），等于凭据片段进了仓库——已由紧随的 docs 修订删除，本行改用「前缀」二字指代，不再复述任何片段。仍提醒用户：这把 Key 曾贴进对话，且片段一度进过 `8bc8884` 的历史，建议到 Inception 平台轮换。
- **§三十六 唯一 commit 已打**：逐路径 `git add` 22 个文件（9 个改动 + 13 个新增，未用 `git add .`），提交身份 `git -c user.name=mydesk-local -c user.email=local@mydesk`，消息逐字 `feat(P6-D): autonomous research agent and tool calling` → **commit `92c260e`**；提交后 `git status --short` 只剩本文件 `M worklog.md`，本 docs commit 打完即工作区干净。
- **本部分不做**：不改 Agent UI、不合并 AI 首页、不加新功能（UI 产品化留 P7）；`period` 进不进台账 refs、Agent 两张表保留几天，仍等用户决定。
- **对上一条 smoke 记录的补充核验（结论：不是缺陷，但我原来的记法不足以说明它有效）**：本轮以 UTF-8 正确编码重跑 `/api/capabilities?need=…`（脚本 `D:/Zai/p6d-audit/probe-caps-need.mjs`）：`need=板块资金` → 4 命中（sector_rank、fund_flow_stock、sector_members、stock_trades_proxy）、`need=风险等级` → 1 命中（risk）、`need=Agent 研究运行记录` → 1 命中（market_research，gap_groups=运维）。同一条中文需求在 git-bash 里直接把 UTF-8 字节塞进 curl 时全部退化为 `?` 且 0 命中，所以我此前那句「`/api/capabilities?need=northbound` 242B、HTTP 200」只证明了接口没报错，**没有**证明匹配有效。另外 `need=radar`、`need=agent_run_history` 这类「拿能力名当需求」查询返回 0 命中是设计如此（需求为自然语言、匹配不上就明说不猜），不是新缺陷；本阶段未改任何代码。

## P7 第一阶段 P7-① 统一决策层纯内核（2026-09-20）

- **起点是任务书而不是代码**：用户提交 `D:\DoubaoData\P7阶段产品化优化任务说明.md`（三大方向：Agent 融合 AI 首页、展示结构类 Deep Research 重构、新增 `decision-core.ts` 统一决策层）。动工前先把任务书逐条对到代码现实，核对记在仓库外 `D:\Zai\p7-review.md`，得到 7 个「不先定就会写出假数据」的前置问题：① 任务书要求「可信度 72%」与 P6-D 已提交的判据（得分不得冒充概率）冲突；② 项目里有两个概率引擎（`historicalWinProbability` 条件概率与 `similarReturnForward` 相似环境），两者口径不可平均；③ §五 分档表区间不闭合（1 日 35%–55% 无归属）；④ §七 公式里的 market_score/event_score 在任务书里根本没有打分规则，项目里也没有现成数值分；⑤ 因子面板存在 4 处「缺数据当 0」的既有写法（`factors/fields.ts:671/:1242-1245/:1189`、`selection/engine.ts:233` 等）；⑥ 与已有 `compositeScores`（横截面因子×方向×权重）的关系；⑦ risk 相似环境样本 113→225 的缺口来自台账 refs 无 `period`。
- **用户对四个决策的回答（都选推荐项，构成本层的口径来源）**：可信度用**得分 + 分级文字**、不出现百分号；market/event **缺规则即降级、不补 0 分**；第一阶段**只做 decision-core 内核**；**授权**把 `period` 提进台账 refs，但作为 P7 独立一小步（下一步，未与本层混做）。
- **新增文件只有 2 个**：`src/lib/quant/screener/decision-core.ts`（纯函数层，协议版本 `p7.decision.v1`）与 `tests/quant/p7-decision.test.ts`（19 条）。本层未接任何 route、未改 UI、未动 schema/DB、未碰已封版的 P6-D 代码，所以现在页面上还看不到它的输出——这是有意的，按用户定的顺序「内核 → 展示层 → 入口统一」走。
- **三条硬规则落在类型里**：`ScoreItem.points: number | null`，`null` = 算不出、`0` = 读数存在但按表归零，二者在文案里分开措辞（测试第 3 条钉住「越界的 `win_rate` 不是 0%」）；`DimensionResult.missing: string[]` 且 `decisionToText` 不得吞掉它（第 18 条）；`RULE_VERSIONS.market = null`、`event = null` 是导出的常量事实，任何外部维度想进分母必须自带 `rule_version`（第 8、19 条）。缺规则维度的权重从分母剔除后重归一，且把重归一结果写进 `weights.applied`（0.5714/0.4286 这种数字要可见，第 6 条）。
- **两个概率引擎禁止混算**：`probabilityDimension` 收到多份读数、或同一期限两条读数 ⇒ 直接 `score = null` 并登记冲突原因，不做平均（第 12 条）；条件概率缺 `conditions` ⇒ 不承认它是「上涨概率」（第 13 条）；样本 < `PROBABILITY_MIN_SAMPLE=30` ⇒ 数值仍呈现但整维度 `DEGRADED`（第 14 条，与引擎自己的 `sample_ok=false` 同向）。概率项 `status` 固定 `HISTORICAL`，`note` 里带「历史统计，非预测」。
- **不吃 `fields.ts` 的现成列**：`technicalItems` 的输入是 `ma5/ma10/ma20/price`、`dif/dea/柱体`、`rsi14` 等**原始读数**，自己在有数据的日期上判结构，不接收 `ma_struct`/`crossUp` 那两列——因为它们缺值时返回 0，会把「缺前一天」算成「没金叉」。测试第 4 条专门断言这点并点名 `crossUp`。任务书没写规则的量能、MACD 跨零轴，本层不补规则，只登记未计入（第 5 条）。
- **三处任务书空洞按「保守 + 自认补充」补口**：1 日 35%–55% 给 0 分且 `note` 写明这是本层补充而非任务书原文；RSI 70–75 取 −5（超买前哨）；MACD 跨零轴取 0 并标注。三处都需要用户确认口径（见本阶段收尾报告）。
- **实测到一个必须上报的规格后果**：`scoreBounds` 按 §五/§六 打分表与 §七 权重复算，四维齐全时 `final_score` 只能落在 **−24.5 ~ +32.5**，而 §七 的映射要求 ≥50 才「看涨」、<−50 才「看跌」⇒ 这两个档位在四维齐全时**永远不可达**（死档）。两维重归一后区间放宽到 −35~46.4，两档仍是死档；只剩技术单维时 −35~55，「看涨」反而首次可达、「看跌」仍不可达。也就是说同一个字面结论取决于参与维度数，所以 `attainable` 每次按生效权重重算并写进 `basis`（第 10 条）。本层**没有**擅自改阈值或打分表来「让它可达」。
- **§九 冲突独立判定**：`detectConflict` 只看技术分（≥15）与 1 日概率（<35），命中时 `grade = "反弹观察"`、`single_side = false`，文案带触发线原文（第 11、17 条）。
- **验收（本层实测）**：`npx tsc --noEmit` 退出码 **0**；`node --experimental-strip-types --test tests/quant/p7-decision.test.ts` = **19/19 通过**；全量 `tests/quant/*.test.ts` = **372 tests / 363 pass / 9 skipped / 0 fail**（P6-D 封版为 353/344，差值 19 恰为本层新增，未删改任何既有测试或断言）。
- **本部分没做**：未接 UI、未做展示层三段式结论卡、未合并 AI 首页入口、未动 `period` 进 refs（已授权，待本层确认后开工）、未 `build`/`start` 实测（本层为纯函数，无服务端运行时行为，接线那一步再按 §三十七 口径实测）。
- **评审确认结论已落地（用户回签 `D:\DoubaoData\P7-①决策内核评审确认结论.md`，两项规格都选推荐项）**：规格 A 选 A1 —— 映射阈值改为 **≥+30 看涨 / +5~+30 偏强震荡 / −20~+5 中性 / −40~−20 偏弱 / <−40 看跌**，任务书 §七 的 ≥50 与 <−50 作废；实现上把映射表收成单一事实源 `GRADE_BANDS`（`gradeForScore` 与可达性自检都读它），新增 `GRADE_MAPPING_VERSION = "p7.review.s1.A1"` 并把「映射阈值 p7.review.s1.A1（左闭右开）：看涨 [30,∞) …」写进 `basis`，让结论卡自己带阈值出处。规格 B 选 B1 —— 三处补分保留，note 统一带 `SUPPLEMENT_MARKER =「本层补充，非原始任务书定义」`，且 MACD 那条按 §一·规格 B 第 3 条原文写上「跨零轴状态」；新增测试同时断言「任务书本来就有的档位（RSI 55–70、20 日 35%–45%）不能被误标为补充」，否则这个标记就没有区分力。
- **A1 之后仍有一半死档没解决，这是本层不能自己吞下去的发现**：技术面全表地板是 −35（均线结构最低 0 + 破 MA20 −15 + 无金叉 0 + 零轴下方 −10 + RSI 偏弱 −10），概率面地板同样 −35，而生效权重必自和为 1 ⇒ 任何真实维度组合下 `final_score ≥ −35`。新阈值把「看涨」救活了（区间上限 − 三种组合分别 55 / 46.4 / 35，都 ≥30），但「看跌」要求 <−40，地板够不到 ⇒ **现行打分表下系统永远不会输出「看跌」**，最差只能到「偏弱」。这与评审确认结论 §一「保证所有维度组合下五档结论全部可达」直接冲突，且不是实现错误：要么把看跌线提到 −35 以上（−30 是自然选择，偏弱档随之收成 −30~−20），要么补技术面负分档或给市场/事件面补规则，两者都属改规则、需用户拍板。本层做法是把事实钉住：`scoreBounds` 的注释重写成 A1 后的真实数字，可达性测试从「断言两档死档」改为「断言看涨已可达 + 穷举三种生效权重组合证明看跌仍不可达」，并让 `basis` 文案在默认视图里说出「映射表里的『看跌』在这个区间内永远打不出来」。**因此 P7-① 的两个 commit 暂停，等该阈值定夺后一次改完再提交。**
- **改阈值不是降标准（记防歧义）**：本次修改的断言只有「映射表数值」与「可达性事实」两组，条数从 19 增至 20（新增 B1 补分留痕一条），旧断言里没有一条被删除或放宽；全量回归 **373 tests / 364 pass / 9 skipped / 0 fail**，`npx tsc --noEmit` 退出码 0，`git diff --check` 干净（仅 autocrlf 提示）。凭据自查按评审 §三 要求重做：`git grep -IE "sk_[A-Za-z0-9]{8,}"` 的 9 处命中全部是 `risk_snapshot` / `task_run` 这类表名列名，仓库内无密钥形态字面量。
- **该定夺已回到用户手上并落定（2026-09-20 当日答复：「看跌线提到 <−30（推荐）」）**：映射表改为 **看涨 [30,∞) / 偏强震荡 [5,30) / 中性 [−20,5) / 偏弱 [−30,−20) / 看跌 (−∞,−30)**，版本记作 `GRADE_MAPPING_VERSION = p7.review.s1.A1.1`（A1 的看跌线补丁，注释里保留「A1 原稿是 <−40、因够不到而提线」这条来龙去脉，防止后人以为 −40 是本层自己拍的）。改后可达性复核：三种**真实**生效权重组合（技术独占 −35~55、概率独占 −35~35、技术+概率重归一 −35~46.4）下 `unreachable_grades` 全为空 ⇒ 评审 §二 第 5 条「所有维度组合下五档全部可达」现在成立，并由测试穷举这三组钉住；`DEFAULT_WEIGHTS` 的 −24.5~32.5 那一组仍报「看跌不可达」，测试里明写它是纸面情形（只有市场/事件面拿到规则并各记 0 分才会出现，而 `scoreBounds` 不建模外部维度极值，地板偏乐观），不拿它冒充真实结论。basis 文案随之间改为「映射表五档全部可达」，无穷端点印成 `[-∞,-30)` 而不是 JS 的 `-Infinity`（新增一条断言守着）。
- **改阈值不算改打分表**：§五/§六 的分档数值一条没动（技术 −35~+55、概率 −35~+35 的地板天花板照旧），只动了「分数怎么变字面档位」这一层映射——这正是 A1 授权的范围。断言层面本次没有任何放宽：可达性测试从「断言存在死档」翻成「断言不存在死档 + 穷举三种组合」，映射测试新增「§七 的 50/20/−50 与 A1 的 −40 都不许再出现在表里」一条，防止旧阈值被回滚。P7-① 测试 19 → **20 条全绿**，全量 **373 tests / 364 pass / 9 skipped / 0 fail**，`npx tsc --noEmit` 退出码 **0**，`git diff --check` 只有 autocrlf 提示。真实样本渲染核对（脚本在仓库外 `D:/Zai/p7-check/demo.ts`，不进 git）：全弱输入 ⇒ `综合判断：看跌（加权得分 -35）` 且两维各 −35、缺口清单不吞；技术 55 + 1 日 30% ⇒ `综合判断：反弹观察（加权得分 +29.3）` + §九 原文风险提示带样本与区间，证明冲突层优先于档位、不会输出单边。
- **P7-① 封版**：commit **`6954fd4`**（`feat(P7-①): unified decision core with explicit missing-data semantics`），逐路径 add 两个文件、未用 `git add .`，`git show --stat` 确认本次提交只含 `src/lib/quant/screener/decision-core.ts`(+614) 与 `tests/quant/p7-decision.test.ts`(+314)，未碰 schema/DB/UI/已封版的 P6-D 代码；提交后 `git status --short` 只剩本文件。提交前实测：`npx tsc --noEmit` = 0、全量 373/364/0 fail/9 skipped、`git diff --cached --check` 干净、暂存新增行里凭证形态字面量 0 命中。本条 hash 记录随之单独提交（`docs(worklog): P7-① decision core completed`）。

## P7 第二阶段 P7-② 概率样本区间进台账 refs（2026-09-20）

- **这是评审确认结论 §四 明确授权、且要求「严格隔离、不与其他任务混提交」的一小步**，动因是 P6-D 那条没修的真实缺口：同一台机器同一交易日，risk 的相似环境统计 5 分钟内从「样本 113 / 46.9%」变成「样本 225 / 52.9%」，而台账 refs 只有 `trade_date/sample/horizon`，事后无法从库里重建那一次用的是哪段日K窗口。
- **先读代码再决定改哪：§四 的第 1 项其实不需要改**。`similarReturnForward`（`src/lib/quant/screener/similar-env.ts:20`）**本来就返回 `period: {start,end}`**（匹配到的历史日里首个与末个的日期，`usable` 为空时退回 `matched` 首末，两边都空才 null），`/api/market/risk` 也一直在透传它。真正的断点在下游两处，所以本步改动面比任务书列的还小、位置也不同：① `extractRefs` 不在 `agent-tools.ts` 而在 `agent-loop-core.ts`（任务书 §四 第 2 项把它归错了文件），它只走到 `depth<=2`，而 `period` 是 `payload.similar_env.period` 的**第三层对象**，字段永远抽不出来；② 服务层没有把区间提成第二层标量。这与 P6-D 那次 `horizon` 的坑完全同构，注释里也是互相指着写的。
- **改了 3 个文件共 +9/−4 行，另加 1 个测试文件**：`agent-loop-core.ts` 的 `REF_KEYS` 增 `"period_start","period_end"` 两项（§十九 的必需三项**一字未动**，`probabilityCheck` 仍只查 `trade_date/sample/horizon`）；`agent-tools.ts` 的 `riskObs` 在 `similar_env` 里加 `period_start/period_end` 两个第二层标量，并把 `，样本区间 2024-08-06→2026-08-20` 写进模型可见的 summary（没有 period 时写「样本区间未给出（引擎没返回 period，不猜窗口）」，不拿基准日或今天凑）；`agent-tools-core.ts` 的 `risk.out` 补上区间口径，让目录里就写着「引用概率要带前三项」。未碰 schema、未碰 DB 结构、未碰 UI，也没有再动其他 P6 核心逻辑。
- **6 条新测试（`tests/quant/p7-period-refs.test.ts`）里最要紧的是两条防回滚**：一条把「原样的 `period` 对象抽不到」钉成断言（`deepEqual(refs, ["horizon=1","sample=225","trade_date=2026-09-20"])`），这就是本次提标量的存在理由，将来谁把服务层改回传对象会立刻红；另一条用 **P6-D 当天真实落库的那一行形态**（无 period、`similar_env:{sample:113,horizon:1}`）跑 `verifyAgentAnswer`，断言 refs 一字不变且仍 `ACCEPTED` —— 因为 §四 要求「历史台账记录不受破坏」，如果我把 period 做成必需项，库里那 7 条真实调用行会全部变成违规，那是拿规格改判据。另有：缺 `horizon` 时即便带了 period 也必须仍报 `缺口径字段：horizon`；`period_start=null` 不产生引用项；`similarReturnForward` 的 period 必须是输入序列里真实存在的日期（合成序列，注释里声明只是验字段语义、不是行情事实）；注册表文本仍含 `trade_date/sample/horizon` 三项且 `snapshot_probability` 的契约保持原样。
- **服务端运行时行为按 §三十七 口径实测过，且真实库一个字节都没动**：`npx next build` 成功后，把真实库**复制**到仓库外 `D:/Zai/p7-check/p72-smoke.db`（复制时 md5 与 `prisma/db/custom.db` 相同，`9b98e11c…`），以 `DATABASE_URL="file:D:/Zai/p7-check/p72-smoke.db" DESK_SCHEDULER=0 npx next start -p 3013` 起隔离实例——绝对 `file:` 路径可以覆盖到 schema 目录之外，所以冒烟库不必落进 `prisma/db/`。脚本 `smoke-p7-2.mjs`（扮演客户端；工具名 `risk` 是人写死的，不是模型选的，这条边界在脚本头部声明）实测结果：`POST /api/agent/run → 200`、`POST /api/agent/tool(risk) → 200`，`data_status=DERIVED`、`kind=value`、`as_of=2026-09-20 08:12:58`，摘要原文含 `上证相似环境后续统计：样本 225 个，1日胜率 52.9%（HISTORICAL，不是今天的预测），样本区间 2024-08-06→2026-08-20`，**台账 refs 实测为 `["trade_date=2026-09-20","sample=225","period_start=2024-08-06","period_end=2026-08-20","horizon=1"]`**，且 `GET /api/agent/run?run_id=p72-smoke-1` 能把同一组 refs 读回（说明落库与重建两侧都通）。
- **隔离性复核**：冒烟后真实库 md5 仍是 `9b98e11cedff742e1a077af3b767c0e2`（未变），`agent_run=3 / agent_tool_call=7 / 带 period 的调用行=0`；副本是 `4 / 8 / 1`。3013 只杀我自己启的那个 PID（netstat 核对端口→PID 后 `taskkill //PID 26984`，未动用户的 21208/3010），杀后端口释放、3010 仍 200。审计与冒烟产物全部留在 `D:/Zai/p7-check/`（仓库外，不进 git）。
- **仍未闭环的两件事（不当成完成）**：① `snapshot_probability` 走的是 `probability_snapshot` 表，那张表**没有存样本区间**（列只有 tradeDate/computedAt/scope/conditions/universe/lookback/pooled/sampleOk/benchmark/payload/missing/source），`/api/quant/probability` 的响应里也没有 period ⇒ 留档概率这条路**仍然给不出窗口**。要补得动表列与留档写入口（P5 生命周期口径 + 二进制库比对那一整套），不属本步范围，留给用户决定。② 用户的 3010 实例还跑在 P6-D 的构建上，而 `.next` 已被本次 build 覆盖，需要重启一次才吃到新代码（重启会中断那个窗口，等你点头再做）。
- **P7-② 封版**：commit **`6def931`**（`feat(P7-②): persist probability period range into agent refs`），逐路径 add 四个文件（`agent-loop-core.ts` +3/−1、`agent-tools-core.ts` +1/−1、`agent-tools.ts` +5/−2、`tests/quant/p7-period-refs.test.ts` 新增 123 行），`git show --stat` 确认本次提交只含这 4 个文件、未用 `git add .`，未含 schema/UI/其他 P6 逻辑；提交后 `git status --short` 只剩本文件。提交前重跑实测：全量 `node --experimental-strip-types --test tests/quant/*.test.ts` = **379 tests / 370 pass / 0 fail / 9 skipped**（P7-① 封版时 373/364，差 6 即本步新增），`npx tsc --noEmit` = 0，`git diff --cached --check` 干净，暂存新增行里凭证形态字面量（`sk_xxx` / `api_key` / `Bearer`）**0 命中**。用户对两条待办的处置已明确：**暂时不重启 3010**（后续需要页面验证 period refs 时手动重启），`probability_snapshot` 缺 period 列与 `.next` 覆盖共享缓存这两件事**按约定保留、不在 P7-② 范围内**，留到后续迭代——本条因此不构成已完成项，也不允许被后续阶段引用成「留档概率已带窗口」。
