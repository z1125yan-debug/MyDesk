"use client";
// 板块风险（见顶预警扫描器 + 详情诊断）
// 第一层=全市场扫描器（发现问题）；第二层=板块详情（为什么）。两层结构，沿用 AI 对话「列表→对话」范式。
// 数据：/api/market/sectors/top-risk（全市场）+ ?sector= 单板块详情。引擎：top-risk-engine.ts。
// 不接 Jev/AI；结论卡渲染规则生成的 conclusion 字符串。术语走方案 §3 词典（少黑话）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, ArrowUp, ArrowDown, Minus, Activity, Network } from "lucide-react";
import type { ScannerResult, SectorRow, SectorTopRisk, Tone } from "@/lib/quant/screener/top-risk-types";

const TONE: Record<Tone, string> = {
  red: "text-red-500 border-red-500/40 bg-red-500/10",
  orange: "text-orange-400 border-orange-500/40 bg-orange-500/10",
  amber: "text-amber-400 border-amber-500/40 bg-amber-500/10",
  green: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  blue: "text-blue-400 border-blue-500/40 bg-blue-500/10",
};
const tonePill = (t: Tone, label: string) => (
  <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[t]}`}>{label}</span>
);
const scoreBand = (v: number): Tone => (v >= 70 ? "red" : v >= 40 ? "amber" : v >= 20 ? "blue" : "green");
const fmt = (v: number | null, d = 1) => (v == null || !isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);

function DeltaTag({ tone, label }: { tone: string; label: string }) {
  const map: Record<string, { icon: JSX.Element; cls: string }> = {
    up_up: { icon: <ArrowUp className="h-3 w-3" />, cls: "text-red-500" },
    up: { icon: <ArrowUp className="h-3 w-3" />, cls: "text-red-400" },
    flat: { icon: <Minus className="h-3 w-3" />, cls: "text-zinc-400" },
    down: { icon: <ArrowDown className="h-3 w-3" />, cls: "text-emerald-400" },
    down_down: { icon: <ArrowDown className="h-3 w-3" />, cls: "text-emerald-500" },
  };
  const m = map[tone] ?? map.flat;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${m.cls}`}>
      {m.icon}
      {label}
    </span>
  );
}

const FILTERS = ["全部", "趋势反转", "顶部形成中", "趋势内回撤", "趋势健康"] as const;
type Filter = (typeof FILTERS)[number];

export default function SectorTopPage() {
  const [scanner, setScanner] = useState<ScannerResult | null>(null);
  const [detail, setDetail] = useState<SectorTopRisk | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("全部");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/market/sectors/top-risk", { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "加载失败");
      setScanner(j.scanner);
      if (!selected && j.scanner.rows.length) {
        const first = j.scanner.rows[0].sector;
        setSelected(first);
      }
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }, [selected]);

  const loadDetail = useCallback(async (sector: string) => {
    setDetailBusy(true);
    try {
      const r = await fetch(`/api/market/sectors/top-risk?sector=${encodeURIComponent(sector)}`, { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "加载失败");
      setDetail(j.detail);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setDetailBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  const rows = useMemo(() => {
    if (!scanner) return [];
    return scanner.rows.filter((r) => (filter === "全部" ? true : r.stage === filter)).filter((r) => (q ? r.sector.includes(q) : true));
  }, [scanner, filter, q]);

  const ss = scanner?.statusSummary;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-blue-400" />
          <h1 className="text-lg font-semibold">板块风险</h1>
          {scanner && <span className="text-xs text-zinc-400">扫描日 {scanner.scanDate} · {scanner.sectorCount} 板块</span>}
        </div>
        <div className="flex items-center gap-2">
          {scanner && (
            <span className="hidden text-xs text-zinc-400 md:inline">
              异动：{scanner.biggestMovers.slice(0, 4).join("  ")}
            </span>
          )}
          <button onClick={load} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-white/5">
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> 刷新
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}

      {/* 状态概览 */}
      {ss && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="趋势反转" v={ss.trendBreak} tone="red" />
          <Stat label="顶部形成中" v={ss.topWatch} tone="amber" />
          <Stat label="趋势内回撤" v={ss.highPullback} tone="blue" />
          <Stat label="趋势健康" v={ss.healthy} tone="green" />
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(340px,38%)_1fr]">
        {/* 左：扫描器列表 */}
        <div className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
          <div className="flex flex-col gap-2 border-b border-border p-2">
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-md px-2.5 py-1 text-xs ${filter === f ? "bg-blue-500/20 text-blue-300" : "text-zinc-400 hover:bg-white/5"}`}
                >
                  {f}
                </button>
              ))}
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索板块…"
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-blue-500/50"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto desk-scroll">
            {rows.map((r) => (
              <button
                key={r.sector}
                onClick={() => setSelected(r.sector)}
                className={`flex w-full items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-left text-sm hover:bg-white/5 ${selected === r.sector ? "bg-blue-500/10" : ""}`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{r.sector}</div>
                  <div className="text-xs text-zinc-400">中期顶 {r.midTop} · 破坏 {r.trendDamage}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {tonePill(r.stageTone, r.stage)}
                  <DeltaTag tone={r.delta} label={r.deltaLabel} />
                </div>
              </button>
            ))}
            {!rows.length && <div className="p-4 text-center text-sm text-zinc-500">无匹配板块</div>}
          </div>
        </div>

        {/* 右：详情诊断 */}
        <div className="min-h-0 overflow-y-auto desk-scroll rounded-xl border border-border bg-card p-4">
          {detailBusy && !detail && <div className="flex items-center gap-2 text-sm text-zinc-400"><RefreshCw className="h-4 w-4 animate-spin" /> 加载诊断…</div>}
          {detail && <Detail d={detail} />}
          {!detail && !detailBusy && <div className="p-4 text-sm text-zinc-500">点左侧板块查看诊断</div>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, v, tone }: { label: string; v: number; tone: Tone }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${TONE[tone]}`}>
      <div className="text-2xl font-bold">{v}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  );
}

function ScoreCard({ label, v, na }: { label: string; v: number | null; na?: boolean }) {
  const tone = v == null ? "amber" : scoreBand(v);
  return (
    <div className={`rounded-xl border px-3 py-3 ${TONE[tone]}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="mt-1 text-2xl font-bold">{v == null ? "—" : v}</div>
      {na && <div className="text-[10px] opacity-70">数据不足·降权</div>}
    </div>
  );
}

function Bar({ label, v, danger }: { label: string; v: number | null; danger?: boolean }) {
  const w = v == null ? 0 : Math.min(100, Math.abs(v) * 5); // -20%~+20% 映射到 100%
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-10 shrink-0 text-zinc-400">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${danger ? "bg-red-500/70" : "bg-emerald-500/70"}`} style={{ width: `${w}%` }} />
      </div>
      <span className={`w-16 shrink-0 text-right ${danger ? "text-red-400" : "text-zinc-300"}`}>{fmt(v)}</span>
    </div>
  );
}

function Detail({ d }: { d: SectorTopRisk }) {
  return (
    <div className="flex flex-col gap-4">
      {/* 状态条 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">{d.sector}</h2>
          {tonePill(d.stageTone, d.stage)}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-zinc-400">今日 {fmt(d.medianChange)}</span>
          <span className="text-zinc-400">相对全A {fmt(d.rsProxy)}</span>
          <span className="text-zinc-400">宽度 {d.advPct == null ? "—" : `${d.advPct.toFixed(0)}%`}</span>
          <DeltaTag tone={d.delta.tone} label={`风险${d.delta.label}`} />
        </div>
      </div>

      {/* 四分数 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ScoreCard label="短期回撤风险" v={d.scores.shortPullback} />
        <ScoreCard label="中期顶部风险" v={d.scores.midTop} />
        <ScoreCard label="趋势破坏程度" v={d.scores.trendDamage} />
        <ScoreCard label="产业周期健康度" v={d.scores.industryHealth} na={d.scores.industryHealth == null} />
      </div>

      {/* 顶部类型 + 确认窗口 */}
      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">顶部类型</span>
          {tonePill(d.topType ? "red" : "green", d.topTypeLabel)}
          <span className="text-xs text-zinc-400">确认窗口：{d.window}</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-zinc-400">{d.topTypeNote}</p>
      </div>

      {/* 信号分色板 */}
      <div>
        <div className="mb-1.5 text-xs font-medium text-zinc-400">信号</div>
        <div className="flex flex-wrap gap-1.5">
          {d.signals.map((s) => tonePill(s.tone, `${s.name}`))}
        </div>
      </div>

      {/* 谁在跌（结构性分解） */}
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-zinc-400">
          <span>谁在跌（结构性分解）</span>
          {d.structural.leadersDecliningPct != null && <span>龙头下带 {d.structural.leadersDecliningPct.toFixed(0)}%</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Bar label="龙头" v={d.structural.leader} danger={d.structural.coreBreak} />
          <Bar label="核心" v={d.structural.core} />
          <Bar label="二线" v={d.structural.second} />
        </div>
      </div>

      {/* 前期涨幅 / 位置 */}
      <div>
        <div className="mb-1.5 text-xs font-medium text-zinc-400">前期涨幅与位置</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
          <Pos label="5日" v={d.position.prevChange5} />
          <Pos label="20日" v={d.position.prevChange20} />
          <Pos label="60日" v={d.position.prevChange60} />
          <Pos label="120日" v={d.position.prevChange120} />
          <Pos label="距20日高" v={d.position.distFromHigh20} />
          <Pos label="距MA60" v={d.position.distMA60} />
        </div>
      </div>

      {/* 产业链诊断 */}
      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="mb-2 flex items-center gap-2">
          <Network className="h-4 w-4 text-blue-400" />
          <span className="text-sm font-medium">产业链诊断</span>
          <span className="text-xs text-zinc-400">{d.industryChain.matched}</span>
        </div>
        {(["上游", "中游", "下游"] as const).map((layer) => {
          const ns = d.industryChain.nodes[layer] || [];
          if (!ns.length) return null;
          return (
            <div key={layer} className="mb-1.5">
              <div className="text-xs text-zinc-500">{layer}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {ns.map((n) => tonePill(n.tone, n.n))}
              </div>
            </div>
          );
        })}
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">{d.industryChain.note}</p>
      </div>

      {/* 证据 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <div className="mb-1.5 text-xs font-medium text-red-400">主要风险</div>
          <ul className="list-inside list-disc space-y-1 text-xs text-zinc-300">
            {d.pro.map((p, i) => <li key={i}>{p}</li>)}
            {!d.pro.length && <li className="text-zinc-500">无明显</li>}
          </ul>
        </div>
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="mb-1.5 text-xs font-medium text-emerald-400">反向信号</div>
          <ul className="list-inside list-disc space-y-1 text-xs text-zinc-300">
            {d.counter.map((p, i) => <li key={i}>{p}</li>)}
            {!d.counter.length && <li className="text-zinc-500">无</li>}
          </ul>
        </div>
      </div>

      {/* 结论 */}
      <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-3">
        <div className="mb-1 text-xs font-medium text-blue-300">结论</div>
        <p className="text-sm leading-relaxed text-zinc-200">{d.conclusion}</p>
      </div>
    </div>
  );
}

function Pos({ label, v }: { label: string; v: number | null }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-zinc-400">{label}</span>
      <span className={v == null ? "text-zinc-500" : v < 0 ? "text-red-400" : "text-emerald-400"}>{fmt(v)}</span>
    </div>
  );
}
