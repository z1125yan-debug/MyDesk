# P24 SSE stage 事件（稳智对齐 P1 #4）

## 对齐目标

稳智逆向扒出的 SSE 事件流里，stage 事件是宏观阶段：researching / answer_streaming / finished / degraded / incomplete / failed。本仓库原来没有 stage 事件，6 阶段进度条是前端从 steps + intent 语义反推的。P24 加了 stage 事件：后端在关键节点 emit，前端收到后用来更新顶部进度条。

## 改动分三块

### 1. SSE 事件契约（chat-stream-core.ts + chat-core.ts）

- `StreamEventBody` 加 `stage` 事件类型：`{ type: "stage"; data: { stage: "researching" | "answer_streaming" | "finished" | "degraded" | "incomplete" | "failed" } }`
- `STREAM_EVENT_TYPES` 从 5 个扩到 6 个（加 "stage"）
- `decodeEventBody` 加 stage 分支（校验 stage 值在合法白名单内）
- `AppliedEvent` 加 stage 类型
- `ChatMessage` 加 `stage` 字段（可选，不落 localStorage，仅用于前端实时更新）
- `applyEvent` 加 stage 分支（更新消息的 stage 字段，不改变 streaming/content/warning 等其他字段）

### 2. 服务端 chat/route.ts

在关键节点 emit stage 事件：
- sseResponse 开头 → `stage: "researching"`（开始研究和取数）
- runToolLoop 完成后、done 前 → `stage: "finished"`（研究完成）
- catch 块 error 后 → `stage: "failed"`（出错后前端进度条显示失败状态）
- 如果 runToolLoop 内部没有 emit 过 answer_streaming（非流式降级），在 done 前补发 `stage: "answer_streaming"`

### 3. 前端 use-chat.ts

- 收到 stage 事件后，applyEvent 自动更新消息的 stage 字段
- Stage 字段不落 localStorage（stage 是过程信息，不是最终结果）
- 前端可以读取 `msg.stage` 来更新顶部进度条（具体渲染逻辑待后续 P2 大项做）

## 钉测（tests/quant/p24-sse-stage.test.ts，14 条）

1. STREAM_EVENT_TYPES 包含 stage
2. decodeStreamEvent 能解码合法的 stage 事件
3. decodeStreamEvent 能解码所有合法的 stage 值（6 个）
4. decodeStreamEvent 对无效的 stage 值返回 null
5. decodeStreamEvent 对 stage 字段非字符串返回 null
6. decodeStreamEvent 对 stage 字段缺失返回 null
7. encodeStreamEvent + decodeStreamEvent 往返一致（stage 事件）
8. asStreamEvent 对带 seq 的 stage 事件保留 seq
9. applyEvent 收到 stage 事件后更新消息的 stage 字段
10. applyEvent 收到 stage 事件后不改变其他字段
11. applyEvent 连续收到多个 stage 事件，后到的覆盖前到的
12. applyEvent 收到 stage 事件后 streaming 字段不变（由 done/error 收口）
13. applyEvent 收到 stage=failed 后 streaming 仍为 true（由 error 收口）
14. encodeStreamEvent 对 stage 事件带 seq 时保留 seq

## 验证

- `npx tsc --noEmit` → 0 错
- `npx tsx --test tests/quant/p24-sse-stage.test.ts` → 14/14 pass
- `npx tsx --test tests/quant/p8-debug-panel.test.ts` → 14/14 pass（更新 STREAM_EVENT_TYPES 断言为 6 类）
- `npx tsx --test tests/quant/*.test.ts` → 1203 tests / 1193 pass / 1 fail（p2-archive-db 是 tsx 老问题）/ 9 skipped
- `npx next build` → 通过

## 影响面

- **SSE 契约向后兼容**：stage 是新增事件类型，旧客户端收到 stage 帧会按 EVENT_TYPES 白名单过滤掉（不 crash）
- **前端用户看到的变化**：暂无（stage 字段已落进消息，但前端进度条渲染逻辑待后续做）
- **不改数据库/不改 API 路由**：只改 SSE 事件数据形状和前端消息状态
- **与 P22 6 阶段进度条的关系**：P22 的 6 阶段进度条是前端从 steps 语义反推的，P24 的 stage 事件是后端显式发的宏观阶段。两者并存，不冲突——stage 用于"宏观阶段进度"（researching → answer_streaming → finished），6 阶段进度条用于"细粒度工具调用阶段"（intent → skills → local_data → external_data → research → answer）
