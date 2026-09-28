// R20 主力净额第三档备胎：东财主力资金明细 + 新浪日度净额两条源都没通时，
// 用**通达信当日逐笔自算**的主力净额顶上。
//
// 为什么要有第三档：个股资金流此前是「东财 → 新浪 → missing」三选一。前两条源任一条通，
// 用户就能看到主力净额；两条都挂时个股画像那一块直接空白，而通达信网关里其实有
// 当日逐笔（有价、有量、有方向），够按公开分档口径自己算一个出来。
//
// 纪律（与 tdx-flow-core 同一套，逐条写清不留在注释里飘着）：
//   · 自算值必须挂 `basis` 出身说明——它不等于东财官方主力净额，不许冒充；
//   · 算不出来返回 null，由调用方照旧走 missing，**不补 0**；
//   · 只覆盖当日（逐笔是当日的），不产生「近 14 日」序列——那是东财/新浪的历史序列，
//     自算造不出历史，硬编就是假数据。

import { tdxMainFlowFor } from "./tdx";
import { MAIN_FLOW_BASIS } from "@/lib/quant/screener/tdx-flow-core";

export interface MainNetSelfComputed {
  /** 主力净额（亿）：特大单+大单 主动买 − 主动卖 */
  mainNetYi: number;
  /** 超大单净额（亿） */
  superBigYi: number;
  /** 大单净额（亿） */
  bigYi: number;
  /** 净占比%（主力净额 / 当日成交额）；成交额未知为 null */
  ratioPct: number | null;
  /** 计入的逐笔数 */
  sampleTicks: number;
  /** 逐笔是否一次取全（无截断）——false 时这个数是半截样本，可信度要打折 */
  sampleComplete: boolean;
  /** 出身说明，消费方展示时必须带上 */
  basis: string;
}

/**
 * 单只当日主力净额（通达信逐笔自算）。
 * amountYuan 传当日成交额（元）才会算净占比；没有就留 null，不补 0。
 * 算不出（网关断 / 该票当日无逐笔 / 符号认不出）返回 null。
 */
export async function tdxMainNetOf(symbol: string, amountYuan?: number | null): Promise<MainNetSelfComputed | null> {
  const flow = await tdxMainFlowFor(symbol, amountYuan).catch(() => null);
  if (!flow || !isFinite(flow.mainNetYi)) return null;
  return {
    mainNetYi: flow.mainNetYi,
    superBigYi: flow.superBigYi,
    bigYi: flow.bigYi,
    ratioPct: flow.ratioPct,
    sampleTicks: flow.sampleTicks,
    sampleComplete: flow.sampleComplete,
    basis: MAIN_FLOW_BASIS,
  };
}

/** 给提示词/日志用的一行白话说明（自算值出场时必须同框） */
export function mainNetSelfNote(r: MainNetSelfComputed): string {
  return `通达信逐笔自算（${r.basis}）；计入 ${r.sampleTicks} 笔${r.sampleComplete ? "，取全当日样本" : "，样本不完整"}。这是本地按公开分档口径算的，与东财/新浪的主力净额不完全等价，转述时须注明「自算」。`;
}

/**
 * 市场层：主力净额合计（通达信逐笔自算，成交额前 N 只的子集）。
 *
 * 耗时兜底：这一趟要挨只拉当日逐笔（约 9 秒，网关侧有 60 秒/10 分钟缓存）。
 * 给 12 秒上限，超时就当这一档没取到——返回空对象，页面照旧按「缺失」显示，不编数。
 */
export async function marketMainNetTdx(): Promise<Record<string, unknown>> {
  try {
    const { tdxMainFlowTotal } = await import("./tdx");
    const t = await Promise.race([
      tdxMainFlowTotal(),
      new Promise<null>((r) => setTimeout(() => r(null), 12_000)),
    ]);
    if (!t) return {};
    return {
      main_net_tdx: {
        sum_yi: t.sumYi,
        known: t.known,
        universe: t.universe,
        complete: t.complete,
        amount_yi: t.amountYi,
        as_of: t.asOf,
        basis: t.basis,
        // 页面直接用的那句口径说明：这个合计是子集、是自算，不是全 A 官方读数
        note: `成交额前 ${t.universe} 只的自算合计（其中 ${t.known} 只取到逐笔、${t.complete} 只样本完整），不是全 A 合计`,
      },
    };
  } catch {
    return {};
  }
}
