# P26 SSE block_started/finished 事件（稳智对齐 P2 #9）

## 对齐目标

稳智逆向扒出的 SSE 事件流里，block_started/finished 事件是结构化块：table/code/quote/markdown。本仓库原来没有 block 事件，Markdown 渲染是纯文本流式（delta 事件逐字追加）。P26 加了 block 事件：后端在遇到 markdown 结构化块时 emit，前端收到后用来渲染成结构化卡片。

## 改动分三块

### 1. SSE 事件契约（chat-stream-core.ts + chat-core.ts）

- `StreamEventBody` 加 `block_started` 和 `block_finished` 事件类型：
  - `{ type: "block_started"; data: { block_id: string; block_type: "table" | "code" | "quote" | "markdown" } }`
  - `{ type: "block_finished"; data: { block_id: string } }`
- `STREAM_EVENT_TYPES` 从 6 个扩到 8 个（加 "block_started" 和 "block_finished"）
- `decodeEventBody` 加 block_started 和 block_finished 分支（校验 block_type 在合法白名单内）
- `AppliedEvent` 加 block_started 和 block_finished 类型
- `ChatMessage` 加 `blocks` 字段（可选，不落 localStorage，仅用于前端实时渲染）
- `applyEvent` 加 block_started 和 block_finished 分支：
  - block_started 时创建新 block 条目（block_id + block_type + content: "" + finished: false）
  - block_finished 时标记 block 结束（finished: true）
  - delta 时如果当前有未结束的 block，内容追加到该 block 的 content 里；否则追加到消息的 content 里

### 2. 服务端 chat/route.ts

暂不改（服务端 emit block 事件的逻辑待后续做，需要 markdown 解析器来识别结构化块）。

### 3. 前端 Markdown.tsx

暂不改（前端渲染 block 卡片的逻辑待后续做）。

## 钉测（tests/quant/p26-sse-block.test.ts，18 条）

1. STREAM_EVENT_TYPES 包含 block_started 和 block_finished
2. decodeStreamEvent 能解码合法的 block_started 事件
3. decodeStreamEvent 能解码所有合法的 block_type 值（4 个）
4. decodeStreamEvent 能解码合法的 block_finished 事件
5. decodeStreamEvent 对无效的 block_type 值返回 null
6. decodeStreamEvent 对 block_id 非字符串返回 null
7. decodeStreamEvent 对 block_type 缺失返回 null
8. decodeStreamEvent 对 block_finished 缺 block_id 返回 null
9. encodeStreamEvent + decodeStreamEvent 往返一致（block_started 事件）
10. encodeStreamEvent + decodeStreamEvent 往返一致（block_finished 事件）
11. asStreamEvent 对带 seq 的 block 事件保留 seq
12. applyEvent 收到 block_started 后创建新 block 条目
13. applyEvent 收到 block_finished 后标记 block 结束
14. applyEvent 收到 delta 时如果当前有未结束的 block，内容追加到 block 的 content 里
15. applyEvent 收到 delta 时如果没有未结束的 block，内容追加到消息的 content 里
16. applyEvent 收到 delta 时如果最后一个 block 已结束，内容追加到消息的 content 里
17. applyEvent 连续收到多个 block_started，blocks 数组累加
18. applyEvent 收到 block_finished 时只标记匹配的 block_id

## 验证

- `npx tsc --noEmit` → 0 错
- `npx tsx --test tests/quant/p26-sse-block.test.ts` → 18/18 pass
- `npx tsx --test tests/quant/p8-debug-panel.test.ts` → 14/14 pass（更新 STREAM_EVENT_TYPES 断言为 8 类）
- `npx tsx --test tests/quant/*.test.ts` → 1221 tests / 1211 pass / 1 fail（p2-archive-db 是 tsx 老问题）/ 9 skipped
- `npx next build` → 通过

## 影响面

- **SSE 契约向后兼容**：block_started/finished 是新增事件类型，旧客户端收到 block 帧会按 EVENT_TYPES 白名单过滤掉（不 crash）
- **前端用户看到的变化**：暂无（block 事件已落进消息，但前端渲染逻辑待后续做）
- **不改数据库/不改 API 路由**：只改 SSE 事件数据形状和前端消息状态
- **与服务端的关系**：服务端暂不 emit block 事件（需要 markdown 解析器来识别结构化块），但 SSE 契约已就绪
