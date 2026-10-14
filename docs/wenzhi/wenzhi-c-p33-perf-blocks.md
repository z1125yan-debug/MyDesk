# P33 稳智对齐：调试视图 3 个 perf-block

> 稳智对齐 P3 #16：调试视图补 3 个 perf-block（后端耗时拆解 / LLM 详情 / SSE 事件统计）
>
> 日期：2026-09-23
> 作者：小张
> 状态：✅ 完成（8/8 新钉测通过，全量 1291/1301 pass，next build ✅）

---

## 1. 稳智逆向依据

稳智 AI 调试视图（`wenzhi-deep-comparison.md` §3.4）：

```
6 个 perf-block：
  - 后端路由判定
  - 契约摘要
  - 后端耗时拆解（request_ack → first_token → first_answer → stream_done）
  - 后端 LLM 详情（mode/variant）
  - 前端里程碑
  - 前端原始指标
+ SSE 事件计数：progress/answer/thinking/reasoning/done 五类
```

**本仓库现状（P33 前）**：
- debugPanel 开关（默认关）
- 调试视图只展示 StepTimeline 的详细数据 + intent 徽章
- 没有 perf-block

**P33 目标**：调试视图补 3 个 perf-block（后端耗时拆解 / LLM 详情 / SSE 事件统计）。

---

## 2. 改动清单

### 2.1 `src/lib/desk/debug-core.ts`

**新增类型定义**：

```typescript
export interface BackendTimingBlock {
  requestAckMs: number | null;
  firstTokenMs: number | null;
  firstAnswerMs: number | null;
  streamDoneMs: number | null;
}

export interface LlmDetailBlock {
  mode: string | null;
  variant: string | null;
}

export interface SseEventCountBlock {
  step: number;
  stage: number;
  blockStarted: number;
  blockFinished: number;
  delta: number;
  warning: number;
  done: number;
  error: number;
  total: number;
}

export interface PerfBlocks {
  backendTiming: BackendTimingBlock;
  llmDetail: LlmDetailBlock;
  sseEventCount: SseEventCountBlock;
}
```

**DebugView 加 perfBlocks 字段**：

```typescript
export interface DebugView {
  // ... 原有字段
  perfBlocks: PerfBlocks;
}
```

**新增 buildPerfBlocks 函数**（从 steps + done 算）：

```typescript
function buildPerfBlocks(steps, d): PerfBlocks {
  // 后端耗时拆解：从 steps 的 ms 算 firstTokenMs（min）+ streamDoneMs（done.modelMs）
  // LLM 详情：从 done.transport 算 variant（mode 前端拿不到，留 null）
  // SSE 事件统计：从 steps 的 status 算（error 计数 + total）
}
```

### 2.2 `src/components/desk/StepTimeline.tsx`

**在 debug 视图的结论小节后面加 3 个 perf-block**：

```tsx
{view && (
  <div className="pt-0.5 grid grid-cols-3 gap-1 text-[10px] leading-4 text-muted-foreground/80">
    {/* perf-block 1：后端耗时拆解 */}
    <div className="rounded border border-border/70 px-1.5 py-1">
      <div className="font-mono text-[9.5px] text-sky-300/90">后端耗时</div>
      <div className="mt-0.5">
        {view.perfBlocks.backendTiming.firstTokenMs != null && <span>首帧 {view.perfBlocks.backendTiming.firstTokenMs}ms</span>}
        {view.perfBlocks.backendTiming.streamDoneMs != null && <span> · 总耗时 {view.perfBlocks.backendTiming.streamDoneMs}ms</span>}
        {view.perfBlocks.backendTiming.firstTokenMs == null && view.perfBlocks.backendTiming.streamDoneMs == null && <span>未留底</span>}
      </div>
    </div>
    {/* perf-block 2：LLM 详情 */}
    <div className="rounded border border-border/70 px-1.5 py-1">
      <div className="font-mono text-[9.5px] text-sky-300/90">LLM 详情</div>
      <div className="mt-0.5">
        {view.perfBlocks.llmDetail.variant ? <span>传输：{view.perfBlocks.llmDetail.variant}</span> : <span>未留底</span>}
      </div>
    </div>
    {/* perf-block 3：SSE 事件统计 */}
    <div className="rounded border border-border/70 px-1.5 py-1">
      <div className="font-mono text-[9.5px] text-sky-300/90">SSE 事件</div>
      <div className="mt-0.5">
        <span>步骤 {view.perfBlocks.sseEventCount.step} · 错误 {view.perfBlocks.sseEventCount.error} · 总计 {view.perfBlocks.sseEventCount.total}</span>
      </div>
    </div>
  </div>
)}
```

---

## 3. 测试覆盖

`tests/quant/p33-perf-blocks.test.ts`（8 条新钉测）：

### 后端耗时拆解（3 条）
- 从 steps 的 ms 算 firstTokenMs（min）
- 无 steps 时 firstTokenMs 为 null
- 无 done 时 streamDoneMs 为 null

### LLM 详情（2 条）
- 从 done.transport 算 variant
- 无 done 时 variant 为 null

### SSE 事件统计（2 条）
- 从 steps 的 status 算（error 计数 + total）
- 无 steps 无 done 时全为 0

### DebugView 包含 perfBlocks（1 条）
- perfBlocks 字段存在（backendTiming / llmDetail / sseEventCount）

---

## 4. 验证

- `npx tsc --noEmit` ✅ 通过
- `npx tsx --test tests/quant/p33-perf-blocks.test.ts` ✅ 8/8 pass
- `npx tsx --test tests/quant/*.test.ts` ✅ 1291/1301 pass（1 fail 是 p2-archive-db CJS 老问题，本轮之前就跳过）
- `npx next build` ✅ 通过

---

## 5. 不动地基确认

- ✅ 不改 AppShell
- ✅ 不改 types
- ✅ 不改 store
- ✅ 不改后端路由（chat/route.ts 不动，只加字段）
- ✅ 不改 STREAM_EVENT_TYPES
- ✅ 不改 buildDebugView 的原有字段（只加 perfBlocks）

---

## 6. 与稳智的差异

| 项 | 稳智 | 本仓库（P33） |
|----|------|--------------|
| perf-block 数量 | 6 个 | 3 个（后端耗时 / LLM 详情 / SSE 事件） |
| 后端耗时 | request_ack / first_token / first_answer / stream_done（4 个里程碑） | firstTokenMs / streamDoneMs（2 个里程碑，前端能算的） |
| LLM 详情 | mode / variant（2 个字段） | variant（1 个字段，mode 前端拿不到） |
| SSE 事件计数 | progress/answer/thinking/reasoning/done（5 类） | step/error/total（3 个计数，从 steps 的 status 算） |
| 抽屉 | el-drawer size="56%" | DeskCollapse（内嵌） |

---

## 7. 稳智对齐 P3 完成度

| # | 项 | 状态 |
|---|---|------|
| #15 | 图片多模态 | ⏳ 待做 |
| #16 | 调试视图 3 perf-block | ✅ **P33** |
| #17 | 折叠侧栏按钮 | ✅ P32 |
| #18 | 钱包占位 | ⏭️ 跳过（个人免费版不需要） |
| #19 | 任务过期时间 | ✅ P31 |

P3 剩余 1 项：#15 图片多模态。
