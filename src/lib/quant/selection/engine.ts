// Quant Research Lab — 选股引擎（Phase 7，一等模块，纯逻辑）
// 唯一实现：实时选股与历史回放共用同一条代码路径（历史回放只是 asOf 与后续评估不同）。
// 数据纪律：因子与过滤一律只用 ≤ asOf 的数据；asOf 早于今天时明确标注幸存者偏差风险。
import { parseExpression, evaluateAst, csRank, csZscore, csMinMax } from "../factors/expression.ts";
import { applyUniverseFilters } from "../data/provider.ts";
import type {
  AssetMeta, Bar, BarsRequest, DataProvider, FactorRef, SelectionRequest, SelectionResult,
  SelectionRow, UniverseSpec,
} from "../types.ts";

const SCORERS = {
  rank: csRank,
  zscore: csZscore,
  minmax: csMinMax,
};

// 选股因子引用：在 FactorRef 之上要求携带表达式（由 API 层从因子库按版本解析填充）
export type SelectionFactorRef = FactorRef & { expression: string };

export interface SelectionRuntime {
  provider: DataProvider;
  request: Omit<SelectionRequest, "factors"> & { factors?: SelectionFactorRef[] };
}

// 从面板式 K 线取"截至 asOf 最后一根有效K线"的字段值
function lastValid(series: (number | null)[]): { value: number | null; date: string | null } {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return { value: series[i], date: null };
  }
  return { value: null, date: null };
}

// 截面打分：因子方向 × 权重，支持 rank/zscore/minmax
export function compositeScores(
  factorMats: { ref: FactorRef; values: Map<string, number> }[],
  symbols: string[],
  method: "rank" | "zscore" | "minmax",
): { scores: Map<string, number>; triggered: Map<string, string[]> } {
  const scores = new Map<string, number>();
  const triggered = new Map<string, string[]>();
  const scoreFn = SCORERS[method] ?? csRank;
  for (const { ref, values } of factorMats) {
    const raw = symbols.map((s) => values.get(s) ?? null);
    const transformed = scoreFn(raw);
    symbols.forEach((s, i) => {
      const tv = transformed[i];
      if (tv === null || raw[i] === null) return;
      const contribution = tv * ref.direction * ref.weight;
      scores.set(s, (scores.get(s) ?? 0) + contribution);
      const list = triggered.get(s) ?? [];
      list.push(ref.factorKey);
      triggered.set(s, list);
    });
  }
  return { scores, triggered };
}

// 规则选股（rule mode）：独立于因子评分的硬性条件
export function applyRule(
  rule: { key: string; params: Record<string, unknown> },
  ctx: { symbol: string; bars: Bar[]; meta: AssetMeta },
): { pass: boolean; reason: string } {
  const closes = ctx.bars.map((b) => b.c);
  const n = closes.length;
  switch (rule.key) {
    case "above_ma": {
      const w = Number(rule.params.window ?? 20);
      if (n < w) return { pass: false, reason: `K线不足 ${w} 根` };
      const ma = closes.slice(-w).reduce((s, v) => s + v, 0) / w;
      const last = closes[n - 1];
      return { pass: last >= ma, reason: `收盘${last >= ma ? "≥" : "<"}MA${w}(${ma.toFixed(2)})` };
    }
    case "near_high": {
      const w = Number(rule.params.window ?? 60);
      const ratio = Number(rule.params.ratio ?? 0.9);
      if (n < 5) return { pass: false, reason: "K线不足" };
      const high = Math.max(...ctx.bars.slice(-w).map((b) => b.h));
      const last = closes[n - 1];
      return { pass: last >= high * ratio, reason: `现价位于${w}日高点 ${(last / high * 100).toFixed(0)}%` };
    }
    case "amount_rank": {
      // amount_rank 需要 UniverseSpec 截面信息，这里永远通过（用过滤条件代替）；仅为占位规则
      return { pass: true, reason: "amount_rank 由截面排序阶段处理" };
    }
    default:
      return { pass: false, reason: `未知规则 ${rule.key}` };
  }
}

export async function runSelection(runtime: SelectionRuntime): Promise<SelectionResult> {
  const { provider, request } = runtime;
  const asOf = request.asOf;
  const warnings: string[] = [];
  const filters = request.filters ?? {};
  const topN = Math.max(1, request.scoring?.topN ?? 20);
  const method = request.scoring?.method ?? "rank";

  // 1) 股票池
  const metas = await provider.listUniverse(request.universe, asOf);
  if (!metas.length) throw new Error("股票池为空（检查股票池配置与 asOf）");

  // 1.5) 预过滤（无需K线的数据）：ST / 上市时间 / 市值快照
  let preDropped = 0;
  let pool = metas.filter((m) => {
    if (filters.excludeST !== false && m.st) { preDropped++; return false; }
    if (filters.minListDays && m.listDate) {
      const days = (Date.parse(asOf) - Date.parse(m.listDate)) / 86400000;
      if (days < filters.minListDays) { preDropped++; return false; }
    }
    if (filters.minMarketCap && m.marketCap && m.marketCap < filters.minMarketCap) { preDropped++; return false; }
    if (filters.maxMarketCap && m.marketCap && m.marketCap > filters.maxMarketCap) { preDropped++; return false; }
    return true;
  });

  // 1.6) K线子集上限：大池（全A）不逐只拉K线——按快照成交额取流动性前 K 只
  //      （K线级过滤与因子计算只在该子集内做；超出部分没有K线，无法参与打分）
  const maxKline = Math.max(20, request.maxKlineSymbols ?? 300);
  if (pool.length > maxKline) {
    pool = [...pool].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, maxKline);
    warnings.push(`股票池 ${metas.length} 只超出K线子集上限 ${maxKline}：已按快照成交额取流动性前 ${maxKline} 只参与过滤与打分`);
  }

  // 2) 拉取近期K线（严格 ≤ asOf），用于价格/成交额/成交量过滤与因子计算
  const lookback = 120;
  const barsReq: BarsRequest = { symbols: pool.map((m) => m.symbol), tf: "day", asOf, lookback };
  const barsMap = await provider.getBars(barsReq);

  // 3) 数据可得性过滤（停牌 = asOf 当日无K线）
  const withBars: { meta: AssetMeta; bars: Bar[] }[] = [];
  let suspended = 0;
  for (const m of pool) {
    const bars = barsMap.get(m.symbol) ?? [];
    const lastBar = bars.length ? bars[bars.length - 1] : null;
    if (!lastBar || lastBar.date.slice(0, 10) !== asOf) {
      if (filters.excludeSuspended !== false) { suspended++; continue; }
    }
    withBars.push({ meta: m, bars });
  }

  // 4) K线级过滤（价格/成交额/换手/成交量——均为 asOf 当日真实值，无未来数据）
  const preFiltered: { meta: AssetMeta; bars: Bar[] }[] = [];
  let filterDropped = 0;
  const floatCapOf = (m: AssetMeta): number | null => (typeof m.floatCap === "number" ? m.floatCap : null);
  for (const { meta, bars } of withBars) {
    const lastBar = bars[bars.length - 1];
    const price = lastBar?.c;
    const amount = lastBar?.amount ?? null;
    const volume = lastBar?.v ?? null;
    if (filters.minPrice && (price ?? 0) < filters.minPrice) { filterDropped++; continue; }
    if (filters.maxPrice && price !== null && price > filters.maxPrice) { filterDropped++; continue; }
    if (filters.minAmount && (amount ?? 0) < filters.minAmount) { filterDropped++; continue; }
    if (filters.minVolume && (volume ?? 0) < filters.minVolume) { filterDropped++; continue; }
    if (filters.minTurnover || filters.maxTurnover) {
      const fc = floatCapOf(meta);
      if (fc && amount !== null) {
        const turnover = (amount / fc) * 100;
        if (filters.minTurnover && turnover < filters.minTurnover) { filterDropped++; continue; }
        if (filters.maxTurnover && turnover > filters.maxTurnover) { filterDropped++; continue; }
      } else {
        warnings.push(`${meta.symbol} 缺流通市值/成交额，跳过换手率过滤`);
      }
    }
    preFiltered.push({ meta, bars });
  }
  filterDropped += preDropped;

  // 5) 规则模式 / 因子模式 / 多因子模式
  const survivors: { symbol: string; name: string; triggered: string[]; reasons: string[] }[] = [];
  const universeSymbols = preFiltered.map((p) => p.meta.symbol);
  let scores = new Map<string, number>();

  if (request.mode === "rule") {
    const rules = request.rules ?? [];
    for (const { meta, bars } of preFiltered) {
      const triggered: string[] = [];
      const reasons: string[] = [];
      let pass = rules.length > 0;
      for (const rule of rules) {
        const r = applyRule(rule, { symbol: meta.symbol, bars, meta });
        if (r.pass) { triggered.push(rule.key); reasons.push(r.reason); } else { pass = false; break; }
      }
      if (pass) survivors.push({ symbol: meta.symbol, name: meta.name, triggered, reasons });
    }
  } else {
    // factor / multi_factor / strategy：因子截面打分
    if (!request.factors?.length) throw new Error("因子模式需要至少一个因子（factors）");
    // 因子矩阵在"过滤后股票池"上求值
    const factorMats: { ref: FactorRef; values: Map<string, number> }[] = [];
    for (const ref of request.factors) {
      const expr = parseExpression(ref.expression); // API 层已按 (factorKey, version) 从因子库解析
      const mat = evaluateAst(expr, asEvalPanel(buildMiniPanel(preFiltered.map((p) => p.bars), universeSymbols, preFiltered.map((p) => p.meta))));
      const values = new Map<string, number>();
      mat.forEach((row, si) => {
        for (let t = row.length - 1; t >= 0; t--) {
          if (row[t] !== null) { values.set(universeSymbols[si], row[t]!); break; }
        }
      });
      factorMats.push({ ref, values });
    }
    const { scores: sc, triggered } = compositeScores(factorMats, universeSymbols, method);
    scores = sc;
    for (const { meta } of preFiltered) {
      const score = scores.get(meta.symbol);
      if (score === undefined) continue; // 因子值缺失（次新/长期停牌）
      survivors.push({
        symbol: meta.symbol, name: meta.name,
        triggered: triggered.get(meta.symbol) ?? [],
        reasons: [`综合分 ${score.toFixed(4)}（${method}）`],
      });
    }
  }

  // 6) 排名取 TopN
  const ordered = survivors.sort((a, b) => (scores.get(b.symbol) ?? 0) - (scores.get(a.symbol) ?? 0));
  const top = request.mode === "rule" ? ordered.slice(0, topN) : ordered.slice(0, topN);

  // 7) 风险标注
  const coverage = provider.coverage();
  const riskBits: string[] = [];
  if (coverage.universeMembership === "current_only" && asOf < todayStr()) {
    riskBits.push("历史回放：成分股名单为当前快照（幸存者偏差风险）");
  }
  if (coverage.fundamentals !== "historical") riskBits.push("市值/换手为当前快照口径");
  const risk = riskBits.join("；") || "无";

  const rows: SelectionRow[] = top.map((s, i) => ({
    code: s.symbol,
    name: s.name,
    timestamp: asOf,
    strategyVersion: strategyVersionLabel(request),
    factorVersions: (request.factors ?? []).map((f) => `${f.factorKey}@${f.version}`).join(","),
    score: Math.round((scores.get(s.symbol) ?? 0) * 10000) / 10000,
    rank: i + 1,
    triggeredFactors: s.triggered,
    reason: s.reasons.join("；") || "因子综合分入选",
    risk,
  }));

  return {
    request,
    rows,
    excluded: { st: filterDropped, suspended, listDays: 0, filters: filterDropped, universe: metas.length },
    warnings,
    source: provider.id,
  };
}

function strategyVersionLabel(request: SelectionRequest): string {
  if (request.strategyKey) return `${request.strategyKey}@${request.strategyVersion ?? "latest"}:${request.mode}`;
  return `adhoc:${request.mode}:${(request.factors ?? []).length}f`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// 轻量面板（选股引擎专用：避免与因子挖掘的 buildPanel 耦合；字段对齐 K 线原始序列）
function buildMiniPanel(barsList: Bar[][], symbols: string[], metas?: AssetMeta[]) {
  const dateSet = new Set<string>();
  for (const bars of barsList) for (const b of bars) dateSet.add(b.date);
  const dates = [...dateSet].sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const fields = new Map<string, (number | null)[][]>();
  for (const f of ["o", "h", "l", "c", "v", "amount"] as const) {
    fields.set(f, symbols.map(() => new Array<number | null>(dates.length).fill(null)));
  }
  barsList.forEach((bars, si) => {
    for (const b of bars) {
      const di = dateIdx.get(b.date);
      if (di === undefined) continue;
      fields.get("o")![si][di] = b.o;
      fields.get("h")![si][di] = b.h;
      fields.get("l")![si][di] = b.l;
      fields.get("c")![si][di] = b.c;
      fields.get("v")![si][di] = b.v;
      if (b.amount !== undefined) fields.get("amount")![si][di] = b.amount;
    }
  });
  // ret 字段
  {
    const c = fields.get("c")!;
    fields.set("ret", c.map((series) => series.map((v, t) => (v !== null && series[t + 1] !== null && v > 0 ? series[t + 1]! / v - 1 : null))));
  }
  // 快照字段（pe/pb/cap/floatcap/turnover 按符号常数填充；当前快照口径）
  if (metas && metas.length === symbols.length) {
    const snap: [string, (m: AssetMeta) => number | null | undefined][] = [
      ["pe", (m) => m.pe], ["pb", (m) => m.pb], ["cap", (m) => m.marketCap],
      ["floatcap", (m) => m.floatCap], ["turnover", (m) => m.turnover],
    ];
    for (const [name, get] of snap) {
      fields.set(name, metas.map((m) => {
        const v = get(m);
        return dates.map(() => (typeof v === "number" ? v : null));
      }));
    }
  }
  return { dates, symbols, fields };
}

// ---------- 历史选股回放：调同一个 runSelection，之后模拟未来 N 日表现 ----------
export interface ReplayOutcome {
  selection: SelectionResult;
  horizon: number;
  forwardWindow: { start: string; end: string };
  picks: {
    code: string; name: string; rank: number; score: number;
    entryPrice: number | null; exitPrice: number | null; forwardReturn: number | null;
    benchmarkReturn: number | null; excess: number | null; suspendedDays: number;
  }[];
  stats: {
    avgForwardReturn: number | null; medianForwardReturn: number | null;
    winRate: number | null; avgExcess: number | null;
    benchmarkReturn: number | null;
  };
  warnings: string[];
}

export async function runSelectionReplay(
  provider: DataProvider,
  request: Omit<SelectionRequest, "factors"> & { factors?: SelectionFactorRef[] },
  horizon: number,
): Promise<ReplayOutcome> {
  if (request.asOf >= todayStr()) {
    throw new Error("历史回放的 asOf 必须早于今天（未来数据不可得）");
  }
  const selection = await runSelection({ provider, request });
  const horizonClamped = Math.max(1, Math.min(60, horizon));

  // 未来窗口：asOf 之后 horizon 根 K 线 —— 这是回放专用的"标签"数据，绝无可能进入选股决策
  const symbols = selection.rows.map((r) => r.code);
  const afterDate = await nextDates(provider, request.asOf, horizonClamped + 1);

  const exitBars = await provider.getBars({
    symbols, tf: "day", asOf: afterDate.endDate, lookback: horizonClamped + 130,
  });
  const entryBars = await provider.getBars({
    symbols: [selection.rows[0]?.code ?? "000001.SH"], tf: "day", asOf: request.asOf, lookback: 2,
  });

  const picks = selection.rows.map((row) => {
    const bars = exitBars.get(row.code) ?? [];
    const entryIdx = bars.findIndex((b) => b.date === request.asOf);
    const entryPrice = entryIdx >= 0 ? bars[entryIdx].c : (entryBars.get(row.code)?.at(-1)?.c ?? null);
    const exitIdx = Math.min(bars.length - 1, entryIdx + horizonClamped);
    const exitBar = entryIdx >= 0 && exitIdx >= 0 && exitIdx < bars.length ? bars[exitIdx] : null;
    let suspendedDays = 0;
    if (entryIdx >= 0) {
      for (let t = entryIdx + 1; t <= exitIdx && t < bars.length; t++) {
        if (bars[t].v === 0) suspendedDays++;
      }
    }
    const forwardReturn = entryPrice && exitBar ? exitBar.c / entryPrice - 1 : null;
    return {
      code: row.code, name: row.name, rank: row.rank, score: row.score,
      entryPrice, exitPrice: exitBar?.c ?? null, forwardReturn,
      benchmarkReturn: null, excess: null, suspendedDays,
    };
  });

  // 基准：等权全池（同窗口）近似
  const valid = picks.filter((p) => p.forwardReturn !== null) as (ReplayOutcome["picks"][number] & { forwardReturn: number })[];
  const rets = valid.map((p) => p.forwardReturn).sort((a, b) => a - b);
  const avg = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : null;
  const median = rets.length ? rets[Math.floor(rets.length / 2)] : null;
  const wins = rets.filter((r) => r > 0).length;

  return {
    selection,
    horizon: horizonClamped,
    forwardWindow: { start: request.asOf, end: afterDate.endDate },
    picks,
    stats: {
      avgForwardReturn: avg,
      medianForwardReturn: median,
      winRate: rets.length ? wins / rets.length : null,
      avgExcess: null,
      benchmarkReturn: null,
    },
    warnings: [
      ...selection.warnings,
      "回放标签（未来 N 日收益）仅用于事后评估，未参与选股决策",
    ],
  };
}

// 找 asOf 之后的第 horizon 个交易日（用基准标的日历近似）
async function nextDates(provider: DataProvider, asOf: string, horizon: number): Promise<{ endDate: string }> {
  const bench = await provider.getBars({ symbols: ["000300.SH"], tf: "day", asOf: plusDays(asOf, Math.ceil(horizon * 2.5) + 10), lookback: 400 });
  const dates = (bench.get("000300.SH") ?? []).map((b) => b.date).filter((d) => d > asOf);
  const endDate = dates[Math.min(horizon, dates.length) - 1] ?? plusDays(asOf, horizon);
  return { endDate };
}

function plusDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// buildMiniPanel 的返回结构是 Panel 的子集（evaluateAst 只需要 dates/symbols/fields）
function asEvalPanel(p: ReturnType<typeof buildMiniPanel>): Parameters<typeof evaluateAst>[1] {
  return p as unknown as Parameters<typeof evaluateAst>[1];
}
