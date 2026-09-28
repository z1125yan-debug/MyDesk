"use client";
// 量化研究 — 因子库 Tab（Phase 3）：版本化列表 + 手动录入 + 状态变更
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import type { FactorRecord, FactorStatus } from "@/lib/quant/types";

const STATUS_STYLE: Record<string, string> = {
  Candidate: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  Validated: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  Paper: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  Live: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  Degraded: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  Retired: "bg-red-500/15 text-red-300 border-red-500/30",
};

function pct(v: number | undefined | null, digits = 2): string {
  return typeof v === "number" && isFinite(v) ? (v * 100).toFixed(digits) + "%" : "-";
}

export function FactorsTab() {
  const { toast } = useToast();
  const [factors, setFactors] = useState<FactorRecord[]>([]);
  const [category, setCategory] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ factorKey: "", name: "", category: "Momentum", expression: "roc(c, 20)", note: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/quant/factors?latestOnly=1${category ? `&category=${category}` : ""}`);
      const j = await r.json();
      setFactors(j.factors ?? []);
    } catch {
      // 忽略瞬时网络错误
    }
  }, [category]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  const addFactor = async () => {
    if (!form.factorKey || !form.expression) {
      toast({ title: "请填写 factorKey 与表达式" });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/quant/factors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (j.error) toast({ title: "录入失败", description: j.error });
      else {
        toast({ title: `已入库 ${j.factor.factorKey} v${j.factor.version}`, description: "状态 Candidate" });
        setShowAdd(false);
        void load();
      }
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (id: string, status: FactorStatus) => {
    const r = await fetch(`/api/quant/factors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const j = await r.json();
    if (j.error) toast({ title: "状态变更失败", description: j.error });
    else void load();
  };

  return (
    <div className="space-y-3 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-border bg-background px-2 text-[14px]"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">全部类目</option>
          {["Price", "Volume", "Momentum", "Trend", "Reversal", "Volatility", "Fundamental", "Microstructure", "AI_Discovered"].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(!showAdd)}>{showAdd ? "收起录入" : "+ 手动录入因子"}</Button>
        <span className="text-[12.5px] text-muted-foreground">共 {factors.length} 个因子（每键显示最新版本；insert-only 版本化，禁止覆盖）</span>
      </div>

      {showAdd && (
        <Card>
          <CardContent className="grid grid-cols-1 gap-2 py-3 md:grid-cols-2">
            <input className="h-8 rounded-md border border-border bg-background px-2 text-[14px]" placeholder="factorKey（如 my_alpha_1）" value={form.factorKey} onChange={(e) => setForm({ ...form, factorKey: e.target.value })} />
            <input className="h-8 rounded-md border border-border bg-background px-2 text-[14px]" placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <select className="h-8 rounded-md border border-border bg-background px-2 text-[14px]" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {["Price", "Volume", "Momentum", "Trend", "Reversal", "Volatility", "Fundamental", "Microstructure", "AI_Discovered"].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input className="h-8 rounded-md border border-border bg-background px-2 font-mono text-[14px]" placeholder="表达式，如 zscore(roc(c, 20))" value={form.expression} onChange={(e) => setForm({ ...form, expression: e.target.value })} />
            <div className="flex items-center gap-2 md:col-span-2">
              <Button size="sm" disabled={busy} onClick={() => void addFactor()}>{busy ? "提交中…" : "提交（自动审计未来函数/白名单）"}</Button>
              <span className="text-[12px] text-muted-foreground">可用字段 o h l c v amount ret turnover cap pe pb；函数 ref ma std sum max min delta roc corr rank zscore minmax winsor abs sign log neg add sub mul div</span>
            </div>
          </CardContent>
        </Card>
      )}

      {factors.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-[14px] text-muted-foreground">因子库为空。先在「因子挖掘」Tab 跑一次挖掘，或手动录入。</CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-[13px]">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-normal">因子</th>
                <th className="px-2 py-1.5 text-left font-normal">类目</th>
                <th className="px-2 py-1.5 text-left font-normal">状态</th>
                <th className="px-2 py-1.5 text-right font-normal">IC</th>
                <th className="px-2 py-1.5 text-right font-normal">RankIC</th>
                <th className="px-2 py-1.5 text-right font-normal">ICIR</th>
                <th className="px-2 py-1.5 text-right font-normal">多空年化</th>
                <th className="px-2 py-1.5 text-right font-normal">稳定性</th>
                <th className="px-2 py-1.5 text-right font-normal">换手</th>
                <th className="px-2 py-1.5 text-left font-normal">表达式</th>
                <th className="px-2 py-1.5 text-left font-normal">状态操作</th>
              </tr>
            </thead>
            <tbody>
              {factors.map((f) => (
                <tr key={f.id} className="border-t border-border/60 align-top">
                  <td className="px-2 py-1.5">
                    <div className="font-mono">{f.factorKey}</div>
                    <div className="text-[11.5px] text-muted-foreground">{f.name} · v{f.version} · {f.dataSource}</div>
                  </td>
                  <td className="px-2 py-1.5">{f.category}</td>
                  <td className="px-2 py-1.5"><Badge variant="outline" className={"text-[11.5px] " + (STATUS_STYLE[f.status] ?? "")}>{f.status}</Badge></td>
                  <td className="px-2 py-1.5 text-right font-mono">{pct(f.metrics.ic, 1)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{pct(f.metrics.rankIc, 1)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{f.metrics.icIr?.toFixed(2) ?? "-"}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{pct(f.metrics.longShortReturn, 0)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{f.metrics.stability != null ? f.metrics.stability.toFixed(2) : "-"}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{pct(f.metrics.turnover, 0)}</td>
                  <td className="max-w-52 truncate px-2 py-1.5 font-mono text-[12px]" title={f.expression}>{f.expression}</td>
                  <td className="px-2 py-1.5">
                    <select
                      className="h-7 rounded border border-border bg-background px-1 text-[12px]"
                      value={f.status}
                      onChange={(e) => void changeStatus(f.id, e.target.value as FactorStatus)}
                    >
                      {["Candidate", "Validated", "Paper", "Live", "Degraded", "Retired"].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
