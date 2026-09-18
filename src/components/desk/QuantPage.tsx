"use client";
// Quant Research Lab 页面（新增页面，不改任何现有页面）
// Phase 1：框架状态（数据源/DB/任务）；后续 Phase 逐 Tab 填充
// 因子库 / 因子挖掘 / 选股 / 回测 / 实验 / 研究 / 知识库。
import { useCallback, useEffect, useState } from "react";
import { FlaskConical, RefreshCw, Pause, Play, Square, Database, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { FactorsTab } from "./quant/FactorsTab";
import { MiningTab } from "./quant/MiningTab";
import { BacktestTab, SelectionTab, ExperimentsTab, KnowledgeTab, ResearchTab } from "./quant/LabTabs";

interface Health {
  ok: boolean;
  db: { counts: { factors: number; strategies: number; experiments: number; knowledge: number } | null; error: string | null };
  providers: { id: string; coverage: { source: string; daily: boolean; minute: boolean; fundamentals: string; universeMembership: string } }[];
  jobs: { total: number; running: number; paused: number; failed: number; done: number };
  ts: string;
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  progress: number;
  stage: string;
  message: string;
  error: string;
  createdAt: string;
}

interface UniverseRow {
  symbol: string;
  name: string;
  industry?: string;
  price?: number;
  marketCap?: number;
  listDate?: string;
  st?: boolean;
  suspended?: boolean;
}

const PHASED_TABS: { key: string; label: string; phase: string; ready: boolean }[] = [
  { key: "overview", label: "实验室状态", phase: "P1", ready: true },
  { key: "factors", label: "因子库", phase: "P3", ready: true },
  { key: "mining", label: "因子挖掘", phase: "P2", ready: true },
  { key: "selection", label: "选股引擎", phase: "P7", ready: true },
  { key: "backtest", label: "回测", phase: "P5", ready: true },
  { key: "experiments", label: "实验跟踪", phase: "P9", ready: true },
  { key: "knowledge", label: "知识库", phase: "P10", ready: true },
  { key: "research", label: "自主研究", phase: "P11", ready: true },
];

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    done: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    running: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    queued: "bg-sky-500/10 text-sky-200/80 border-sky-500/20",
    paused: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    failed: "bg-red-500/15 text-red-300 border-red-500/30",
    cancelled: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  };
  return <Badge variant="outline" className={"text-[11px] " + (map[status] ?? "")}>{status}</Badge>;
}

export default function QuantPage() {
  const { toast } = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [universe, setUniverse] = useState<UniverseRow[]>([]);
  const [source, setSource] = useState<"em" | "demo">("em");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [h, j] = await Promise.all([
        fetch("/api/quant/health").then((r) => r.json()),
        fetch("/api/quant/jobs?limit=20").then((r) => r.json()),
      ]);
      setHealth(h);
      setJobs(j.jobs ?? []);
    } catch {
      toast({ title: "实验室状态获取失败", description: "请确认本地服务已启动" });
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const probeUniverse = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/quant/data/universe?source=${source}&limit=15`);
      const j = await r.json();
      if (j.error) {
        toast({ title: `${source} 数据源探测失败`, description: j.error });
        setUniverse([]);
      } else {
        setUniverse(j.rows ?? []);
        toast({ title: `${source} 数据源正常`, description: `股票池 ${j.total} 只，过滤后 ${j.kept} 只` });
      }
    } catch (e) {
      toast({ title: "探测失败", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [source, toast]);

  const jobAction = useCallback(async (id: string, action: "pause" | "resume" | "cancel") => {
    await fetch("/api/quant/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    void refresh();
  }, [refresh]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 shadow-md shadow-sky-500/20">
          <FlaskConical size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-lg font-bold">Quant Research Lab</h1>
          <p className="text-xs text-muted-foreground">
            因子 → 策略 → 选股 → 历史回放 → 回测 → OOS 验证 → 实时选股 → 监控 → 再研究
          </p>
        </div>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void refresh()}>
          <RefreshCw size={14} className="mr-1" /> 刷新
        </Button>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="flex flex-wrap">
          {PHASED_TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="text-[12.5px]">
              {t.label}
              <span className="ml-1 text-[10px] text-muted-foreground">{t.ready ? "" : t.phase}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="space-y-4 pt-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">数据库</CardTitle></CardHeader>
              <CardContent>
                {health?.db.error ? (
                  <div className="text-sm text-red-300">{health.db.error}</div>
                ) : (
                  <div className="text-sm leading-6">
                    <div>因子 <b>{health?.db.counts?.factors ?? "-"}</b> · 策略 <b>{health?.db.counts?.strategies ?? "-"}</b></div>
                    <div>实验 <b>{health?.db.counts?.experiments ?? "-"}</b> · 知识 <b>{health?.db.counts?.knowledge ?? "-"}</b></div>
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">任务</CardTitle></CardHeader>
              <CardContent className="text-sm">
                <div>运行 <b>{health?.jobs.running ?? 0}</b> · 暂停 <b>{health?.jobs.paused ?? 0}</b></div>
                <div>完成 <b>{health?.jobs.done ?? 0}</b> · 失败 <b>{health?.jobs.failed ?? 0}</b></div>
              </CardContent>
            </Card>
            <Card className="md:col-span-2">
              <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">数据源（Data Provider）</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 text-[12.5px]">
                {health?.providers.map((p) => (
                  <div key={p.id} className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[11px]">{p.id}</Badge>
                    <span className="text-muted-foreground">{p.coverage.source}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      日线{p.coverage.daily ? "✓" : "✗"} · 分钟{p.coverage.minute ? "✓" : "✗"} · 基本面={p.coverage.fundamentals}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Database size={15} /> 数据链路探测
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <select
                  className="h-8 rounded-md border border-border bg-background px-2 text-[13px]"
                  value={source}
                  onChange={(e) => setSource(e.target.value as "em" | "demo")}
                >
                  <option value="em">em（腾讯/东财真实行情）</option>
                  <option value="demo">demo（本机演示数据）</option>
                </select>
                <Button size="sm" disabled={busy} onClick={() => void probeUniverse()}>
                  <Activity size={14} className="mr-1" /> {busy ? "探测中…" : "探测股票池"}
                </Button>
                <span className="text-[11.5px] text-muted-foreground">验证 DataProvider → API → UI 全链路</span>
              </div>
              {universe.length > 0 && (
                <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                  <table className="w-full text-[12px]">
                    <thead className="sticky top-0 bg-card text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left font-normal">代码</th>
                        <th className="px-2 py-1.5 text-left font-normal">名称</th>
                        <th className="px-2 py-1.5 text-left font-normal">行业</th>
                        <th className="px-2 py-1.5 text-right font-normal">现价</th>
                        <th className="px-2 py-1.5 text-right font-normal">总市值(亿)</th>
                        <th className="px-2 py-1.5 text-left font-normal">上市</th>
                      </tr>
                    </thead>
                    <tbody>
                      {universe.map((r) => (
                        <tr key={r.symbol} className="border-t border-border/60">
                          <td className="px-2 py-1 font-mono">{r.symbol}</td>
                          <td className="px-2 py-1">{r.name}{r.st && <span className="ml-1 text-red-400">ST</span>}{r.suspended && <span className="ml-1 text-amber-400">停</span>}</td>
                          <td className="px-2 py-1 text-muted-foreground">{r.industry ?? "-"}</td>
                          <td className="px-2 py-1 text-right font-mono">{r.price?.toFixed(2) ?? "-"}</td>
                          <td className="px-2 py-1 text-right font-mono">{r.marketCap ? (r.marketCap / 1e8).toFixed(0) : "-"}</td>
                          <td className="px-2 py-1 text-muted-foreground">{r.listDate ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">长任务（进度 / 暂停 / 恢复 / 失败原因）</CardTitle>
            </CardHeader>
            <CardContent>
              {jobs.length === 0 ? (
                <div className="py-4 text-center text-[12.5px] text-muted-foreground">暂无任务。因子挖掘 / 回测 / 研究任务将在此显示进度。</div>
              ) : (
                <div className="space-y-2">
                  {jobs.map((j) => (
                    <div key={j.id} className="rounded-md border border-border p-2.5 text-[12.5px]">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] text-muted-foreground">{j.id}</span>
                        <Badge variant="outline" className="text-[11px]">{j.kind}</Badge>
                        <StatusBadge status={j.status} />
                        <span className="ml-auto text-muted-foreground">{j.stage || j.kind}</span>
                        {(j.status === "running" || j.status === "queued") && (
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void jobAction(j.id, "pause")}><Pause size={13} /></Button>
                        )}
                        {j.status === "paused" && (
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void jobAction(j.id, "resume")}><Play size={13} /></Button>
                        )}
                        {j.status !== "done" && j.status !== "failed" && j.status !== "cancelled" && (
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void jobAction(j.id, "cancel")}><Square size={13} /></Button>
                        )}
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-accent">
                        <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${j.progress}%` }} />
                      </div>
                      <div className="mt-1 text-[11.5px] text-muted-foreground">
                        {j.error ? <span className="text-red-300">失败原因：{j.error}</span> : j.message || `${j.progress}%`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="factors" className="pt-0"><FactorsTab /></TabsContent>
        <TabsContent value="mining" className="pt-0"><MiningTab /></TabsContent>
        <TabsContent value="selection" className="pt-0"><SelectionTab /></TabsContent>
        <TabsContent value="backtest" className="pt-0"><BacktestTab /></TabsContent>
        <TabsContent value="experiments" className="pt-0"><ExperimentsTab /></TabsContent>
        <TabsContent value="knowledge" className="pt-0"><KnowledgeTab /></TabsContent>
        <TabsContent value="research" className="pt-0"><ResearchTab /></TabsContent>

        {PHASED_TABS.filter((t) => !t.ready).map((t) => (
          <TabsContent key={t.key} value={t.key} className="pt-6">
            <Card>
              <CardContent className="flex flex-col items-center gap-1 py-10 text-center">
                <FlaskConical size={22} className="text-muted-foreground" />
                <div className="text-sm font-medium">{t.label}</div>
                <div className="text-[12px] text-muted-foreground">将在 {t.phase} 阶段启用（框架已就绪）</div>
              </CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
