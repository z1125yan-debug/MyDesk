// P6-A 混合取K线的「为什么没拿到」判定（纯内核：不 fetch、不 import 任何带别名的服务端模块，node --test 可直跑）。
//
// 修的是哪一类失真：fetchBarsHybrid 原来对「eltdx 与腾讯都失败」和「这只票真的没有K线」给出同一个结果——
// 空数组。下游（选股器、概率回放、涨停梯队）只能 `if (!bars.length) continue`，于是：
// - 一次限流/超时会伪装成「这只股票不符合条件」，漏斗里看不出差别；
// - 提示语只能说「全部无数据」，不能说「其中 N 只是取数失败」；
// - 更糟的是把取数失败当成真实的 0 参与统计（任务书 §六 明令禁止）。
// 这里只补「分类」这一件事：拿到的条数、哪条通道拿的、是不是兜底 —— 判定标准集中在一处，
// 取数层照抄结论，页面/引擎不得各自再解释一遍。
import type { ObservationKind } from "../screener/datastatus-core.ts";

/** 两条真实通道：eltdx 直连网关（快、带量额）与腾讯日K（慢、口径稳定） */
export type BarChannel = "tdx" | "tencent";

export interface BarAttempt {
  symbol: string;
  /** 最终给出条数的通道；两条都没给出结果时为 null */
  channel: BarChannel | null;
  /** 该通道是否成功返回（抛错/超时算 false） */
  ok: boolean;
  /** 返回的日K根数（ok=false 时不参与判定） */
  count: number;
  /** 失败原文；空串时由本层补默认说明 */
  error?: string;
}

export interface BarOutcome {
  symbol: string;
  /** 与 datastatus-core 同一套口径：value / no_data / request_failed 三种互不合并 */
  kind: ObservationKind;
  count: number;
  channel: BarChannel | null;
  /** 走了兜底通道（主通道不可用或被拒）：整体响应应降为 DEGRADED 的依据 */
  degraded: boolean;
  reason: string;
}

/**
 * 单只股票的最终观测：失败优先于空——通道抛错时，哪怕同时是 0 根，也只能说「取数失败」，
 * 不能说「这只没有数据」。判定顺序刻意写成 ok → count，与 observeValue 一致。
 */
export function classifyBarOutcome(attempt: BarAttempt): BarOutcome {
  if (!attempt.ok) {
    return {
      symbol: attempt.symbol,
      kind: "request_failed",
      count: 0,
      channel: attempt.channel,
      degraded: true,
      reason: attempt.error?.trim() || "两条K线通道均未成功返回（超时/被拒/解析失败），不按 0 处理",
    };
  }
  if (attempt.count <= 0) {
    return {
      symbol: attempt.symbol,
      kind: "no_data",
      count: 0,
      channel: attempt.channel,
      degraded: attempt.channel !== "tdx",
      reason: attempt.error?.trim() || "通道请求成功但没有返回该标的的日K（不是 0 根可用数据）",
    };
  }
  return {
    symbol: attempt.symbol,
    kind: "value",
    count: attempt.count,
    channel: attempt.channel,
    degraded: attempt.channel !== "tdx",
    reason: "",
  };
}

export interface OutcomeCounts {
  value: number;
  no_data: number;
  request_failed: number;
  tdx: number;
  tencent: number;
}

export function summarizeOutcomes(outcomes: BarOutcome[]): OutcomeCounts {
  const c: OutcomeCounts = { value: 0, no_data: 0, request_failed: 0, tdx: 0, tencent: 0 };
  for (const o of outcomes) {
    if (o.kind === "value") c.value++;
    else if (o.kind === "no_data") c.no_data++;
    else if (o.kind === "request_failed") c.request_failed++;
    if (o.channel === "tdx") c.tdx++;
    else if (o.channel === "tencent") c.tencent++;
  }
  return c;
}

/**
 * 给漏斗/警告用的一句话口径：三种情形分别报数，绝不合并成「N 只无数据」。
 * 全部成功时返回空串（调用方据此不追加噪音）。
 */
export function outcomeWarning(outcomes: BarOutcome[]): string {
  const c = summarizeOutcomes(outcomes);
  if (c.no_data === 0 && c.request_failed === 0 && c.tencent === 0) return "";
  const parts = [
    c.tdx ? `eltdx 直连 ${c.tdx} 只` : "",
    c.tencent ? `腾讯兜底 ${c.tencent} 只（主通道不可用，已降级）` : "",
    c.request_failed ? `取数失败 ${c.request_failed} 只（未参与K线条件，不算不符合条件）` : "",
    c.no_data ? `无K线返回 ${c.no_data} 只` : "",
  ].filter(Boolean);
  return `K线口径：${parts.join("；")}；取数失败与「没有数据」是两回事，不合并统计`;
}
