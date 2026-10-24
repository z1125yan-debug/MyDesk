// 影子版策略纯核（2026-10-24 规格书定稿）：纯机械规则，零 IO、零时钟、零 LLM。
//
// 定位：与正式版（AI 优选）并行运行的对照组。不替换正式版、不共用任何选股逻辑、
// 不做任何温度/过热/风险标签排雷（已双源验证：温度闸门强势档有害、震荡/弱势无效）。
//
// 规则（规格书第三节，一个字不许改口径）：
//   股票池 = 当日全市场按成交额前 300 只，等权；
//   ret20 = close[t]/close[t-20]-1；devMa20 = close[t]/MA20[t]-1（个股自己的 20 日均线）；
//   S2 震荡且大盘 MA20 向下：ret20≤-30%，ret20 升序取前 10；震荡且 MA20 向上 → 强制空仓（关键闸门）；
//   S3 弱势：ret20≤-20%，ret20 升序取前 10。
//   三条同一天只触发一条（档位互斥）；不足 10 只记几只，0 只记空仓行。
//
// ⚠️ S1 强势动量已删除（2026-10-24 定稿修正，WB 交底 + 云端复核双签）：
//   原 87.7% 年化源于 WB 静态池的前视偏差（按样本期后段总成交额一次性选池）；
//   每日重算池的干净口径下 S1 净值 0.823、年化 −7.1%，且强势档×持 20 日的
//   全池基线本身就是 −0.97%（整格为负）。强势日一律记空仓行。
//   影子版定型 = S2+S3（干净口径组合：净值 ≈2.03、年化 ≈+30.4%、回撤 ≈−24.3%、247 份）。
//
// 质量过滤（2026-10-24 补丁，与 S1 删除同日定稿）：入池前剔除 ①名称含 ST/*ST/退
//   ②收盘 <2 元 ③上市不足 60 个交易日 ④一字跌停买不进（当日停牌无 bar 天然剔除）。
//   WB 三年名单审计：S3b 1687 只票次里 ST 仅 1 只、<2 元 18 只、停牌 12 只、全程停牌 0；
//   加过滤回测几乎不动（duo 34.7%→34.5%，线性近似口径）。立据是尾部风险，不是历史收益。
//
// 档位（规格书第二节）：上证收盘 > MA20 且 MA20 向上（今日>=昨日）= 强势；
//   收盘 < MA20 且 MA20 向下 = 弱势；其余 = 震荡。
//   注意与 regime-core 的细微差别：那边向上用「>」，规格书用「>=」，影子版按规格书。
//
// 持有与成本（规格书第四节）：信号日收盘买、第 N 个交易日收盘卖；
//   成本 0.41% 双边合计，每个持有期口径都按「若持有到该日卖出」扣满 0.41%（与正式版 T+1 同口径可比）。

import { ma20Of, type Regime } from "./regime-core.ts";

export const SHADOW_SOURCE = "shadow";
/** 借 StrategyPick.strategyId 当自然键：影子版一天一行，唯一键=(tradeDate,-2,"shadow") */
export const SHADOW_STRATEGY_ID = -2;
export const SHADOW_POOL_SIZE = 300;
export const SHADOW_TAKE = 10;
export const SHADOW_COST_PCT = 0.41;
export const SHADOW_HOLD_DAYS = 20;
/** 页面固定标注（规格书第七节） */
export const SHADOW_DISCLAIMER = "影子版为机械规则回测口径，历史年化不构成收益承诺";

export type ShadowStrategyName = "影子S1强势" | "影子S2震荡" | "影子S3弱势" | "影子空仓";

export interface ShadowRegime {
  regime: Regime;
  /** 大盘 MA20 是否向上（今日 >= 昨日）；S2 的闸门就看它 */
  indexSlopeUp: boolean;
  ma20: number;
  close: number;
}

/** 由上证收盘序列（升序，至少 21 根）算当日档位；算不出返回 null，不猜 */
export function shadowRegimeOf(indexCloses: number[]): ShadowRegime | null {
  const ma = ma20Of(indexCloses);
  const i = indexCloses.length - 1;
  if (i < 20) return null;
  const m = ma[i];
  const prev = ma[i - 1];
  const close = indexCloses[i];
  if (m == null || prev == null || !Number.isFinite(m) || !Number.isFinite(prev) || !Number.isFinite(close)) return null;
  const up = m >= prev;
  const regime: Regime = close > m && up ? "强势" : close < m && !up ? "弱势" : "震荡";
  return { regime, indexSlopeUp: up, ma20: m, close };
}

export interface ShadowCandidate {
  symbol: string;
  name: string;
  close: number;
  /** 当日成交额（元，池子排序用） */
  amount: number | null;
  /** 20 日涨幅（小数，如 0.18 = +18%）；算不出 = null，该票不参与选股 */
  ret20: number | null;
  /** 离个股 MA20 偏离（小数）；算不出 = null */
  devMa20: number | null;
  /** 库内累计 bar 根数（近似上市交易日数：库起点 2024-01-02 之后上市的票准确，
   *  更早上市的票根数必然远超 60，不误伤）；取不到 = null，不因此剔除 */
  listedBars?: number | null;
  /** 信号日一字跌停（全天一价且跌停，收盘根本买不进） */
  onePriceDown?: boolean;
}

/**
 * 质量过滤（2026-10-24 规格补丁，WB 三年名单审计后定）：入池前剔除，返回剔除原因或 null。
 * 立据不是历史收益（审计显示历史上几乎没选到、加过滤回测几乎不动），是尾部：
 * 烂公司一次就是 −100%，0.1% 的历史占比不等于可以裸奔。
 * 当日停牌不在这里判——没 bar 的票在取数层根本不进候选，天然剔除。
 */
export function shadowQualityReject(c: ShadowCandidate): string | null {
  if (c.name && (c.name.includes("ST") || c.name.includes("退"))) return "名称含 ST/退市标识";
  if (c.close < 2) return "收盘价低于 2 元（面值退市区）";
  if (c.listedBars != null && c.listedBars < 60) return `上市不足 60 个交易日（库内 ${c.listedBars} 根 bar）`;
  if (c.onePriceDown) return "一字跌停，买不进";
  return null;
}

export interface ShadowPick {
  symbol: string;
  name: string;
  close: number;
  ret20: number;
  devMa20: number | null;
}

export interface ShadowSelection {
  strategyName: ShadowStrategyName;
  picks: ShadowPick[];
  /** 空仓/少票的原因，说人话，进 symbolsNote */
  note: string;
}

/** 从一只票的收盘序列（升序，最后一根 = 信号日）算 ret20 / devMa20；根数不足返回 null */
export function shadowFactorsOf(closes: number[]): { ret20: number; devMa20: number } | null {
  const n = closes.length;
  if (n < 21) return null;
  const close = closes[n - 1];
  const base = closes[n - 21];
  if (!Number.isFinite(close) || !Number.isFinite(base) || base <= 0 || close <= 0) return null;
  const ma = ma20Of(closes)[n - 1];
  if (ma == null || !Number.isFinite(ma) || ma <= 0) return null;
  return { ret20: close / base - 1, devMa20: close / ma - 1 };
}

/** 池子：按成交额降序取前 SHADOW_POOL_SIZE；成交额缺失的票不进池（排不了名就不猜） */
export function shadowPoolOf(cands: ShadowCandidate[]): ShadowCandidate[] {
  return cands
    .filter((c) => c.amount != null && Number.isFinite(c.amount) && c.amount > 0)
    .slice()
    .sort((a, b) => (b.amount as number) - (a.amount as number))
    .slice(0, SHADOW_POOL_SIZE);
}

/**
 * 带质量过滤的池子（规格补丁口径：先过滤、再按成交额取前 300，池子始终补满 300 只干净票）。
 * rejected 只报「本来能进前 300、被质量过滤拦下」的票——这是对当日选股真正有影响的剔除数，
 * 全市场层面的 ST/低价票数量与本策略无关，不报。
 */
export function shadowPoolWithQuality(cands: ShadowCandidate[]): {
  pool: ShadowCandidate[];
  rejected: { symbol: string; name: string; reason: string }[];
} {
  const ranked = cands
    .filter((c) => c.amount != null && Number.isFinite(c.amount) && c.amount > 0)
    .slice()
    .sort((a, b) => (b.amount as number) - (a.amount as number));
  const rejected = ranked
    .slice(0, SHADOW_POOL_SIZE)
    .map((c) => ({ c, reason: shadowQualityReject(c) }))
    .filter((x): x is { c: ShadowCandidate; reason: string } => x.reason != null)
    .map((x) => ({ symbol: x.c.symbol, name: x.c.name, reason: x.reason }));
  const pool = ranked.filter((c) => shadowQualityReject(c) == null).slice(0, SHADOW_POOL_SIZE);
  return { pool, rejected };
}

/** 按档位选股。pool 必须是已截断的 Top300 池。纯函数：同输入同输出，不许掺随机/时间 */
export function selectShadowPicks(regime: Regime, indexSlopeUp: boolean, pool: ShadowCandidate[]): ShadowSelection {
  const usable = pool.filter((c) => c.ret20 != null && Number.isFinite(c.ret20));
  const byRetAsc = (a: ShadowCandidate, b: ShadowCandidate) => (a.ret20 as number) - (b.ret20 as number);
  const toPick = (c: ShadowCandidate): ShadowPick => ({
    symbol: c.symbol, name: c.name, close: c.close, ret20: c.ret20 as number, devMa20: c.devMa20,
  });

  if (regime === "强势") {
    // S1 已按 2026-10-24 定稿删除（文件头注释有全账）：强势日强制空仓。
    // 删除时点影子版尚无任何 S1 落库行（首行是 2026-10-23 弱势 S3），不损失前向样本。
    return {
      strategyName: "影子空仓",
      picks: [],
      note: "强势档：S1 强势动量已删除（干净口径年化 −7.1%，且强势档持 20 日全池基线为负），按定稿空仓；影子版只跑 S2 震荡反弹 + S3 弱势深跌",
    };
  }
  if (regime === "震荡") {
    if (indexSlopeUp) {
      // 规格书硬闸门：震荡 + 大盘均线向上 = 强制空仓（回测里这条值 +6.7 年化，删掉明显变差）
      return { strategyName: "影子空仓", picks: [], note: "震荡档且大盘 20 日均线向上：按 S2 闸门强制空仓（只在均线向下时才做深跌反弹）" };
    }
    const hits = usable
      .filter((c) => (c.ret20 as number) <= -0.30)
      .sort(byRetAsc)
      .slice(0, SHADOW_TAKE)
      .map(toPick);
    return {
      strategyName: "影子S2震荡",
      picks: hits,
      note: hits.length ? `震荡档 S2（均线向下）：池内 ${usable.length} 只可算，跌深命中 ${hits.length} 只` : "震荡档 S2（均线向下）：池内没有跌够 30% 的票，空仓",
    };
  }
  const hits = usable
    .filter((c) => (c.ret20 as number) <= -0.20)
    .sort(byRetAsc)
    .slice(0, SHADOW_TAKE)
    .map(toPick);
  return {
    strategyName: "影子S3弱势",
    picks: hits,
    note: hits.length ? `弱势档 S3：池内 ${usable.length} 只可算，跌深命中 ${hits.length} 只` : "弱势档 S3：池内没有跌够 20% 的票，空仓",
  };
}

/** 一只票某持有期的净收益 %：信号日收盘买、持有 N 个交易日收盘卖、扣 0.41%；价缺失返回 null */
export function shadowNetOf(entryClose: number | null, exitClose: number | null): number | null {
  if (entryClose == null || exitClose == null || !Number.isFinite(entryClose) || !Number.isFinite(exitClose) || entryClose <= 0 || exitClose <= 0) return null;
  return (exitClose / entryClose - 1) * 100 - SHADOW_COST_PCT;
}

export interface HorizonStat {
  /** 均值 % */
  mean: number;
  /** 中位数 % */
  median: number;
  /** 赚钱只数占比 % */
  winRate: number;
  count: number;
  /** 上证同期涨跌幅 %（不扣费）；取不到 = null */
  benchMean: number | null;
  /** 该持有期的卖出日 YYYY-MM-DD */
  sellDate: string;
}

function medianOf(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 一档持有期的汇总（规格书第五节：mean/median/winRate/count 都要，另存大盘同期） */
export function horizonStatOf(nets: number[], benchPct: number | null, sellDate: string): HorizonStat | null {
  const xs = nets.filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  return {
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    median: medianOf(xs),
    winRate: (xs.filter((x) => x > 0).length / xs.length) * 100,
    count: xs.length,
    benchMean: benchPct != null && Number.isFinite(benchPct) ? benchPct : null,
    sellDate,
  };
}

/**
 * 影子组合净值（1/20 滚动口径的近似结算）：每份仓位占组合 1/20，
 * 到期那天把这 1/20 的净收益结进净值。输入是已到期的每份（卖出日 + 该份平均净收益%），
 * 输出按卖出日排序的净值点。未到期的份不进曲线——曲线只由已实现的钱构成，不许预支。
 */
export function shadowNavSeriesOf(matured: { sellDate: string; netPct: number }[]): { tradeDate: string; nav: number }[] {
  const byDay = new Map<string, number[]>();
  for (const m of matured) {
    if (!Number.isFinite(m.netPct)) continue;
    const arr = byDay.get(m.sellDate) ?? [];
    arr.push(m.netPct);
    byDay.set(m.sellDate, arr);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let nav = 1;
  const out: { tradeDate: string; nav: number }[] = [];
  for (const [d, nets] of days) {
    const slice = nets.reduce((a, b) => a + b, 0) / 100 / SHADOW_HOLD_DAYS;
    nav = nav * (1 + slice);
    out.push({ tradeDate: d, nav });
  }
  return out;
}
