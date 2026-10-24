"use client";
// 新闻筛选（催化分流器规则版 v1，2026-10-24）：财联社电报按 9 个口子分流展示。
// 只做分类展示：不接选股、不进 AI 优选、不产买卖信号、不写库。
// 分类口径见 src/lib/desk/news-outlets-core.ts（规则先行，拿不准归未分类）。
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import type { NewsOutletKey } from "@/lib/desk/news-outlets-core";

interface OutletCount { key: NewsOutletKey; label: string; desc: string; count: number }
interface StockChip { name: string; code: string }
interface NewsItem {
  id: string; time: string; title: string; outlet: NewsOutletKey; rule: string;
  subjects: string[]; stocks: StockChip[];
}
interface FilterResp {
  ok: boolean; error?: string; as_of: string;
  window: { from: string; days: number };
  coverage: { earliest_in_db: string | null; scanned: number };
  outlets: OutletCount[]; outlet: string; q: string | null;
  total_after_q: number; returned: number; truncated: boolean; items: NewsItem[];
}

const OUTLET_TONE: Record<NewsOutletKey, string> = {
  policy: "border-sky-500/40 text-sky-300",
  incident: "border-orange-500/40 text-orange-300",
  product: "border-violet-500/40 text-violet-300",
  data: "border-emerald-500/40 text-emerald-300",
  institution: "border-amber-500/40 text-amber-300",
  risk: "border-red-500/40 text-red-300",
  order: "border-teal-500/40 text-teal-300",
  earnings: "border-blue-500/40 text-blue-300",
  company: "border-pink-500/40 text-pink-300",
  unclassified: "border-border text-muted-foreground",
};

const shortTime = (t: string) => (t.length >= 16 ? t.slice(5, 16) : t);

export default function NewsFilterPage() {
  const [outlet, setOutlet] = useState<string>("all");
  const [days, setDays] = useState(7);
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [resp, setResp] = useState<FilterResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ outlet, days: String(days), limit: "300" });
      if (q) params.set("q", q);
      const r = await fetch(`/api/news/filter?${params.toString()}`);
      const j = (await r.json()) as FilterResp;
      if (!j.ok) throw new Error(j.error || "接口返回异常");
      setResp(j);
    } catch (e) {
      setError(String((e as Error).message || e));
      setResp(null);
    } finally {
      setBusy(false);
    }
  }, [outlet, days, q]);

  useEffect(() => { load(); }, [load]);

  const total = resp?.total_after_q ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">新闻筛选</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          催化分流器规则版 v1：财联社电报按 9 个口子分流，只做分类展示，不接选股、不进 AI 优选、不产买卖信号。
          规则先行、拿不准的归「未分类」，不硬塞；后续上语义分类再补漏网。
        </p>
        {resp && (
          <p className="mt-1 text-xs text-muted-foreground">
            电报库：{resp.coverage.scanned} 条（窗口 {resp.window.from} 起）· 库内最早 {resp.coverage.earliest_in_db ?? "—"} · 本次命中 {total} 条
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-overlay/40 p-0.5 text-xs">
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setQ(qInput.trim()); }}
            placeholder="搜标题/正文关键词"
            className="w-52 bg-transparent px-2 py-1.5 outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={() => setQ(qInput.trim())}
            className="flex items-center gap-1 rounded-md px-2.5 py-1.5 hover:bg-accent"
            title="搜索"
          >
            <Search className="h-3.5 w-3.5" />搜
          </button>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
          title="时间窗口"
        >
          <option value={3}>近 3 天</option>
          <option value={7}>近 7 天</option>
          <option value={14}>近 14 天</option>
          <option value={30}>近 30 天</option>
        </select>
        <button
          onClick={load}
          disabled={busy}
          className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />刷新
        </button>
        {q && (
          <button
            onClick={() => { setQ(""); setQInput(""); }}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
          >
            清除搜索「{q}」
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="口子">
        <button
          role="tab"
          aria-selected={outlet === "all"}
          onClick={() => setOutlet("all")}
          className={`rounded-full border px-3 py-1.5 text-xs ${outlet === "all" ? "border-sky-500/60 bg-sky-500/15 text-sky-200" : "border-border text-muted-foreground hover:text-foreground"}`}
        >
          全部 {resp ? `(${total})` : ""}
        </button>
        {(resp?.outlets ?? []).map((o) => (
          <button
            key={o.key}
            role="tab"
            aria-selected={outlet === o.key}
            title={o.desc}
            onClick={() => setOutlet(o.key)}
            className={`rounded-full border px-3 py-1.5 text-xs ${outlet === o.key ? "border-sky-500/60 bg-sky-500/15 text-sky-200" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {o.label} ({o.count})
          </button>
        ))}
      </div>

      {busy && !resp && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />正在筛电报…
        </div>
      )}
      {error && <div className="rounded-lg border border-red-500/40 p-3 text-sm text-red-300">{error}</div>}
      {resp && resp.items.length === 0 && !busy && (
        <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          这个口子 / 关键词下没有电报。换个口子或放宽关键词、时间窗口试试。
        </div>
      )}
      {resp && resp.truncated && (
        <p className="text-xs text-muted-foreground">
          列表仅展示最新 {resp.returned} 条（该口子共 {resp.outlets.find((o) => o.key === outlet)?.count ?? resp.total_after_q} 条），其余请缩短窗口或加关键词。
        </p>
      )}

      <div className="space-y-2">
        {(resp?.items ?? []).map((it) => {
          const label = resp?.outlets.find((o) => o.key === it.outlet)?.label ?? it.outlet;
          return (
            <div key={it.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">{shortTime(it.time)}</span>
                <span className={`rounded-full border px-2 py-0.5 ${OUTLET_TONE[it.outlet]}`}>{label}</span>
                {it.rule && <span className="text-muted-foreground">命中：{it.rule}</span>}
              </div>
              <p className="mt-1.5 text-sm leading-relaxed">{it.title}</p>
              {(it.subjects.length > 0 || it.stocks.length > 0) && (
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                  {it.subjects.map((s) => (
                    <span key={`s-${s}`} className="rounded bg-overlay/60 px-1.5 py-0.5 text-muted-foreground">{s}</span>
                  ))}
                  {it.stocks.map((s) => (
                    <span key={`k-${s.code}`} className="rounded bg-overlay/60 px-1.5 py-0.5 text-muted-foreground">
                      {s.name} {s.code}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
