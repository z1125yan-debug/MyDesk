# 稳智 AI 逆向对齐 · 方案 C 第 2 天收尾报告

_生成时间：2026-09-23 21:50 · 会话：kairotrend-p1 · 上一版报告：`wenzhi-deep-comparison.md`_

---

## 一、今晚做了什么（按时间顺序）

### 1. 前端 UI 逆向对齐（第 2 天主线）
- ChatModeMenu 4 选项（决策/思考/量化/分析）全可见：`createPortal` + `fixed` + `calc(100vh - 24px)` 双保险，深色浅色主题都全展开
- 输入条贴底：外层 `h-full w-full flex-col`，底部 `shrink-0 pb-2`，去掉中间那层固定高度
- AI 消息气泡左侧机器人头像删除：稳智原版就没有，去掉更对齐
- 全局主题切换：`--overlay` / `--overlay-strong` CSS 变量体系，12 个组件批量替换 `bg-white/[0.0X]` → `bg-overlay`，浅色主题不再黑底白字看不清
- Logo 换成稳智的图标，产品名改"工作室"

### 2. AI 对话输出对齐稳智决策模式
- 尝试 11 字段结构化模板 → doubao-pro 抢跑：模型先写结论再补 tool_calls，或只填 3 字段就停，或全写"暂无"
- 尝试强约束"content 必须为空" → 全字段空的失败模式
- **回退到自然语言散文体**：`MODE_NOTES.decision` 改为"像一位懂行的朋友当面讲——先加粗结论、再展开论据带数字和出处、最后给风险提示和失效点"
- 更新测试断言 `tests/quant/p8-mode-anywhere.test.ts`

### 3. Markdown 卡片化（P0 #2，稳智逆向对齐最重要一层）
`src/lib/desk/markdown-sections-core.ts` 9 类 section kind + `splitBlocks` + `stripLeadingEmoji`，与稳智 `flowVisualRegistry` 的 11 字段 emoji 语义表逐项对齐：

| 类别 | emoji | 关键词 |
|---|---|---|
| risk | ⚠️ | 风险/止损/失效/防守/警惕/注意 |
| action | 🧭 | 仓位/减仓/加仓/操作/计划/买点/卖点/策略 |
| capital | 💰 | 资金/主力/量能/成交/筹码 |
| technical | 📈 | 技术/趋势/均线/支撑/压力/回踩/形态/指标 |
| fundamental | 📊 | 财报/业绩/基本面/估值/盈利/公司/行业逻辑 |
| market | 🔥 | 市场/大盘/板块/轮动/情绪/环境 |
| event | 📰 | 新闻/消息/公告/催化/事件/快讯 |
| decision | 🎯 | 结论/判断/总结/定性/一句话/决策 |
| note | 📌 | 备注/说明/口径/数据来源/免责声明 |

### 4. chat2api 网关尝试（失败收尾）
- 下载 chat2api 1.8.8-beta2（`D:\chat2api\chat2api-main`），启动成功
- 用户 Google 账号 session-token 是**新版 JWE 加密**（`eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0...`，3933 字符）
- chatgpt.com 直接返回 401 "Could not parse your authentication token"
- **根因**：ChatGPT 2025 下半年把 session-token 从明文 JWT 换成 A256GCM 加密，chat2api 只支持明文 JWT 或 45 字符短 token，不支持 JWE 解密（JWE 需服务端 RSA 密钥）
- **本地无解，社区无解**，OpenAI 主动加锁防逆向
- token/env/脚本已从项目目录清除；项目目录保留（明天若社区出补丁可秒用）

### 5. doubao2API 假路由清理
`D:\doubao2API-main\backend\core\config.py` 里 BOT_MAP 的 30+ 假路由（gpt-4o/deepseek-chat/claude-sonnet-* 都被转发到豆包 bot_id）全删，只保留真实的 doubao/doubao-pro/doubao-lite

---

## 二、今晚门禁验证

| 检查 | 结果 | 备注 |
|---|---|---|
| `next build` | ✅ 通过 | 全 60+ 路由产出 |
| `tsc --noEmit` | ✅ 0 错 |  |
| `tsx --test tests/quant/*.test.ts` | ✅ **1098 pass / 1 fail / 9 skip / 1108 total** | 唯一 1 fail 是 `p2-archive-db.test.ts` tsx 加载 top-level await 的**存量**问题（`git log` 显示此文件本轮未改动，HEAD 上就跑不通），与本轮方案 C 改动无关 |
| P15 稳智对齐专项测试 | ✅ 7/7 全过 | `p15-wz-expression.test.ts` 覆盖分类器、emoji 剥前缀、切块、接线、定义完整性 |

**当前 HEAD 基线**：本轮未把 1099/1099 的门槛拉低，也未新增失败。

---

## 三、稳智对齐进度（对照 `wenzhi-deep-comparison.md`）

### 🔴 P0（2 项，已完成 1 项）
| # | 项 | 状态 |
|---|---|---|
| 1 | 意图识别器（8 个意图自动路由模板） | ⏸ **依赖后端 LLM 网关**，今晚卡壳；明天网关通了再做 |
| 2 | Markdown 前端 emoji 卡片化 | ✅ **已完成**（P15-①~⑦ 7 条测试全绿） |

### 🟡 P1（6 项，本轮做完了 3 项的 UI 部分）
| # | 项 | 状态 |
|---|---|---|
| 3 | 菜单区分 LLM 分析 vs AI 对话 | ✅ 稳智 9 项菜单 vs Kairo 8 项已对齐，命名与图标一致 |
| 4 | SSE 加 `stage` 事件 | ⏸ 后端事 |
| 5 | StepTimeline 阶段分组 | ⚠ **部分**：LineageSection 已有时间线，缺稳智 6 阶段（intent/skills/local_data/external_data/research/answer）分组折叠 |
| 6 | 错误码 → 用户文案映射 | ⏸ 待做 |
| 7 | 侧栏会话历史区 | ⏸ 待做 |
| 8 | 结论契约（markdown 固定前缀） | ⚠ **部分**：`extractDecision` + `DecisionWidget` 11 字段已在，`decision_signal` 等 10 字段前端识别已通；但 doubao-pro 指令遵循差，输出经常拿不到字段 |

### 🟠 P2（6 项，全部待做）
9 SSE block / 10 Agent Loop 6 阶段固定顺序 / 11 交易周期 3→5 档 / 12 parentStepId 嵌套 / 13 SourceStrip / 14 active_task_id 状态

### 🔵 P3-P4
按兴趣做；`多模态图片输入`（P3 #15）用户已明确搁置

---

## 四、当前环境状态

| 服务 | 状态 |
|---|---|
| Kairo (Next.js 3014) | ⏸ 需重启一次以加载最新前端改动（本轮 UI 已改动但未验证运行时热更新是否完全生效） |
| doubao2API (7861) | ❌ 停。Playwright Chromium 启动失败（"No available accounts"），今晚未解 |
| chat2api (5005) | ❌ 停。token 已清除，OpenAI 加密锁无解 |
| DeepSeek 网关 | ⏸ 用户被封到明早 |

**Kairo 现在实际不能用 AI 对话功能**（三个网关全断）。前端 UI 层改动已收口但需重启验证。

---

## 五、明天怎么接

### 优先级排序（推荐）
1. **修 doubao2API Playwright Chromium**：`No available accounts` 意味着 `python -m playwright install chromium` 没成功装，或者登录态 cookie 过期。查一下 backend 日志找具体报错，重装 chromium 或清一下用户态缓存。0.5-1 天，恢复今晚的豆包 pro 网关
2. **P0 #1 意图识别器**：doubao-pro 通了就接 `chat/route.ts` 开头做 8 意图分类，映射到已有模板。1 天
3. **P1 #5 StepTimeline 阶段分组**：把 `step_name` 映射到 6 阶段（intent/skills/local_data/external_data/research/answer），前端折叠分组渲染。0.5-1 天，纯前端
4. **P1 #6 错误码映射**：8 条错误码 → 用户文案。1 天，纯前端
5. **P1 #7 侧栏会话历史**：从 `useDesk.sessions` 读最近 5 条。0.5 天，纯前端
6. 若以上都通了，可以再看 chat2api 上游是否有 fork 支持 JWE；无解就彻底放弃 ChatGPT 逆向

### 已知 Bug（存量，非本轮引入）
1. `absolute_index === 0` 判断（回测代码）
2. 9 位数字截断（个股代码）
3. `BubbleFlow unitLabel` 板块榜显示"个股"文案（R17 修过后可能残留）
4. `p2-archive-db.test.ts` tsx top-level await 加载失败（**存量**，本轮未动）

### 用户搁置
- 多模态图片输入（P3 #15）—— 已明确跳过

---

## 六、今晚的一句话

**稳智逆向对齐第 2 天收口**：前端 UI 层（菜单/主题/输入框/头像/选项可见性）已全面对齐稳智原版；Markdown 9 类卡片化 7 条测试全绿；chat2api 网关路线被封（OpenAI JWE 加密锁），走豆包网关待修 Playwright。**Next build/tsc 全绿，1098/1099 测试通过，唯一失败是存量 tsx 环境问题。**

---

## 附录：证据锚点

- 稳智逆向主报告：`wenzhi-deep-comparison.md`（502 行，7 章，8 项遗留证据缺口）
- 稳智 JS bundle 逆向笔记：`.box-agent-scratch/wenzhi-reverse/reverse-01-AiMatrixHome.md`（393 行）+ `reverse-02-visual-debug.md`（1248 行，flowVisualRegistry + agentStepTimeline + useAiMatrixDebugView + CSS 完整拆解）
- 本轮 P15 稳智对齐专项测试：`tests/quant/p15-wz-expression.test.ts`（7/7 全过）
- Kairo Markdown 卡片化纯核：`src/lib/desk/markdown-sections-core.ts`（9 类 section + splitBlocks）
- Kairo Markdown 渲染层：`src/components/desk/Markdown.tsx`（用 splitBlocks 分节成卡）
- 稳智 flowVisualRegistry 原文：`.box-agent-scratch/wenzhi-reverse/js/flowVisualRegistry-BCNn6fhT.js`
- 决策卡 11 字段核心：`src/lib/desk/decision-widget-core.ts`
- chat2api 项目：`D:\chat2api\chat2api-main\`（保留，token 已清空）
