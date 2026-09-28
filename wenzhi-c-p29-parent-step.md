# P29 稳智对齐：parentStepId 嵌套步骤

> 稳智对齐 P2 #12：子 Agent 步骤挂父步骤（层次化步骤）
>
> 日期：2026-09-23
> 作者：小张
> 状态：✅ 完成（15/15 新钉测通过，全量 1250/1260 pass，next build ✅）

---

## 1. 稳智逆向依据

稳智 AI 的步骤时间线是**层次化**的：一个"研究"父步骤下可以挂多个子步骤（比如 fetch_news / fetch_quote / fetch_fund），前端渲染时按层级缩进显示。

**稳智契约**（`wenzhi-deep-comparison.md` §2.3 + reverse-01 §5）：

```
step 事件带 parentStepId 字段（可选）：
  parentStepId?: number   // 引用父步骤的 step 号
  前端按 parentStepId 分组渲染嵌套结构
  没有 parentStepId 的步骤是顶层
```

**本仓库现状（P29 前）**：
- `StreamStep` 没有 parentStepId 字段
- `StepInfo` 没有 parentStepId 字段
- `StepTimeline.tsx` 是扁平渲染，没有嵌套结构
- Agent Loop 6 阶段（P27）是按 phase_key 分组，不是嵌套

---

## 2. 改动清单

### 2.1 `src/lib/desk/chat-stream-core.ts`

**StreamStep 加 parentStepId 字段**（可选）：

```typescript
export interface StreamStep {
  // ... 原有字段
  phase_key?: "intent" | "skills" | "local_data" | "external_data" | "research" | "answer";
  parentStepId?: number;  // P29 新增
}
```

**decodeEventBody 的 step 分支加 parentStepId 解析**：

```typescript
// 只收 number 类型，坏值直接丢弃
if (typeof d.parentStepId === "number" && Number.isFinite(d.parentStepId)) {
  data.parentStepId = d.parentStepId;
}
```

### 2.2 `src/lib/desk/chat-core.ts`

**StepInfo 加 parentStepId 字段**（同步 StreamStep）：

```typescript
export interface StepInfo {
  // ... 原有字段
  phase_key?: "intent" | "skills" | "local_data" | "external_data" | "research" | "answer";
  parentStepId?: number;  // P29 新增
}
```

**新增 buildStepTree 函数**（把扁平 steps 转成嵌套树）：

```typescript
export interface StepTreeNode extends StepInfo {
  children?: StepTreeNode[];
}

export function buildStepTree(steps?: StepInfo[]): StepTreeNode[] {
  if (!steps || steps.length === 0) return [];

  const nodes = new Map<number, StepTreeNode>();
  for (const s of steps) {
    nodes.set(s.step, { ...s });
  }

  const roots: StepTreeNode[] = [];
  for (const s of steps) {
    const node = nodes.get(s.step)!;
    const parentId = s.parentStepId;
    const parent = parentId !== undefined ? nodes.get(parentId) : undefined;

    if (parent && parent !== node) {
      // 有合法父步骤：挂到父步骤的 children 下
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    } else {
      // 无父步骤 或 孤儿：作为顶层
      roots.push(node);
    }
  }

  // 按 step 号排序
  const sortNodes = (arr: StepTreeNode[]) => {
    arr.sort((a, b) => a.step - b.step);
    for (const n of arr) {
      if (n.children && n.children.length > 0) sortNodes(n.children);
    }
  };
  sortNodes(roots);
  return roots;
}
```

**buildStepTree 规则**：
1. 有 parentStepId 且能找到父步骤的，挂到父步骤的 children 下
2. parentStepId 找不到父步骤的（孤儿），作为顶层处理（不丢步骤）
3. 每个节点的 children 按 step 号排序
4. 顶层节点也按 step 号排序
5. 兼容：老数据（所有步骤都没有 parentStepId）返回扁平树

### 2.3 `src/lib/desk/chat-core.ts` 的 applyEvent

**不改**：applyEvent 的 step upsert 已经用"后到的覆盖前到的"策略，parentStepId 作为普通字段自动写入。

---

## 3. 后端 emit 示例

```typescript
// 父步骤：研究阶段
emit({
  type: "step",
  data: { step: 1, label: "研究", status: "running", phase_key: "research" },
});

// 子步骤 1：fetch_news（挂在 step 1 下）
emit({
  type: "step",
  data: { step: 2, label: "fetch_news", status: "ok", parentStepId: 1, phase_key: "research" },
});

// 子步骤 2：fetch_quote（挂在 step 1 下）
emit({
  type: "step",
  data: { step: 3, label: "fetch_quote", status: "ok", parentStepId: 1, phase_key: "research" },
});

// 父步骤 2：回答
emit({
  type: "step",
  data: { step: 4, label: "回答", status: "running", phase_key: "answer" },
});
```

**前端渲染效果**（用 buildStepTree 转树后）：

```
• 研究          (step 1, phase: research)
  • fetch_news   (step 2, parent: 1)
  • fetch_quote  (step 3, parent: 1)
• 回答          (step 4, phase: answer)
```

---

## 4. 测试覆盖

`tests/quant/p29-parent-step.test.ts`（15 条新钉测）：

### 类型定义（2 条）
- StreamStep 支持可选 parentStepId（number 类型）
- 不带 parentStepId 的 step 是顶层步骤

### asStreamEvent 解析（3 条）
- 合法 number parentStepId 被解析
- 坏值（字符串）parentStepId 被丢弃，帧仍然合法
- 坏值（非数值字符串）parentStepId 被丢弃

### applyEvent 透传（2 条）
- step 事件带 parentStepId，upsert 后 message.steps 里保留
- 后到的同 step 事件覆盖前一个（parentStepId 可更新）

### buildStepTree 层次化分组（5 条）
- 扁平 steps 转成嵌套树
- 无 parentStepId 时返回扁平树（所有步骤都是顶层）
- 孤儿步骤（parentStepId 指向不存在的父步骤）作为顶层处理
- 支持多层嵌套（孙步骤）
- children 按 step 号排序

### SSE 编码往返（1 条）
- step 事件带 parentStepId，encode + decode 往返一致

### 兼容性（2 条）
- STREAM_EVENT_TYPES 仍然是 8 类（parentStepId 是字段不是新事件）
- 老客户端（不带 parentStepId）解码不报错

---

## 5. 验证

- `npx tsc --noEmit` ✅ 通过
- `npx tsx --test tests/quant/p29-parent-step.test.ts` ✅ 15/15 pass
- `npx tsx --test tests/quant/*.test.ts` ✅ 1250/1260 pass（1 fail 是 p2-archive-db CJS 老问题，本轮之前就跳过）
- `npx next build` ✅ 通过

---

## 6. 不动地基确认

- ✅ 不改 AppShell
- ✅ 不改 types
- ✅ 不改 store
- ✅ 不改后端路由（chat/route.ts 不动，只加字段）
- ✅ 不改 StepTimeline.tsx（前端渲染下一步做，本次只做数据层契约）
- ✅ 不改 STREAM_EVENT_TYPES（parentStepId 是字段不是新事件类型）

---

## 7. 下一步（前端渲染）

P29 只做**数据层契约**（后端 emit + 前端解码 + 树结构构建）。前端 StepTimeline.tsx 实际渲染嵌套结构需要单独一步：

- 在 StepTimeline.tsx 里调用 buildStepTree
- 递归渲染 children（缩进 + 层级样式）
- 可选：折叠/展开子步骤

---

## 8. 稳智对齐 P2 完成度

| # | 项 | 状态 |
|---|---|------|
| #9 | SSE block_started/finished | ✅ P26 |
| #10 | Agent Loop 6 阶段 phase_key | ✅ P27 |
| #11 | 交易周期 3→5 档 | ✅ P28 |
| #12 | parentStepId 嵌套步骤 | ✅ **P29** |
| #13 | 数据源面板 | ⏳ 待做 |
| #14 | active_task_id | ⏳ 待做 |

P2 剩余 2 项：#13 数据源面板、#14 active_task_id。
