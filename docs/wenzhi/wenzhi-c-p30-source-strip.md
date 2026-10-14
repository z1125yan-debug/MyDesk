# P30 稳智对齐：数据源面板（已核验来源，按类型分组）

> 稳智对齐 P2 #13：答案末尾的「已核验的信息来源」面板（可折叠）
>
> 日期：2026-09-23
> 作者：小张
> 状态：✅ 完成（14/14 新钉测通过，全量 1264/1274 pass，next build ✅）

---

## 1. 稳智逆向依据

稳智 AI 的答案末尾有 `AiMatrixAssistantSourceStrip` 组件（`wenzhi-deep-comparison.md` §3.3）：

```
- 可折叠引用源面板
- 按类型过滤：公告 / 新闻 / 实时行情 / 其他
- 按来源分组 + 展开/折叠
- 每条来源带外链（新 tab 打开）
```

**本仓库差异**：
- 无外链（内部工具调用的结果不来自外部 URL，只来自后端工具层）
- 分类扩展到 5 类：news / quote / kline / fund / other

**P30 目标**：加"已核验的信息来源"面板（可折叠），把本轮 `StepTimeline.steps` 里的工具调用按类型分组展示。

---

## 2. 改动清单

### 2.1 `src/lib/desk/source-groups-core.ts`（新增）

核心逻辑，方便单元测试独立验证：

```typescript
export type SourceGroupKey = "news" | "quote" | "kline" | "fund" | "other";

export function classifyStep(tool: string | undefined): SourceGroupKey {
  if (!tool) return "other";
  if (NEWS_TOOLS.has(tool)) return "news";
  if (QUOTE_TOOLS.has(tool)) return "quote";
  if (KLINE_TOOLS.has(tool)) return "kline";
  if (FUND_TOOLS.has(tool)) return "fund";
  return "other";
}

export function groupStepsBySource(steps?: StepInfo[]): Record<SourceGroupKey, StepInfo[]> {
  // 只显示已核验的状态（ok/missing/stale），跳过 running/error
  // 不认识的 tool 归 other
}
```

**分类映射**：

| 分类 | tool 名 |
|------|---------|
| news（新闻与公告） | stock_news, market_news |
| quote（实时行情） | stock_snapshot, tdx_quotes, stock_depth, stock_trades, tdx_market_overview |
| kline（K 线与周期） | stock_kline_summary, tdx_kline |
| fund（资金与情绪） | stock_fund_flow, market_sentiment, historical_probability |
| other（其他） | sector_rank, candidate_pool, factor_screener, run_backtest, watchlist_overview 等 |

### 2.2 `src/components/desk/SourceStrip.tsx`（新增）

组件本体：

- 顶部标题栏：🔵 已核验的信息来源 · N 项（可折叠）
- 按 5 类分组渲染（news → quote → kline → fund → other），每组可独立展开/折叠
- 每组有 emoji + 中文名 + 计数 + 展开/折叠按钮
- 每条步骤：状态图标（✓ ok / ○ missing / ⚠ stale）+ label + 耗时（ms）
- 空面板（total === 0）返回 null

### 2.3 `src/components/desk/pages/AssistantPage.tsx`

在 StepTimeline 之后挂 SourceStrip：

```tsx
<StepTimeline ... />
<SourceStrip steps={m.steps} />
<ChatBacktestCards steps={m.steps} />
```

---

## 3. 使用效果

**渲染效果**（假设 steps 有 6 个 ok 状态的工具调用）：

```
🔵 已核验的信息来源 · 6 项                    ▼
┌─ 📰 新闻与公告 (2) ─┐
│ ✓ 取个股新闻 · 120ms
│ ✓ 取最新快讯 · 85ms
└─────────────────────────┘
┌─ 📈 实时行情 (2) ──┐
│ ✓ 取通达信实时行情 · 45ms
│ ✓ 取五档盘口 · 32ms
└─────────────────────────┘
┌─ 🕯️ K 线与周期 (1) ─┐
│ ✓ 取日 K 并计算技术状态 · 210ms
└─────────────────────────┘
┌─ 💰 资金与情绪 (1) ─┐
│ ✓ 取近 14 日主力资金流 · 95ms
└─────────────────────────┘
```

---

## 4. 测试覆盖

`tests/quant/p30-source-strip.test.ts`（14 条新钉测）：

### classifyStep（7 条）
- news 类工具归类正确（stock_news / market_news）
- quote 类工具归类正确（stock_snapshot / tdx_quotes / stock_depth / stock_trades / tdx_market_overview）
- kline 类工具归类正确（stock_kline_summary / tdx_kline）
- fund 类工具归类正确（stock_fund_flow / market_sentiment / historical_probability）
- 其他工具归 other（sector_rank / candidate_pool / factor_screener / run_backtest / watchlist_overview）
- undefined 或空工具归 other
- 未知工具归 other

### groupStepsBySource（7 条）
- 空 steps 返回空分组
- 空数组返回空分组
- 只收 ok/missing/stale 状态，跳过 running/error
- 多工具跨分类正确分组
- 无 tool 字段的步骤归 other
- 全 running 时所有分类为空
- 保留原步骤字段（label/ms/detail 等）

---

## 5. 验证

- `npx tsc --noEmit` ✅ 通过
- `npx tsx --test tests/quant/p30-source-strip.test.ts` ✅ 14/14 pass
- `npx tsx --test tests/quant/*.test.ts` ✅ 1264/1274 pass（1 fail 是 p2-archive-db CJS 老问题，本轮之前就跳过）
- `npx next build` ✅ 通过

---

## 6. 不动地基确认

- ✅ 不改 AppShell
- ✅ 不改 types
- ✅ 不改 store
- ✅ 不改后端路由（chat/route.ts 不动）
- ✅ 不改 StepTimeline.tsx（SourceStrip 是独立组件，挂在它后面）
- ✅ 不改 STREAM_EVENT_TYPES
- ✅ 不改 source-groups 之外的分类逻辑（核心逻辑抽到 source-groups-core.ts，组件只用它）

---

## 7. 与稳智的差异

| 项 | 稳智 | 本仓库（P30） |
|----|------|--------------|
| 分类 | 4 类（公告/新闻/行情/其他） | 5 类（news/quote/kline/fund/other） |
| 外链 | 每条来源带外链（新 tab 打开） | 无外链（内部工具调用，不来自外部 URL） |
| 面板位置 | 答案末尾独立区块 | StepTimeline 之后 |
| 可折叠 | 主面板 + 每个分组都可折叠 | 主面板 + 每个分组都可折叠 |

---

## 8. 稳智对齐 P2 完成度

| # | 项 | 状态 |
|---|---|------|
| #9 | SSE block_started/finished | ✅ P26 |
| #10 | Agent Loop 6 阶段 phase_key | ✅ P27 |
| #11 | 交易周期 3→5 档 | ✅ P28 |
| #12 | parentStepId 嵌套步骤 | ✅ P29 |
| #13 | 数据源面板 | ✅ **P30** |
| #14 | active_task_id | ⏳ 待做 |

P2 剩余 1 项：#14 active_task_id。
