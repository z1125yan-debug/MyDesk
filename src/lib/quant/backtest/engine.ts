// Quant Research Lab — 组合回测引擎（Phase 5，纯逻辑可测试）
// 时序纪律（反未来函数的执行约定）：
//   决策：调仓日用 dates[t-1] 及更早的数据生成目标持仓（selector 只能看到 ≤ t-1）
//   成交：dates[t] 开盘价执行；开盘缺失 = 停牌当日不可交易
// 约束：佣金/最低佣金/印花税(卖)/滑点/点差/涨跌停/停牌/成交量上限/流动性上限/线性冲击
// 简化声明（v1）：100股整手；涨跌停按板块真实比例（主板10%/创业科创20%/北交所30%/ST5%，复用 limitRatio）；qfq 复权口径
import type { BacktestConfig, TransactionCost, BacktestConstraints } from "../types.ts";
import { limitRatio } from "../factors/fields.ts";

export type Mat = (number | null)[][];

export interface BacktestPanel {
  dates: string[];
  symbols: string[];
  names?: string[]; // 与 symbols 对齐的股票简称（ST 判定 5% 涨跌停用；缺省按非 ST）
  fields: Map<string, Mat>; // o h l c v amount ...
}

export interface BacktestPanelView {
  dates: string[];
  symbols: string[];
  fields: Map<string, Mat>;
  t: number; // 允许访问的最大日期下标（含）
}

export interface PositionSelector {
  name: string;
  select: (view: BacktestPanelView) => Map<string, number>; // symbol → 权重（和≈1）；空Map=清仓
}

export interface BacktestTrade {
  date: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  shares: number;
  cost: number; // 交易成本（佣金+税+滑点金额）
  reason: string;
}

export interface EngineResult {
  equityCurve: { date: string; value: number; benchmark: number }[];
  trades: BacktestTrade[];
  dailyReturns: number[];
  finalEquity: number;
  blockedOrders: { reason: string; count: number }[];
}

export const DEFAULT_COST: Required<TransactionCost> = {
  commissionRate: 0.0003,
  minCommission: 5,
  stampDuty: 0.0005,
  slippageRate: 0.001,
  spreadRate: 0.001, // §二十二 点差：买一/卖一价差，双边各承担一半
};

export const DEFAULT_CONSTRAINTS: Required<BacktestConstraints> = {
  respectLimitUpDown: true,
  respectSuspension: true,
  volumeCapRatio: 0.05,
  liquidityCapRatio: 0.01,
  marketImpactCoeff: 0,
};

const BOARD_LOT = 100;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** §二十二：涨跌停幅度按板块区分（主板10% / 创业板·科创板20% / 北交所30% / ST 5%），不再用 0.095 近似 */
export function limitRatioOf(panel: BacktestPanel, si: number): number {
  return limitRatio(panel.symbols[si], panel.names?.[si] ?? "");
}

export function runBacktestEngine(
  panel: BacktestPanel,
  selector: PositionSelector,
  config: BacktestConfig,
  options?: { benchmarkSeries?: number[] | null }, // 与 panel.dates 对齐的基准净值序列
): EngineResult {
  const cost: Required<TransactionCost> = { ...DEFAULT_COST, ...config.cost };
  const cons: Required<BacktestConstraints> = { ...DEFAULT_CONSTRAINTS, ...config.constraints ?? {} };
  const n = panel.dates.length;
  const nSym = panel.symbols.length;
  const o = panel.fields.get("o")!;
  const c = panel.fields.get("c")!;
  const v = panel.fields.get("v")!;
  const amount = panel.fields.get("amount")!;
  const symIdx = new Map(panel.symbols.map((s, i) => [s, i]));

  let cash = config.initialCash;
  const shares = new Array<number>(nSym).fill(0);
  const avgCost = new Array<number>(nSym).fill(0); // 用于胜率统计
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; value: number; benchmark: number }[] = [];
  const blocked: Map<string, number> = new Map();
  const rebalanceEvery = Math.max(1, config.rebalanceEvery ?? 5);

  function block(reason: string): void {
    blocked.set(reason, (blocked.get(reason) ?? 0) + 1);
  }

  function buyCost(price: number, sh: number): { total: number; fee: number } {
    const notional = price * sh;
    const slip = notional * cost.slippageRate;
    const commission = Math.max(cost.minCommission, notional * cost.commissionRate);
    return { total: notional + slip + commission, fee: slip + commission };
  }
  function sellProceeds(price: number, sh: number): { total: number; fee: number } {
    const notional = price * sh;
    const slip = notional * cost.slippageRate;
    const commission = Math.max(cost.minCommission, notional * cost.commissionRate);
    const duty = notional * cost.stampDuty;
    return { total: notional - slip - commission - duty, fee: slip + commission + duty };
  }

  // 基准序列：外部提供或等权指数
  const benchmark = options?.benchmarkSeries ?? null;

  let lastSelectorDate = -1;
  let targets = new Map<string, number>();

  for (let t = 0; t < n; t++) {
    // ---- 调仓决策（使用 ≤ t-1 的数据）----
    const isRebalance = t >= 1 && (t - 1) % rebalanceEvery === 0;
    if (isRebalance) {
      lastSelectorDate = t - 1;
      try {
        targets = selector.select({ dates: panel.dates, symbols: panel.symbols, fields: panel.fields, t: lastSelectorDate });
      } catch {
        targets = new Map(); // selector 出错当日视为空仓决策
      }
    }

    // ---- 执行（t 开盘）----
    if (isRebalance && t >= 1) {
      // 先卖出不在目标里的与超出权重的
      const targetSet = new Set(targets.keys());
      for (let si = 0; si < nSym; si++) {
        const sym = panel.symbols[si];
        if (shares[si] <= 0) continue;
        const openPrice = o[si][t];
        const prevClose = c[si][t - 1];
        if (openPrice === null || prevClose === null) { if (cons.respectSuspension) { block(`停牌无法卖出:${sym}`); continue; } continue; }
        const wantWeight = targets.get(sym) ?? 0;
        const equity = cash + shares.reduce((s, sh, i) => s + sh * (c[i][t - 1] ?? 0), 0);
        const targetShares = Math.floor((equity * wantWeight) / openPrice / BOARD_LOT) * BOARD_LOT;
        if (!targetSet.has(sym) || targetShares < shares[si]) {
          const ratio = limitRatioOf(panel, si); // §二十二：分板涨跌停（10%/20%/30%/ST5%）
          if (cons.respectLimitUpDown && openPrice <= round2(prevClose * (1 - ratio))) {
            block(`跌停无法卖出:${sym}(${(ratio * 100).toFixed(0)}%)`);
            continue;
          }
          const sh = targetSet.has(sym) ? shares[si] - targetShares : shares[si];
          if (sh <= 0) continue;
          const sellPrice = round2(openPrice * (1 - cost.spreadRate / 2)); // 点差：卖出按买一侧
          const proceeds = sellProceeds(sellPrice, sh);
          shares[si] -= sh;
          cash += proceeds.total;
          trades.push({ date: panel.dates[t], symbol: sym, side: "sell", price: sellPrice, shares: sh, cost: proceeds.fee, reason: "调仓减仓" });
        }
      }
      // 再买入
      const equity = cash + shares.reduce((s, sh, i) => s + sh * (c[i][t - 1] ?? 0), 0);
      for (const [sym, weight] of targets) {
        const si = symIdx.get(sym);
        if (si === undefined) continue;
        const openPrice = o[si][t];
        const prevClose = c[si][t - 1];
        if (openPrice === null || prevClose === null) { block(`停牌无法买入:${sym}`); continue; }
        const ratioBuy = limitRatioOf(panel, si); // §二十二：分板涨跌停
        if (cons.respectLimitUpDown && openPrice >= round2(prevClose * (1 + ratioBuy))) {
          block(`涨停无法买入:${sym}(${(ratioBuy * 100).toFixed(0)}%)`);
          continue;
        }
        const targetValue = equity * weight;
        const currentShares = shares[si];
        const currentValue = currentShares * openPrice;
        let deltaValue = targetValue - currentValue;
        if (deltaValue <= equity * 0.005) continue; // 忽略微小调仓
        const impactPrice = cons.marketImpactCoeff > 0 && amount[si][t]
          ? openPrice * (1 + cons.marketImpactCoeff * Math.min(1, deltaValue / (amount[si][t] as number)))
          : openPrice;
        const execPrice = round2(impactPrice * (1 + cost.spreadRate / 2)); // 点差：买入按卖一侧
        let buyShares = Math.min(
          Math.floor(deltaValue / execPrice / BOARD_LOT) * BOARD_LOT,
          Math.floor(Math.max(0, cash) / (execPrice * (1 + cost.slippageRate + cost.commissionRate)) / BOARD_LOT) * BOARD_LOT,
        );
        const rawShares = buyShares;
        // 成交量/流动性约束
        const volToday = v[si][t];
        const amtToday = amount[si][t];
        if (volToday !== null) {
          const capShares = Math.floor((volToday * cons.volumeCapRatio) / BOARD_LOT) * BOARD_LOT;
          buyShares = Math.min(buyShares, capShares);
        }
        if (amtToday !== null) {
          const capValue = amtToday * cons.liquidityCapRatio;
          buyShares = Math.min(buyShares, Math.floor(capValue / execPrice / BOARD_LOT) * BOARD_LOT);
        }
        if (buyShares < BOARD_LOT) {
          if (rawShares >= BOARD_LOT) block(`量/流动性约束:${sym}`); // 有意下单但被约束拒绝
          continue;
        }
        const paid = buyCost(execPrice, buyShares);
        if (paid.total > cash) { block(`现金不足:${sym}`); continue; }
        const prevShares = shares[si];
        const prevAvg = prevShares > 0 ? avgCost[si] : 0;
        avgCost[si] = prevShares > 0 ? (prevAvg * prevShares + execPrice * buyShares) / (prevShares + buyShares) : execPrice;
        shares[si] += buyShares;
        cash -= paid.total;
        trades.push({ date: panel.dates[t], symbol: sym, side: "buy", price: execPrice, shares: buyShares, cost: paid.fee, reason: "调仓建仓" });
      }
    }

    // ---- 估值 ----
    let equity = cash;
    for (let si = 0; si < nSym; si++) {
      if (shares[si] > 0) {
        const px = c[si][t] ?? (c[si][t - 1] ?? avgCost[si]); // 停牌按最后收盘估值
        equity += shares[si] * px;
      }
    }
    equityCurve.push({
      date: panel.dates[t],
      value: Math.round(equity * 100) / 100,
      benchmark: benchmark ? benchmark[t] : 1,
    });
  }

  return {
    equityCurve,
    trades,
    dailyReturns: equityCurve.map((p, i) => (i === 0 ? 0 : p.value / equityCurve[i - 1].value - 1)),
    finalEquity: equityCurve.length ? equityCurve[equityCurve.length - 1].value : config.initialCash,
    blockedOrders: [...blocked.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

// Train/Validation/Test 切分
export function splitRanges(dates: string[], split?: { train: number; validation: number; test: number }): { name: "train" | "validation" | "test"; startDate: string; endDate: string }[] {
  if (!split || split.train + split.validation + split.test <= 0) return [];
  const n = dates.length;
  const a = Math.floor(n * split.train);
  const b = Math.floor(n * (split.train + split.validation));
  const out: { name: "train" | "validation" | "test"; startDate: string; endDate: string }[] = [];
  if (a > 0) out.push({ name: "train", startDate: dates[0], endDate: dates[Math.max(0, a - 1)] });
  if (b > a) out.push({ name: "validation", startDate: dates[a], endDate: dates[Math.max(a, b - 1)] });
  if (b < n) out.push({ name: "test", startDate: dates[b], endDate: dates[n - 1] });
  return out;
}
