"use client";
// AI 选股：用户友好版。
// - 隐藏开发者信息（因子验证统计、漏斗、字段 key、数据源标注）
// - 结果用「一眼抓重点」的卡片行：名称/现价/涨跌为大，其余为小字号次要态
// - AI 解读独立成块，人话呈现；数据逻辑与旧版一致，只改呈现
import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, Plus, X, Loader2, Sparkles, ArrowRight } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";
import { useDesk } from "@/lib/desk/store";
import {
  fetchFactorCatalog, fetchTradeDates, runScreenerApi, aiChatTools,
  type FactorFieldDef, type ScreenerCond, type ScreenerRespClient,
} from "@/lib/desk/quant-api";

// 操作符
const OPS = ["=", ">=", ">", "<=", "<", "!=", "in", "not in"] as const;
const isMultiOp = (op: string): boolean => op === "in" || op === "not in";
const parseCondValue = (op: string, raw: string): number | string =>
  isMultiOp(op) ? raw.trim() : Number(raw);

// 常用预设
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
  const [editing, setEditing] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState("amount_yi");
  const [limit, setLimit] = useState(50);
  const [tradeDate, setTradeDate] = useState("");
  const [tradeDates, setTradeDates] = useState<string[]>([]);
  const [todayDate, setTodayDate] = useState("");
  const [result, setResult] = useState<ScreenerRespClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [aiNote, setAiNote] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  // 自定义条件
  const [cField, setCField] = useState("turnover_rate");
  const [cOp, setCOp] = useState<string>(">=");
  const [cVal, setCVal] = useState("3");
  const [cType, setCType] = useState<"single" | "rolling_any" | "rolling_sum" | "rolling_return">("single");
  const [cWindow, setCWindow] = useState("10");
  const [cMinDays, setCMinDays] = useState("3");

  useEffect(() => { fetchFactorCatalog().then(setCatalog).catch((e) => setError(String(e.message || e))); }, []);
  useEffect(() => {
    fetchTradeDates(120).then((d) => { setTradeDates(d.dates); setTodayDate(d.as_of_trade_date); })
      .catch(() => setTradeDates([]));
  }, []);

  const fieldMap = useMemo(() => new Map((catalog?.fields ?? []).map((f) => [f.key, f])), [catalog]);

  const addCond = useCallback((key: string) => {
    const def = fieldMap.get(key);
    if (!def) return;
    if (chips.some((c) => c.field === key && (c.type ?? "single") === "single")) return;
    const preset = PRESET_DEFAULT[key] ?? { op: def.source === "kline" && key.match(/^(above_ma|is_limit_up|ma_struct|macd_cross|kdj_cross|ema14|double_volume|volume_signal|vwap20_filter|vwap20_up3|above_cost_20|break_cost_20|breakout)/) ? "=" : ">=", value: 1 };
    setChips((cs) => [...cs, { field: key, op: preset.op as ScreenerCond["op"], value: preset.value, zh: def.zh }]);
  }, [chips, fieldMap]);

  const addCustom = () => {
    const def = fieldMap.get(cField);
    if (!def || cVal === "") return;
    const parsed = parseCondValue(cOp, cVal);
    const base: ScreenerCond = cType === "single"
      ? { field: cField, op: cOp as ScreenerCond["op"], value: parsed }
      : { type: cType, field: cField, op: cOp as ScreenerCond["op"], value: parsed, window: Number(cWindow) || 10, ...(cType === "rolling_any" ? { min_match_days: Number(cMinDays) || 3 } : {}) };
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
        trade_date: tradeDate || undefined,
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
    setAiBusy(true);
    setAiNote("");
    try {
      const list = result.list.slice(0, 15).map((r) => ({
        代码: r.symbol, 名称: r.name, 现价: r.close, 涨跌幅: r.change_pct,
        胜率: { "1日": r.win_prob?.horizons.find((h) => h.h === 1)?.win_rate ?? null, "5日": r.win_prob?.horizons.find((h) => h.h === 5)?.win_rate ?? null, 样本: r.win_prob?.horizons[0]?.sample_size ?? 0 },
      }));
      const { content } = await aiChatTools(
        { provider: ai.provider, baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, proxy: ai.proxy },
        [{ role: "user", content: `以下是刚刚从全市场筛出的股票（已带历史胜率）。请用大白话帮我看一遍：保留你最看好的 5-10 只，每只一两句话说清楚「为什么值得看、什么价位要小心」；再点出明显要回避的。不要堆砌指标名词，像朋友荐股那样说。数据：\n${JSON.stringify(list)}` }],
        { mode: "deep" },
      );
      setAiNote(content);
    } catch (e) {
      setAiNote(`解读失败：${(e as Error).message}`);
    } finally {
      setAiBusy(false);
    }
  };

  const openProfile = (symbol: string) => { setFocusSymbol(symbol); go("profile"); };
  const condLabel = (c: ChipCond) => `${c.zh} ${c.op} ${c.value}${c.window ? `·近${c.window}日` : ""}`;

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-6 py-6">
      {/* 标题区 */}
      <div className="apple-slide-up">
        <h1 className="text-[22px] font-semibold tracking-tight">AI 选股</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          选几个你在意的条件，从全市场里筛出候选，再让 AI 用大白话帮你过一遍。
        </p>
      </div>

      {/* 条件区 */}
      <div className="apple-card apple-fade-in p-5">
        {catalog ? Object.entries(catalog.category).map(([cat, keys]) => (
          <div key={cat} className="mb-4 last:mb-0">
            <div className="mb-2 text-[12px] font-medium text-muted-foreground/80">{cat}</div>
            <div className="flex flex-wrap gap-1.5">
              {keys.map((k) => {
                const def = fieldMap.get(k)!;
                const active = chips.some((c) => c.field === k && (c.type ?? "single") === "single");
                return (
                  <div key={k} className="relative">
                    <button
                      onClick={() => (active ? setChips((cs) => cs.filter((c) => c.field !== k)) : (addCond(k), setEditing(k)))}
                      className={
                        "rounded-full border px-3.5 py-1.5 text-[12.5px] transition-all duration-200 " +
                        (active
                          ? "border-sky-400/50 bg-sky-400/15 text-sky-200"
                          : "border-border/70 bg-white/[0.02] text-muted-foreground hover:border-sky-400/30 hover:text-foreground")
                      }
                    >
                      {def.zh}
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
        )) : <div className="py-6 text-center text-[13px] text-muted-foreground">正在准备选股条件…</div>}
      </div>

      {/* 已选条件 + 操作 */}
      <div className="apple-card apple-fade-in p-5">
        <div className="mb-2.5 text-[12px] font-medium text-muted-foreground/80">当前条件</div>
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          {chips.length === 0 && <span className="text-[13px] text-muted-foreground/70">还没有条件——点上面的标签添加，例如「放量上涨」「主力流入」</span>}
          {chips.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-400/10 py-1.5 pl-3.5 pr-2 text-[12.5px] text-sky-100">
              {condLabel(c)}
              <select
                value={c.op}
                onChange={(e) => setChips((cs) => cs.map((x, k) => (k === i ? { ...x, op: e.target.value as ScreenerCond["op"] } : x)))}
                className="bg-transparent text-[11px] outline-none"
              >
                {OPS.map((o) => <option key={o} className="text-foreground">{o}</option>)}
              </select>
              <input
                value={String(c.value)}
                onChange={(e) => setChips((cs) => cs.map((x, k) => (k === i ? { ...x, value: parseCondValue(x.op, e.target.value) } : x)))}
                title={isMultiOp(c.op) ? "多个值用逗号分隔" : undefined}
                className={`${isMultiOp(c.op) ? "w-24" : "w-14"} bg-transparent text-[11px] outline-none`}
              />
              <button onClick={() => setChips((cs) => cs.filter((_, k) => k !== i))} className="rounded-full p-0.5 opacity-60 hover:opacity-100"><X size={12} /></button>
            </span>
          ))}
        </div>

        {/* 自定义一行 */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
          <select value={cType} onChange={(e) => setCType(e.target.value as typeof cType)} className="rounded-lg border border-border/70 bg-white/[0.03] px-2.5 py-1.5 text-[12px]">
            <option value="single">单次</option>
            <option value="rolling_any">近N日出现</option>
            <option value="rolling_sum">近N日累计</option>
            <option value="rolling_return">近N日涨跌幅</option>
          </select>
          {cType !== "rolling_return" && (
            <select value={cField} onChange={(e) => setCField(e.target.value)} className="max-w-44 rounded-lg border border-border/70 bg-white/[0.03] px-2.5 py-1.5 text-[12px]">
              {(catalog?.fields ?? []).map((f) => (
                <option key={f.key} value={f.key} disabled={f.implemented === false}>{f.zh}</option>
              ))}
            </select>
          )}
          {cType !== "single" && <input value={cWindow} onChange={(e) => setCWindow(e.target.value)} className="w-14 rounded-lg border border-border/70 bg-white/[0.03] px-2 py-1.5 text-[12px]" />}
          <select value={cOp} onChange={(e) => setCOp(e.target.value)} className="rounded-lg border border-border/70 bg-white/[0.03] px-2.5 py-1.5 text-[12px]">
            {OPS.map((o) => <option key={o}>{o}</option>)}
          </select>
          <input value={cVal} onChange={(e) => setCVal(e.target.value)} placeholder="数值" className="w-20 rounded-lg border border-border/70 bg-white/[0.03] px-2.5 py-1.5 text-[12px]" />
          {cType === "rolling_any" && (<> <span className="text-muted-foreground">至少</span> <input value={cMinDays} onChange={(e) => setCMinDays(e.target.value)} className="w-12 rounded-lg border border-border/70 bg-white/[0.03] px-2 py-1.5 text-[12px]" /> <span className="text-muted-foreground">天</span> </>)}
          <button onClick={addCustom} className="flex items-center gap-1 rounded-full bg-white/[0.06] px-3 py-1.5 text-[12px] text-foreground hover:bg-white/[0.1]">
            <Plus size={13} /> 加入
          </button>
        </div>

        {/* 操作行 */}
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <button onClick={runScan} disabled={busy} className="apple-primary-btn flex items-center gap-2 px-5 py-2.5 text-[14px] font-medium">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} 开始筛选
          </button>
          <button onClick={aiRefine} disabled={!result?.list.length || aiBusy} className="flex items-center gap-2 rounded-full border border-border/70 px-4 py-2.5 text-[13.5px] text-muted-foreground transition-colors hover:border-sky-400/40 hover:text-sky-200 disabled:opacity-40">
            {aiBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} {aiBusy ? "AI 解读中…" : "让 AI 帮我挑"}
          </button>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className="rounded-full border border-border/70 bg-white/[0.03] px-3 py-2 text-[12.5px] text-muted-foreground">
            <option value="amount_yi">按成交额</option>
            <option value="change_pct">按涨跌幅</option>
            <option value="turnover_rate">按换手率</option>
            <option value="volume_ratio">按量比</option>
            <option value="main_net_yi">按主力净额</option>
            <option value="rps_50">按强度</option>
            <option value="win_rate_1">按1日胜率</option>
            <option value="win_rate_5">按5日胜率</option>
            <option value="win_rate_20">按20日胜率</option>
          </select>
          <select value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} className="rounded-full border border-border/70 bg-white/[0.03] px-3 py-2 text-[12.5px] text-muted-foreground">
            <option value="">今日（{todayDate || "实时"}）</option>
            {tradeDates.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="rounded-full border border-border/70 bg-white/[0.03] px-3 py-2 text-[12.5px] text-muted-foreground">
            {[30, 50, 100].map((n) => <option key={n} value={n}>{n} 条</option>)}
          </select>
          {result && <span className="text-[12.5px] text-muted-foreground">共 {result.total} 只</span>}
        </div>

        {error && <div className="mt-3 rounded-xl border border-red-400/25 bg-red-400/10 px-3.5 py-2.5 text-[13px] text-red-300">{error}</div>}
      </div>

      {/* AI 解读 */}
      {aiNote && (
        <div className="apple-card apple-slide-up border-sky-400/20 p-5">
          <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-sky-200">
            <Sparkles size={16} /> AI 怎么看
          </div>
          <div className="prose-invert text-[13.5px] leading-relaxed text-foreground/90">{aiNote}</div>
          <div className="mt-3 text-[11.5px] text-muted-foreground/70">AI 解读仅供参考，不构成投资建议。</div>
        </div>
      )}

      {/* 结果：卡片行 */}
      {result && (
        <div className="apple-stagger space-y-2.5">
          {/* P9-经验轮：被数据缺口忽略的条件必须当面说清——「选不出来」有两种，
              没有股票符合 vs 这个字段现在根本查不到，用户必须分得清。 */}
          {(result.unavailable_fields?.length ?? 0) > 0 && (
            <div className="apple-card border-amber-500/30 bg-amber-500/[0.06] px-5 py-3.5 text-[13px] leading-relaxed">
              <span className="font-medium text-amber-200">以下条件因数据缺口被忽略，本次结果没有按它们筛选：</span>
              <span className="text-amber-200/90"> {result.unavailable_fields!.map((g) => g.zh).join("、")}</span>
              <div className="mt-1 text-[12.5px] text-muted-foreground">
                当前数据源里这些字段没有任何真实读数（资金类数据断源兜底期），换用涨跌幅/成交额/换手率/强度等条件即可正常筛选。
              </div>
            </div>
          )}
          {result.list.map((r, idx) => {
            const wp = r.win_prob;
            const h1 = wp?.horizons.find((h) => h.h === 1);
            const h5 = wp?.horizons.find((h) => h.h === 5);
            const h20 = wp?.horizons.find((h) => h.h === 20);
            return (
              <button
                key={r.symbol}
                onClick={() => openProfile(r.symbol)}
                className="apple-card group flex w-full items-center gap-4 px-5 py-4 text-left transition-all duration-200 hover:border-sky-400/30 hover:bg-white/[0.05]"
              >
                <span className="w-6 shrink-0 text-right text-[12px] text-muted-foreground/60">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[15px] font-medium">{r.name}</span>
                    <span className="font-mono text-[11.5px] text-muted-foreground/60">{r.symbol}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[12px] text-muted-foreground/80">
                    <span>成交 <NumText value={r.values.amount_yi} digits={1} /> 亿</span>
                    <span>换手 <NumText value={r.values.turnover_rate} />%</span>
                    <span>主力 <NumText value={r.values.main_net_yi} digits={1} /> 亿</span>
                    <span>强度 <NumText value={r.values.rps_50} digits={0} /></span>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[18px] font-semibold"><NumText value={r.close} digits={2} /></div>
                  <div className="mt-0.5"><PctText value={r.change_pct} className="text-[13px] font-medium" /></div>
                </div>
                <div className="hidden w-24 shrink-0 text-right sm:block">
                  <div className="text-[11px] text-muted-foreground/70">历史胜率</div>
                  <div className="mt-0.5 flex items-center justify-end gap-2 text-[12px]">
                    <WinRate h={h1} label="1日" />
                    <WinRate h={h5} label="5日" />
                    <WinRate h={h20} label="20日" />
                  </div>
                </div>
                <ArrowRight size={16} className="shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-sky-300" />
              </button>
            );
          })}
          {result.list.length === 0 && ((result.unavailable_fields?.length ?? 0) > 0 ? (
            <div className="apple-card px-6 py-10 text-center text-[13.5px] text-muted-foreground">
              本次没能真正执行筛选——你的条件里的字段（见上方黄色提示）当前数据源取不到，不显示任何「命中」也不假装筛过了。
              <div className="mt-1.5 text-[12.5px] text-muted-foreground/70">这不是「没有股票符合条件」，去掉这些字段或改用 K线/行情类条件再试即可。</div>
            </div>
          ) : (
            <div className="apple-card px-4 py-10 text-center text-[13px] text-muted-foreground">没有符合条件的股票，试试放宽条件。</div>
          ))}
        </div>
      )}

      {!result && !busy && (
        <div className="apple-card apple-fade-in px-4 py-12 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.04]">
            <Search size={20} className="text-muted-foreground" />
          </div>
          <div className="text-[14px] text-foreground/80">选好条件，点「开始筛选」</div>
          <div className="mt-1 text-[12.5px] text-muted-foreground">筛完可以让 AI 再帮你用大白话挑一遍。</div>
        </div>
      )}
    </div>
  );
}

function WinRate({ h, label }: { h?: { win_rate: number | null; sample_size: number }; label: string }) {
  const v = h?.win_rate;
  const cls = v == null ? "text-muted-foreground/50" : v >= 55 ? "text-red-400" : v >= 50 ? "text-foreground/80" : "text-emerald-400";
  return (
    <span className={cls} title={`${label}：${v == null ? "暂无样本" : v.toFixed(0) + "%（样本 " + h!.sample_size + "）"}`}>
      {v == null ? "—" : v.toFixed(0) + "%"}
    </span>
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
    <div className="apple-card absolute left-0 top-9 z-30 flex items-center gap-1.5 p-2 shadow-2xl">
      <span className="pl-1 text-[11px] text-muted-foreground">{def.zh}</span>
      <select value={op} onChange={(e) => setOp(e.target.value)} className="rounded-lg bg-white/[0.05] px-1.5 py-1 text-[11px]">
        {OPS.map((o) => <option key={o}>{o}</option>)}
      </select>
      <input value={val} onChange={(e) => setVal(e.target.value)} autoFocus
        placeholder={isMultiOp(op) ? "用逗号分隔" : "数值"}
        onKeyDown={(e) => { if (e.key === "Enter") onOk(op, parseCondValue(op, val)); if (e.key === "Escape") onCancel(); }}
        className={`${isMultiOp(op) ? "w-24" : "w-16"} rounded-lg bg-white/[0.05] px-1.5 py-1 text-[11px] outline-none`} />
      <button onClick={() => onOk(op, parseCondValue(op, val))} className="rounded-lg bg-sky-400/20 px-2 py-1 text-[11px] text-sky-200">确定</button>
      <button onClick={onCancel} className="rounded-lg px-1.5 py-1 text-[11px] text-muted-foreground">取消</button>
    </div>
  );
}
