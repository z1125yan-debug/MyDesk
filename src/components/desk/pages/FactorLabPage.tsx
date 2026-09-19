"use client";
// 因子有效性测试台（P1-4，需求文档 五/三十）：选因子 → 跑测试 → IC/分层/月度胜率/回撤 + 历史记录
// 通过标准（硬性）：|ICIR|>0.5 或 分层单调显著，且 月度胜率>60% → catalog 中该因子 verified 徽章自动转「已验证」。
import { useState, useEffect, useCallback } from "react";
import { Microscope, Loader2 } from "lucide-react";
import { NumText } from "../SourceBadge";
import {
  fetchFactorCatalog, runFactorTestApi, fetchFactorTests,
  type FactorFieldDef, type FactorTestResultClient,
} from "@/lib/desk/quant-api";

interface LatestTest extends FactorTestResultClient {
  id?: string;
  monthlyIc?: { month: string; rankIc: number }[];
}

export default function FactorLabPage() {
  const [catalog, setCatalog] = useState<{ fields: FactorFieldDef[]; category: Record<string, string[]> } | null>(null);
  const [field, setField] = useState("rps_50");
  const [horizon, setHorizon] = useState(5);
  const [maxStocks, setMaxStocks] = useState(300);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LatestTest | null>(null);
  const [history, setHistory] = useState<LatestTest[]>([]);

  useEffect(() => {
    fetchFactorCatalog().then(setCatalog).catch((e) => setError(String((e as Error).message || e)));
    fetchFactorTests().then((j) => setHistory(j.tests as LatestTest[])).catch(() => { /* 首次无记录 */ });
  }, []);

  const loadHistory = useCallback((f: string) => {
    fetchFactorTests(f).then((j) => setHistory(j.tests as LatestTest[])).catch(() => setHistory([]));
  }, []);

  const run = async () => {
    setBusy(true); setError("");
    try {
      const r = await runFactorTestApi({ field, horizon, maxStocks });
      setResult(r);
      await Promise.all([
        fetchFactorTests(field).then((j) => setHistory(j.tests as LatestTest[])),
        fetchFactorCatalog().then(setCatalog), // verified 徽章即时刷新
      ]);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const def = catalog?.fields.find((f) => f.key === field);
  const verifiedCount = catalog?.fields.filter((f) => f.verified).length ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-4">
      <div>
        <div className="flex items-center gap-2 text-lg font-bold"><Microscope size={18} className="text-sky-400" /> 因子有效性测试台</div>
        <div className="text-[11px] text-muted-foreground">
          口径：t 日因子值 ↔ t+{horizon} 日前向收益（防泄漏）· 样本=全A剔ST/停牌按流动性Top-N · 快照口径字段拒绝测试 ·
          通过标准 |ICIR|&gt;0.5 或 分层单调显著，且 月度胜率&gt;60% · 已验证 {verifiedCount}/{catalog?.fields.length ?? "…"}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        {/* 因子选择 */}
        <div className="space-y-3 rounded-xl border border-border bg-card p-3">
          {catalog?.category
            ? Object.entries(catalog.category).map(([cat, keys]) => (
              <div key={cat}>
                <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/70">{cat}</div>
                <div className="space-y-0.5">
                  {keys.map((k) => {
                    const f = catalog.fields.find((x) => x.key === k);
                    const disabled = f?.source !== "kline";
                    return (
                      <button key={k} onClick={() => { if (!disabled) { setField(k); loadHistory(k); } }} disabled={disabled}
                        title={disabled ? "快照口径字段：无历史时点数据，不可测" : f?.zh}
                        className={
                          "flex w-full items-center gap-1.5 rounded px-2 py-1 text-[11.5px] transition-colors " +
                          (field === k ? "bg-sky-500/10 text-sky-300 font-medium" : disabled ? "text-muted-foreground/40" : "text-muted-foreground hover:bg-accent hover:text-foreground")
                        }>
                        <span className="truncate">{f?.zh ?? k}</span>
                        {f?.verified && <span className="ml-auto rounded bg-emerald-500/15 px-1 text-[9px] text-emerald-400">已验证</span>}
                        {disabled && !f?.verified && <span className="ml-auto text-[9px] text-muted-foreground/50">快照</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
            : <div className="py-6 text-center text-xs text-muted-foreground">{error || "加载因子目录…"}</div>}
        </div>

        {/* 参数 + 结果 */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-xs">
            <span>因子 <span className="font-mono text-sky-300">{def?.zh ?? field}</span>（{field}）</span>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              前向天数
              <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}
                className="rounded border border-border bg-background px-1.5 py-1 text-xs">
                {[1, 3, 5, 10, 20].map((h) => <option key={h} value={h}>{h}日</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              样本数
              <select value={maxStocks} onChange={(e) => setMaxStocks(Number(e.target.value))}
                className="rounded border border-border bg-background px-1.5 py-1 text-xs">
                {[150, 300, 500].map((n) => <option key={n} value={n}>{n}只</option>)}
              </select>
            </label>
            <button onClick={run} disabled={busy}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-1.5 font-medium text-white hover:bg-sky-400 disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Microscope size={13} />} 跑测试
            </button>
          </div>

          {busy && (
            <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-[11px] text-sky-300">
              正在拉取 {maxStocks} 只 × 500 根真实日K并计算（eltdx优先，腾讯兜底）—— 约需 1~3 分钟，请勿离开页面…
            </div>
          )}
          {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

          {result && (
            <div className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className={"rounded px-2 py-0.5 text-xs font-semibold " +
                  (result.passed ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300")}>
                  {result.passed ? "✓ 通过（已写入验证状态）" : "✗ 未通过（保持未验证标记）"}
                </span>
                <span className="text-[10.5px] text-muted-foreground">{result.metrics.dataRange} · 样本 {result.metrics.sample.stocks} 只 × {result.metrics.sample.dates} 日 · 有效截面 {result.metrics.sample.validPairs}</span>
              </div>
              <div className="text-[10.5px] text-muted-foreground">{result.passRule}</div>

              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Metric label="IC" v={result.metrics.ic} d={4} />
                <Metric label="RankIC" v={result.metrics.rankIc} d={4} />
                <Metric label="ICIR" v={result.metrics.icIr} d={3} strong />
                <Metric label="单调性ρ" v={result.metrics.monotonicity} d={3} strong />
                <Metric label="月度胜率" v={result.metrics.monthlyWinRate * 100} d={1} suffix="%" strong />
                <Metric label="换手(日)" v={result.metrics.turnover} d={3} />
                <Metric label="最优档最大回撤" v={result.metrics.maxDrawdown * 100} d={1} suffix="%" negIsBad />
                <div className="rounded-md bg-accent/40 p-2">
                  <div className="text-[10px] text-muted-foreground">5档分层年化（低→高）</div>
                  <GroupBars values={result.metrics.groupAnnual} />
                </div>
              </div>

              {!!result.monthlyIc?.length && <MonthlyBars months={result.monthlyIc} />}
              <div className="text-[10px] leading-5 text-muted-foreground">{result.note}</div>
            </div>
          )}

          {/* 历史记录 */}
          <div className="rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-2.5 text-[12px] font-semibold text-foreground/80">
              测试记录（每次可追溯 · 最新在前）
            </div>
            {history.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">暂无记录 · 选一个K线因子点「跑测试」</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    {["因子", "窗口", "RankIC", "ICIR", "单调", "月胜率", "最大回撤", "通过", "测试时间"].map((h) => (
                      <th key={h} className="px-3 py-1.5">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.map((t) => (
                    <tr key={t.id ?? `${t.field}-${t.testedAt}`} className="border-b border-border/40">
                      <td className="px-3 py-1.5">{t.metrics ? t.field : ""}<span className="ml-1 text-[10px] text-muted-foreground">{t.field}</span></td>
                      <td className="px-3 py-1.5">{t.horizon}日</td>
                      <td className="px-3 py-1.5 text-right"><NumText value={t.metrics?.rankIc} digits={4} /></td>
                      <td className="px-3 py-1.5 text-right"><NumText value={t.metrics?.icIr} digits={3} /></td>
                      <td className="px-3 py-1.5 text-right"><NumText value={t.metrics?.monotonicity} digits={2} /></td>
                      <td className="px-3 py-1.5 text-right">{((t.metrics?.monthlyWinRate ?? 0) * 100).toFixed(0)}%</td>
                      <td className="px-3 py-1.5 text-right text-emerald-400">{((t.metrics?.maxDrawdown ?? 0) * 100).toFixed(1)}%</td>
                      <td className="px-3 py-1.5">
                        {t.passed
                          ? <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">通过</span>
                          : <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-300">未过</span>}
                      </td>
                      <td className="px-3 py-1.5 text-[10px] text-muted-foreground">{t.testedAt?.slice(0, 16).replace("T", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, v, d = 3, suffix = "", strong, negIsBad }: {
  label: string; v: number | null | undefined; d?: number; suffix?: string; strong?: boolean; negIsBad?: boolean;
}) {
  const cls = negIsBad ? "text-emerald-400" : (v ?? 0) > 0 ? "text-red-400" : (v ?? 0) < 0 ? "text-emerald-400" : "";
  return (
    <div className="rounded-md bg-accent/40 p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-mono text-[13px] tabular-nums ${strong ? "font-semibold " : ""}${cls}`}>
        <NumText value={v ?? null} digits={d} suffix={suffix} />
      </div>
    </div>
  );
}

function GroupBars({ values }: { values: number[] }) {
  const max = Math.max(1e-6, ...values.map(Math.abs));
  return (
    <div className="mt-1 space-y-0.5">
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="w-8 text-[9px] text-muted-foreground">G{i + 1}</span>
          <div className="relative h-2 flex-1 rounded-sm bg-background">
            <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
            <div
              className={"absolute inset-y-0 " + (v >= 0 ? "left-1/2 bg-red-500/60" : "right-1/2 bg-emerald-500/60")}
              style={{ width: `${Math.min(50, (Math.abs(v) / max) * 50)}%` }}
            />
          </div>
          <span className="w-14 text-right font-mono text-[9.5px]">{(v * 100).toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

function MonthlyBars({ months }: { months: { month: string; rankIc: number }[] }) {
  const max = Math.max(1e-6, ...months.map((m) => Math.abs(m.rankIc)));
  return (
    <div>
      <div className="mb-1 text-[10.5px] text-muted-foreground">逐月 RankIC（方向已调整：正柱=当月有效）</div>
      <div className="flex h-16 items-end gap-0.5">
        {months.map((m) => (
          <div key={m.month} title={`${m.month}: ${m.rankIc.toFixed(4)}`} className="flex-1">
            <div
              className={"w-full rounded-t-sm " + (m.rankIc >= 0 ? "bg-red-500/50" : "bg-emerald-500/50")}
              style={{ height: `${Math.max(2, (Math.abs(m.rankIc) / max) * 56)}px` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
