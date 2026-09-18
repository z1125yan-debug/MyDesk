"use client";
// 量化研究 — 因子挖掘 Tab（Phase 2/3）：配置漏斗 → 启动任务 → 进度 → 结果
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";

interface JobView {
  id: string;
  kind: string;
  status: string;
  progress: number;
  stage: string;
  message: string;
  error: string;
  result: Record<string, unknown>;
}

interface AcceptedRow {
  candidate: { factorKey: string; name: string; category: string };
  normalizedExpression: string;
  reason: string;
  metrics?: { rankIc: number; icIr: number; stability: number; longShortReturn: number; turnover: number };
}

const inputCls = "h-8 rounded-md border border-border bg-background px-2 text-[13px]";

export function MiningTab() {
  const { toast } = useToast();
  const [source, setSource] = useState<"em" | "demo">("em");
  const [kind, setKind] = useState<"all" | "industry" | "concept" | "custom">("all");
  const [boardCode, setBoardCode] = useState("");
  const [lookback, setLookback] = useState(240);
  const [maxSymbols, setMaxSymbols] = useState(80);
  const [limit, setLimit] = useState(32);
  const [minAbsRankIc, setMinAbsRankIc] = useState(0.02);
  const [minIcIr, setMinIcIr] = useState(0.3);
  const [minStability, setMinStability] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobView | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async (jobId: string) => {
    const r = await fetch(`/api/quant/mining?jobId=${jobId}`);
    const j = await r.json();
    setJob(j.job ?? null);
    if (j.job && ["done", "failed", "cancelled"].includes(j.job.status) && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      if (j.job.status === "failed") toast({ title: "挖掘任务失败", description: j.job.error });
      else if (j.job.status === "done") toast({ title: "挖掘完成", description: j.job.message });
    }
  }, [toast]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const start = async () => {
    setBusy(true);
    try {
      const body = {
        source, kind, boardCode: boardCode || undefined,
        lookback, maxSymbols, limit,
        config: { preliminary: { minAbsRankIc, minIcIr, keep: 24 }, fine: { minStability, maxTurnover: 0.9, keep: 10, redundancyThreshold: 0.85 } },
      };
      const r = await fetch("/api/quant/mining", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.error) { toast({ title: "启动失败", description: j.error }); return; }
      toast({ title: j.duplicate ? "相同任务已在进行中" : "挖掘任务已启动", description: j.jobId });
      setJob(j.job ?? null);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => void poll(j.jobId), 2500);
      void poll(j.jobId);
    } finally {
      setBusy(false);
    }
  };

  const funnel = (job?.result?.funnel ?? null) as Record<string, number> | null;
  const accepted = (job?.result?.accepted ?? []) as AcceptedRow[];
  const rejected = (job?.result?.rejected ?? []) as { factorKey: string; status: string; reason: string }[];

  return (
    <div className="space-y-3 pt-3">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">挖掘配置（Candidate → 初筛 → 精筛 → 入库，逐级收敛）</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <label className="text-[11.5px] text-muted-foreground">数据源
            <select className={inputCls + " mt-1 w-full"} value={source} onChange={(e) => setSource(e.target.value as "em" | "demo")}>
              <option value="em">em 真实行情</option>
              <option value="mcp">mcp (china-stock-mcp)</option>
              <option value="demo">demo 演示</option>
            </select>
          </label>
          <label className="text-[11.5px] text-muted-foreground">股票池
            <select className={inputCls + " mt-1 w-full"} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="all">全A股</option>
              <option value="industry">行业</option>
              <option value="concept">概念</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          {kind === "industry" || kind === "concept" ? (
            <label className="text-[11.5px] text-muted-foreground">板块代码（BKxxxx）
              <input className={inputCls + " mt-1 w-full"} value={boardCode} onChange={(e) => setBoardCode(e.target.value)} placeholder="如 BK0475" />
            </label>
          ) : null}
          <label className="text-[11.5px] text-muted-foreground">K线根数 {lookback}
            <input type="range" min={80} max={400} step={20} value={lookback} onChange={(e) => setLookback(+e.target.value)} className="mt-2 w-full" />
          </label>
          <label className="text-[11.5px] text-muted-foreground">样本股票数 {maxSymbols}
            <input type="range" min={20} max={200} step={10} value={maxSymbols} onChange={(e) => setMaxSymbols(+e.target.value)} className="mt-2 w-full" />
          </label>
          <label className="text-[11.5px] text-muted-foreground">候选上限 {limit}
            <input type="range" min={8} max={80} step={4} value={limit} onChange={(e) => setLimit(+e.target.value)} className="mt-2 w-full" />
          </label>
          <label className="text-[11.5px] text-muted-foreground">初筛 |RankIC| ≥ {minAbsRankIc}
            <input type="range" min={0.01} max={0.06} step={0.005} value={minAbsRankIc} onChange={(e) => setMinAbsRankIc(+e.target.value)} className="mt-2 w-full" />
          </label>
          <label className="text-[11.5px] text-muted-foreground">初筛 ICIR ≥ {minIcIr}
            <input type="range" min={0.1} max={1.5} step={0.05} value={minIcIr} onChange={(e) => setMinIcIr(+e.target.value)} className="mt-2 w-full" />
          </label>
          <label className="text-[11.5px] text-muted-foreground">精筛稳定性 ≥ {minStability}
            <input type="range" min={0.2} max={1} step={0.05} value={minStability} onChange={(e) => setMinStability(+e.target.value)} className="mt-2 w-full" />
          </label>
          <div className="flex items-end">
            <Button size="sm" disabled={busy} onClick={() => void start()} className="w-full">
              {busy ? "启动中…" : "开始挖掘"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {job && (
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              任务 <span className="font-mono text-[11px] text-muted-foreground">{job.id}</span>
              <Badge variant="outline" className="text-[11px]">{job.status}</Badge>
              <span className="ml-auto text-[11.5px] text-muted-foreground">{job.stage || job.message}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress value={job.progress} className="h-2" />
            {job.error && <div className="text-[12px] text-red-300">失败原因：{job.error}</div>}
            {funnel && (
              <div className="flex flex-wrap gap-2 text-[11.5px]">
                <Badge variant="outline">生成 {funnel.generated}</Badge>
                <Badge variant="outline" className="text-red-300 border-red-500/30">审计未过 {funnel.auditFailed}</Badge>
                <Badge variant="outline" className="text-amber-300 border-amber-500/30">初筛未过 {funnel.preliminaryFailed}</Badge>
                <Badge variant="outline" className="text-amber-300 border-amber-500/30">冗余淘汰 {funnel.redundant}</Badge>
                <Badge variant="outline" className="text-amber-300 border-amber-500/30">精筛未过 {funnel.fineFailed}</Badge>
                <Badge variant="outline" className="text-emerald-300 border-emerald-500/30">通过 {funnel.accepted}</Badge>
                <Badge variant="outline" className="text-sky-300 border-sky-500/30">入库 {funnel.saved ?? (job.result?.saved as unknown[] | undefined)?.length ?? 0}</Badge>
              </div>
            )}
            {accepted.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-[12px]">
                  <thead className="bg-card text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-normal">通过因子</th>
                      <th className="px-2 py-1.5 text-right font-normal">RankIC</th>
                      <th className="px-2 py-1.5 text-right font-normal">ICIR</th>
                      <th className="px-2 py-1.5 text-right font-normal">稳定性</th>
                      <th className="px-2 py-1.5 text-right font-normal">多空年化</th>
                      <th className="px-2 py-1.5 text-right font-normal">换手</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accepted.map((a) => (
                      <tr key={a.candidate.factorKey} className="border-t border-border/60" title={a.normalizedExpression}>
                        <td className="px-2 py-1.5 font-mono">{a.candidate.factorKey}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{((a.metrics?.rankIc ?? 0) * 100).toFixed(2)}%</td>
                        <td className="px-2 py-1.5 text-right font-mono">{a.metrics?.icIr.toFixed(2)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{a.metrics?.stability.toFixed(2)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{((a.metrics?.longShortReturn ?? 0) * 100).toFixed(1)}%</td>
                        <td className="px-2 py-1.5 text-right font-mono">{((a.metrics?.turnover ?? 0) * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rejected.length > 0 && (
              <details className="text-[12px]">
                <summary className="cursor-pointer text-muted-foreground">淘汰明细（{rejected.length}，含失败原因）</summary>
                <div className="mt-1 max-h-44 space-y-1 overflow-y-auto">
                  {rejected.map((r) => (
                    <div key={r.factorKey} className="rounded border border-border/60 px-2 py-1">
                      <span className="font-mono text-[11px]">{r.factorKey}</span>
                      <Badge variant="outline" className="ml-1 text-[10px]">{r.status}</Badge>
                      <div className="text-[11px] text-muted-foreground">{r.reason}</div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
