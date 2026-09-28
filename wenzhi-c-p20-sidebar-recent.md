# P20 侧栏底部「最近」会话历史区

## 起因与口径

主任务回到稳智对齐 P1 剩余项。AMD Radeon Cloud 直连/网关测试均已完成（结论：能通但有并发墙，不适合主上游，切回 Groq）。按 `wenzhi-deep-comparison.md` 里 P1 #7「侧栏会话历史区，从 `useDesk.sessions` 读最近 5 条，0.5 天，纯前端」推进。

三条口径钉死：

1. **只列有消息的会话**——"新会话"骨架不占位（否则一打开侧栏就是 5 条"新会话"）
2. **最多 5 条，按 updatedAt 倒序**——稳智原版口径
3. **点击 = switchSession(id) + go('copilot')**——两步一个不能少（先切会话、再跳页面，跳页时 activeSessionId 已就位）

## 落点

- `src/components/desk/Sidebar.tsx`：
  - 新增 imports：`useMemo`、`History` / `MessageSquare` 图标、`titleFromMessages` + `ChatSession` 类型
  - 新增 store 订阅：`sessions` / `activeSessionId` / `switchSession`
  - 新增 `recent` memo：`filter(messages.length > 0) → sort(updatedAt desc) → slice(0, 5) → map({id, title, msgCount})`
  - 新增渲染区（在 `<nav>` 之后、底部齿轮区之前）：`{recent.length > 0 && ...}` 空态不占位；每条会话用 `MessageSquare` 图标 + 标题截断；当前激活高亮（`page === "copilot" && activeSessionId === r.id`）
- `tests/quant/p20-sidebar-recent.test.ts`：9 条测试（3 数据源订阅 / 5 条上限 + 空消息过滤 / updatedAt 倒序 / switchSession+go 顺序 / 标题现算 / 激活高亮 / 空态不渲染 / 无 setInterval / 图标语义）

## 关键决定

- **标题现算**：`s.title && s.title !== "新会话" ? s.title : titleFromMessages(s.messages)`——用户手动重命名过的沿用，被 prune/清理过的从消息现算。
- **页面 key 用 "copilot" 不用 "assistant"**：`PageKey` 里 `assistant` 不存在，AI 对话页 key 是 `copilot`（`nav-core.ts:83`）。
- **纯订阅驱动**：`useDesk((s) => s.sessions)` 走 zustand selector，不加 setInterval、不加时间轮子。
- **放在底部齿轮区之前**：稳智左栏「最近」在菜单和底部账号区之间，符合用户扫读习惯。

## 验收

- **tsc**：`tsc --noEmit` 0 错误
- **next build**：通过
- **新增测试**：`p20-sidebar-recent.test.ts` 9/9 全绿
- **全量回归**：1145/1145 pass（0 fail，9 skipped 是存量 p2-archive-db tsx 环境问题）
- **AMD 折腾无回潮**：本次全量测试 1145 全绿，AMD 那次配置改动没影响主链路

## 未收口边界

- 「最近」区目前不做「删除会话」/「重命名」等编辑操作——那些在对话页头部有入口，避免侧栏挤爆
- 会话超过 5 条时只显最近 5 条，没有"查看更多"——稳智原版也没有，保持对齐
- 会话列表数据源是 `useDesk.sessions`（in-memory + persist），不是 `localStorage` 直读，所以跨 tab 不实时同步（下次刷新才对齐）

## 一句话

侧栏底部现在有一条真正的会话历史区，用户打开就能回上一轮的对话，不用翻聊天记录找。稳智对齐 P1 剩余项打勾一个。
