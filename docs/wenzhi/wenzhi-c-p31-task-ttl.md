# P31 稳智对齐：active_task_id 状态 + 任务过期时间（TTL 15 分钟）

> 稳智对齐 P2 #14：刷新后重新连 SSE + 任务过期时间机制
>
> 日期：2026-09-23
> 作者：小张
> 状态：✅ 完成（10/10 新钉测通过，全量 1274/1284 pass，next build ✅）

---

## 1. 稳智逆向依据

稳智 AI 有 `ai_matrix_active_task_v1` 状态（`wenzhi-deep-comparison.md` §2.7）：

```
ai_matrix_active_task_v1         → 当前正在流式的 task_id（刷新后恢复）
ai_matrix_active_task_view_v1    → 当前 flow snapshot（切路由再回来不丢）
9e5 (15min)                      → 任务过期时间
```

**本仓库现状（P31 前）**：
- 有 `runRef` 机制（消息级续传锚）+ `resumePendingDrafts`（刷新后扫所有会话续传）
- 有 `activeRunRef`（hook 级，本轮留底 id）
- **没有任务过期时间**——runRef 永不过期，刷新后一直尝试续传

**差距**：
- 稳智有 **task_id 过期时间**（15 分钟）
- 本仓库**没有过期机制**

**P31 目标**：加 `active_task_id` 状态（runRef 加 createdAt）+ 任务过期时间（TTL 15 分钟），刷新后扫会话时检查过期并清掉。

---

## 2. 改动清单

### 2.1 `src/lib/desk/chat-core.ts`

**runRef 加 createdAt 字段**（可选）：

```typescript
runRef?: { id: string; lastSeq: number; createdAt?: number };
```

### 2.2 `src/lib/desk/use-chat.ts`

**新增 TASK_TTL_MS 常量**（15 分钟）：

```typescript
export const TASK_TTL_MS = 15 * 60 * 1000;
```

**新增 isRunRefExpired 函数**（过期判定）：

```typescript
export function isRunRefExpired(ref: { createdAt?: number } | undefined, now: number = Date.now()): boolean {
  if (ref?.createdAt == null) return false; // 老存档无 createdAt，不判过期
  return now - ref.createdAt > TASK_TTL_MS;
}
```

**send 函数里 runRef 加 createdAt**：

```typescript
const runPatch =
  ev.type === "done" || ev.type === "error"
    ? { runRef: undefined }
    : typeof ev.seq === "number"
      ? { runRef: { id: runId, lastSeq: resumeSince, createdAt: cur.runRef?.createdAt ?? Date.now() } }
      : null;
```

**resumeRound 里 runRef 保留原 createdAt**：

```typescript
runRef: closed ? undefined : { id: run, lastSeq, createdAt: msg.runRef?.createdAt },
```

**resumePendingDrafts 加过期检查**：

```typescript
if (isRunRefExpired(ref, now)) {
  // 过期：清掉 runRef + 结算 running 步骤 + 补一条 warning
  const next = settleRunningSteps({ ...m, streaming: false, runRef: undefined });
  useDesk.getState().patchChatMessage(s.id, m.id, {
    content: next.content || "（本轮分析已过期，保留断点前内容；不自动重问。）",
    steps: next.steps,
    warning: joinWarnings([next.warning, "本轮分析已过期（超过 15 分钟未续传），保留断点前内容，不自动重问。"]),
    streaming: false,
    runRef: undefined,
  });
  continue;
}
```

---

## 3. 测试覆盖

`tests/quant/p31-task-ttl.test.ts`（10 条新钉测）：

### 常量（1 条）
- TASK_TTL_MS = 15 分钟（900000ms）

### isRunRefExpired 过期判定（6 条）
- 未过期返回 false（10 分钟前）
- 刚好过期边界返回 true（超过 15 分钟 1ms）
- 刚好未过期边界返回 false（未超过 15 分钟）
- 已过期返回 true（20 分钟前）
- createdAt 缺失返回 false（向后兼容老存档）
- createdAt 为 0 返回 true（1970 年，已过很久）

### runRef 类型（2 条）
- ChatMessage.runRef 支持 createdAt 字段
- ChatMessage.runRef 不强制 createdAt（向后兼容）

### 过期时清掉 runRef（1 条）
- settleRunningSteps 把 running 步骤结算为 error

### 更新既有测试（1 处）
- `tests/quant/p8-run-resume.test.ts` 更新 runRef 断言（加 createdAt 字段）

---

## 4. 验证

- `npx tsc --noEmit` ✅ 通过
- `npx tsx --test tests/quant/p31-task-ttl.test.ts` ✅ 10/10 pass
- `npx tsx --test tests/quant/*.test.ts` ✅ 1274/1284 pass（1 fail 是 p2-archive-db CJS 老问题，本轮之前就跳过）
- `npx next build` ✅ 通过

---

## 5. 不动地基确认

- ✅ 不改 AppShell
- ✅ 不改 types
- ✅ 不改 store（runRef 随消息进存档，store 不用改）
- ✅ 不改后端路由（chat/route.ts 不动，只加字段）
- ✅ 不改 StepTimeline.tsx
- ✅ 不改 STREAM_EVENT_TYPES
- ✅ 不改 runRef 的语义（只加 createdAt 字段，向后兼容）

---

## 6. 与稳智的差异

| 项 | 稳智 | 本仓库（P31） |
|----|------|--------------|
| 存储 | sessionStorage + localStorage | zustand persist 到 localStorage |
| key | ai_matrix_active_task_v1 | runRef（随消息进存档） |
| 过期时间 | 15 分钟 | 15 分钟（TASK_TTL_MS） |
| 过期处理 | 未知（扒不到实现） | 清掉 runRef + 结算 running 步骤 + 补 warning |
| 多环境隔离 | :storageScope 后缀 | 无（本仓库单环境） |

---

## 7. 稳智对齐 P2 完成度

| # | 项 | 状态 |
|---|---|------|
| #9 | SSE block_started/finished | ✅ P26 |
| #10 | Agent Loop 6 阶段 phase_key | ✅ P27 |
| #11 | 交易周期 3→5 档 | ✅ P28 |
| #12 | parentStepId 嵌套步骤 | ✅ P29 |
| #13 | 数据源面板 | ✅ P30 |
| #14 | active_task_id 状态 | ✅ **P31** |

**P2 全部完成**（6 项：#9 #10 #11 #12 #13 #14 全绿）。

剩余 P3 可选 5 项：#15 图片多模态、#16 调试视图 3 perf-block、#17 折叠侧栏、#18 钱包占位、#19 任务过期（P31 已覆盖）。
