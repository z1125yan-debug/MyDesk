# P22 StepTimeline 步骤按 6 阶段分组渲染

## 对齐目标

稳智对齐 P1 #5：稳智 StepTimeline 把步骤**按 6 阶段分组**渲染，每组带阶段标题行（emoji + 中文名 + 该组步骤计数），下面挂该组的步骤；空阶段跳过。

本仓库原实现：StepTimeline 把 steps 平铺渲染成一列，用户看到的是"步1、步2、步3..."的流水账，看不出这是行情还是新闻、是回测还是筛选。6 阶段进度条虽然在上方画了（P18 加的），但下方步骤行还是平铺。

## 改动分两块

### 1. `src/lib/desk/agent-phases-core.ts`

- `classifyStep` 从内部函数改成 `export function`——单一映射规则两处消费（`deriveAgentPhases` 内部聚合 + `StepTimeline` 分组渲染），不重造。
- 新增 `groupStepsByPhase(steps) → Record<PhaseKey, StepInfo[]>`：把 steps 按 `classifyStep` 的语义映射分到 6 个桶里，保序。分组口径完全复用 `classifyStep`（quote/行情→local_data；news/新闻→external_data；回测/筛选/因子→research；无关键词命中兜底 local_data）。
- intent/skills/answer 三阶段永远空数组——步骤行只可能来自后三阶段（intent 靠徽章字段、skills 靠 steps 存在判定、answer 靠消息流，都不是"步骤行"）。调用方按空数组跳过。

### 2. `src/components/desk/StepTimeline.tsx`

- 把原来 `{steps?.map((s) => ...)}` 平铺渲染换成 `{(() => { const groups = groupStepsByPhase(steps); return AGENT_PHASES.map((ph) => {...}) })()}` 分组渲染。
- 每组画一个阶段标题行：`emoji + 中文名 + N 步计数 + 阶段状态符号`（●active/⚠error/✓done，从 `deriveAgentPhases` 结果里查）。
- 组内步骤保留原渲染：步号、系统预取/模型自取徽、第 N 轮徽、label、状态文字、ms、reason、detail、调试入参/摘要——只外包一层组。
- 空阶段跳过（`if (groupSteps.length === 0) return null;`）；intent/skills/answer 三阶段永远空，不硬凑空标题行。

## 为什么不直接做快照

React 组件依赖 jsdom + lucide + radix，钉测成本远高于收益。所以分组口径抽成 `groupStepsByPhase` 纯核函数，StepTimeline 只做排版，测试只打纯核。

## 钉测（`tests/quant/p22-steps-grouped.test.ts`，9 条）

1. `classifyStep` 已导出且按工具/label 语义分类（quote/RSI→local_data，news/公告→external_data，回测/筛选→research）
2. `classifyStep` 兜底归 local_data（无关键词命中）
3. `classifyStep` 优先级：local_data > external_data > research
4. `groupStepsByPhase` 只把属于该阶段的步骤分到该阶段
5. `groupStepsByPhase` 保留原始顺序
6. `groupStepsByPhase` 空输入返回全空数组
7. `AGENT_PHASES` 顺序钉死（= 稳智 label 映射数组顺序）
8. `PhaseKey` 类型覆盖 6 阶段（防未来加阶段时忘改 StepTimeline 分支）
9. 分组结果与 `deriveAgentPhases` 的阶段集合一致（不重复分类、不遗漏）

## 验证

- `npx tsc --noEmit` → 0 错
- `npx tsx --test tests/quant/p22-steps-grouped.test.ts` → 9/9 pass
- `npx tsx --test tests/quant/*.test.ts` → 1169 tests / 1159 pass / 1 fail（`p2-archive-db.test.ts` 是 tsx 对 CJS 输出格式不支持 top-level await 的老问题，与本轮无关）
- `npx next build` → 通过

## 影响面

- **只改 StepTimeline 组件**：AI 首页、智能助手页、右下角随问小窗三处共享同一组件，改动一处三处生效。
- **不改 SSE 契约**：分组是纯前端语义分组，后端不感知，无需新增事件类型。
- **不动 P18 6 阶段进度条**：进度条还在上方画（一横排 6 个圆点 + 中文名），本轮只是把下方步骤行也按同 6 阶段分组，两边阶段状态保持一致（都用 `deriveAgentPhases` + `groupStepsByPhase`）。
- **不硬凑空组**：intent/skills/answer 三阶段永远空，不画标题行；用户看到的最多是 3 个非空分组（local_data / external_data / research）。
