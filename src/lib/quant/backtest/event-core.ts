// 事件回测口径纯核（P36-B，2026-09-30）
//
// 为什么单独成核：页面上的「胜率 69.3% / 次日 +2.86%」此前是裸算出来的——
// 既没扣手续费印花税滑点点差，也没做样本外切分。而 engine.ts（组合回测）里
// 明明已经有完整成本模型，只是这条链路没接上。口径必须有且只有一份可测的实现，
// 否则「弹卡说赚、回测说亏」会在同一块屏上打架。
//
// 事件口径（与 A 闸的成交价纪律一致，不许再退回 T 日收盘买）：
//   信号：T 日收盘后条件成立（只能用 ≤T 的数据）
//   买入：T+1 开盘价（T 日收盘买=涨停板买不进，实测三档全负，已废）
//   卖出：T+1+H 开盘价（H=1 次日 / H=5 后 5 日）
//   剔除：T+1 开盘价已封涨停 → 这笔根本买不进，不计入样本（不是「收益为 0」）
//   成本：复用 engine.ts 的 DEFAULT_COST（佣金 0.03% / 最低 5 元 / 印花税 0.05%(卖) /
//         滑点 0.1% / 点差 0.1% 双边各半），往返合计 0.41%
//         （买 0.18% = 滑点0.1+半点差0.05+佣金0.03；卖 0.23% = 再多半点差0.05+印花税0.05）
//
// 净收益为什么按乘性算而不是「毛收益 - 0.41%」：
//   成本是乘在成交价上的（滑点按名义额、点差按价格），加减法会随涨跌幅度漂移，
//   一次性乘出来才对得上真实成交。
//
// 本核零 IO、零时钟，可被 node:test 直跑。

import { DEFAULT_COST } from "./engine.ts";
import { pctWithCI } from "../factors/wilson-core.ts";

/** 单笔名义金额（元）。只用于把「最低佣金 5 元」折算成比例；10 万级别下最低佣金可忽略 */
export const EVENT_NOTIONAL = 100_000;

export interface EventCostModel {
  commissionRate: number;
  minCommission: number;
  stampDuty: number;
  slippageRate: number;
  spreadRate: number;
}

export const EVENT_COST: EventCostModel = {
  commissionRate: DEFAULT_COST.commissionRate,
  minCommission: DEFAULT_COST.minCommission,
  stampDuty: DEFAULT_COST.stampDuty,
  slippageRate: DEFAULT_COST.slippageRate,
  spreadRate: DEFAULT_COST.spreadRate,
};

/** 单边买入成本比例（相对成交价）：滑点 + 半边点差 + 佣金 */
export function buyDragOf(cost: EventCostModel = EVENT_COST, notional = EVENT_NOTIONAL): number {
  const commission = Math.max(cost.minCommission / notional, cost.commissionRate);
  return cost.slippageRate + cost.spreadRate / 2 + commission;
}

/** 单边卖出成本比例：滑点 + 半边点差 + 佣金 + 印花税 */
export function sellDragOf(cost: EventCostModel = EVENT_COST, notional = EVENT_NOTIONAL): number {
  const commission = Math.max(cost.minCommission / notional, cost.commissionRate);
  return cost.slippageRate + cost.spreadRate / 2 + commission + cost.stampDuty;
}

/** 往返成本比例（用于页面解释「为什么扣了这么多」） */
export function roundTripDragOf(cost: EventCostModel = EVENT_COST, notional = EVENT_NOTIONAL): number {
  return buyDragOf(cost, notional) + sellDragOf(cost, notional);
}

export interface EventQuote {
  /** T+1 开盘价（买入侧）；null=停牌/无价，不可成交 */
  entryOpen: number | null;
  /** T 日收盘价（用于判断 T+1 是否一字/涨停买不进） */
  signalClose: number | null;
  /** 涨停幅度（0.1 / 0.2 / 0.3 / ST 0.05）；由调用方按板块给 */
  limitRatio: number;
  /** T+2 开盘价（持有 1 日卖出） */
  exitOpen1: number | null;
  /** T+6 开盘价（持有 5 日卖出）；null=不足 5 日后视窗，不算 5 日样本 */
  exitOpen5?: number | null;
}

export interface EventOutcome {
  /** 这笔能不能买得进（T+1 开盘未封涨停且有价） */
  tradable: boolean;
  /** 买不进的原因（说人话，直接给页面用） */
  blockedReason: string | null;
  /** 毛收益 %（不扣费，只作对照，不对外当成绩卖） */
  gross1: number | null;
  /** 净收益 %（扣费后，持 1 日）——页面展示的必须是这个 */
  net1: number | null;
  gross5: number | null;
  net5: number | null;
}

/** 毛→净：一次性乘性扣费。gross 传百分比（如 1.5 表示 +1.5%） */
export function netOf(grossPct: number | null, cost: EventCostModel = EVENT_COST, notional = EVENT_NOTIONAL): number | null {
  if (grossPct == null || !Number.isFinite(grossPct)) return null;
  const b = buyDragOf(cost, notional);
  const s = sellDragOf(cost, notional);
  return ((1 + grossPct / 100) * (1 - b) * (1 - s) - 1) * 100;
}

/**
 * 一次命中的成交结果。
 * 纪律：买不进的样本直接踢出（tradable=false），
 * 绝不能记成「收益 0」混进平均——那等于把「根本没买」当成「买了没赚」。
 */
export function eventOutcomeOf(q: EventQuote, cost: EventCostModel = EVENT_COST): EventOutcome {
  const none: EventOutcome = { tradable: false, blockedReason: null, gross1: null, net1: null, gross5: null, net5: null };
  if (q.entryOpen == null || !(q.entryOpen > 0)) return { ...none, blockedReason: "次日无开盘价（停牌）" };
  if (q.signalClose != null && q.signalClose > 0 && q.limitRatio > 0) {
    const limitPrice = Math.round(q.signalClose * (1 + q.limitRatio) * 100) / 100;
    if (q.entryOpen >= limitPrice) return { ...none, blockedReason: `次日一字涨停买不进（${(q.limitRatio * 100).toFixed(0)}%）` };
  }
  const gross1 = q.exitOpen1 != null && q.exitOpen1 > 0 ? (q.exitOpen1 / q.entryOpen - 1) * 100 : null;
  const gross5 = q.exitOpen5 != null && q.exitOpen5 > 0 ? (q.exitOpen5 / q.entryOpen - 1) * 100 : null;
  return {
    tradable: true,
    blockedReason: null,
    gross1,
    net1: netOf(gross1, cost),
    gross5,
    net5: netOf(gross5, cost),
  };
}

// ---- 汇总统计 ----

export interface EventStat {
  /** 可成交样本数 */
  n: number;
  /** 净收益为正的占比 % */
  win: number;
  /** 持有 1 日净收益均值 % */
  net1: number;
  /** 持有 5 日净收益均值 %（样本不足为 null，不许用 1 日值顶替） */
  net5: number | null;
  /** 毛收益均值 %（仅对照用，页面不展示） */
  gross1: number;
  /** 胜率 Wilson 95%CI 文本 */
  winCi: string;
  /** 每段样本数（页面要标「样本外 N=xx」） */
  split: { train: number; validation: number; test: number };
}

export type SplitName = "train" | "validation" | "test";

/** 样本外段名（页面主展示这一段） */
export const OOS_SPLIT: SplitName = "test";

export interface EventSample {
  /** 命中日下标（用于三段切分） */
  t: number;
  outcome: EventOutcome;
}

export interface StatOptions {
  /** 日期总数（用于按命中下标切三段） */
  totalDates: number;
  /** 三段比例，默认 0.6/0.2/0.2（沿用 engine 的 splitRanges 惯例） */
  split?: { train: number; validation: number; test: number };
}

/** 命中下标 → 段名。日期轴不足三段时按实际存在的段归类，不猜 */
export function splitOfIndex(t: number, totalDates: number, split = { train: 0.6, validation: 0.2, test: 0.2 }): SplitName {
  const a = Math.floor(totalDates * split.train);
  const b = Math.floor(totalDates * (split.train + split.validation));
  if (t < a) return "train";
  if (t < b) return "validation";
  return "test";
}

/** 流式累加器：全市场回测有几千万次命中，不能把样本存下来再统计（内存会炸） */
export interface EventAcc {
  n: number;
  wins: number;
  sumNet1: number;
  sumNet5: number;
  nNet5: number;
  sumGross1: number;
}

export function emptyAcc(): EventAcc {
  return { n: 0, wins: 0, sumNet1: 0, sumNet5: 0, nNet5: 0, sumGross1: 0 };
}

/** 只累加真买得进、且算得出净收益的样本 */
export function accPush(acc: EventAcc, o: EventOutcome): void {
  if (!o.tradable || o.net1 == null || !Number.isFinite(o.net1)) return;
  acc.n++;
  if (o.net1 > 0) acc.wins++;
  acc.sumNet1 += o.net1;
  if (o.gross1 != null) acc.sumGross1 += o.gross1;
  if (o.net5 != null && Number.isFinite(o.net5)) { acc.nNet5++; acc.sumNet5 += o.net5; }
}

export interface AccStat {
  n: number;
  win: number;
  net1: number;
  net5: number | null;
  gross1: number;
  winCi: string;
}

export function accStatOf(acc: EventAcc): AccStat | null {
  if (!acc.n) return null;
  const win = (acc.wins / acc.n) * 100;
  return {
    n: acc.n,
    win,
    net1: acc.sumNet1 / acc.n,
    net5: acc.nNet5 ? acc.sumNet5 / acc.nNet5 : null,
    gross1: acc.sumGross1 / acc.n,
    winCi: pctWithCI(win, acc.n),
  };
}

export function eventStatOf(samples: readonly EventSample[], opts: StatOptions): EventStat | null {
  const usable = samples.filter((s) => s.outcome.tradable && s.outcome.net1 != null);
  if (!usable.length) return null;
  const acc = emptyAcc();
  for (const s of usable) accPush(acc, s.outcome);
  const split = opts.split ?? { train: 0.6, validation: 0.2, test: 0.2 };
  const counts: Record<SplitName, number> = { train: 0, validation: 0, test: 0 };
  for (const s of usable) counts[splitOfIndex(s.t, opts.totalDates, split)]++;
  const base = accStatOf(acc) as AccStat;
  // 胜率区间文本走 wilson-core 的 pctWithCI（全局只有这一处格式化，页面不许再拼一遍）
  return { ...base, split: counts };
}

/** 只统计某一段（样本外报告用）。样本不足返回 null——不许拿全期数字冒充样本外 */
export function eventStatOfSplit(
  samples: readonly EventSample[],
  segment: SplitName,
  opts: StatOptions,
): EventStat | null {
  const split = opts.split ?? { train: 0.6, validation: 0.2, test: 0.2 };
  return eventStatOf(samples.filter((s) => splitOfIndex(s.t, opts.totalDates, split) === segment), opts);
}
