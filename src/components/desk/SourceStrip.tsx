"use client";
// P30 稳智对齐 P2 #13：数据源面板（已核验的信息来源，可折叠）
//
// 稳智对齐依据（wenzhi-deep-comparison.md §3.3）：
//   稳智的答案末尾有 AiMatrixAssistantSourceStrip 组件——按类型过滤
//   （公告 / 新闻 / 实时行情 / 其他），按来源分组 + 展开/折叠，每条来源带外链。
//
// 本仓库差异：
//   - 没有外链（内部工具调用的结果不来自外部 URL，只来自后端工具层）
//   - 数据源分类基于 tool 名字符串前缀（stock_news / market_news → 新闻；stock_snapshot / tdx_quotes → 行情；等）
//
// 输入：StepInfo[]（本轮 steps）
// 输出：一个可折叠面板，按类型分组展示工具调用（只显示 ok/missing/stale 状态、不显示 running/error）
// 兼容：steps 为空 / 全部是 running 时返回 null（不画空面板）

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Newspaper, BarChart3, TrendingUp, Coins, Wrench, CircleDashed } from "lucide-react";
import type { StepInfo } from "@/lib/desk/chat-core";
import { groupStepsBySource, type SourceGroupKey } from "@/lib/desk/source-groups-core";

function groupMeta(key: SourceGroupKey): { zh: string; emoji: string; tone: string; Icon: typeof Newspaper } {
  switch (key) {
    case "news": return { zh: "新闻与公告", emoji: "📰", tone: "text-sky-300 border-sky-500/25 bg-sky-500/5", Icon: Newspaper };
    case "quote": return { zh: "实时行情", emoji: "📈", tone: "text-emerald-300 border-emerald-500/25 bg-emerald-500/5", Icon: BarChart3 };
    case "kline": return { zh: "K 线与周期", emoji: "🕯️", tone: "text-violet-300 border-violet-500/25 bg-violet-500/5", Icon: TrendingUp };
    case "fund": return { zh: "资金与情绪", emoji: "💰", tone: "text-amber-300 border-amber-500/25 bg-amber-500/5", Icon: Coins };
    case "other": return { zh: "其他", emoji: "🔧", tone: "text-muted-foreground border-border bg-accent/30", Icon: Wrench };
  }
}

const ORDER: SourceGroupKey[] = ["news", "quote", "kline", "fund", "other"];

/**
 * SourceStrip：答案末尾的「已核验来源」面板。
 *
 * 使用场景：在 StepTimeline 之后挂，展示本轮 tools 调用按类型分组的清单。
 * 兼容：steps 为空 / 全部 running/error 时返回 null（不画空面板）。
 *
 * @param steps 本轮消息的步骤（ChatMessage.steps）
 * @param defaultOpen 初始展开状态（默认 false）
 */
export default function SourceStrip({
  steps,
  defaultOpen = false,
}: {
  steps?: StepInfo[];
  defaultOpen?: boolean;
}) {
  const grouped = useMemo(() => groupStepsBySource(steps), [steps]);
  const total = ORDER.reduce((n, k) => n + grouped[k].length, 0);

  // Hooks 必须在 early return 之前调用（React Hooks 规则）
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState<Partial<Record<SourceGroupKey, boolean>>>({});

  // 空面板不画
  if (total === 0) return null;

  const toggleGroup = (k: SourceGroupKey) => {
    setExpanded((prev) => ({ ...prev, [k]: !prev[k] }));
  };

  return (
    <div className="mt-1.5 rounded border border-border/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent/40"
      >
        <CircleDashed size={11} className="text-sky-300" />
        <span className="font-medium text-foreground/90">已核验的信息来源</span>
        <span className="font-mono text-[11px]">{total} 项</span>
        <span className="ml-auto">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
      </button>

      {open && (
        <div className="space-y-1 border-t border-border/70 px-2 py-1.5">
          {ORDER.map((k) => {
            const items = grouped[k];
            if (items.length === 0) return null;
            const meta = groupMeta(k);
            const Icon = meta.Icon;
            const isExpanded = expanded[k] ?? true; // 默认展开
            return (
              <div key={k} className={"rounded border px-1.5 py-1 " + meta.tone}>
                <button
                  type="button"
                  onClick={() => toggleGroup(k)}
                  className="flex w-full items-center gap-1.5 text-[11.5px] font-medium"
                >
                  <Icon size={11} className="shrink-0" />
                  <span aria-hidden>{meta.emoji}</span>
                  <span>{meta.zh}</span>
                  <span className="ml-auto font-mono text-[10.5px] opacity-70">{items.length}</span>
                  {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                </button>

                {isExpanded && (
                  <ul className="mt-1 space-y-0.5 pl-5">
                    {items.map((s) => (
                      <li key={s.step} className="flex items-start gap-1.5 text-[11px] leading-4 text-muted-foreground/90">
                        <span className="shrink-0">
                          {s.status === "ok" ? "✓" : s.status === "missing" ? "○" : "⚠"}
                        </span>
                        <span className="min-w-0 flex-1 break-words">
                          {s.label}
                          {s.ms != null && <span className="ml-1 font-mono opacity-60">{s.ms}ms</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
