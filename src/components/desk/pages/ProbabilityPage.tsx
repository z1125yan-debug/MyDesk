"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Percent } from "lucide-react";
import { PctText, NumText, SourceBadge } from "../SourceBadge";
import { SnapshotBar } from "../SnapshotBar";
import { useDesk } from "@/lib/desk/store";
import {
  fetchFactorCatalog, fetchTradeDates, runProbabilityApi,
  type FactorFieldDef, type ScreenerCond, type ProbabilityResp,
} from "@/lib/desk/quant-api";

// §四 操作符全集（in / not in = 多值，值用逗号或空格分隔）
const OPS = ["=", ">=", ">", "<=", "<", "!=", "in", "not in"] as const;
const isMultiOp = (op: string): boolean => op === "in" || op === "not in";
/** 值输入：多值操作符保留原始字符串（列表），其余转数值 */
const parseCondValue = (op: string, raw: string): number | string =>
  isMultiOp(op) ? raw.trim() : Number(raw);

const PRESET: Record<string, { op: ScreenerCond["op"]; value: number }> = {
  macd_cross: { op: "=", value: 1 },
  kdj_cross: { op: "=", value: 1 },
  above_ma_20: { op: "=", value: 1 },
  rps_50: { op: ">=", value: 80 },
  rsi_14: { op: "<=", value: 30 },
};

export default function ProbabilityPage() {
  const watchlist = useDesk((s) => s.watchlist);
  const [catalog, setCatalog] = useState<{ fields: FactorFieldDef[] } | null>(null);
  const [chips, setChips] = useState<(ScreenerCond & { zh: string })[]>([]);
  const [universe, setUniverse] = useState<"index" | "custom">("index");
  const [custom, setCustom] = useState("000001.SH,399006.SZ");
  // §二 历史交易日：仅真实交易日，默认当日
  const [tradeDate, setTradeDate] = useState("");
  const [tradeDates, setTradeDates] = useState<string[]>([]);
  const [todayDate, setTodayDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ProbabilityResp | null>(null);
  // 留档要连「这次用的是哪一组条件」一起存：没有条件的胜率数字无法复现也无法解释。
  // 记的是上一次**成功计算**真正发出去的请求体，不随用户之后改动 pill 而变（改完没重算就留档，留的仍是刚算出的那份结果对应的条件）。
  const [lastReq, setLastReq] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    fetchFactorCatalog().then((c) => setCatalog({ fields: c.fields })).catch((e) => setError(String(e.message || e)));
  }, []);
  useEffect(() => {
    // 交易日取自真实上证指数日线；失败只留空，不伪造日期
    fetchTradeDates(120).then((d) => { setTradeDates(d.dates); setTodayDate(d.as_of_trade_date); })
      .catch(() => setTradeDates([]));
  }, []);
  const klineFields = useMemo(
    () => (catalog?.fields ?? []).filter((f) => f.source === "kline" && f.implemented !== false),
    [catalog],
  );

  const add = (key: string) => {
    const def = klineFields.find((f) => f.key === key);
    if (!def || chips.some((c) => c.field === key)) return;
    const p = PRESET[key] ?? { op: "=" as const, value: 1 };
    setChips((cs) => [...cs, { field: key, op: p.op, value: p.value, zh: def.zh }]);
  };

  const run = async () => {
    setBusy(true); setError("");
    try {
      const symbols = universe === "custom"
        ? custom.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
        : undefined;
      const body = {
        conditions: chips.map(({ zh: _z, ...c }) => c),
        universe,
        symbols,
        trade_date: tradeDate || undefined,
      };
      setResult(await runProbabilityApi(body));
      setLastReq(body);
    } catch (e) {
      setError(String((e as Error).message || e));
      setResult(null);
    } finally { setBusy(false); }
  };

  const fillWatch = useCallback(() => {
    setUniverse("custom");
    setCustom(watchlist.map((w) => w.symbol).join(","));
  }, [watchlist]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Percent size={18} className="text-sky-400" /> 历史条件概率</div>
          <div className="text-[11px] text-muted-foreground">仅 K 线口径条件参与历史匹配 · 样本 &lt; 30 标不足 · 快照条件会被引擎忽略并警示 · 基准 = 沪深300（000300.SH）</div>
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          {result && (
            <div className="mb-1">
              <SourceBadge
                status="HISTORICAL"
                source={`K线回放 ${result.universe === "custom" ? "自定义池" : "三大指数"} · 基准 ${result.benchmark?.name ?? "沪深300"}（${result.benchmark?.bars ?? 0} 根）`}
                time={String(result.as_of_trade_date).slice(0, 10)}
              />
            </div>
          )}
          统计截止：{result?.as_of_trade_date ?? tradeDate ?? "当日"}
          {result?.trade_date_is_historical && <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">历史回放</span>}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {["macd_cross", "kdj_cross", "above_ma_20", "above_ma_60", "rps_50", "rsi_14", "chan_bottom_fractal", "td_signal"].map((k) => (
            <button key={k} onClick={() => add(k)} className="rounded-md border border-border px-2 py-1 text-[11px] hover:border-sky-500/40 hover:text-sky-300">
              {klineFields.find((f) => f.key === k)?.zh ?? k}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {chips.map((c, i) => (
            <span key={c.field} className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-300">
              {c.zh}
              <select
                value={c.op}
                onChange={(e) => setChips((cs) => cs.map((x, k) => (k === i ? { ...x, op: e.target.value as ScreenerCond["op"] } : x)))}
                className="rounded bg-background/60 px-1 text-[10px] text-sky-300 outline-none"
              >
                {OPS.map((o) => <option key={o} className="text-foreground">{o}</option>)}
              </select>
              <input
                value={String(c.value)}
                onChange={(e) => setChips((cs) => cs.map((x, k) => (k === i ? { ...x, value: parseCondValue(c.op, e.target.value) } : x)))}
                title={isMultiOp(c.op) ? "多值用逗号或空格分隔" : undefined}
                className={`${isMultiOp(c.op) ? "w-28" : "w-12"} rounded bg-background/60 px-1 text-[10px] text-sky-300 outline-none`}
              />
              <button onClick={() => setChips((cs) => cs.filter((x) => x.field !== c.field))} className="opacity-60 hover:opacity-100">×</button>
            </span>
          ))}
          {!chips.length && <span className="text-[11px] text-muted-foreground">先点 pill 添加 K 线条件</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1"><input type="radio" checked={universe === "index"} onChange={() => setUniverse("index")} /> 三大指数</label>
          <label className="flex items-center gap-1"><input type="radio" checked={universe === "custom"} onChange={() => setUniverse("custom")} /> 自定义代码</label>
          <button onClick={fillWatch} className="text-sky-400 hover:underline">填入自选</button>
          {universe === "custom" && (
            <input value={custom} onChange={(e) => setCustom(e.target.value)} className="min-w-[16rem] flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs" placeholder="688256.SH,000001.SZ" />
          )}
          {/* §二 历史交易日选择器 */}
          <select value={tradeDate} onChange={(e) => setTradeDate(e.target.value)}
            title="选择历史交易日：统计截止日按该日重放（含基准同期）"
            className="rounded-md border border-border bg-background px-2 py-1 text-xs">
            <option value="">当日（{todayDate || "最新"}）</option>
            {tradeDates.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button onClick={run} disabled={busy || !chips.length} className="ml-auto rounded-md bg-sky-500 px-3 py-1.5 text-xs text-white disabled:opacity-40">
            {busy ? <Loader2 size={12} className="inline animate-spin" /> : "计算胜率"}
          </button>
        </div>
      </div>
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      <SnapshotBar kind="probability" label="条件概率"
        sideEffect="留档这一下会在服务端按上面那组条件真的重算一次（拉指数/自定义池 K 线 + 全A快照），并把这组条件与结果一起存进条件概率留档。"
        getRequest={() => lastReq} />
      {result && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            {result.pooled.map((h) => (
              <div key={h.h} className="rounded-xl border border-border bg-card px-4 py-3">
                <div className="text-[11px] text-muted-foreground">{h.h} 日上涨概率（样本加权）</div>
                <div className="text-xl font-bold">{h.win_rate == null ? "—" : `${h.win_rate.toFixed(0)}%`}</div>
                <div className="text-[10.5px] text-muted-foreground">样本 {h.sample_size} · {h.symbols_used} 只</div>
                {/* §二/§六：最大回撤 + 基准收益 + 超额（基准缺失显示 —） */}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted-foreground">
                  <span>最大回撤 <PctText value={h.max_drawdown ?? null} digits={1} /></span>
                  <span title="同期沪深300平均收益">基准 <NumText value={h.benchmark_return ?? null} digits={2} suffix="%" /></span>
                  <span title="本策略样本平均收益 − 基准同期">超额 <PctText value={h.excess_return ?? null} digits={2} /></span>
                </div>
              </div>
            ))}
          </div>
          {!result.sample_ok && <div className="text-[11px] text-amber-400">样本不足（&lt;30），仅供参考</div>}
          {!!result.benchmark && (
            <div className={`text-[10.5px] ${result.benchmark.bars > 0 ? "text-muted-foreground" : "text-amber-400"}`}>
              基准指数：{result.benchmark.name}（{result.benchmark.symbol}）K线 {result.benchmark.bars} 根
              {result.benchmark.bars === 0 && " · 基准数据缺失，基准收益/超额以 — 显示，不以 0 代替"}
            </div>
          )}
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1">代码</th><th>名称</th><th>1日</th><th>5日</th><th>20日</th>
                <th className="text-right" title="5日持有：命中样本复利净值最大回撤（≤0）">5日回撤</th>
                <th className="text-right" title="5日持有：同期沪深300平均收益 / 超额">基准·超额</th>
                <th>区间</th>
              </tr>
            </thead>
            <tbody>
              {result.per_symbol.map((r) => {
                const h = (n: number) => r.stats?.horizons.find((x) => x.h === n);
                const h5 = h(5);
                return (
                  <tr key={r.symbol} className="border-t border-border/60">
                    <td className="py-1.5 font-mono">{r.symbol}</td>
                    <td>{r.name}</td>
                    <td><WinText v={h(1)?.win_rate} /></td>
                    <td><WinText v={h5?.win_rate} /></td>
                    <td><WinText v={h(20)?.win_rate} /></td>
                    <td className="text-right"><PctText value={h5?.max_drawdown ?? null} digits={1} /></td>
                    <td className="text-right text-[10.5px]">
                      {h5?.benchmark_return == null ? <span className="text-muted-foreground" title="基准K线缺失，不以0代替">—</span>
                        : <span><NumText value={h5.benchmark_return} digits={1} /> / <PctText value={h5.excess_return ?? null} digits={1} /></span>}
                    </td>
                    <td className="text-muted-foreground">{r.stats?.period ? `${r.stats.period.start}~${r.stats.period.end}` : r.error ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!!result.warnings.length && <div className="text-[10.5px] text-muted-foreground">警示：{[...new Set(result.warnings)].join("；")}</div>}
        </div>
      )}
    </div>
  );
}

/** 胜率（0-100）显示：非收益率，不加正负号 */
function WinText({ v }: { v?: number | null }) {
  if (v === null || v === undefined || !isFinite(v)) return <span className="text-muted-foreground">—</span>;
  return <span>{v.toFixed(0)}%</span>;
}
