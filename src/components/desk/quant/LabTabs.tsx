"use client";
// 量化研究 — 回测/选股/实验/知识库/自主研究 Tab（Phase 4-11 UI）
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { jobLookupVerdict, type JobLookup } from "@/lib/desk/backtest-core";
// P13 门户轮：因子 pill 中文化（展示换脸、协议不换——选择串仍是 key@version[，权重，方向]）
import { groupFactorsByCategory, pillLabel, pillTitle, type PillFactor } from "@/lib/quant/screener/factor-pill-core";

const inputCls = "h-8 rounded-md border border-border bg-background px-2 text-[13px]";

interface JobView {
  id: string; kind: string; status: string; progress: number; stage: string; message: string; error: string;
  result: Record<string, unknown>;
}

export type { JobView };

/**
 * 任务轮询（2.5 秒一次，跑完就停）。
 * P7-⑧④ 起对话链路也用这一份：回测结果在对话里画的就是量化页那张卡，
 * 再写一套轮询就会有两边进度节拍不同、一边显示完成一边还在转的可能。
 *
 * `missing` 是这一轮新加的第三种收尾：任务号问不出东西时不能一直问下去。
 * 判定（404/「不存在」= 没了；其余 = 这次没问出来、继续按节拍问）在 backtest-core.jobLookupVerdict，
 * 不在组件里写正则 —— 客户端组件里长口径，回头服务端那份就对不上了。
 */
export function useJobPoll(kind: string) {
  const [job, setJob] = useState<JobView | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);
  const poll = useCallback(async (jobId: string) => {
    let verdict: JobLookup;
    try {
      const r = await fetch(`/api/quant/${kind}?jobId=${jobId}`);
      verdict = jobLookupVerdict(r.status, (await r.json().catch(() => null)) as { job?: unknown; error?: unknown } | null);
    } catch {
      verdict = { kind: "unknown" }; // 网络断了不等于任务没了：留着节拍下次再问
    }
    if (verdict.kind === "missing") {
      stop();
      setMissing(verdict.reason);
      setJob(null);
      return;
    }
    if (verdict.kind === "job") {
      setMissing(null);
      setJob(verdict.job as unknown as JobView);
      if (["done", "failed", "cancelled"].includes(verdict.job.status as string)) stop();
    }
  }, [kind, stop]);
  useEffect(() => stop, [stop]);
  const startPolling = useCallback((jobId: string) => {
    stop();
    setMissing(null);
    pollRef.current = setInterval(() => void poll(jobId), 2500);
    void poll(jobId);
  }, [poll, stop]);
  return { job, setJob, startPolling, missing };
}

/** 任务状态卡（进度条 + 阶段 + 失败原因 + 各 Tab 自己塞进来的结果区） */
export function JobPanel({ job, extra }: { job: JobView | null; extra?: React.ReactNode }) {
  if (!job) return null;
  return (
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
        {extra}
      </CardContent>
    </Card>
  );
}

function pct(v: unknown, d = 1): string {
  return typeof v === "number" && isFinite(v) ? (v * 100).toFixed(d) + "%" : "-";
}
function num(v: unknown, d = 2): string {
  return typeof v === "number" && isFinite(v) ? v.toFixed(d) : "-";
}

/**
 * P13 门户轮：因子 pill 分组（选股/回测两个 Tab 共用一份渲染）。
 * 展示层口径：中文 name 优先、无 name 回退 key（不硬造翻译）；按 category 中文分组；
 * hover title 保留 factorKey@version——中文化是换脸不是藏身份。
 * **选择串由调用方给**：协议（key@version / key@version,权重,方向）一个字没动。
 */
function FactorPillGrid({ factors, isSelected, onToggle, emptyText }: {
  factors: PillFactor[];
  isSelected: (f: PillFactor) => boolean;
  onToggle: (f: PillFactor) => void;
  emptyText?: string;
}) {
  if (!factors.length) return <span className="text-[12px] text-muted-foreground">{emptyText ?? "因子库为空"}</span>;
  return (
    <div className="space-y-1.5">
      {groupFactorsByCategory(factors).map((g) => (
        <div key={g.category || "none"} className="flex flex-wrap items-start gap-1.5">
          <span className="w-16 shrink-0 pt-1.5 text-right text-[10.5px] text-muted-foreground/80">{g.label}</span>
          <span className="flex flex-wrap gap-1.5">
            {g.factors.map((f) => {
              const active = isSelected(f);
              return (
                <Badge key={`${f.factorKey}@${f.version}`} variant="outline" title={pillTitle(f)}
                  className={"cursor-pointer text-[11px] " + (active ? "border-sky-500/50 bg-sky-500/15 text-sky-200" : "")}
                  onClick={() => onToggle(f)}>
                  {pillLabel(f)}<span className="ml-1 opacity-60">v{f.version}</span>
                </Badge>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 回测结果卡 —— 全工程唯一一份回测渲染（任务状态 + 12 项指标网格）。
 * P7-⑧④：对话链路里 run_backtest 带回的 jobId 也画这一张。
 * 任务书的原话是「回测结果直接复用现有量化工具页的回测组件渲染，不重新写渲染逻辑」，
 * 所以这里做的是「把原来内联在回测 Tab 里的那段抽出来」，不是「再抄一份」。
 * 本层不换算任何指标：网格画的就是引擎 result.metrics 那一份，pct/num 只负责显示格式。
 */
export function BacktestJobCard({ job }: { job: JobView | null }) {
  const result = job?.result as Record<string, unknown> | null;
  const metrics = (result?.metrics ?? null) as Record<string, number> | null;
  const validation = (result?.validation ?? null) as {
    verdict: string; overfitFlags: string[];
    oos: { decayRatio: number; isMetrics: Record<string, number>; oosMetrics: Record<string, number> };
  } | null;
  return (
    <JobPanel job={job} extra={metrics && (
      <div className="grid grid-cols-3 gap-2 text-[12px] md:grid-cols-6">
        <div>年化 <b>{pct(metrics.annualReturn)}</b></div>
        <div>Sharpe <b>{num(metrics.sharpe)}</b></div>
        <div>Sortino <b>{num(metrics.sortino)}</b></div>
        <div>Calmar <b>{num(metrics.calmar)}</b></div>
        <div>最大回撤 <b className="text-red-300">{pct(metrics.maxDrawdown)}</b></div>
        <div>胜率 <b>{pct(metrics.winRate, 0)}</b></div>
        <div>盈亏比 <b>{num(metrics.payoffRatio)}</b></div>
        <div>交易次数 <b>{metrics.tradeCount}</b></div>
        <div>换手 <b>{num(metrics.turnover, 1)}x</b></div>
        <div>成本占比 <b>{pct(metrics.transactionCost, 2)}</b></div>
        <div>稳定性 <b>{num(metrics.stability)}</b></div>
        <div>综合分 <b className="text-sky-300">{num(result?.compositeScore, 3)}</b></div>
        {validation && (
          <>
            <div className="md:col-span-3">验证结论 <b>{validation.verdict}</b> · OOS/IS 衰减 {pct(validation.oos.decayRatio, 0)}</div>
            <div className="md:col-span-3 text-amber-300">{validation.overfitFlags.join("；") || "无过拟合信号"}</div>
          </>
        )}
      </div>
    )} />
  );
}

// ---------- 回测 Tab ----------

export function BacktestTab() {
  const { toast } = useToast();
  const [factors, setFactors] = useState<{ factorKey: string; version: number; status: string; name?: string; category?: string }[]>([]);
  const [sel, setSel] = useState<string>(""); // factorKey@version,weight,dir;...
  const [topN, setTopN] = useState(10);
  const [rebalance, setRebalance] = useState(5);
  const [periodDays, setPeriodDays] = useState(240);
  const [maxSymbols, setMaxSymbols] = useState(60);
  const [source, setSource] = useState("demo");
  const [validate, setValidate] = useState(true);
  const [busy, setBusy] = useState(false);
  const { job, setJob, startPolling } = useJobPoll("backtest");

  useEffect(() => {
    void fetch("/api/quant/factors?latestOnly=1").then((r) => r.json()).then((j) => setFactors(j.factors ?? [])).catch(() => undefined);
  }, []);

  const start = async () => {
    const list = sel.split(";").filter(Boolean).map((s) => {
      const [kv, w, d] = s.split(",");
      const [factorKey, version] = kv.split("@");
      return { factorKey, version: parseInt(version, 10) || 1, weight: parseFloat(w) || 1, direction: (parseInt(d, 10) || 1) as 1 | -1 };
    });
    if (!list.length) { toast({ title: "请至少选择一个因子" }); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/quant/backtest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, factors: list, topN, rebalanceEvery: rebalance, periodDays, maxSymbols, validate, split: { train: 0.6, validation: 0.2, test: 0.2 } }),
      });
      const j = await r.json();
      if (j.error) { toast({ title: "启动失败", description: j.error }); return; }
      toast({ title: "回测任务已启动", description: j.jobId });
      setJob(null);
      startPolling(j.jobId);
    } finally { setBusy(false); }
  };

  // 结果区已经抽到 BacktestJobCard（对话链路共用同一份渲染），这里不再本地解一遍指标

  return (
    <div className="space-y-3 pt-3">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">组合回测（佣金/印花税/滑点/涨跌停/停牌/量与流动性约束 + Walk-forward/OOS）</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 md:grid-cols-3">
          <label className="text-[11.5px] text-muted-foreground">数据源
            <select className={inputCls + " mt-1 w-full"} value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="demo">demo 演示</option>
              <option value="em">em 真实行情</option>
              <option value="mcp">mcp (china-stock-mcp)</option>
            </select>
          </label>
          <label className="text-[11.5px] text-muted-foreground">取前 {topN} 只
            <input type="range" min={3} max={30} value={topN} onChange={(e) => setTopN(+e.target.value)} className="mt-2 w-full" />
          </label>
          <label className="text-[11.5px] text-muted-foreground">调仓周期 {rebalance} 日
            <input type="range" min={1} max={20} value={rebalance} onChange={(e) => setRebalance(+e.target.value)} className="mt-2 w-full" />
          </label>
          <label className="text-[11.5px] text-muted-foreground">回测长度 {periodDays} 日
            <input type="range" min={80} max={400} step={20} value={periodDays} onChange={(e) => setPeriodDays(+e.target.value)} className="mt-2 w-full" />
          </label>
          <label className="text-[11.5px] text-muted-foreground">样本股票 {maxSymbols}
            <input type="range" min={20} max={200} step={10} value={maxSymbols} onChange={(e) => setMaxSymbols(+e.target.value)} className="mt-2 w-full" />
          </label>
          <label className="flex items-end gap-2 text-[11.5px] text-muted-foreground">
            <input type="checkbox" checked={validate} onChange={(e) => setValidate(e.target.checked)} />
            启用 Walk-forward/OOS 验证
          </label>
          <div className="md:col-span-3">
            <div className="text-[11.5px] text-muted-foreground">选择因子（可多选；格式 key@version,权重,方向）</div>
            <div className="mt-1">
              <FactorPillGrid
                factors={factors}
                emptyText="因子库为空，先去挖掘"
                isSelected={(f) => sel.includes(`${f.factorKey}@${f.version},1,1`)}
                onToggle={(f) => {
                  const tag = `${f.factorKey}@${f.version},1,1`;
                  const active = sel.includes(tag);
                  setSel(active ? sel.replace(tag + ";", "").replace(tag, "") : sel + tag + ";");
                }}
              />
            </div>
          </div>
          <div className="md:col-span-3">
            <Button size="sm" disabled={busy} onClick={() => void start()}>{busy ? "启动中…" : "开始回测"}</Button>
          </div>
        </CardContent>
      </Card>

      <BacktestJobCard job={job} />
    </div>
  );
}

// ---------- 选股 Tab ----------

export function SelectionTab() {
  const { toast } = useToast();
  const [factors, setFactors] = useState<{ factorKey: string; version: number; name?: string; category?: string }[]>([]);
  const [sel, setSel] = useState<string>("");
  const [asOf, setAsOf] = useState("");
  const [topN, setTopN] = useState(10);
  const [replay, setReplay] = useState(false);
  const [horizon, setHorizon] = useState(5);
  const [source, setSource] = useState("demo");
  const [busy, setBusy] = useState(false);
  const { job, setJob, startPolling } = useJobPoll("selection");

  useEffect(() => {
    void fetch("/api/quant/factors?latestOnly=1").then((r) => r.json()).then((j) => setFactors(j.factors ?? [])).catch(() => undefined);
  }, []);

  const start = async () => {
    const list = sel.split(";").filter(Boolean).map((s) => {
      const [factorKey, version] = s.split("@");
      return { factorKey, version: parseInt(version, 10) || 1, weight: 1, direction: 1 as const };
    });
    if (!list.length) { toast({ title: "请至少选择一个因子" }); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/quant/selection", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source, replay, horizon,
          mode: "multi_factor", asOf: replay ? asOf : undefined,
          universe: { kind: "all" }, filters: { excludeST: true, excludeSuspended: true },
          factors: list, scoring: { method: "rank", topN },
        }),
      });
      const j = await r.json();
      if (j.error) { toast({ title: "启动失败", description: j.error }); return; }
      toast({ title: replay ? "历史回放已启动" : "实时选股已启动", description: j.jobId });
      setJob(null);
      startPolling(j.jobId);
    } finally { setBusy(false); }
  };

  const result = job?.result as Record<string, unknown> | null;
  const rows = (result?.rows ?? (result?.selection as { rows?: Record<string, unknown>[] } | null)?.rows ?? []) as Record<string, unknown>[];
  const picks = (result?.picks ?? null) as Record<string, unknown>[] | null;
  const stats = (result?.stats ?? null) as Record<string, number | null> | null;

  return (
    <div className="space-y-3 pt-3">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">选股引擎（实时与历史回放共用同一实现）</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 md:grid-cols-3">
          <label className="text-[11.5px] text-muted-foreground">数据源
            <select className={inputCls + " mt-1 w-full"} value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="demo">demo 演示</option>
              <option value="em">em 真实行情</option>
              <option value="mcp">mcp (china-stock-mcp)</option>
            </select>
          </label>
          <label className="flex items-end gap-2 text-[12px]">
            <input type="checkbox" checked={replay} onChange={(e) => setReplay(e.target.checked)} />历史回放模式
          </label>
          {replay && (
            <label className="text-[11.5px] text-muted-foreground">回放日期（早于今天）
              <input type="date" className={inputCls + " mt-1 w-full"} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </label>
          )}
          <label className="text-[11.5px] text-muted-foreground">取前 {topN} 只
            <input type="range" min={3} max={30} value={topN} onChange={(e) => setTopN(+e.target.value)} className="mt-2 w-full" />
          </label>
          {replay && (
            <label className="text-[11.5px] text-muted-foreground">未来窗口 {horizon} 日
              <input type="range" min={1} max={20} value={horizon} onChange={(e) => setHorizon(+e.target.value)} className="mt-2 w-full" />
            </label>
          )}
          <div className="md:col-span-3">
            <FactorPillGrid
              factors={factors}
              emptyText="因子库为空"
              isSelected={(f) => sel.includes(`${f.factorKey}@${f.version}`)}
              onToggle={(f) => {
                const tag = `${f.factorKey}@${f.version}`;
                const active = sel.includes(tag);
                setSel(active ? sel.replace(tag + ";", "").replace(tag, "") : sel + tag + ";");
              }}
            />
          </div>
          <div className="md:col-span-3">
            <Button size="sm" disabled={busy} onClick={() => void start()}>{busy ? "启动中…" : replay ? "开始回放" : "开始选股"}</Button>
          </div>
        </CardContent>
      </Card>

      <JobPanel job={job} extra={stats && (
        <div className="text-[12px]">回放统计：{picks?.length} 只 · 平均未来收益 <b>{pct(stats.avgForwardReturn, 2)}</b> · 胜率 <b>{pct(stats.winRate, 0)}</b></div>
      )} />

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-[12px]">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-normal">排名</th>
                <th className="px-2 py-1.5 text-left font-normal">代码</th>
                <th className="px-2 py-1.5 text-left font-normal">名称</th>
                <th className="px-2 py-1.5 text-right font-normal">得分</th>
                <th className="px-2 py-1.5 text-left font-normal">触发因子</th>
                <th className="px-2 py-1.5 text-left font-normal">理由</th>
                {picks && <th className="px-2 py-1.5 text-right font-normal">未来收益</th>}
                <th className="px-2 py-1.5 text-left font-normal">风险</th>
              </tr>
            </thead>
            <tbody>
              {(picks ? picks.map((p) => ({ code: p.code, name: p.name, rank: p.rank, score: p.score, forwardReturn: p.forwardReturn })) : rows).map((r, i) => (
                <tr key={String(r.code)} className="border-t border-border/60">
                  <td className="px-2 py-1">{String(r.rank ?? i + 1)}</td>
                  <td className="px-2 py-1 font-mono">{String(r.code)}</td>
                  <td className="px-2 py-1">{String(r.name)}</td>
                  <td className="px-2 py-1 text-right font-mono">{num(r.score as number, 4)}</td>
                  <td className="px-2 py-1">{Array.isArray(r.triggeredFactors) ? (r.triggeredFactors as string[]).join(",") : "-"}</td>
                  <td className="max-w-52 truncate px-2 py-1 text-[11px] text-muted-foreground" title={String(r.reason ?? "")}>{String(r.reason ?? "")}</td>
                  {picks && <td className={"px-2 py-1 text-right font-mono " + ((r.forwardReturn as number) >= 0 ? "text-red-300" : "text-emerald-300")}>{pct(r.forwardReturn, 2)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- 实验 Tab ----------

interface ExperimentRow {
  id: string; fingerprint: string; kind: string; startedAt: string; dataRange: string;
  factorVersions: string; strategyVersion: string; status: string; failureReason: string;
}

export function ExperimentsTab() {
  const [rows, setRows] = useState<ExperimentRow[]>([]);
  useEffect(() => {
    const load = () => void fetch("/api/quant/experiments?limit=50").then((r) => r.json()).then((j) => setRows(j.experiments ?? [])).catch(() => undefined);
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-2 pt-3">
      <div className="text-[11.5px] text-muted-foreground">实验指纹去重：同输入（数据区间/股票池/因子版本/参数/成本）的实验不会重复执行。</div>
      {rows.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-[13px] text-muted-foreground">暂无实验记录</CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-[12px]">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-normal">时间</th>
                <th className="px-2 py-1.5 text-left font-normal">类型</th>
                <th className="px-2 py-1.5 text-left font-normal">状态</th>
                <th className="px-2 py-1.5 text-left font-normal">数据区间</th>
                <th className="px-2 py-1.5 text-left font-normal">因子版本</th>
                <th className="px-2 py-1.5 text-left font-normal">失败原因</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="px-2 py-1 font-mono text-[11px]">{r.startedAt.slice(0, 19).replace("T", " ")}</td>
                  <td className="px-2 py-1">{r.kind}</td>
                  <td className="px-2 py-1"><Badge variant="outline" className={"text-[10.5px] " + (r.status === "done" ? "text-emerald-300 border-emerald-500/30" : r.status === "failed" ? "text-red-300 border-red-500/30" : "")}>{r.status}</Badge></td>
                  <td className="px-2 py-1">{r.dataRange || "-"}</td>
                  <td className="max-w-40 truncate px-2 py-1 font-mono text-[11px]" title={r.factorVersions}>{r.factorVersions || "-"}</td>
                  <td className="max-w-52 truncate px-2 py-1 text-[11px] text-red-300" title={r.failureReason}>{r.failureReason || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- 知识库 Tab ----------

interface KnowledgeRow { id: string; kind: string; title: string; content: string; active: boolean; updatedAt: string }

export function KnowledgeTab() {
  const [rows, setRows] = useState<KnowledgeRow[]>([]);
  const [kind, setKind] = useState("");
  const load = useCallback(() => {
    void fetch(`/api/quant/knowledge${kind ? `?kind=${kind}` : ""}`).then((r) => r.json()).then((j) => setRows(j.entries ?? [])).catch(() => undefined);
  }, [kind]);
  useEffect(load, [load]);
  const KIND_LABEL: Record<string, string> = {
    valid_factor: "有效因子", invalid_factor: "无效因子", tested_param: "已试参数",
    failed_strategy: "失败策略", retired_strategy: "退役策略", experiment_note: "实验备注",
    market_env: "市场环境", current_strategy: "当前策略",
  };
  return (
    <div className="space-y-2 pt-3">
      <div className="flex items-center gap-2">
        <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部类型</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="text-[11.5px] text-muted-foreground">Agent 开始新研究前会自动查询本库，避免重复失败实验</span>
      </div>
      {rows.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-[13px] text-muted-foreground">知识库为空（挖掘/研究会自动沉淀条目）</CardContent></Card>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.id} className={"rounded-md border border-border px-3 py-2 text-[12.5px] " + (r.active ? "" : "opacity-40")}>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10.5px]">{KIND_LABEL[r.kind] ?? r.kind}</Badge>
                <span className="font-mono text-[11.5px]">{r.title}</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground">{r.updatedAt.slice(0, 10)}</span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">{r.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 自主研究 Tab ----------

export function ResearchTab() {
  const { toast } = useToast();
  const [source, setSource] = useState("demo");
  const [goal, setGoal] = useState("研究一个A股短线选股策略");
  const [busy, setBusy] = useState(false);
  const [pipeline, setPipeline] = useState<{ step: string; detail: string }[]>([]);
  const { job, setJob, startPolling } = useJobPoll("research");

  const start = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/quant/research", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, source }),
      });
      const j = await r.json();
      if (j.error) { toast({ title: "启动失败", description: j.error }); return; }
      toast({ title: "自主研究已启动", description: j.jobId });
      setPipeline([]);
      setJob(null);
      startPolling(j.jobId);
    } finally { setBusy(false); }
  };

  useEffect(() => {
    const p = job?.result?.pipeline as { step: string; detail: string }[] | undefined;
    if (p?.length) setPipeline(p);
  }, [job]);

  const result = job?.result as Record<string, unknown> | null;
  const failure = (result?.failure ?? null) as { reason: string; evidence: string; failedMetric: string; overfitPossible: boolean; nextSuggestions: string[] } | null;
  const strategy = (result?.strategy ?? null) as { strategyKey: string; version: number; status: string } | null;
  const live = (result?.liveSelection ?? null) as { rows: Record<string, unknown>[] } | null;

  return (
    <div className="space-y-3 pt-3">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Agent 自主研究（查知识库 → 生成 → 漏斗 → 策略 → 回放 → 回测 → 验证 → 选股 → 监控）</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <input className={inputCls + " flex-1"} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="研究目标" />
          <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="demo">demo 演示</option>
            <option value="em">em 真实行情</option>
              <option value="mcp">mcp (china-stock-mcp)</option>
          </select>
          <Button size="sm" disabled={busy} onClick={() => void start()}>{busy ? "启动中…" : "开始自主研究"}</Button>
        </CardContent>
      </Card>

      <JobPanel job={job} extra={strategy && (
        <div className="text-[12px]">
          策略产出：<b className="font-mono">{strategy.strategyKey}@{strategy.version}</b> 状态 <b>{strategy.status}</b>
          {live && <span> · 实时选股 {live.rows.length} 只（{live.rows.slice(0, 5).map((r) => r.code).join(", ")}…）</span>}
        </div>
      )} />

      {failure && (
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-red-300">结构化失败报告</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-[12.5px]">
            <div>失败原因：{failure.reason}</div>
            <div>数据证据：{failure.evidence}</div>
            <div>失败指标：{failure.failedMetric}</div>
            <div>可能过拟合：{failure.overfitPossible ? "是" : "未发现"}</div>
            <div className="mt-1">下一步建议：</div>
            <ul className="list-disc pl-5">{failure.nextSuggestions.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </CardContent>
        </Card>
      )}

      {pipeline.length > 0 && (
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm">研究流水线（20 步闭环）</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {pipeline.map((p, i) => (
              <div key={i} className="flex gap-2 text-[12px]">
                <span className="w-8 shrink-0 font-mono text-muted-foreground">{p.step}</span>
                <span>{p.detail}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
