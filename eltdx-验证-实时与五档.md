# eltdx 验证记录：实时行情与五档盘口

> 验证时间：2026-09-19（周六，非交易日）凌晨 · 验证人：ZCode
> 结论先说：**网关在线、快照可用（约 30ms 往返）、五档盘口真实存在且有数据、逐笔成交可用**。
> 今天休市，盘中实时跳动效果需交易日（下周一）开盘后复核。

## 一、验证环境

- 网关：eltdx 3.2.2（`pip` 装在 Python 3.14），`eltdx-http` 常驻 `127.0.0.1:8756`
- 接口：`POST /rpc`（JSON-RPC 风格，`{"id":1,"method":"...","params":{...}}`），另有 `GET /methods`、`GET /docs`、WebSocket `/ws`
- 应用侧现有调用层：`src/lib/desk/tdx.ts`（目前只用了快照 / K线 / 代码表三个方法）

## 二、验证结果（全部为真实 RPC 调用，非推测）

| # | 验证项 | 方法 | 结果 |
|---|--------|------|------|
| 1 | 网关存活 | `GET /`、`GET /docs` | ✅ 200，FastAPI 文档可访问 |
| 2 | 交易日判断 | `workdays.today_is_workday` | ✅ 返回 `false`（2026-09-19 周六，数据自洽） |
| 3 | 实时快照 | `quotes.get_snapshots {codes:["sh688256"]}` | ✅ 寒武纪 1113.14（周五收盘 +0.65%），含开高低收、成交额 135.1亿、**内外盘**（主动卖/买量）、买一/卖一各 1 档 |
| 4 | **五档盘口** | `quotes.get_depth {codes:["sh688256"]}` | ✅ **买 5 档 + 卖 5 档**（买一 1113.14×45手 … 卖五 1113.60×21手），源码注释：*Refresh five-level quote depth through native 0x0547*，单次最多 100 只 |
| 5 | 逐笔成交 | `trades.history {code:"sh688256", trading_date:"2026-09-18"}` | ✅ 返回 `ticks` 数组：时间、价格、成交量、**方向 buy/sell**、笔数；`trades.today` 非交易日返回 0 条属正常 |
| 6 | 往返延迟 | 3 次快照调用计时 | ✅ 31~34ms（3 只股票批量） |
| 7 | 实时推送 | `quotes.subscribe` / `quotes.unsubscribe` | ⚠️ 方法已注册（WebSocket 专用），**未实测**，留给盘中验证 |

## 三、对「AI 实时选股中心」意味着什么

**现在就能用真实数据做的（无需任何新数据源）：**

- 全A 股票清单：`codes.all_a_shares` / `codes.latest_stocks`（含 ST/停牌表：`codes.st`、`codes.suspended`）
- 批量快照扫全A：`quotes.get_snapshots`（涨跌幅、成交额、换手基数、内外盘、买一卖一）
- 五档盘口批量：`quotes.get_depth`（一次 100 只）
- 排行/翻页扫描：`quotes.list_by_category`（按分类+排序）、`helpers.realtime_rank` / `helpers.stock_realtime_rank`
- 分时：`minutes.today` / `minutes.recent` / `minutes.sparkline`
- 买卖强弱（主动买卖）：`helpers.buy_sell_strength`、`minutes.buy_sell_strength`
- 题材/板块强度：`helpers.theme_strength_rank`、`helpers.stock_theme_strength_rank`、`helpers.stock_topics`
- 涨停跌停/连板：`limits.special`、`f10.limit_up_down_list`、`helpers.limit_ladder`
- K线/技术指标原始数据：`bars.get`（1/5/15/30/60分钟、日/周/月，前复权）
- F10 基本面：估值、财务、评分、热点题材等 `f10.*` 全家桶

**当前没有现成接口、需要替代方案的：**

- **主力资金流分级**（超大单/大单/中单/小单净额）：eltdx 无此方法 → 沿用东财 push2（应用已有 `src/lib/desk/em.ts`），或用快照内外盘 + 逐笔方向聚合做近似
- 逐笔有单笔上限（1800/页），全量需翻页（`trades.all_today` 支持自动翻页，`max_pages` 上限 100）

**必须在交易日开盘后复核的：**

- 盘中快照跳动感、`quotes.subscribe` WebSocket 推送实时性
- 盘中调用 `quotes.get_depth` 的频率上限（别把通达信主站打疼了）

## 四、关于「MCP 面板里为什么没有 tdx」

- 应用现在的行情**不走 MCP**，走 eltdx HTTP 网关（`启动.bat` 自动拉起），所以 MCP 面板里看不到 tdx 是正常的。
- eltdx 其实**自带 MCP 服务器**：`eltdx.mcp:main`，安装后已有 `C:\Users\Lenovo\AppData\Local\Programs\Python\Python314\Scripts\eltdx-mcp.exe`。想要的话，在你截图那个 MCP 面板里添加：名称 `tdx`，命令 `C:\Users\Lenovo\AppData\Local\Programs\Python\Python314\Scripts\eltdx-mcp.exe` 即可（与 HTTP 网关二选一或并存均可）。
- MCP 面板里现有的 `demo-market`（`py scripts/mcp/demo_market.py`，stopped）是应用自带的演示源，与 eltdx 无关。

## 五、风格预览页的假数据声明

`design-mockups/` 里的 4 套风格页（含五档盘口截图中的数字）**全部是手写死的示例数据**，仅用于视觉选型，未接任何数据源。页面顶部「示例数据」标签与页脚均有标注。真实版实现时，本文档第三节即数据源依据。
