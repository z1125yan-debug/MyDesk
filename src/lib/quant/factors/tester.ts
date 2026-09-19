// P1-4 因子有效性测试台 — 单因子测试引擎（服务端）
// 流程（需求文档 五）：样本池（全A快照粗筛剔 ST/停牌 → 流动性Top-N）→ fetchBarsHybrid 取长历史
//   → buildFieldPanel → IC/RankIC/ICIR/5档分层/单调性/换手（复用 metrics.ts，口径：t 日因子 ↔ t→t+h 前向收益，
//   因子只用 ≤t 数据，标签在 t 之后，防泄漏）→ 月度胜率（方向调整）→ 最优档组合最大回撤。
// 通过标准（文档硬性）：|ICIR|>0.5 或 分层单调性显著(|ρ|≥0.9)，且 月度胜率>60%，且样本充足。
// 快照口径字段无历史时点数据 → 明确拒绝测试（REAL_DATA_ONLY，不造数）。
import { getProvider } from "@/lib/quant/data/index";
import { fetchBarsHybrid } from "@/lib/quant/data/hybrid";
import { shanghaiDate } from "@/lib/desk/session";
import {
  buildFieldPanel, FACTOR_FIELD_DEFS, FACTOR_FIELD_MAP, markFieldVerified, type BarsLike,
} from "@/lib/quant/factors/fields";
import { evaluateFactorMetrics } from "@/lib/quant/factors/metrics";

export interface FactorTestOptions {
  field: string;
  horizon?: number;    // 前向收益天数，默认 5
  maxStocks?: number;  // 样本池上限（按成交额流动性Top-N），默认 300
  lookback?: number;   // 日K根数，默认 500
}

export interface FactorTestResult {
  field: string;
  fieldZh: string;
  horizon: number;
  testedAt: string;
  passed: boolean;
  passRule: string;
  metrics: {
    ic: number;
    rankIc: number;
    icIr: number;
    groupAnnual: number[];
    monotonicity: number;
    turnover: number;
    monthlyWinRate: number;
    maxDrawdown: number;
    sample: { dates: number; stocks: number; validPairs: number };
    dataRange: string;
  };
  monthlyIc: { month: string; rankIc: number }[];
  icSeriesLite: { date: string; rankIc: number }[];
  note: string;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

export async function runFactorTest(opts: FactorTestOptions): Promise<FactorTestResult> {
  const def = FACTOR_FIELD_MAP.get(opts.field);
  if (!def) throw new Error(`未知因子字段：${opts.field}`);
  if (def.implemented === false) {
    throw new Error(`「${def.zh}」(${def.key}) 已登记但未实现（依赖筹码分布或无原始公式，status=pending_dependency），无法测试（明确拒绝，不造数）`);
  }
  if (def.source !== "kline") {
    throw new Error(`「${def.zh}」(${def.key}) 是快照口径字段：无历史时点数据，无法做 IC/分层测试（明确拒绝，不造数）`);
  }
  const horizon = Math.max(1, Math.min(20, opts.horizon ?? 5));
  const maxStocks = Math.max(50, Math.min(600, opts.maxStocks ?? 300));
  const lookback = Math.max(200, Math.min(800, opts.lookback ?? 500));

  // 1) 样本池：全A快照粗筛（剔 ST/停牌）→ 流动性 Top-N
  const provider = await getProvider("em");
  const asOf = shanghaiDate();
  const metas = (await provider.listUniverse({ kind: "all" }, asOf))
    .filter((m) => !m.st && !m.suspended && (m.amount ?? 0) > 0)
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, maxStocks);
  if (metas.length < 50) throw new Error(`样本池仅 ${metas.length} 只（<50），数据源返回不足，测试中止`);

  // 2) 长历史日K + 因子面板
  const barsMap = await fetchBarsHybrid(metas.map((m) => m.symbol), asOf, lookback);
  const symbols: string[] = [];
  const barsList: BarsLike[][] = [];
  const metasOf: typeof metas = [];
  for (const m of metas) {
    const bars = (barsMap.get(m.symbol) ?? []) as BarsLike[];
    if (bars.length < 120) continue; // 历史过短的股票不参与（新上市干扰截面）
    symbols.push(m.symbol);
    barsList.push(bars);
    metasOf.push(m);
  }
  if (symbols.length < 50) throw new Error(`有效K线样本仅 ${symbols.length} 只（<50），测试中止`);
  const panel = buildFieldPanel(symbols, barsList, metasOf);
  return testFieldOnPanel(def, panel, horizon);
}

/** 在既有面板上跑单因子测试（批量模式复用同一次数据拉取与面板构建，口径与逐项一致） */
export function testFieldOnPanel(
  def: NonNullable<ReturnType<typeof FACTOR_FIELD_MAP.get>>,
  panel: ReturnType<typeof buildFieldPanel>,
  horizon: number,
): FactorTestResult {
  const symbols = panel.symbols;
  const factorMat = panel.fields.get(def.key);
  if (!factorMat) throw new Error(`面板中不存在字段 ${def.key}`);

  // 3) 指标（复用 Phase 2 指标引擎；minStocks 提高以保截面质量）
  const full = evaluateFactorMetrics(factorMat, panel, {
    horizon, groups: 5, minStocks: Math.max(30, Math.floor(symbols.length * 0.3)),
  });

  // 4) 月度胜率（方向调整：整体 RankIC 为负的因子按反向计胜率）
  const sign = Math.sign(full.rankIc ?? 0) || 1;
  const byMonth = new Map<string, number[]>();
  for (const s of full.icSeries) {
    const mo = s.date.slice(0, 7);
    (byMonth.get(mo) ?? byMonth.set(mo, []).get(mo)!).push(s.rankIc);
  }
  const monthlyIc = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, rankIc: mean(v) * sign })); // 方向调整：正=当月有效
  const monthlyWinRate = monthlyIc.length
    ? monthlyIc.filter((m) => m.rankIc > 0).length / monthlyIc.length
    : 0;

  // 5) 最优档（方向调整后因子值最大组）1日前瞻收益复权曲线 → 最大回撤
  const cMat = panel.fields.get("c")!;
  const fAdj = sign < 0
    ? factorMat.map((row) => row.map((v) => (v === null ? null : -v)))
    : factorMat;
  const T = panel.dates.length;
  const n = symbols.length;
  let equity = 1, peak = 1, maxDd = 0;
  const topPct = 0.2;
  for (let t = Math.floor(T * 0.3); t < T - 1; t++) {
    const pairs: { f: number; r: number }[] = [];
    for (let si = 0; si < n; si++) {
      const f = fAdj[si][t];
      const c0 = cMat[si][t], c1 = cMat[si][t + 1];
      if (f !== null && f !== undefined && c0 !== null && c1 !== null && c0 > 0) {
        pairs.push({ f, r: c1 / c0 - 1 });
      }
    }
    if (pairs.length < 30) continue;
    pairs.sort((a, b) => b.f - a.f);
    const top = pairs.slice(0, Math.max(1, Math.floor(pairs.length * topPct)));
    equity *= 1 + mean(top.map((p) => p.r));
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }

  // 6) 通过判定（文档五硬性）
  const enoughSample = full.sample.validPairs >= 60 && monthlyIc.length >= 4;
  const icirPass = Math.abs(full.icIr ?? 0) > 0.5;
  const monoPass = Math.abs(full.monotonicity ?? 0) >= 0.9;
  const winPass = monthlyWinRate > 0.6;
  const passed = enoughSample && (icirPass || monoPass) && winPass;
  const passRule =
    `通过条件：(|ICIR|>0.5 ${icirPass ? "✓" : "✗"} 或 分层单调|ρ|≥0.9 ${monoPass ? "✓" : "✗"}) ` +
    `且 月度胜率>60%（${(monthlyWinRate * 100).toFixed(0)}% ${winPass ? "✓" : "✗"}）且 样本充足（${enoughSample ? "✓" : "✗"}）`;

  markFieldVerified(def.key, passed);

  const dataRange = panel.dates.length ? `${panel.dates[0]}~${panel.dates[T - 1]}` : "";
  return {
    field: def.key,
    fieldZh: def.zh,
    horizon,
    testedAt: shanghaiDate(),
    passed,
    passRule,
    metrics: {
      ic: full.ic ?? 0,
      rankIc: full.rankIc ?? 0,
      icIr: full.icIr ?? 0,
      groupAnnual: full.groupAnnual,
      monotonicity: full.monotonicity ?? 0,
      turnover: full.turnover ?? 0,
      monthlyWinRate,
      maxDrawdown: maxDd,
      sample: full.sample,
      dataRange,
    },
    monthlyIc,
    icSeriesLite: full.icSeries.map((s) => ({ date: s.date, rankIc: s.rankIc })),
    note: `样本=${symbols.length}只流动性Top（全A剔ST/停牌）×${T}个交易日；t日因子↔t+${horizon}前向收益（防泄漏）；胜率按方向调整后月度RankIC>0占比`,
  };
}

// ---------- 批量验证（Task P2-1）：一次拉数 + 一次建面板，逐因子复用同一口径 ----------

export interface BatchFieldTestOptions {
  fields?: string[];   // 指定因子；默认 = 全部可测（implemented!==false 且 source==="kline"）
  horizon?: number;    // 默认 5
  maxStocks?: number;  // 默认 300
  lookback?: number;   // 默认 500（需求文档口径：需覆盖 250 日窗口因子，故不用指令文档的 250）
}

export interface BatchFieldTestRow {
  field: string;
  fieldZh: string;
  category: string;
  tested: boolean;
  passed: boolean;          // 需求文档§五硬性标准（verified=true 的唯一依据）
  loosePass: boolean;       // 指令文档宽松线：|RankIC|>0.03 且 |ICIR|>0.3（仅报告，不落 verified）
  rankIc: number;
  ic: number;
  icIr: number;
  monotonicity: number;
  monthlyWinRate: number;
  turnover: number;
  maxDrawdown: number;
  sampleDates: number;
  sampleStocks: number;
  validPairs: number;
  months: number;
  error: string;
  result: FactorTestResult | null;
}

export interface BatchFieldTestReport {
  ok: true;
  asOfTradeDate: string;
  horizon: number;
  lookback: number;
  dataRange: string;
  universeStocks: number;
  panelStocks: number;
  panelDates: number;
  totals: { requested: number; tested: number; passed: number; loosePassed: number; failed: number };
  rows: BatchFieldTestRow[];
  unavailable: { field: string; reason: string }[];
}

/** 宽松线（指令文档给的参考线）——只用于报告对比，不作为 verified 依据 */
export function loosePassOf(rankIc: number, icIr: number): boolean {
  return Math.abs(rankIc) > 0.03 && Math.abs(icIr) > 0.3;
}

/**
 * 批量跑因子有效性测试：样本池/K线/面板只构建一次，逐因子在同一数据上判定，
 * 与逐项 runFactorTest 口径完全一致（testFieldOnPanel）。
 * 不可测因子（pending/快照口径）不进入 rows，由 unavailable 列表明确说明原因。
 */
export async function runBatchFieldTests(opts: BatchFieldTestOptions = {}): Promise<BatchFieldTestReport> {
  const horizon = Math.max(1, Math.min(20, opts.horizon ?? 5));
  const maxStocks = Math.max(50, Math.min(600, opts.maxStocks ?? 300));
  const lookback = Math.max(200, Math.min(800, opts.lookback ?? 500));

  const allTestable = FACTOR_FIELD_DEFS
    .filter((d) => d.implemented !== false && d.source === "kline")
    .map((d) => d.key);
  const requested = (opts.fields?.length ? opts.fields : allTestable)
    .filter((k, i, a) => a.indexOf(k) === i);
  const unavailable: { field: string; reason: string }[] = [];
  const testable: string[] = [];
  for (const k of requested) {
    const def = FACTOR_FIELD_MAP.get(k);
    if (!def) { unavailable.push({ field: k, reason: "未知字段" }); continue; }
    if (def.implemented === false) { unavailable.push({ field: k, reason: "已登记未实现（pending_dependency）" }); continue; }
    if (def.source !== "kline") { unavailable.push({ field: k, reason: "快照口径，无历史时点数据" }); continue; }
    testable.push(k);
  }

  // 1) 样本池 + 2) 长历史 + 面板（一次）
  const provider = await getProvider("em");
  const asOf = shanghaiDate();
  const metas = (await provider.listUniverse({ kind: "all" }, asOf))
    .filter((m) => !m.st && !m.suspended && (m.amount ?? 0) > 0)
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, maxStocks);
  if (metas.length < 50) throw new Error(`样本池仅 ${metas.length} 只（<50），数据源返回不足，批量测试中止`);

  const barsMap = await fetchBarsHybrid(metas.map((m) => m.symbol), asOf, lookback);
  const symbols: string[] = [];
  const barsList: BarsLike[][] = [];
  const metasOf: typeof metas = [];
  for (const m of metas) {
    const bars = (barsMap.get(m.symbol) ?? []) as BarsLike[];
    if (bars.length < 120) continue;
    symbols.push(m.symbol);
    barsList.push(bars);
    metasOf.push(m);
  }
  if (symbols.length < 50) throw new Error(`有效K线样本仅 ${symbols.length} 只（<50），批量测试中止`);
  const panel = buildFieldPanel(symbols, barsList, metasOf);

  // 3) 逐因子
  const rows: BatchFieldTestRow[] = [];
  for (const key of testable) {
    const def = FACTOR_FIELD_MAP.get(key)!;
    try {
      const r = testFieldOnPanel(def, panel, horizon);
      rows.push({
        field: key,
        fieldZh: def.zh,
        category: def.category ?? "",
        tested: true,
        passed: r.passed,
        loosePass: loosePassOf(r.metrics.rankIc, r.metrics.icIr),
        rankIc: r.metrics.rankIc,
        ic: r.metrics.ic,
        icIr: r.metrics.icIr,
        monotonicity: r.metrics.monotonicity,
        monthlyWinRate: r.metrics.monthlyWinRate,
        turnover: r.metrics.turnover,
        maxDrawdown: r.metrics.maxDrawdown,
        sampleDates: r.metrics.sample.dates,
        sampleStocks: r.metrics.sample.stocks,
        validPairs: r.metrics.sample.validPairs,
        months: r.monthlyIc.length,
        error: "",
        result: r,
      });
    } catch (e) {
      rows.push({
        field: key, fieldZh: def.zh, category: def.category ?? "", tested: false,
        passed: false, loosePass: false, rankIc: 0, ic: 0, icIr: 0, monotonicity: 0,
        monthlyWinRate: 0, turnover: 0, maxDrawdown: 0,
        sampleDates: 0, sampleStocks: 0, validPairs: 0, months: 0,
        error: (e as Error).message, result: null,
      });
    }
  }

  const T = panel.dates.length;
  return {
    ok: true,
    asOfTradeDate: asOf,
    horizon,
    lookback,
    dataRange: T ? `${panel.dates[0]}~${panel.dates[T - 1]}` : "",
    universeStocks: metas.length,
    panelStocks: symbols.length,
    panelDates: T,
    totals: {
      requested: requested.length,
      tested: rows.filter((r) => r.tested).length,
      passed: rows.filter((r) => r.passed).length,
      loosePassed: rows.filter((r) => r.loosePass).length,
      failed: rows.filter((r) => !r.tested).length,
    },
    rows,
    unavailable,
  };
}
