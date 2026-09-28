# P32 稳智对齐：折叠侧栏按钮

> 稳智对齐 P3 #17：侧栏品牌区加折叠按钮（稳智 nav-header 位置）
>
> 日期：2026-09-23
> 作者：小张
> 状态：✅ 完成（9/9 新钉测通过，全量 1283/1293 pass，next build ✅）

---

## 1. 稳智逆向依据

稳智 AI 侧栏有折叠按钮（`wenzhi-deep-comparison.md` §1.1 表格）：

```
| 折叠侧栏按钮 | 有（nav-header 位置） | 无 | ❌ 缺折叠按钮 |
```

**本仓库现状（P32 前）**：
- TopBar 有折叠按钮（PanelLeftClose 图标）
- Sidebar 品牌区没有折叠按钮
- 稳智的折叠按钮在侧栏 nav-header 位置，不在 TopBar

**P32 目标**：在 Sidebar 品牌区加折叠按钮（稳智 nav-header 位置），点击后折叠侧栏。

---

## 2. 改动清单

### 2.1 `src/components/desk/Sidebar.tsx`

**导入 PanelLeftClose 图标**：

```typescript
import { ..., PanelLeftClose, ... } from "lucide-react";
```

**引入 toggleSidebar action**：

```typescript
const toggleSidebar = useDesk((s) => s.toggleSidebar);
```

**品牌区改为 flex justify-between（左品牌右按钮）**：

```tsx
<div className="flex items-center justify-between px-5 pb-5 pt-6">
  <div className="flex items-center gap-3">
    {/* 品牌区（Logo + 名称） */}
    ...
  </div>
  {/* P32 稳智对齐 P3 #17：折叠侧栏按钮（稳智 nav-header 位置） */}
  <button
    onClick={toggleSidebar}
    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground"
    title="折叠侧栏"
  >
    <PanelLeftClose size={16} />
  </button>
</div>
```

---

## 3. 测试覆盖

`tests/quant/p32-sidebar-toggle.test.ts`（9 条新钉测）：

### store 层（3 条）
- sidebarCollapsed 初始为 false
- toggleSidebar 切换 sidebarCollapsed
- persist partialize 包含 sidebarCollapsed

### Sidebar 组件（5 条）
- 导入 PanelLeftClose 图标
- 调用了 toggleSidebar（useDesk + onClick 绑定）
- 有折叠按钮（title='折叠侧栏'）
- 品牌区是 flex justify-between（左品牌右按钮）
- TopBar 也有折叠按钮（原有，P32 不改）

### AppShell（1 条）
- 用 collapsed 控制侧栏显示（!collapsed && <Sidebar />）

---

## 4. 验证

- `npx tsc --noEmit` ✅ 通过
- `npx tsx --test tests/quant/p32-sidebar-toggle.test.ts` ✅ 9/9 pass
- `npx tsx --test tests/quant/*.test.ts` ✅ 1283/1293 pass（1 fail 是 p2-archive-db CJS 老问题，本轮之前就跳过）
- `npx next build` ✅ 通过

---

## 5. 不动地基确认

- ✅ 不改 AppShell（只改 Sidebar）
- ✅ 不改 types
- ✅ 不改 store（toggleSidebar 已存在，只调用）
- ✅ 不改后端路由
- ✅ 不改 StepTimeline.tsx
- ✅ 不改 STREAM_EVENT_TYPES
- ✅ TopBar 的折叠按钮不动（原有，P32 不改）

---

## 6. 与稳智的差异

| 项 | 稳智 | 本仓库（P32） |
|----|------|--------------|
| 折叠按钮位置 | nav-header（侧栏顶部） | 侧栏品牌区右侧 + TopBar 左侧 |
| 折叠效果 | 折叠成图标栏（保留 icon 列） | 完全隐藏侧栏 |
| 双按钮 | 只有侧栏一个 | 侧栏 + TopBar 两个入口 |

---

## 7. 稳智对齐 P3 完成度

| # | 项 | 状态 |
|---|---|------|
| #15 | 图片多模态 | ⏳ 待做 |
| #16 | 调试视图 3 perf-block | ⏳ 待做 |
| #17 | 折叠侧栏按钮 | ✅ **P32** |
| #18 | 钱包占位 | ⏳ 待做 |
| #19 | 任务过期时间 | ✅ P31（P2 #14 顺带完成） |

P3 剩余 3 项：#15 图片多模态、#16 调试视图 3 perf-block、#18 钱包占位。
