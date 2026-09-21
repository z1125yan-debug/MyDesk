// Quant Screener — 全A漏斗式选股引擎（服务端）
// 层级（需求文档 十七）：股票池 → 快照口径粗筛 → K线子集（流动性Top-K）→ K线口径精筛
//   → 排序分页 → （include_stats）逐只历史条件概率。
// 硬规则：
//  - 只用真实数据源（emProvider：腾讯/东财公开接口）；失败直接报错，绝不回退演示数据；
//  - 大池不逐只无限拉K线：K线子集上限 maxKlineSymbols（默认 120，按快照成交额取流动性Top-K），
//    漏斗各层数量全部返回给前端展示；
//  - 未验证因子在响应中显式标注。

import { getProvider } from "@/lib/quant/data/index";
import { universeSource } from "@/lib/quant/data/tc-universe";
import { fetchBarsHybrid, fetchBarsHybridTracked } from "@/lib/quant/data/hybrid";
import { outcomeWarning, summarizeOutcomes } from "@/lib/quant/data/hybrid-core";
import { shanghaiDate } from "@/lib/desk/session";
import { evalLimitSnapshot } from "./sentiment";
import { buildFieldPanel, lastValues, factorCatalog, FACTOR_FIELD_MAP, type BarsLike } from "../factors/fields.ts";
import { cmpWithOp, historicalWinProbability, type ScreenerCond, type WinProbStats } from "../factors/probability.ts";
import { partitionUnavailableSnapConds } from "./snapshot-avail-core.ts";
import type { AssetMeta } from "../types.ts";

export type UniverseSpec = "all_a" | "hs_a" | { kind: "watchlist"; symbols: string[] } | { kind: "industry"; boardCode: string };

export interface ScreenerRequestBody {
  universe?: UniverseSpec;
  conditions?: ScreenerCond[];
  fields?: string[];
  /** §二 历史交易日：YYYY-MM-DD（仅K线口径可回溯；缺省=当日） */
  trade_date?: string;
  sort?: { order_by?: string; order_dir?: "asc" | "desc" };
  pagination?: { limit?: number; offset?: number };
  include_stats?: boolean;
  maxKlineSymbols?: number;
  statsMaxRows?: number;
}

export interface ScreenerRow {
  symbol: string;
  name: string;
  industry?: string;
  close: number | null;
  change_pct: number | null;
  values: Record<string, number | null>;
  win_prob?: WinProbStats | null;
}

export interface ScreenerResponse {
  list: ScreenerRow[];
  total: number;
  page: { limit: number; offset: number };
  as_of_trade_date: string;
  trade_date_available: boolean;
  /** §二 是否为历史交易日回放（true=仅K线口径可回溯，快照口径已剔除） */
  trade_date_is_historical: boolean;
  funnel: { universe: number; snapshot_pass: number; kline_subset: number; kline_pass: number };
  source: { provider: string; note: string; price_basis?: string };
  /** §五：是否「本次涉及的因子全部已验证」（动态绑定 factor-verified 落盘状态，非静态写死） */
  factors_verified: boolean;
  factor_verify: { total: number; enabled: number; verified: number; unverified: number };
  warnings: string[];
  /**
   * P9-经验轮：本次被忽略的「整池无真实读数」快照条件（字段全缺登记，非空即代表
   * 结果没有按这些条件筛过——「无命中」与「字段缺失」必须能分开，不许静默清零）。
   */
  unavailable_fields: { field: string; zh: string; total: number }[];
}

function shanghaiToday(): string {
  return shanghaiDate();
}

/** §二/§六 基准指数：胜率统计的同期对比基准（沪深300） */
export const BENCHMARK_SYMBOL = "000300.SH";
export const BENCHMARK_NAME = "沪深300";

// §四 操作符契约：与概率引擎共用同一份实现（= >= > <= < != like + in / not in）
const cmpNum = cmpWithOp;

// §三（验收修复）：涨停实时状态优先用实时快照（snapshot_time），而非K线最后一根（bar_time 可能滞后）。
// 快照不可判（新股无涨跌幅限制期 / 缺 prevClose/high）→ 返回 null=UNKNOWN，绝不冒充 false。
function snapLimitUp(m: AssetMeta): number | null {
  const ev = evalLimitSnapshot(m);
  return ev === null ? null : ev.sealed ? 1 : 0;
}

// 快照口径条件的当日求值（AssetMeta → 字段值）
function snapshotValue(meta: AssetMeta, field: string): number | null {
  switch (field) {
    case "pe_ttm": return meta.pe ?? null;
    case "pb": return meta.pb ?? null;
    case "market_cap_yi": return meta.marketCap != null ? meta.marketCap / 1e8 : null;
    case "floatcap_yi": return meta.floatCap != null ? meta.floatCap / 1e8 : null;
    case "change_pct": return meta.changePct ?? null;
    case "turnover_rate": return meta.turnover ?? null;
    case "volume_ratio": return meta.volumeRatio ?? null;
    case "amplitude": return meta.amplitude ?? null;
    case "amount_yi": return meta.amount != null ? meta.amount / 1e8 : null;
    case "main_net_yi": return meta.mainNet != null ? meta.mainNet / 1e8 : null;
    default: return null;
  }
}

export async function runScreener(body: ScreenerRequestBody): Promise<ScreenerResponse> {
  const provider = await getProvider("em");
  // §二 历史交易日选择器：trade_date 只接受 YYYY-MM-DD 且不晚于今日；
  // 历史日期只有K线口径可回溯（当日快照/实时涨停态无历史时点数据 → 显式剔除并告警，不冒充历史）
  const today = shanghaiToday();
  const reqDate = typeof body.trade_date === "string" ? body.trade_date.trim().slice(0, 10) : "";
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(reqDate);
  const warnings: string[] = [];
  if (reqDate && !dateValid) warnings.push(`trade_date 格式非法（${reqDate}），已按当日 ${today} 执行`);
  else if (dateValid && reqDate > today) warnings.push(`trade_date 晚于当日（${reqDate} > ${today}），已按当日 ${today} 执行`);
  const asOf = dateValid && reqDate <= today ? reqDate : today;
  const isHistorical = asOf < today;
  const allConds = body.conditions ?? [];
  const unknownFields = allConds.filter((c) => !FACTOR_FIELD_MAP.has(c.field)).map((c) => c.field);
  if (unknownFields.length) warnings.push(`未知因子字段已忽略：${unknownFields.join("、")}`);
  // 已登记但未实现（implemented=false，如依赖筹码分布/无原始公式）：不参与筛选，显式提示而非静默永不命中
  const pendingFields = [
    ...new Set(
      allConds
        .filter((c) => FACTOR_FIELD_MAP.has(c.field) && FACTOR_FIELD_MAP.get(c.field)!.implemented === false)
        .map((c) => c.field)
    ),
  ];
  if (pendingFields.length)
    warnings.push(`已登记但未实现的因子已忽略：${pendingFields.join("、")}（依赖筹码分布或无原始公式，见因子实验室 status=pending_dependency）`);
  const conditions = allConds.filter(
    (c) => FACTOR_FIELD_MAP.has(c.field) && FACTOR_FIELD_MAP.get(c.field)!.implemented !== false
  );

  const snapCondsAll = conditions.filter((c) => FACTOR_FIELD_MAP.get(c.field)!.source === "snapshot");
  const snapConds = isHistorical ? [] : snapCondsAll; // 历史日期：快照口径条件不可回溯 → 剔除并告警
  const klineConds = conditions.filter((c) => FACTOR_FIELD_MAP.get(c.field)!.source === "kline");
  if (isHistorical && snapCondsAll.length) {
    warnings.push(
      `历史交易日 ${asOf}：快照口径条件（${snapCondsAll.map((c) => FACTOR_FIELD_MAP.get(c.field)!.zh).join("、")}）` +
      `无历史时点数据，本次已剔除（不用当前快照值冒充历史）；结果仅按K线口径条件在 ${asOf} 当日评估`,
    );
  }
  if (isHistorical) {
    warnings.push(`历史日期口径：股票池名单来自当前快照（已退市/已改名股票不在池内，存在幸存者偏差）；close/涨跌幅取 ${asOf} 当日K线收盘`);
  }
  const hasSectorCond = (body.conditions ?? []).some((c) => c.field === "sector");
  if (hasSectorCond) warnings.push("板块(sector)条件暂未接入：请用 industry 字段或在结果中按行业筛选");
  const hasRolling = conditions.some((c) => (c.type ?? "single") !== "single");
  if (hasRolling && !klineConds.length) {
    // rolling 条件作用于任意字段的日序列；快照字段无历史 → 明确拒绝而不是静默忽略
    warnings.push("近N日(rolling)条件仅支持K线口径字段；含快照字段的rolling条件无法进行（无历史时点数据）");
  }

  // 1) 股票池
  const spec = body.universe ?? "all_a";
  let metas: AssetMeta[];
  if (typeof spec === "string") {
    metas = await provider.listUniverse({ kind: "all" }, asOf);
    if (spec === "hs_a") metas = metas.filter((m) => !m.symbol.endsWith(".BJ"));
  } else if (spec.kind === "watchlist") {
    metas = await provider.listUniverse({ kind: "custom", symbols: spec.symbols }, asOf);
  } else {
    metas = await provider.listUniverse({ kind: "industry", boardCode: spec.boardCode }, asOf);
  }
  const universeCount = metas.length;
  if (!metas.length) throw new Error("股票池为空（数据源无返回）");

  // P9-经验轮：快照条件字段可得性预检——断源兜底期某些字段全池无一条真实读数
  // （如东财资金数据断源时的主力净额：5565 家 mainNet 全 null）。这类条件放进粗筛
  // 会把所有股票判不符合，页面只剩「无命中结果」——那是字段缺失，不是筛不出。
  // 处置与「已登记未实现因子」同一纪律：忽略该条件 + 显式告警，并把缺口以
  // unavailable_fields 机器可读地随响应返回（前端/工具环据此强提示），绝不静默清零。
  const avail = partitionUnavailableSnapConds(snapConds, metas, snapshotValue);
  const snapCondsUsable = avail.usable;
  const unavailableFields = avail.unavailable.map((g) => ({ field: g.field, zh: FACTOR_FIELD_MAP.get(g.field)!.zh, total: g.total }));
  for (const g of unavailableFields) {
    warnings.push(
      `「${g.zh}」(${g.field}) 在当前数据源的 ${g.total} 只里没有一条真实读数（断源/字段缺失，不是「值为 0」）：` +
      `本次已忽略该条件——结果未据此筛过，属数据缺口，不是无标的符合此条件`,
    );
  }
  // 条件被忽略光了就不出整池：「没有任何有效条件」的选股不构成答案——
  // 返回空表并说明原因，也不把 5565 只未经筛池的全A名单冒充「命中结果」。
  const nothingEvaluated = conditions.length > 0 && snapCondsUsable.length === 0 && klineConds.length === 0;
  if (nothingEvaluated) {
    warnings.push("本次全部条件均因数据缺口被忽略：没有执行任何筛选，结果为空是「未评」，不是「无标的符合」");
  }

  // 2) 快照口径粗筛（含 ST/停牌默认剔除）
  const snapshotPass = nothingEvaluated ? [] : metas.filter((m) => {
    if (m.st) return false;
    if (m.suspended) return false;
    for (const c of snapCondsUsable) {
      const v = snapshotValue(m, c.field);
      if (!cmpNum(v, c.op, c.value)) return false; // 原值传入：in/not in 需要列表，数值操作符内部再转数值
    }
    return true;
  });

  // 3) K线子集：需要K线的条件/字段存在时，按成交额取流动性Top-K
  const outFields = (body.fields ?? []).filter(
    (f) => (FACTOR_FIELD_MAP.has(f) && FACTOR_FIELD_MAP.get(f)!.implemented !== false) || f === "close" || f === "change_pct"
  );
  const needKline =
    klineConds.length > 0 ||
    hasRolling ||
    isHistorical || // 历史日期：展示值必须由当日K线重建（快照值不可用）
    outFields.some((f) => FACTOR_FIELD_MAP.get(f)?.source === "kline");
  const klineSubsetCap = Math.max(20, Math.min(600, body.maxKlineSymbols ?? 120));
  let subset = snapshotPass;
  if (needKline && subset.length > klineSubsetCap) {
    subset = [...subset].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, klineSubsetCap);
    warnings.push(`快照粗筛后 ${snapshotPass.length} 只超出K线子集上限 ${klineSubsetCap}：已按成交额取流动性Top-K参与K线条件（其余不参与）`);
  }

  let rows: ScreenerRow[] = [];
  let klinePass = subset.length;

  if (needKline && subset.length) {
    // 4) 拉K线 + 建面板 + 逐日条件
    const lookback = Math.max(
      180,
      ...klineConds.map((c) => {
        const w = (c.type ?? "single") === "single" ? 0 : Math.max(1, c.window ?? 1);
        const maN = c.field.startsWith("above_ma_") ? Number(c.field.slice(9)) : 0;
        return w + maN + 30;
      }),
      ...["rps_120", "above_ma_144"].filter((f) => klineConds.some((c) => c.field === f) || outFields.includes(f)).map(() => 160),
    );
    const barsMap = await fetchBarsHybridTracked(subset.map((m) => m.symbol), asOf, lookback);
    const bars = barsMap.bars;
    // P6-A：取数失败与「这只真的没K线」分开报数——否则一次限流会在漏斗里伪装成「不符合条件」
    const klineWarn = outcomeWarning(barsMap.outcomes);
    if (klineWarn) warnings.push(klineWarn);
    if (barsMap.tdx_down) warnings.push("eltdx 网关本批已熔断（连续 8 只失败）：其余标的全部走腾讯日K，结果为 DEGRADED 口径");
    const symbols: string[] = [];
    const barsList: BarsLike[][] = [];
    const metasOf: (AssetMeta | undefined)[] = [];
    for (const m of subset) {
      const b = (bars.get(m.symbol) ?? []) as BarsLike[];
      if (!b.length) continue;
      symbols.push(m.symbol);
      barsList.push(b);
      metasOf.push(m);
    }
    if (!symbols.length) {
      const c = summarizeOutcomes(barsMap.outcomes);
      throw new Error(c.request_failed && c.request_failed + c.no_data === barsMap.outcomes.length
        ? `K线子集 ${barsMap.outcomes.length} 只全部取数失败（eltdx 与腾讯都没成功返回，不是「没有符合的标的」）：${c.request_failed} 只请求失败，请稍后重试`
        : "K线子集全部无数据（数据源可能被限流，请稍后重试）");
    }
    const panel = buildFieldPanel(symbols, barsList, metasOf);
    const lastVals = lastValues(panel);

    // §三：bar_time 与 snapshot_time 一致性提示（周末/盘前 K线未更新属正常，仅在使用涨停类实时判定时说明口径）
    const usesLimitSnap = klineConds.some((c) => c.field === "is_limit_up") || outFields.includes("is_limit_up");
    const lastBarDate = panel.dates[panel.dates.length - 1] ?? "";
    if (usesLimitSnap && lastBarDate && lastBarDate < asOf) {
      warnings.push(`K线最后日期 ${lastBarDate} 早于当日 ${asOf}（bar_time < snapshot_time）：is_limit_up 实时态已优先使用快照口径`);
    }
    let limitUnknown = 0; // is_limit_up 快照不可判（UNKNOWN）计数

    // 每只股票逐日评估 kline 条件（含 rolling），取「当日命中」的股票
    const passedIdx: number[] = [];
    for (let si = 0; si < symbols.length; si++) {
      const seriesOf = (key: string) => panel.fields.get(key)?.[si];
      let ok = true;
      for (const c of klineConds) {
        const val = c.value; // §四：原值下传，in/not in 需要列表
        const type = c.type ?? "single";
        // §三：is_limit_up 的「当日」判定优先实时快照；不可判 → UNKNOWN（计警告，不按 false 处理）
        // 历史交易日：实时快照属「今日」口径，不可用于历史日 → 直接用K线口径列（当日涨幅≥涨停比例）
        if (c.field === "is_limit_up" && type === "single" && !isHistorical) {
          const sv = snapLimitUp(metasOf[si]!);
          if (sv === null) { limitUnknown++; ok = false; break; }
          if (!cmpNum(sv, c.op, val)) { ok = false; break; }
          continue;
        }
        const series = seriesOf(c.field);
        if (!series) { ok = false; break; }
        const T = series.length;
        if (type === "single") {
          if (!cmpNum(series[T - 1] ?? null, c.op, val)) { ok = false; break; }
        } else {
          // rolling 条件：按「以最后一日为终点」评估（与历史概率引擎同规则）
          const probe = (t: number): boolean => {
            const w = Math.max(1, Math.min(250, c.window ?? 0));
            if (type === "rolling_return") {
              if (t < w) return false;
              const now = series[t], then = series[t - w];
              if (now === null || then === null || then <= 0) return false;
              return cmpNum((now / then - 1) * 100, c.op, val);
            }
            if (type === "rolling_sum") {
              if (t < w - 1) return false;
              let s = 0, o = true;
              for (let i = t - w + 1; i <= t; i++) { const v = series[i]; if (v === null) { o = false; break; } s += v; }
              return o ? cmpNum(s, c.op, val) : false;
            }
            if (t < w - 1) return false;
            let hits = 0;
            for (let i = t - w + 1; i <= t; i++) if (cmpNum(series[i] ?? null, c.op, val)) hits++;
            return hits >= Math.max(1, c.min_match_days ?? 1);
          };
          if (!probe(T - 1)) { ok = false; break; }
        }
      }
      if (ok) passedIdx.push(si);
    }
    klinePass = passedIdx.length;
    if (limitUnknown > 0) warnings.push(`涨停判定 UNKNOWN ${limitUnknown} 只（快照缺 prevClose/high 或新股无涨跌幅限制期）：条件求值按不满足剔除并显式计数，不作「确认未涨停」结论；展示值回退K线口径并另有 bar_time 提示`);

    rows = passedIdx.map((si) => {
      const m = metasOf[si]!;
      const vals = lastVals.get(symbols[si]) ?? new Map();
      const values: Record<string, number | null> = {};
      for (const f of outFields) {
        // 历史交易日：快照口径字段无历史时点数据 → null（显示「—」），不得用今日快照值冒充
        if (isHistorical && FACTOR_FIELD_MAP.get(f)?.source === "snapshot") { values[f] = null; continue; }
        values[f] = f === "close" ? ((isHistorical ? null : m.price) ?? vals.get("c") ?? null)
          : f === "change_pct" ? ((isHistorical ? null : m.changePct) ?? vals.get("ret") ?? null)
          : f === "is_limit_up" ? ((isHistorical ? null : snapLimitUp(m)) ?? vals.get(f) ?? null) // §三：快照优先，不可判回退K线口径
          : vals.get(f) ?? null;
      }
      const close = (isHistorical ? null : m.price) ?? vals.get("c") ?? null;
      return {
        symbol: m.symbol, name: m.name, industry: m.industry,
        close, change_pct: (isHistorical ? null : m.changePct) ?? vals.get("ret") ?? null, values,
      };
    });
  } else {
    rows = snapshotPass.map((m) => {
      const values: Record<string, number | null> = {};
      for (const f of outFields) values[f] = f === "close" ? (m.price ?? null) : f === "change_pct" ? (m.changePct ?? null) : snapshotValue(m, f);
      return { symbol: m.symbol, name: m.name, industry: m.industry, close: m.price ?? null, change_pct: m.changePct ?? null, values };
    });
  }

  // 5) 历史条件概率（include_stats）——按胜率排序时必须在排序前算好，故提前
  const statsMax = Math.max(1, Math.min(40, body.statsMaxRows ?? 25));
  const limit = Math.max(1, Math.min(200, body.pagination?.limit ?? 50));
  const offset = Math.max(0, body.pagination?.offset ?? 0);
  const orderBy = body.sort?.order_by ?? "amount_yi";
  const winRateSort = /^win_rate_(\d+)(?:d|D)?$/.exec(orderBy); // §二 结果表支持按 1/5/20 日胜率排序
  let benchBars: BarsLike[] = [];
  if (body.include_stats && rows.length) {
    // 基准（沪深300）只拉一次，供逐只同期基准收益对比；拉不到 → benchmark_* 为 null 并提示
    try {
      benchBars = (await fetchBarsHybrid([BENCHMARK_SYMBOL], asOf, 520)).get(BENCHMARK_SYMBOL) ?? [];
    } catch {
      benchBars = [];
    }
    if (!benchBars.length) warnings.push(`基准指数 ${BENCHMARK_NAME}（${BENCHMARK_SYMBOL}）K线获取失败：本期不显示基准/超额收益（不以0代替）`);
  }
  async function attachStats(target: ScreenerRow[], cap: number): Promise<void> {
    for (const row of target.slice(0, cap)) {
      try {
        const barsMap = await fetchBarsHybrid([row.symbol], asOf, 480);
        const bars = (barsMap.get(row.symbol) ?? []) as BarsLike[];
        if (bars.length < 60) {
          row.win_prob = { hit_today: null, horizons: [], period: null, sample_ok: false, warnings: ["K线历史不足，无法统计"] };
          continue;
        }
        const meta = subset.find((m) => m.symbol === row.symbol);
        row.win_prob = historicalWinProbability({
          symbol: row.symbol, bars, meta, conditions,
          benchmarkBars: benchBars, benchmarkName: BENCHMARK_NAME,
        });
      } catch {
        row.win_prob = { hit_today: null, horizons: [], period: null, sample_ok: false, warnings: ["历史统计失败"] };
      }
    }
  }
  const statsCap = Math.max(statsMax, winRateSort ? limit + offset : 0);
  if (body.include_stats && rows.length && winRateSort) {
    await attachStats(rows, statsCap);
    if (rows.length > statsCap) warnings.push(`按胜率排序：仅对前 ${statsCap} 只计算历史胜率（控制数据源请求量），其余排在后面`);
  }

  // 6) 排序 + 分页
  const dir = body.sort?.order_dir === "asc" ? 1 : -1;
  const sortVal = (r: ScreenerRow): number | null => {
    if (orderBy === "close") return r.close;
    if (orderBy === "change_pct") return r.change_pct;
    if (winRateSort) {
      const h = Number(winRateSort[1]);
      const row = r.win_prob?.horizons.find((x) => x.h === h);
      return row?.win_rate ?? null;
    }
    return r.values[orderBy] ?? null;
  };
  rows.sort((a, b) => {
    const va = sortVal(a), vb = sortVal(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va - vb) * dir;
  });

  const pageRows = rows.slice(offset, offset + limit);

  // 7) 非胜率排序时，胜率统计只对本页做（省数据源请求）
  if (body.include_stats && pageRows.length && !winRateSort) {
    await attachStats(pageRows, statsMax);
    if (pageRows.length > statsMax) warnings.push(`历史胜率仅统计前 ${statsMax} 只（控制数据源请求量）`);
  }

  // §五：因子验证状态绑定真实落盘数据（factorCatalog 已合并 data/factor-verified.json 覆盖），禁止硬编码结论
  const catalogFields = factorCatalog().fields;
  const catalogMap = new Map(catalogFields.map((f) => [f.key, f]));
  const involvedFactors = [...new Set([...conditions.map((c) => c.field), ...outFields])].filter((f) => catalogMap.has(f));
  const verifiedN = involvedFactors.filter((f) => catalogMap.get(f)!.verified).length;
  const unverifiedN = involvedFactors.length - verifiedN;
  if (involvedFactors.length === 0) {
    warnings.push("因子验证状态未知：本次请求未涉及任何已登记因子字段");
  } else if (unverifiedN === involvedFactors.length && involvedFactors.length > 0) {
    warnings.push(`本次涉及 ${involvedFactors.length} 个因子均未通过 IC/稳定性验证（因子测试台：选股器页→因子实验室），结果仅为条件筛选，不构成投资建议`);
  } else if (unverifiedN > 0) {
    warnings.push(`本次涉及 ${involvedFactors.length} 个因子，其中 ${unverifiedN} 个未通过 IC/稳定性验证，结果仅为条件筛选，不构成投资建议`);
  } else {
    warnings.push(`本次涉及 ${involvedFactors.length} 个因子均已通过 IC/稳定性验证；结果仍仅为条件筛选，不构成投资建议`);
  }
  if (snapCondsUsable.length) warnings.push("快照口径条件（估值/市值/换手/量比/主力净额等）为当日口径，历史胜率不含这些条件的时点匹配");

  return {
    list: pageRows,
    total: rows.length,
    page: { limit, offset },
    as_of_trade_date: asOf,
    trade_date_available: true,
    trade_date_is_historical: isHistorical,
    funnel: { universe: universeCount, snapshot_pass: snapshotPass.length, kline_subset: subset.length, kline_pass: klinePass },
    source: {
      // P9-经验轮：与 sentiment/limitup 同纪律——兜底期不冒充东财出身（universeSource 三元）
      provider: universeSource() === "tc"
        ? "腾讯批量快照兜底（东财 clist 断源；K线走 eltdx/腾讯日K）"
        : "em（腾讯/东财公开接口，本机直连）",
      note: "REAL_DATA_ONLY：数据失败时明确报错，不回退演示数据",
      // §四：价格口径显式标注（真实价 vs 前复权，禁止为对齐数字修改数据）
      price_basis: "close/涨跌幅/快照字段=真实未复权实时价；K线因子字段=日线序列（eltdx 实测为原始价、腾讯兜底为前复权qfq，同一序列内口径一致）；胜率/收益均在同一K线序列内计算，除权除息日附近真实价与复权价不相等属正常，不是数据错误",
    },
    factors_verified: involvedFactors.length > 0 && unverifiedN === 0,
    factor_verify: { total: catalogFields.length, enabled: involvedFactors.length, verified: verifiedN, unverified: unverifiedN },
    warnings,
    unavailable_fields: unavailableFields,
  };
}
