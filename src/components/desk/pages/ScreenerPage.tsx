"use client";
// 因子选股器（需求文档 P0：因子pill + 条件筛选 + 结果表格直接显示历史胜率）
import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, Plus, X, Loader2, Sparkles, AlertTriangle } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";
import { useDesk } from "@/lib/desk/store";
import {
  fetchFactorCatalog, runScreenerApi, aiChatTools,
  type FactorFieldDef, type ScreenerCond, type ScreenerRespClient,
} from "@/lib/desk/quant-api";

const OPS = ["=", ">=", ">", "<=", "<", "!="] as const;

// 常用预设 pill（默认操作符/值，可编辑）
const PRESET_DEFAULT: Record<string, { op: string; value: number | string }> = {
  pe_ttm: { op: "<=", value: 30 },
  pb: { op: "<=", value: 3 },
  market_cap_yi: { op: ">=", value: 50 },
  floatcap_yi: { op: ">=", value: 100 },
  turnover_rate: { op: ">=", value: 3 },
  volume_ratio: { op: ">=", value: 1.5 },
  amount_yi: { op: ">=", value: 1 },
  amplitude: { op: ">=", value: 5 },
  change_pct: { op: ">=", value: 2 },
  main_net_yi: { op: ">", value: 0 },
  rps_50: { op: ">=", value: 80 },
  rps_120: { op: ">=", value: 70 },
  rps_composite: { op: ">=", value: 80 },
  vwap_pos: { op: ">=", value: 0 },
  rsi_14: { op: "<=", value: 30 },
  atr_ratio_14: { op: ">=", value: 3 },
  macd: { op: ">", value: 0 },
};

interface ChipCond extends ScreenerCond { zh: string }

export default function ScreenerPage() {
  const go = useDesk((s) => s.go);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const ai = useDesk((s) => s.ai);
  const [catalog, setCatalog] = useState<{ fields: FactorFieldDef[]; category: Record<string, string[]> } | null>(null);
  const [chips, setChips] = useState<ChipCond[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // 正在编辑默认值的 pill key
  const [sortKey, setSortKey] = useState("amount_yi");
  const [limit, setLimit] = useState(50);
  const [result, setResult] = useState<ScreenerRespClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [aiNote, setAiNote] = useState("");
  // 自定义条件
  const [cField, setCField] = useState("turnover_rate");
  const [cOp, setCOp] = useState<string>(">=");
  const [cVal, setCVal] = useState("3");
  const [cType, setCType] = useState<"single" | "rolling_any" | "rolling_sum" | "rolling_return">("single");
  const [cWindow, setCWindow] = useState("10");
  const [cMinDays, setCMinDays] = useState("3");

  useEffect(() => { fetchFactorCatalog().then(setCatalog).catch((e) => setError(String(e.message || e))); }, []);

  const fieldMap = useMemo(() => new Map((catalog?.fields ?? []).map((f) => [f.key, f])), [catalog]);

  const addCond = useCallback((key: string) => {
    const def = fieldMap.get(key);
    if (!def) return;
    if (chips.some((c) => c.field === key && (c.type ?? "single") === "single")) return; // 单条件去重
    const preset = PRESET_DEFAULT[key] ?? { op: def.source === "kline" && key.match(/^(above_ma|is_limit_up|ma_struct|macd_cross|kdj_cross|ema14|double_volume|volume_signal|vwap20_filter|vwap20_up3|above_cost_20|break_cost_20|breakout)/) ? "=" : ">=", value: 1 };
    setChips((cs) => [...cs, { field: key, op: preset.op as ScreenerCond["op"], value: preset.value, zh: def.zh }]);
  }, [chips, fieldMap]);

  const addCustom = () => {
    const def = fieldMap.get(cField);
    if (!def || cVal === "") return;
    const base: ScreenerCond = cType === "single"
      ? { field: cField, op: cOp as ScreenerCond["op"], value: Number(cVal) }
      : { type: cType, field: cField, op: cOp as ScreenerCond["op"], value: Number(cVal), window: Number(cWindow) || 10, ...(cType === "rolling_any" ? { min_match_days: Number(cMinDays) || 3 } : {}) };
    setChips((cs) => [...cs, { ...base, zh: `${def.zh}·${cType === "single" ? "" : `近${cWindow}日${cType === "rolling_any" ? `含${cMinDays}天` : ""}`}` }]);
  };

  const runScan = async () => {
    setError(""); setAiNote("");
    setBusy(true);
    try {
      const resp = await runScreenerApi({
        universe: "all_a",
        conditions: chips.map(({ zh: _zh, ...c }) => c),
        fields: ["change_pct", "amount_yi", "turnover_rate", "volume_ratio", "main_net_yi", "rps_50", "rps_120", "vwap_pos"],
        sort: { order_by: sortKey, order_dir: "desc" },
        pagination: { limit },
        include_stats: true,
      });
      setResult(resp);
    } catch (e) {
      setError(String((e as Error).message || e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const aiRefine = async () => {
    if (!result?.list.length) return;
    setAiNote("");
    try {
      const list = result.list.slice(0, 15).map((r) => ({
        代码: r.symbol, 名称: r.name, 现价: r.close, 涨跌幅: r.change_pct,
        胜率: { "1d": r.win_prob?.horizons.find((h) => h.h === 1)?.win_rate ?? null, "5d": r.win_prob?.horizons.find((h) => h.h === 5)?.win_rate ?? null, 样本: r.win_prob?.horizons[0]?.sample_size ?? 0 },
        条件值: r.values,
      }));
      const { content } = await aiChatTools(
        { provider: ai.provider, baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, proxy: ai.proxy },
        [{ role: "user", content: `以下是因子选股的结果（已带历史胜率与条件值）。请优中选优：给出你保留的 5-10 只及保留理由（引用数据），并明确排除哪些、为什么。数据如下：\n${JSON.stringify(list)}` }],
        { mode: "deep" },
      );
      setAiNote(content);
    } catch (e) {
      setAiNote(`AI 优中选优失败：${(e as Error).message}`);
    }
  };

  const openProfile = (symbol: string) => { setFocusSymbol(symbol); go("profile"); };
  const condLabel = (c: ChipCond) => `${c.zh} ${c.op} ${c.value}${c.window ? `窗口${c.window}` : ""}`;

  // §五：因子验证状态统计——全部由 catalog/结果真实数据推导，禁止硬编码「全部未验证/全部已验证」
  const verifyStats = (() => {
    const total = catalog?.fields.length ?? null;
    if (total === null) return null;
    const verified = (catalog?.fields ?? []).filter((f) => f.verified).length;
    const enabled = new Set(chips.map((c) => c.field)).size;
    const excluded = chips.filter((c) => catalog && !catalog.fields.some((f) => f.key === c.field)).length;
    let conclusion: string;
    let tone = "text-amber-400";
    if (result?.factor_verify) {
      const rv = result.factor_verify;
      conclusion = rv.enabled === 0 ? "验证状态未知（本次未涉及登记因子）"
        : rv.unverified === 0 ? `本次涉及 ${rv.enabled} 个因子均已验证`
        : rv.verified === 0 ? `本次涉及 ${rv.enabled} 个因子均未验证`
        : `本次涉及 ${rv.enabled} 个因子：${rv.verified} 已验证 / ${rv.unverified} 未验证`;
      tone = rv.unverified === 0 && rv.enabled > 0 ? "text-emerald-400" : "text-amber-400";
    } else if (verified === total) { conclusion = "全库因子均已验证"; tone = "text-emerald-400"; }
    else if (verified === 0) { conclusion = "全库因子均未验证"; }
    else { conclusion = `存在未验证因子（已验证 ${verified}/${total}）`; }
    return { total, verified, enabled, excluded, conclusion, tone };
  })();

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-4">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-lg font-bold">多因子量化选股</div>
          <div className="text-[11px] text-muted-foreground">
            所示结果仅为模型筛选结果，不构成投资建议 · 因子验证：
            {verifyStats ? (
              <>
                <span className={verifyStats.tone}>{verifyStats.conclusion}</span>
                （库 {verifyStats.total} · 选用 {verifyStats.enabled} · 已验证 {verifyStats.verified} · 排除/忽略 {verifyStats.excluded}，验证入口：因子实验室）
              </>
            ) : <span>验证状态未知（因子目录加载中）</span>}
          </div>
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          交易日：{result?.as_of_trade_date ?? "当日"} · 数据源：em（腾讯/东财）
        </div>
      </div>

      {/* 因子分组 */}
      <div className="rounded-xl border border-border bg-card p-4">
        {catalog ? Object.entries(catalog.category).map(([cat, keys]) => (
          <div key={cat} className="mb-3 last:mb-0">
            <div className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold text-foreground/80">
              <span className="h-3 w-0.5 rounded bg-sky-400" />{cat}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {keys.map((k) => {
                const def = fieldMap.get(k)!;
                const active = chips.some((c) => c.field === k && (c.type ?? "single") === "single");
                return (
                  <div key={k} className="relative">
                    <button
                      onClick={() => (active ? setChips((cs) => cs.filter((c) => c.field !== k)) : (addCond(k), setEditing(k)))}
                      className={
                        "rounded-full border px-2.5 py-1 text-[11.5px] transition-colors " +
                        (active
                          ? "border-sky-500/60 bg-sky-500/15 text-sky-300"
                          : "border-border bg-accent/40 text-muted-foreground hover:border-sky-500/40 hover:text-foreground")
                      }
                    >
                      {def.zh}
                      {def.source === "snapshot" && <span className="ml-1 text-[9px] text-muted-foreground/60">快照</span>}
                    </button>
                    {editing === k && !active && (
                      <DefaultEditor
                        def={def}
                        init={PRESET_DEFAULT[k] ?? { op: ">=", value: 0 }}
                        onOk={(op, value) => {
                          setChips((cs) => [...cs, { field: k, op: op as ScreenerCond["op"], value, zh: def.zh }]);
                          setEditing(null);
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )) : <div className="py-6 text-center text-xs text-muted-foreground">因子目录加载中…</div>}
      </div>

      {/* 自定义条件 */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 text-[12px] font-semibold text-foreground/80">自定义条件</div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select value={cType} onChange={(e) => setCType(e.target.value as typeof cType)} className="rounded border border-border bg-background px-2 py-1">
            <option value="single">单条件</option>
            <option value="rolling_any">近N日出现</option>
            <option value="rolling_sum">近N日累计</option>
            <option value="rolling_return">近N日涨跌幅</option>
          </select>
          {cType !== "rolling_return" && (
            <select value={cField} onChange={(e) => setCField(e.target.value)} className="max-w-44 rounded border border-border bg-background px-2 py-1">
              {(catalog?.fields ?? []).map((f) => (
                <option key={f.key} value={f.key} disabled={f.implemented === false}>
                  {f.zh}（{f.key}）{f.implemented === false ? " · 未实现" : ""}
                </option>
              ))}
            </select>
          )}
          {cType !== "single" && <input value={cWindow} onChange={(e) => setCWindow(e.target.value)} className="w-14 rounded border border-border bg-background px-2 py-1" title="窗口天数" />}
          <select value={cOp} onChange={(e) => setCOp(e.target.value)} className="rounded border border-border bg-background px-2 py-1">
            {OPS.map((o) => <option key={o}>{o}</option>)}
          </select>
          <input value={cVal} onChange={(e) => setCVal(e.target.value)} placeholder="值" className="w-20 rounded border border-border bg-background px-2 py-1" />
          {cType === "rolling_any" && (<> <span className="text-muted-foreground">至少</span> <input value={cMinDays} onChange={(e) => setCMinDays(e.target.value)} className="w-12 rounded border border-border bg-background px-2 py-1" /> <span className="text-muted-foreground">天</span> </>)}
          <button onClick={addCustom} className="flex items-center gap-1 rounded bg-sky-500/15 px-2.5 py-1 text-sky-300 hover:bg-sky-500/25">
            <Plus size={12} /> 添加
          </button>
        </div>
      </div>

      {/* 已选条件 + 执行 */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 text-[12px] font-semibold text-foreground/80">已选条件</div>
        <div className="flex min-h-8 flex-wrap items-center gap-1.5">
          {chips.length === 0 && <span className="text-xs text-muted-foreground">尚未选择条件：点上方 pill 添加，或用自定义条件</span>}
          {chips.map((c, i) => (
            <span key={i} className="flex items-center gap-1 rounded-full border border-sky-500/50 bg-sky-500/10 px-2.5 py-1 text-[11.5px] text-sky-300">
              {condLabel(c)}
              <select
                value={c.op}
                onChange={(e) => setChips((cs) => cs.map((x, k) => (k === i ? { ...x, op: e.target.value as ScreenerCond["op"] } : x)))}
                className="bg-transparent text-[10px] outline-none"
              >
                {OPS.map((o) => <option key={o} className="text-foreground">{o}</option>)}
              </select>
              <input
                value={String(c.value)}
                onChange={(e) => setChips((cs) => cs.map((x, k) => (k === i ? { ...x, value: Number(e.target.value) } : x)))}
                className="w-14 bg-transparent text-[10px] outline-none"
              />
              <button onClick={() => setChips((cs) => cs.filter((_, k) => k !== i))}><X size={11} /></button>
            </span>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={runScan} disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} 筛选全A
          </button>
          <button onClick={aiRefine} disabled={!result?.list.length}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-40">
            <Sparkles size={14} /> AI优中选优
          </button>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className="rounded border border-border bg-background px-2 py-1.5 text-xs">
            <option value="amount_yi">按成交额</option>
            <option value="change_pct">按涨跌幅</option>
            <option value="turnover_rate">按换手率</option>
            <option value="volume_ratio">按量比</option>
            <option value="main_net_yi">按主力净额</option>
            <option value="rps_50">按RPS50</option>
          </select>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="rounded border border-border bg-background px-2 py-1.5 text-xs">
            {[30, 50, 100].map((n) => <option key={n} value={n}>{n} 条</option>)}
          </select>
          {result && <span className="text-xs text-muted-foreground">共 {result.total} 条</span>}
        </div>

        {/* 漏斗 + 警示 */}
        {result && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
            漏斗：全A {result.funnel.universe} → 快照粗筛 {result.funnel.snapshot_pass} → K线子集 {result.funnel.kline_subset} → 命中 <span className="text-sky-400">{result.funnel.kline_pass}</span>
          </div>
        )}
        {result?.warnings.map((w, i) => (
          <div key={i} className="mt-1.5 flex items-start gap-1 rounded bg-amber-500/5 px-2 py-1 text-[10.5px] text-amber-300/90">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {w}
          </div>
        ))}
        {error && <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      </div>

      {/* AI 优中选优 */}
      {aiNote && (
        <div className="rounded-xl border border-border bg-card p-4 text-sm">
          <div className="mb-1 text-[12px] font-semibold text-sky-300">AI 优中选优（模型推断，非事实）</div>
          <div className="prose-sm">{aiNote}</div>
        </div>
      )}

      {/* 结果表格 */}
      {result && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2">代码</th>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2 text-right">最新价</th>
                <th className="px-3 py-2 text-right">涨跌幅</th>
                <th className="px-3 py-2 text-right">成交额(亿)</th>
                <th className="px-3 py-2 text-right">换手%</th>
                <th className="px-3 py-2 text-right">量比</th>
                <th className="px-3 py-2 text-right">主力净额(亿)</th>
                <th className="px-3 py-2 text-right">RPS50</th>
                <th className="px-3 py-2 text-right">1日胜率</th>
                <th className="px-3 py-2 text-right">5日胜率</th>
                <th className="px-3 py-2 text-right">20日胜率</th>
              </tr>
            </thead>
            <tbody>
              {result.list.map((r) => {
                const wp = r.win_prob;
                const h1 = wp?.horizons.find((h) => h.h === 1);
                const h5 = wp?.horizons.find((h) => h.h === 5);
                const h20 = wp?.horizons.find((h) => h.h === 20);
                const hover = wp ? [
                  `样本数：${h1?.sample_size ?? 0}${wp.sample_ok ? "" : "（样本不足，仅供参考）"}`,
                  `统计区间：${wp.period ? `${wp.period.start} ~ ${wp.period.end}` : "—"}`,
                  `1日：均 ${h1?.avg_return?.toFixed(2)}% 最差 ${h1?.worst_return?.toFixed(2)}%`,
                  `5日：均 ${h5?.avg_return?.toFixed(2)}% 最差 ${h5?.worst_return?.toFixed(2)}%`,
                  `20日：均 ${h20?.avg_return?.toFixed(2)}% 最差 ${h20?.worst_return?.toFixed(2)}%`,
                  ...wp.warnings,
                ].join("\n") : "无历史统计";
                return (
                  <tr key={r.symbol} onClick={() => openProfile(r.symbol)}
                    title={hover}
                    className="cursor-pointer border-b border-border/40 hover:bg-sky-500/5">
                    <td className="px-3 py-1.5 font-mono">{r.symbol}</td>
                    <td className="px-3 py-1.5">{r.name}</td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.close} /></td>
                    <td className="px-3 py-1.5 text-right"><PctText value={r.change_pct} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.values.amount_yi} digits={1} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.values.turnover_rate} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.values.volume_ratio} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.values.main_net_yi} digits={1} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.values.rps_50} digits={0} /></td>
                    <WinCell h={h1} ok={wp?.sample_ok} />
                    <WinCell h={h5} ok={wp?.sample_ok} />
                    <WinCell h={h20} ok={wp?.sample_ok} />
                  </tr>
                );
              })}
              {result.list.length === 0 && (
                <tr><td colSpan={12} className="px-3 py-8 text-center text-muted-foreground">无命中结果（试试放宽条件）</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!result && !busy && (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
          选择条件后点「筛选全A」：结果将直接带 1/5/20 日历史胜率（悬停看样本数/区间/收益分布）
        </div>
      )}
    </div>
  );
}

function WinCell({ h, ok }: { h?: { win_rate: number | null; sample_size: number }; ok?: boolean }) {
  const v = h?.win_rate;
  return (
    <td className={`px-3 py-1.5 text-right ${ok === false ? "opacity-60" : ""}`}>
      {v === null || v === undefined ? <span className="text-muted-foreground">—</span> : (
        <span className={v >= 55 ? "text-red-500 font-medium" : v >= 50 ? "text-foreground" : "text-emerald-500"}>
          {v.toFixed(0)}%<span className="ml-0.5 text-[9px] text-muted-foreground">({h?.sample_size})</span>
        </span>
      )}
    </td>
  );
}

function DefaultEditor({ def, init, onOk, onCancel }: {
  def: FactorFieldDef;
  init: { op: string; value: number | string };
  onOk: (op: string, value: number | string) => void;
  onCancel: () => void;
}) {
  const [op, setOp] = useState(init.op);
  const [val, setVal] = useState(String(init.value));
  return (
    <div className="absolute left-0 top-7 z-30 flex items-center gap-1 rounded-lg border border-border bg-popover p-1.5 shadow-lg">
      <span className="pl-1 text-[10px] text-muted-foreground">{def.zh}</span>
      <select value={op} onChange={(e) => setOp(e.target.value)} className="rounded bg-background px-1 py-0.5 text-[10px]">
        {OPS.map((o) => <option key={o}>{o}</option>)}
      </select>
      <input value={val} onChange={(e) => setVal(e.target.value)} autoFocus
        onKeyDown={(e) => { if (e.key === "Enter") onOk(op, Number(val)); if (e.key === "Escape") onCancel(); }}
        className="w-16 rounded bg-background px-1 py-0.5 text-[10px]" />
      <button onClick={() => onOk(op, Number(val))} className="rounded bg-sky-500 px-1.5 py-0.5 text-[10px] text-white">确定</button>
      <button onClick={onCancel} className="rounded px-1 py-0.5 text-[10px] text-muted-foreground">取消</button>
    </div>
  );
}
