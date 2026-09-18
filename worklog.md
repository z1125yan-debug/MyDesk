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
