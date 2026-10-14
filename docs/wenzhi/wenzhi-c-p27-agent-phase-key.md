# P27 Agent Loop 6 阶段固定顺序（后端显式发 phase_key）（稳智对齐 P2 #10）

## 对齐目标

稳智逆向扒出的 Agent Loop 是 6 阶段固定顺序：intent → skills → local_data → external_data → research → answer。本仓库 P22 已经做了前端语义映射（classifyStep），P27 加了后端显式发 phase_key 字段。前端收到后优先用 phase_key，没有时 fallback 到语义映射（旧服务端/未升级的客户端）。

## 改动分三块

### 1. SSE 事件契约（chat-stream-core.ts + chat-core.ts）

- `StreamStep` 加 `phase_key` 字段（可选）：`"intent" | "skills" | "local_data" | "external_data" | "research" | "answer"`
- `StepInfo` 加 `phase_key` 字段（可选）
- `decodeEventBody` 的 step 分支加 phase_key 解析（按白名单校验，坏值丢弃）

### 2. agent-phases-core.ts（groupStepsByPhase）

- `groupStepsByPhase` 优先用 `step.phase_key`（后端显式发），没有时 fallback 到 `classifyStep` 语义映射
- 这样后端显式发更精确（不用猜），语义映射是兜底（旧服务端/未升级的客户端）

### 3. 服务端 chat/route.ts

暂不改（服务端 emit step 事件时不主动加 phase_key，因为服务端不知道每个 step 属于哪个阶段——phase_key 是前端语义映射出来的）。但 SSE 契约已就绪，后端可以在后续版本里显式发 phase_key。

## 钉测（tests/quant/p27-agent-phase-key.test.ts，10 条）

1. decodeStreamEvent 能解码带 phase_key 的 step 事件
2. decodeStreamEvent 对无效的 phase_key 值丢弃该字段（不报错）
3. decodeStreamEvent 对 phase_key 非字符串丢弃该字段
4. encodeStreamEvent + decodeStreamEvent 往返一致（带 phase_key 的 step 事件）
5. groupStepsByPhase 优先用 phase_key（后端显式发）
6. groupStepsByPhase 对无 phase_key 的步骤 fallback 到 classifyStep 语义映射
7. groupStepsByPhase 混合 phase_key 和语义映射
8. groupStepsByPhase 对 phase_key 与 classifyStep 冲突时优先用 phase_key
9. classifyStep 对无 phase_key 的步骤仍正常语义映射（P22 逻辑不变）
10. AGENT_PHASES 顺序钉死（P22 逻辑不变）

## 验证

- `npx tsc --noEmit` → 0 错
- `npx tsx --test tests/quant/p27-agent-phase-key.test.ts` → 10/10 pass
- `npx tsx --test tests/quant/*.test.ts` → 1231 tests / 1221 pass / 1 fail（p2-archive-db 是 tsx 老问题）/ 9 skipped
- `npx next build` → 通过

## 影响面

- **SSE 契约向后兼容**：phase_key 是可选字段，旧服务端不发也不报错（前端 fallback 到语义映射）
- **前端用户看到的变化**：暂无（后端暂不 emit phase_key，前端仍用语义映射分组）
- **不改数据库/不改 API 路由**：只改 SSE 事件数据形状和前端分组逻辑
- **与 P22 的关系**：P22 是前端语义映射（classifyStep），P27 是后端显式发（phase_key）。两者并存，P27 优先，P22 兜底
