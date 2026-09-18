"use client";
import { useState } from "react";
import { History as HistoryIcon, Trash2, ArrowLeft, ArrowRight } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import type { HistoryEntry } from "@/lib/desk/types";

function rrOf(e: HistoryEntry): number | null {
  const m = e.meta;
  if (!m?.entry || !m.stop || !m.targets?.length) return null;
  const risk = Math.abs(m.entry - m.stop);
  const reward = Math.abs(m.targets[0] - m.entry);
  if (!risk) return null;
  const v = reward / risk;
  return isFinite(v) && v > 0 ? v : null;
}

// 方向标签：优先用 AI 给的 bias；没有时从入场/目标的几何关系推导
function directionOf(e: HistoryEntry): { label: string; cls: string; bigCls: string; arrow: string } {
  const m = e.meta;
  let long: boolean | null = null;
  if (m?.bias === "看多") long = true;
  else if (m?.bias === "看空") long = false;
  else if (m?.entry && m?.targets?.[0] != null && m.targets[0] !== m.entry) long = m.targets[0] > m.entry;
  if (long === true) {
    return { label: "看涨", cls: "border-rose-500/40 bg-rose-500/10 text-rose-300", bigCls: "border-rose-500/40 bg-rose-500/10 text-rose-300", arrow: "↑" };
  }
  if (long === false) {
    return { label: "看跌", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", bigCls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", arrow: "↓" };
  }
  return { label: "震荡", cls: "border-sky-500/40 bg-sky-500/10 text-sky-300", bigCls: "border-sky-500/40 bg-sky-500/10 text-sky-300", arrow: "→" };
}

export default function HistoryPage() {
  const history = useDesk((s) => s.history);
  const clearHistory = useDesk((s) => s.clearHistory);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = history.find((h) => h.id === selectedId) ?? null;
  if (selected) {
    return (
      <DetailView
        entry={selected}
        index={history.indexOf(selected) + 1}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold">历史</h1>
          <p className="mt-1 text-[12.5px] text-muted-foreground">AI 分析的存档，点击任意记录查看完整交易详情（最多保留 100 条）</p>
        </div>
        {history.length > 0 && (
          <button onClick={clearHistory}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted-foreground hover:border-rose-500/40 hover:text-rose-300">
            <Trash2 size={13.5} /> 清空
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <HistoryIcon size={30} className="text-muted-foreground/50" />
          <div className="text-[13px] text-muted-foreground">还没有分析记录。在 AI 分析页点「开始分析」后会自动存档。</div>
        </div>
      ) : (
        <div className="space-y-2.5">
          {history.map((h, i) => {
            const m = h.meta;
            const rr = rrOf(h);
            const dir = directionOf(h);
            return (
              <div key={h.id}
                onClick={() => setSelectedId(h.id)}
                className="group cursor-pointer rounded-xl border border-border bg-card p-4 transition-colors hover:border-sky-500/40">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent font-mono text-[13px] font-bold text-foreground">
                    {i + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[15px] font-bold">{h.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{h.symbol}</span>
                      <span className="rounded bg-accent px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{h.style}</span>
                      <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">{h.timeframe}</span>
                      {m?.trend && <span className="text-[11px] text-muted-foreground">{m.trend}</span>}
                    </div>
                    {(m?.entry != null || m?.stop != null || m?.targets?.length || rr) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12px]">
                        {m?.entry != null && <span>入场 <span className="font-bold">{m.entry.toFixed(2)}</span></span>}
                        {m?.stop != null && <span className="text-rose-300">止损 {m.stop.toFixed(2)}</span>}
                        {m?.targets?.[0] != null && <span className="text-emerald-300">止盈 {m.targets[0].toFixed(2)}</span>}
                        {rr && <span>盈亏比 <span className="font-bold">{rr.toFixed(2)} : 1</span></span>}
                      </div>
                    )}
                    <div className="mt-1.5 truncate text-[12.5px] text-muted-foreground">{h.summary}</div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">{h.createdAt}</span>
                    <span className={"rounded-md border px-2 py-0.5 text-[11.5px] " + dir.cls}>{dir.label}</span>
                    <ArrowRight size={14} className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-sky-300" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DetailView({ entry, index, onBack }: { entry: HistoryEntry; index: number; onBack: () => void }) {
  const m = entry.meta;
  const rr = rrOf(entry);
  const dir = directionOf(entry);

  // 从存档数据推导执行步骤
  const steps: string[] = [];
  if (m?.entry != null && m?.bias) {
    steps.push(`在当前价格 ${m.entry.toFixed(2)} 元附近建立${m.bias === "看空" ? "空头" : "多头"}仓位`);
  }
  if (m?.stop != null) {
    steps.push(`止损位设在 ${m.stop.toFixed(2)} 元，跌破关键支撑坚决离场`);
  }
  if (m?.targets?.length) {
    steps.push(`目标位依次为 ${m.targets.map((t) => t.toFixed(2)).join(" / ")} 元`);
  }
  if (steps.length) {
    steps.push("若反弹无量或跌破关键位，及时调整仓位并复盘");
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-5">
      <button onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
        <ArrowLeft size={13.5} /> 返回列表
      </button>

      {/* 标题 + 方向大标签 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-accent font-mono text-[15px] font-bold">
            {index}
          </div>
          <div>
            <div className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11.5px] text-sky-300 inline-block">分析详情</div>
            <div className="mt-1 text-[28px] font-bold leading-8">
              {entry.name}
              <span className="ml-2 font-mono text-[15px] text-muted-foreground">{entry.symbol}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">{entry.style}</span>
              <span className="rounded bg-accent px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{entry.timeframe}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{entry.createdAt}</span>
            </div>
          </div>
        </div>
        <div className={"flex shrink-0 items-center gap-1.5 rounded-lg border px-4 py-2 text-[17px] font-bold " + dir.bigCls}>
          <span>{dir.arrow}</span> {dir.label}
        </div>
      </div>

      {/* 交易计划 */}
      <div>
        <div className="mb-1.5 text-[12px] text-muted-foreground">交易计划</div>
        <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
          {([
            ["入场", m?.entry != null ? m.entry.toFixed(2) : "—", ""],
            ["止损", m?.stop != null ? m.stop.toFixed(2) : "—", "text-rose-300"],
            ["止盈", m?.targets?.[0] != null ? m.targets[0].toFixed(2) : "—", "text-emerald-300"],
            ["盈亏比", rr ? `${rr.toFixed(2)} : 1` : "—", ""],
            ["风险(元)", m?.entry != null && m?.stop != null ? Math.abs(m.entry - m.stop).toFixed(2) : "—", ""],
            ["交易市场", /\.(SH|SZ|BJ)$/.test(entry.symbol) ? "中国股市" : "—", ""],
          ] as const).map(([label, value, color]) => (
            <div key={label} className="rounded-lg border border-border bg-card p-3">
              <div className="text-[11px] text-muted-foreground">{label}</div>
              <div className={"mt-0.5 font-mono text-[15px] font-bold " + color}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 结构解读 */}
      <div>
        <div className="mb-1.5 text-[12px] text-muted-foreground">结构解读</div>
        <div className="rounded-lg border border-border bg-card p-3.5 text-[13px] leading-6">{entry.summary}</div>
      </div>

      {/* 技术快照 */}
      <div>
        <div className="mb-1.5 text-[12px] text-muted-foreground">技术快照</div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {([
            ["趋势", m?.trend ?? "—", ""],
            ["RSI（14）", m?.rsi != null ? m.rsi.toFixed(1) : "—", ""],
            ["区间高", m?.rangeHigh != null ? m.rangeHigh.toFixed(2) : "—", ""],
            ["区间低", m?.rangeLow != null ? m.rangeLow.toFixed(2) : "—", ""],
          ] as const).map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-card p-3">
              <div className="text-[11px] text-muted-foreground">{label}</div>
              <div className="mt-0.5 font-mono text-[16px] font-bold">{value}</div>
            </div>
          ))}
        </div>
        {m?.rangePos != null && (
          <div className="mt-2 rounded-lg border border-border bg-card p-3">
            <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground">
              <span className="font-mono">{m.rangeLow?.toFixed(2)}</span>
              <span>区间位置 {m.rangePos.toFixed(0)}%</span>
              <span className="font-mono">{m.rangeHigh?.toFixed(2)}</span>
            </div>
            <div className="relative h-1.5 rounded-full bg-gradient-to-r from-emerald-500/60 via-accent to-rose-500/60">
              <div className="absolute h-3 w-1 rounded bg-sky-400"
                style={{ left: `calc(${Math.min(98, Math.max(2, m.rangePos))}% - 2px)`, top: -2 }} />
            </div>
          </div>
        )}
      </div>

      {/* 风险提示 */}
      {m?.risk && (
        <div>
          <div className="mb-1.5 text-[12px] text-muted-foreground">风险提示</div>
          <div className="rounded-lg border border-border bg-card p-3.5 text-[13px] leading-6">{m.risk}</div>
        </div>
      )}

      {/* 执行步骤 */}
      {steps.length > 0 && (
        <div>
          <div className="mb-1.5 text-[12px] text-muted-foreground">执行步骤</div>
          <div className="space-y-1.5">
            {steps.map((s, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 text-[12.5px]">
                <span className="font-mono text-[11px] text-sky-300">{String(i + 1).padStart(2, "0")}</span>
                <span>{s}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
