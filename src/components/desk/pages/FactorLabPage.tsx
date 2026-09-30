"use client";
// 条件有效性测试台（P1-4，需求文档 五/三十）：选条件 → 跑测试 → IC/分层/月度胜率/回撤 + 历史记录
// 通过标准（硬性）：|ICIR|>0.5 或 分层单调显著，且 月度胜率>60% → catalog 中该条件 verified 徽章自动转「已验证」。
// P15-R3c 血缘卡制：原来 4 块手搓散卡（条件选择/参数条/结果/记录）+ local Metric 小卡收进一张 LineageCard——
// 参数条升格为卡头控制面板（对齐板块页形态），卡内按「选条件 → 看结果 → 翻记录」的血缘分节；
// 数字小卡走全仓库唯一源 StatCard，取数与判定逻辑一个字没动。
import { useState, useEffect, useCallback } from "react";
import { Microscope, Loader2 } from "lucide-react";
import { NumText } from "../SourceBadge";
import { LineageCard, LineageSection, StatCard } from "../ui/LineageCard";
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

  // 数字着色规则原样保自旧 local Metric（A股红涨绿跌；回撤恒负数走绿）——只是卡壳换成统一 StatCard
  const metricTone = (v: number | null | undefined, negIsBad = false): string =>
    negIsBad ? "text-emerald-400" : (v ?? 0) > 0 ? "text-red-400" : (v ?? 0) < 0 ? "text-emerald-400" : "";

  return (
    <div className="w-full space-y-4 px-6 py-4">
      {/* P15-R3c 血缘收口：选条件→跑测试→看结果→翻记录是同一条验证链，
          原来是四块各套各的边框竖着散开——收成一张卡，参数条升格为卡头控制面板。 */}
      <LineageCard
        title={<span className="flex items-center gap-2"><Microscope size={17} className="text-sky-400" />条件有效性测试台</span>}
        note={
          <>
            口径：t 日条件值 ↔ t+{horizon} 日前向收益（防泄漏）· 样本=全A剔ST/停牌按流动性Top-N · 快照口径字段拒绝测试 ·
            通过标准 |ICIR|&gt;0.5 或 分层单调显著，且 月度胜率&gt;60%
          </>
        }
        actions={
          <>
            <span className="text-[13px] text-muted-foreground">条件 <span className="font-mono text-sky-300">{def?.zh ?? field}</span></span>
            <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              前向天数
              <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}
                className="rounded border border-border bg-background px-1.5 py-1 text-xs">
                {[1, 3, 5, 10, 20].map((h) => <option key={h} value={h}>{h}日</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              样本数
              <select value={maxStocks} onChange={(e) => setMaxStocks(Number(e.target.value))}
                className="rounded border border-border bg-background px-1.5 py-1 text-xs">
                {[150, 300, 500].map((n) => <option key={n} value={n}>{n}只</option>)}
              </select>
            </label>
            <button onClick={run} disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-1.5 text-[13.5px] font-medium text-white hover:bg-sky-400 disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Microscope size={13} />} 跑测试
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-[250px_1fr]">
          {/* 条件选择：原独立侧栏卡→卡内首节。列表、已验证/快照徽章、不可测置灰的判定一个字没动 */}
          <LineageSection title="条件选择" hint={`已验证 ${verifiedCount}/${catalog?.fields.length ?? "…"}`} divided={false}>
            {catalog?.category
              ? Object.entries(catalog.category).map(([cat, keys]) => (
                <div key={cat} className="mb-2 last:mb-0">
                  <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground/70">{cat}</div>
                  <div className="space-y-0.5">
                    {keys.map((k) => {
                      const f = catalog.fields.find((x) => x.key === k);
                      const disabled = f?.source !== "kline";
                      return (
                        <button key={k} onClick={() => { if (!disabled) { setField(k); loadHistory(k); } }} disabled={disabled}
                          title={disabled ? "快照口径字段：无历史时点数据，不可测" : f?.zh}
                          className={
                            "flex w-full items-center gap-1.5 rounded px-2 py-1 text-[12.5px] transition-colors " +
                            (field === k ? "bg-sky-500/10 text-sky-300 font-medium" : disabled ? "text-muted-foreground/40" : "text-muted-foreground hover:bg-accent hover:text-foreground")
                          }>
                          <span className="truncate">{f?.zh ?? k}</span>
                          {f?.verified && <span className="ml-auto rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-400">已验证</span>}
                          {disabled && !f?.verified && <span className="ml-auto text-[10px] text-muted-foreground/50">快照</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
              : <div className="py-6 text-center text-xs text-muted-foreground">{error || "加载条件目录…"}</div>}
          </LineageSection>

          <div className="min-w-0">
            {busy && (
              <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-[12px] text-sky-300">
                正在拉取 {maxStocks} 只 × 500 根真实日K并计算（通达信优先，腾讯兜底）—— 约需 1~3 分钟，请勿离开页面…
              </div>
            )}
            {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

            {result && (
              <LineageSection title="验证结果" tone={result.passed ? "success" : "warning"} divided={!busy && !error}>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={"rounded px-2 py-0.5 text-xs font-semibold " +
                      (result.passed ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300")}>
                      {result.passed ? "✓ 通过（已写入验证状态）" : "✗ 未通过（保持未验证标记）"}
                    </span>
                    <span className="text-[11.5px] text-muted-foreground">{result.metrics.dataRange} · 样本 {result.metrics.sample.stocks} 只 × {result.metrics.sample.dates} 天 · 有效配对 {result.metrics.sample.validPairs}</span>
                  </div>

                  <div className="text-[11.5px] text-muted-foreground">{result.passRule}</div>

                  {/* 指标小卡走全仓库唯一源 StatCard（口径进 tooltip，措辞与 metrics.ts 实现一致） */}
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <StatCard label="历史上准不准" value={<NumText value={result.metrics.ic ?? null} digits={4} />} toneClass={metricTone(result.metrics.ic)} title="逐日看：满足这个条件的票，后来是涨得多还是跌得多（取平均）" />
                    <StatCard label="按排名看准不准" value={<NumText value={result.metrics.rankIc ?? null} digits={4} />} toneClass={metricTone(result.metrics.rankIc)} title="同上，但不看具体涨跌多少，只看排名先后（更不受几只极端票的影响）" />
                    <StatCard label="每个月都准吗" value={<NumText value={result.metrics.icIr ?? null} digits={3} />} toneClass={metricTone(result.metrics.icIr)} title="上面那个数字稳不稳：平均值 ÷ 波动。越大越稳，一般要超过 0.5 才算稳" />
                    <StatCard label="越强越准吗" value={<NumText value={result.metrics.monotonicity ?? null} digits={3} />} toneClass={metricTone(result.metrics.monotonicity)} title="把票按这个条件的强弱分成 5 档，看收益是不是一档比一档高" />
                    <StatCard label="按月看准的比例" value={<NumText value={result.metrics.monthlyWinRate * 100} digits={1} suffix="%" />} toneClass={metricTone(result.metrics.monthlyWinRate)} title="方向调整后，逐月看这个条件准的月份占多少（一般要超过 60%）" />
                    <StatCard label="换手(日)" value={<NumText value={result.metrics.turnover ?? null} digits={3} />} title="每天要换掉多少票：条件的排名一天到一天的变化（越高越频繁调仓，手续费也越贵）" />
                    <StatCard label="最猛那档最惨亏多少" value={<NumText value={result.metrics.maxDrawdown * 100} digits={1} suffix="%" />} toneClass={metricTone(result.metrics.maxDrawdown, true)} title="方向调整后，最强那一档的收益曲线，从最高点跌到最低点的幅度" />
                    <div className="rounded-md bg-accent/40 p-2">
                      <div className="text-[11px] text-muted-foreground">5档分层年化（低→高）</div>
                      <GroupBars values={result.metrics.groupAnnual} />
                    </div>
                  </div>

                  {!!result.monthlyIc?.length && <MonthlyBars months={result.monthlyIc} />}
                  <div className="text-[11px] leading-5 text-muted-foreground">{result.note}</div>
                </div>
              </LineageSection>
            )}

            {/* 测试记录：原独立卡→末节；表格、空态、可追溯口径原样 */}
            <LineageSection title="测试记录" hint="每次可追溯 · 最新在前" divided={Boolean(result)}>
              {history.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">暂无记录 · 选一个K线条件点「跑测试」</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      {["条件", "看几天后", "按排名看准不准", "每个月都准吗", "越强越准吗", "按月看准的比例", "最惨亏多少", "过没过检", "测试时间"].map((h) => (
                        <th key={h} className="px-3 py-1.5">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((t) => (
                      <tr key={t.id ?? `${t.field}-${t.testedAt}`} className="border-b border-border/40">
                        <td className="px-3 py-1.5">{t.metrics ? t.field : ""}<span className="ml-1 text-[11px] text-muted-foreground">{t.field}</span></td>
                        <td className="px-3 py-1.5">{t.horizon}日</td>
                        <td className="px-3 py-1.5 text-right"><NumText value={t.metrics?.rankIc} digits={4} /></td>
                        <td className="px-3 py-1.5 text-right"><NumText value={t.metrics?.icIr} digits={3} /></td>
                        <td className="px-3 py-1.5 text-right"><NumText value={t.metrics?.monotonicity} digits={2} /></td>
                        <td className="px-3 py-1.5 text-right">{((t.metrics?.monthlyWinRate ?? 0) * 100).toFixed(0)}%</td>
                        <td className="px-3 py-1.5 text-right text-emerald-400">{((t.metrics?.maxDrawdown ?? 0) * 100).toFixed(1)}%</td>
                        <td className="px-3 py-1.5">
                          {t.passed
                            ? <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-400">通过</span>
                            : <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-300">未过</span>}
                        </td>
                        <td className="px-3 py-1.5 text-[11px] text-muted-foreground">{t.testedAt?.slice(0, 16).replace("T", " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </LineageSection>
          </div>
        </div>
      </LineageCard>
    </div>
  );
}

// GroupBars / MonthlyBars 留下：图元（条形）不是卡，不属于「local 重定义卡组件」的禁区
function GroupBars({ values }: { values: number[] }) {
  const max = Math.max(1e-6, ...values.map(Math.abs));
  return (
    <div className="mt-1 space-y-0.5">
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="w-8 text-[10px] text-muted-foreground">G{i + 1}</span>
          <div className="relative h-2 flex-1 rounded-sm bg-background">
            <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
            <div
              className={"absolute inset-y-0 " + (v >= 0 ? "left-1/2 bg-red-500/60" : "right-1/2 bg-emerald-500/60")}
              style={{ width: `${Math.min(50, (Math.abs(v) / max) * 50)}%` }}
            />
          </div>
          <span className="w-14 text-right font-mono text-[10.5px]">{(v * 100).toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

function MonthlyBars({ months }: { months: { month: string; rankIc: number }[] }) {
  const max = Math.max(1e-6, ...months.map((m) => Math.abs(m.rankIc)));
  return (
    <div>
      <div className="mb-1 text-[11.5px] text-muted-foreground">逐月：这个条件准不准（方向已调整：向上的柱子 = 当月有效）</div>
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
