"use client";
// 数据能力面板（P6-A）：放在设置页，回答「我现在能查什么 / 这次到底取到了没有 / 还缺什么」。
//
// 面板自己不判定任何状态：kind、status、usable、note 全部照 /api/capabilities/probe 的返回原样显示。
// 四条显示纪律（与 datastatus-core 同源）：
// - 未探测（probed:false）显示「未探测」，不显示「暂无数据」，更不显示 0；
// - 取数失败 / 本次无内容 / 无可靠来源 三种不可用分开着色与措辞，绝不合并成一句「没数据」；
// - 新鲜度未知（服务端没给出可核对的时刻）显示「新鲜度未知」，不显示「超出上限（? 秒）」；
// - scope=channel 行必须带出「只验证了接口族可达」这句原文，避免被读成「这个能力当场取到了数据」。
import { useCallback, useEffect, useState } from "react";
import { Boxes, Globe2, Loader2, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { SourceBadge } from "./SourceBadge";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
import { freshnessChip } from "@/lib/quant/screener/datastatus-core";
import {
  fetchCapabilitiesRegistry, fetchCapabilitiesForNeed, fetchCapabilityProbe,
  type CapabilitiesProbeClient, type CapabilitiesRegistryClient, type CapabilityProbeClient,
} from "@/lib/desk/quant-api";
import type { CapabilityDef } from "@/lib/quant/screener/capability-core";

const KIND_TEXT: Record<string, { label: string; cls: string }> = {
  value: { label: "取到", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" },
  real_zero: { label: "真实 0", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" },
  no_data: { label: "本次无内容", cls: "border-amber-500/30 bg-amber-500/10 text-amber-300" },
  request_failed: { label: "取数失败", cls: "border-rose-500/30 bg-rose-500/10 text-rose-300" },
  not_covered: { label: "无可靠来源", cls: "border-border bg-accent/40 text-muted-foreground" },
  unprobed: { label: "未探测", cls: "border-dashed border-border text-muted-foreground" },
};

function kindKey(p: CapabilityProbeClient): string {
  return !p.probed ? "unprobed" : (p.kind ?? "unprobed");
}

function Evidence({ p }: { p: CapabilityProbeClient }) {
  const entries = Object.entries(p.evidence ?? {}).filter(([k]) => k !== "probed" && k !== "probe_scope");
  if (!entries.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="rounded border border-border/70 px-1 py-0.5 text-[10px] text-muted-foreground">
          {k}=<span className="text-foreground">{String(v)}</span>
        </span>
      ))}
    </span>
  );
}

function Row({ p, def }: { p: CapabilityProbeClient; def?: CapabilityDef }) {
  const k = KIND_TEXT[kindKey(p)] ?? KIND_TEXT.unprobed;
  return (
    <div className="border-t border-border/60 px-3 py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${k.cls}`}>{k.label}</span>
        <span className="text-[12.5px] font-semibold">{p.title}</span>
        <span className="font-mono text-[10.5px] text-muted-foreground">{p.name}</span>
        <span className="text-[10.5px] text-muted-foreground">状态分层 {p.status}</span>
        {p.degraded_from && <span className="text-[10.5px] text-amber-300">兜底自 {p.degraded_from}</span>}
        {p.probed && p.usable && (() => {
          // 措辞全部来自内核：只有服务端判了「超上限」才说不算实时；没有时刻时说未知，不显示「（? 秒）」
          const chip = freshnessChip(p.fresh, p.freshness, p.freshness_s);
          if (!chip) return null;
          return <span className={`text-[10.5px] ${p.fresh === false ? "text-amber-300" : "text-muted-foreground"}`}>{chip}</span>;
        })()}
        {p.mutating && <span className="rounded border border-fuchsia-500/30 bg-fuchsia-500/10 px-1 text-[10px] text-fuchsia-300">写操作·Agent 不可用</span>}
      </div>
      <div className="mt-1 text-[11.5px] leading-4 text-muted-foreground">{p.note}</div>
      {def && <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">入参 {def.input} ｜ 返回 {def.output}</div>}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-border/70 px-1 py-0.5 text-[10px] text-muted-foreground">范围 {p.scope}</span>
        <span className="rounded border border-border/70 px-1 py-0.5 text-[10px] text-muted-foreground">来源 {def?.source ?? "—"}</span>
        {!!p.fallbacks.length && (
          <span className="rounded border border-sky-500/25 px-1 py-0.5 text-[10px] text-sky-300/90">兜底 {p.fallbacks.join(" → ")}</span>
        )}
        <Evidence p={p} />
      </div>
      {!!p.limitations.length && (
        <DeskCollapse
          className="mt-1"
          title={`已知局限 ${p.limitations.length} 条`}
          triggerClassName="text-[11px] text-muted-foreground hover:text-foreground"
          contentClassName="text-[11px] text-muted-foreground"
        >
          <ul className="space-y-0.5">
            {p.limitations.map((l) => <li key={l}>· {l}</li>)}
          </ul>
        </DeskCollapse>
      )}
    </div>
  );
}

export function CapabilityPanel() {
  const [reg, setReg] = useState<CapabilitiesRegistryClient | null>(null);
  const [probe, setProbe] = useState<CapabilitiesProbeClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [error, setError] = useState("");
  const [need, setNeed] = useState("");
  const [needResult, setNeedResult] = useState<{
    need: string; matches: CapabilityDef[]; match_note: string;
    hits?: { name: string; matched: string[] }[]; order_note?: string; gap_groups?: string[];
  } | null>(null);
  const [needBusy, setNeedBusy] = useState(false);

  useEffect(() => {
    fetchCapabilitiesRegistry().then(setReg).catch((e) => setError(String((e as Error).message || e)));
    void fetchCapabilityProbe().then(setProbe).catch(() => setProbe(null));
  }, []);

  const reload = useCallback(async (live: boolean) => {
    if (live) setLiveBusy(true); else setBusy(true);
    setError("");
    try {
      setProbe(await fetchCapabilityProbe({ live, force: true }));
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
      setLiveBusy(false);
    }
  }, []);

  const askNeed = async () => {
    const q = need.trim();
    if (!q) return;
    setNeedBusy(true);
    try {
      const r = await fetchCapabilitiesForNeed(q);
      setNeedResult({ need: r.need, matches: r.matches, match_note: r.match_note, hits: r.hits, order_note: r.order_note, gap_groups: r.gap_groups });
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setNeedBusy(false);
    }
  };

  const probes = probe?.probes ?? [];
  const defOf = new Map<string, CapabilityDef>();
  for (const g of reg?.groups ?? []) for (const it of g.items) defOf.set(it.name, it);
  const groups = (reg?.groups ?? []).map((g) => ({
    group: g.group,
    items: probes.filter((p) => g.group === p.group),
  })).filter((g) => g.items.length);
  const counts = probe?.counts ?? {};
  const missing = probe?.missing ?? [];

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-1.5 text-[13.5px] font-semibold">
          <Boxes size={14} className="text-sky-400" /> 数据能力与来源状态（我现在能查什么）
        </div>
        <div className="flex items-center gap-2">
          {probe && (
            <SourceBadge
              status={probe.live ? "READ-ONLY 探测（含上游）" : "READ-ONLY 探测（仅本地）"}
              source={probe.cached ? `复用 ${probe.cache_age_s ?? 0} 秒前的探测` : `上游请求 ${probe.upstream_calls} 次`}
              time={probe.probed_at}
            />
          )}
          <button onClick={() => void reload(false)} disabled={busy || liveBusy}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 重新探测（不碰外网）
          </button>
          <button onClick={() => void reload(true)} disabled={busy || liveBusy}
            className="flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-xs text-sky-300 hover:bg-sky-500/15 disabled:opacity-50">
            {liveBusy ? <Loader2 size={12} className="animate-spin" /> : <Globe2 size={12} />} 带上游探测（真的打 7 个小请求）
          </button>
        </div>
      </div>

      <div className="space-y-3 px-4 py-4">
        {!probe && !busy && <div className="text-[12px] text-muted-foreground">{error || "探测未取到：没有真实探测结果就不做任何判断。"}</div>}
        {probe && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                { k: "本次取到数据", v: `${counts.usable ?? 0} 项`, t: "kind=value / real_zero：真的取到了，才敢说结论" },
                { k: "本次取不到", v: `${(counts.no_data ?? 0) + (counts.request_failed ?? 0)} 项`, t: `其中取数失败 ${counts.request_failed ?? 0} 项、请求成功但无内容 ${counts.no_data ?? 0} 项（两者不合并）` },
                { k: "无可靠来源", v: `${counts.not_covered ?? 0} 项`, t: "本来就没有这个数据（如北向已停披）：不是失败，也不补 0" },
                { k: "未探测", v: `${counts.unprobed ?? 0} 项`, t: "没测就是没测，面板不会把它显示成「暂无数据」" },
              ].map((c) => (
                <div key={c.k} title={c.t} className="rounded-lg border border-border px-3 py-2">
                  <div className="text-[10.5px] text-muted-foreground">{c.k}</div>
                  <div className="text-[13px] font-semibold">{c.v}</div>
                </div>
              ))}
            </div>

            <div className="rounded-md border border-border/70 bg-accent/20 px-2.5 py-2 text-[11.5px] leading-4 text-muted-foreground">
              <div>{probe.layering}</div>
              <div className="mt-1">{probe.gateway_note}</div>
              <div className="mt-1">口径：{probe.basis}</div>
              {!!probe.self_check.violations.length && (
                <div className="mt-1 flex items-start gap-1 text-rose-300">
                  <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                  <span>出参自检发现 {probe.self_check.violations.length} 条自相矛盾的响应：{probe.self_check.violations.join("、")}（应修服务端，不要把这种响应当事实）</span>
                </div>
              )}
            </div>

            {!!missing.length && (
              <DeskCollapse
                tone="amber"
                defaultOpen
                className="mt-2"
                triggerClassName="text-[11.5px] font-medium text-amber-200 hover:text-amber-100"
                contentClassName="text-[11.5px] text-amber-100/80"
                title={`还缺什么 ${missing.length} 项（这些结论不能用真实数据支撑）`}
              >
                <ul className="space-y-1">
                  {missing.map((m) => <li key={m}>· {m}</li>)}
                </ul>
              </DeskCollapse>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Search size={13} className="text-muted-foreground" />
                <input value={need} onChange={(e) => setNeed(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void askNeed()}
                  placeholder="我还缺什么数据？例：板块资金 / 事件 / 因子 / 留档"
                  className="w-[280px] rounded-md border border-border bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-sky-500/50" />
              </div>
              <button onClick={() => void askNeed()} disabled={needBusy || !need.trim()}
                className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">
                {needBusy ? "匹配中" : "查这个需求能用什么"}
              </button>
            </div>
            {needResult && (
              <div className="rounded-lg border border-border/70 px-2.5 py-2 text-[11.5px]">
                <div className="text-muted-foreground">需求「{needResult.need}」的已登记只读候选：</div>
                {needResult.matches.length ? (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {needResult.matches.map((m) => (
                      <span key={m.name} className="rounded border border-sky-500/25 bg-sky-500/5 px-1.5 py-0.5 text-[11px] text-sky-200">{m.title}<span className="ml-1 font-mono text-[10px] text-muted-foreground">{m.name}</span>{needResult.hits?.find((h) => h.name === m.name)?.matched.length ? <span className="ml-1 text-[10px] text-muted-foreground">·命中 {needResult.hits!.find((h) => h.name === m.name)!.matched.join("/")}</span> : null}</span>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1 text-amber-200">{needResult.match_note || "没有已登记能力覆盖这个需求。"}{needResult.gap_groups?.length ? <span className="text-muted-foreground">（相近分组：{needResult.gap_groups.join("、")}）</span> : null}</div>
                )}
                <div className="mt-1 text-[10.5px] text-muted-foreground">这里只列只读能力（写库/删库/外部执行不在其中）；能不能取到看上面同一次探测。</div>
              </div>
            )}

            <div className="overflow-hidden rounded-lg border border-border">
              {groups.map((g) => (
                <div key={g.group}>
                  <div className="flex items-center justify-between bg-accent/40 px-3 py-1.5 text-[11.5px] font-medium text-muted-foreground">
                    <span>{g.group}</span>
                    <span>{g.items.filter((p) => p.usable).length}/{g.items.length} 本次可取</span>
                  </div>
                  {g.items.map((p) => <Row key={p.name} p={p} def={defOf.get(p.name)} />)}
                </div>
              ))}
            </div>
            {!!error && probe && <div className="text-[11.5px] text-rose-300">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
