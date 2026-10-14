# MyDesk 个人行情工作台

跑在 Windows 本机的 A 股行情与量化研究工作台。**不用注册、不走云端、没有订阅和次数限制**——行情数据由本机直连公开接口获取，AI 分析调用你自己配置的模型接口，自选 / 追踪 / 历史 / 对话等数据全部存在本机。

> 🔒 私有项目，仅供个人学习与技术研究使用。AI 输出由第三方模型生成，仅供参考，**不构成任何投资建议**。

---

## 功能一览

| 菜单 | 说明 |
| --- | --- |
| **总览** | 自选行情卡片、刷新倒计时、常用入口 |
| **数据看板** | 板块资金流向榜（实时 / 历史 / 行业 / 概念 / 地域 × 流入 / 流出）、行点击联动明细、资金气泡图 |
| **AI 分析** | K 线图（8 档周期）+ 算法支撑 / 阻力 / 趋势通道 + 「开始分析」输出结构解读 / 关键价位 / 思路参考 / 风险提示，一键加入追踪 |
| **追踪** | 交易计划（方向 / 入场 / 止损 / 目标），可标记触达 |
| **历史** | AI 分析存档 |
| **智能助手** | 多会话 AI 对话，按「结构 / 关键位 / 思路 / 风险」的分析师风格回答品种问题 |
| **扩展** | TradingView 浏览器扩展：图表页一键把品种发回工作台 |
| **设置** | AI 接口配置与测试连接、MCP 服务器管理、刷新周期 |

看板、行情、追踪等界面功能**不需要任何 Key**，装好即可用；只有「AI 分析 / 智能助手」需要配一个大模型接口。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Next.js 16（App Router）· React 19 · TypeScript |
| UI | Tailwind CSS v4 · shadcn/Radix · ECharts · framer-motion |
| 数据 | Prisma 6 · SQLite（`prisma/db/custom.db`） |
| 行情源 | 腾讯 `qt.gtimg.cn` · 东方财富 · 通达信 `eltdx` HTTP 网关（本地 `:8756`） |
| AI | OpenAI / Claude / Gemini / DeepSeek / Moonshot / OpenRouter / Ollama / 自建中转 |
| 协议 | MCP（模型上下文协议）服务器管理与工具调用 |

---

## 快速开始

### 环境要求

- **Node.js ≥ 20**（推荐 LTS）
- Windows 10 / 11

### 三步启动

```bat
:: 1. 双击「启动.bat」
::    首次会自动装依赖（国内镜像，约 3~8 分钟，只此一次）
:: 2. 脚本自动初始化数据库、构建、启动本地服务
:: 3. 浏览器自动打开 http://localhost:3000
```

启动脚本的四种用法：

```bat
启动.bat            :: 正常启动（默认 dev 模式，改代码即时生效）
启动.bat rebuild    :: 改过代码后强制重新构建再启动
启动.bat prod       :: 生产模式（常驻更稳定，收盘自动扫描挂在这个进程上）
启动.bat 3011       :: 换端口启动（3000 被占用时）
```

### 手动启动（开发用）

```bash
npm install
npx prisma generate
npx prisma db push --accept-data-loss
npx next dev -p 3000 --webpack
```

---

## 数据与自动化

### 行情网关

服务启动前需拉起通达信行情网关，否则 `dailybars`（日 K 粮仓）会失败并连带 `picksym` / `pickfill` 空转：

```bat
%LocalAppData%\Programs\Python\Python314\Scripts\eltdx-http.exe ^
  --host 127.0.0.1 --port 8756 --server-count 2 --connections-per-server 2
```

### 收盘后自动扫描

服务端内置调度器，每 60 秒检查一次，在**交易日北京时间 15:20** 之后执行当日收盘任务链：

```
radar → events → breadth → review → roster → sectorsnap → dailysnap
      → dailybars → picksym → pickfill → aipick
```

- 每次执行都写 `task_run` 表，「到底有没有跑 / 什么时候跑 / 为什么失败」全部按真实记录展示，不把「手动扫描」写成「自动完成」。
- **服务启动时会补跑当天**已过窗口的任务；但**只补当天**，历史日期回放未实现。
- 增量口径：同一交易日重复扫描不重写、不重复；游标按交易日分行，跨日即视为首次。

### 数据体检

一条命令看清「缺什么、缺哪天、为什么」，并给出补抓命令：

```bash
node --experimental-strip-types scripts/data-health.ts
```

### 手动补跑任务

```bash
curl -X POST http://localhost:3000/api/tasks/run \
  -H 'Content-Type: application/json' \
  -d '{"kind":"dailybars","force":true}'
```

`kind` 可选：`radar` `events` `breadth` `review` `roster` `dailysnap` `picksym` `pickfill` `dailybars` `aipick`。**只允许执行当日**。

---

## 目录结构

```
src/
  app/            Next.js App Router 页面与 90+ 个 API 路由
  components/     UI 组件（看板 / 图表 / 桌面壳）
  lib/
    desk/         行情会话、交易日历、东财接口封装
    quant/        量化核心
      data/       数据源与粮仓（daily-bar-collect、em-provider…）
      scheduler/  收盘调度器（rules / index）
      screener/   选股与因子
      strategy/   策略与战绩层（AI优选、回测）
    llm/          模型通道配置
    mcp/          MCP 服务器与 OAuth
prisma/
  schema.prisma   数据模型
  db/custom.db    SQLite 数据库（**不入版本库**）
scripts/          数据构建 / 回测 / 体检脚本（含 quant/*.py）
data/             行情与板块快照归档（JSON）
public/           静态资源与浏览器扩展
```

---

## AI 接口配置

1. 打开「设置 → AI 接口」
2. 点选服务商（自动填地址与模型）
3. 填 API Key（OpenRouter 有免费模型；本机装 Ollama 可完全离线免费）
4. 点「测试连接」，变绿即可用

API Key 只保存在你本机浏览器里，请求经本地代理转发，**不落库、不进日志**。服务端任务（如 `aipick`）走 `.env` 里的 `LLM_*` / `AI_PROXY_URL` 配置。

---

## MCP（模型上下文协议）

位置：**设置 → MCP 服务器**

- 手动添加或 JSON 导入（格式参考 `data/mcp-config.json`）
- 启动 / 停止 / 工具发现 / 工具调用，带 trust 门控
- 包内附演示服务器 `scripts/mcp/demo_market.py`（纯标准库实现，可作为自己服务器的模板）

---

## 浏览器扩展

Chrome：`chrome://extensions` → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选择 `public/mydesk-extension`（Edge 同理 `edge://extensions`）。然后在扩展弹窗里填入工作台扩展页显示的回传地址与配对码。

---

## 常见问题

**双击「启动.bat」黑窗口一闪就没？**
多是被杀毒软件拦截，右键 → 使用管理员方式运行再试。

**提示端口已被占用？**
多半是你又双击了一次「启动.bat」，服务本来就在跑——直接打开 http://localhost:3000 即可；确实要开第二个实例就换成 `启动.bat 3011`。

**关掉浏览器窗口，收盘后的自动扫描还会跑吗？**
会——自动扫描跟着「启动.bat」那个黑窗口走，不看浏览器。但关掉那个黑窗口（或重启电脑后没再启动）就不会跑，本工具**不宣称无人值守**。

**数据会丢吗？**
自选 / 追踪 / 历史 / AI 配置都存在本机浏览器里，清浏览器缓存前请留意。

---

## 声明

本工具仅供个人学习与技术研究使用。行情数据来自公开接口，可能有延迟；AI 输出由第三方模型生成，仅供参考，不构成任何投资建议。请使用你自己的模型接口账号，并遵守其服务条款。
