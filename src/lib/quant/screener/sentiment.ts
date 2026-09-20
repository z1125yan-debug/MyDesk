// Quant Screener — 市场状态/大盘情绪（服务端）
// 数据：全A快照（东财 clist，emProvider 缓存）+ 指数实时（腾讯）。
// 风险等级按需求文档九的口径，但只用「有真实数据源的指标」；
// 没有数据源的指标（北向等）显式列入 missing，绝不编造。
// P0补齐（任务A）：炸板率——用同一份全A快照的 high(f15)/prevClose(f18) 判触板/封板，
//   涨停价 = round(昨收 × (1+限制比例), 2)；比例：创业板/科创板(300/301/688/689) 20%（含ST，
//   交易所规则注册制板块ST不降比例）→ 北交所 30% → 主板ST 5% → 其余 10%；名称 N 开头（上市首日）不参与判定。
//   触板 = high ≥ 涨停价；收盘涨停 = price ≥ 涨停价；炸板 = 触板 且 未封板。

import { getProvider } from "@/lib/quant/data/index";
import { fetchQuotesReal, type RealQuote } from "@/lib/desk/em";
import { marketSession, shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import type { AssetMeta } from "../types.ts";

export interface SentimentResult {
  as_of: string; // 本地时间
  trade_date: string;
  live: boolean; // 是否交易时段
  total: number;
  advancers: number;
  decliners: number;
  flat: number;
  limit_up: number;
  limit_down: number;
  touched_limit: number; // 触板数（含已封板）
  limit_up_broken: number; // 炸板数 = 触板 - 封板
  break_rate: number | null; // 炸板率 %；触板为 0 时 null（列入 missing）
  amount_total_yi: number;
  main_net_sum_yi: number;
  /**
   * 全 A 快照里 **mainNet 真实有值**的家数（P7-④ 接线补的口径登记）。
   * 为什么要有它：`main_net_sum_yi` 是 `+= m.mainNet ?? 0` 累加出来的，一家都没抓到该字段时它同样是 0。
   * 下游（市场面打分表）必须能区分「今日主力净额 0 亿」与「这个数根本没读到」，否则缺失会被算成中性。
   */
  main_net_known: number;
  median_pct: number;
  indices: { symbol: string; name: string; price: number; changePct: number }[];
  risk: { level: "正常" | "注意" | "偏高" | "高风险"; triggers: string[] };
  missing: string[];
  source: { provider: string; universe_endpoint: string; indices_endpoint: string };
}

function limitUpPct(symbol: string): number {
  if (symbol.endsWith(".BJ")) return 29.8;
  if (/^(688|689)\./.test(symbol) || /^30\d{4}\./.test(symbol)) return 19.8;
  return 9.8;
}

/** 涨停比例 / 快照口径涨停判定：纯逻辑已上移至 fields.ts（node:test 可直跑），此处转导保持既有引用不变 */
export { limitRatio, evalLimitSnapshot } from "../factors/fields.ts";
export type { LimitEval } from "../factors/fields.ts";
import { evalLimitSnapshot } from "../factors/fields.ts";

export async function computeSentiment(): Promise<SentimentResult> {
  const provider = await getProvider("em");
  const now = new Date();
  const tradeDate = shanghaiDate(now);
  const session = marketSession(now);
  const live = session.phase === "trading";
  const metas: AssetMeta[] = await provider.listUniverse({ kind: "all" }, tradeDate);
  if (!metas.length) throw new Error("全A快照为空（数据源无返回）");

  let advancers = 0, decliners = 0, flat = 0, limitUp = 0, limitDown = 0;
  let touched = 0, broken = 0, limitUnknown = 0;
  let amountSum = 0, mainNetSum = 0, mainNetKnown = 0;
  const pcts: number[] = [];
  for (const m of metas) {
    const pct = m.changePct;
    const price = m.price;
    if (price === undefined || price <= 0 || pct === undefined) continue; // 停牌/无成交
    pcts.push(pct);
    if (pct > 0) advancers++;
    else if (pct < 0) decliners++;
    else flat++;
    const ev = evalLimitSnapshot(m);
    if (ev) {
      if (ev.touched) touched++;
      if (ev.sealed) limitUp++;
      if (ev.touched && !ev.sealed) broken++;
    } else if (/^[NC]/.test(m.name)) {
      // 新股（无涨跌幅限制期/首日）：完全不参与涨停判定
    } else {
      limitUnknown++;
      // 快照缺 high/prevClose 时退回涨跌幅口径，只判封板不判触板
      const lim = limitUpPct(m.symbol);
      if (pct >= lim) limitUp++;
    }
    if (pct <= -limitUpPct(m.symbol)) limitDown++;
    amountSum += m.amount ?? 0;
    mainNetSum += m.mainNet ?? 0;
    // 家数登记：上面那行 `?? 0` 让「字段缺失」和「净额正好 0」长得一样，下游需要一个能区分的口径
    if (typeof m.mainNet === "number" && Number.isFinite(m.mainNet)) mainNetKnown++;
  }
  const breakRate = touched > 0 ? (broken / touched) * 100 : null;
  pcts.sort((a, b) => a - b);
  const median = pcts.length ? pcts[Math.floor(pcts.length / 2)] : 0;
  const advRatio = decliners > 0 ? advancers / decliners : advancers > 0 ? 99 : 1;

  const triggers: string[] = [];
  let level: SentimentResult["risk"]["level"] = "正常";
  const worse = (next: SentimentResult["risk"]["level"]): void => {
    const order = ["正常", "注意", "偏高", "高风险"];
    if (order.indexOf(next) > order.indexOf(level)) level = next;
  };
  if (advRatio < 0.5) { triggers.push(`涨跌家数比 ${advRatio.toFixed(2)}（阈值 <0.5）`); worse("偏高"); }
  else if (advRatio < 0.8) { triggers.push(`涨跌家数比 ${advRatio.toFixed(2)}（<0.8 弱势）`); worse("注意"); }
  if (limitDown > limitUp && limitDown > 0) { triggers.push(`跌停 ${limitDown} 家 > 涨停 ${limitUp} 家`); worse("偏高"); }
  else if (limitDown >= 5) { triggers.push(`跌停 ${limitDown} 家`); worse("注意"); }
  const mainNetYi = mainNetSum / 1e8;
  if (mainNetYi < -500) { triggers.push(`全A主力净流出 ${mainNetYi.toFixed(0)} 亿（阈值 -500）`); worse("偏高"); }
  else if (mainNetYi < -300) { triggers.push(`全A主力净流出 ${mainNetYi.toFixed(0)} 亿（阈值 -300）`); worse("注意"); }
  if (median < -1.5) { triggers.push(`全A中位涨跌幅 ${median.toFixed(2)}%`); worse("注意"); }
  // 炸板率触发（需求文档九）：>40% → 升到「偏高」
  if (breakRate !== null && breakRate > 40) {
    triggers.push(`炸板率升至 ${breakRate.toFixed(0)}%（触板 ${touched}/炸板 ${broken}，阈值 >40%）`);
    worse("偏高");
  }
  if (!triggers.length) triggers.push("各项可用指标均在正常范围");

  const idxQuotes = await fetchQuotesReal(["000001.SH", "399001.SZ", "399006.SZ"]).catch(() => [] as (RealQuote | null)[]);
  const idxNames: Record<string, string> = { "000001.SH": "上证指数", "399001.SZ": "深证成指", "399006.SZ": "创业板指" };
  const indices = (idxQuotes ?? [])
    .filter((q): q is RealQuote => q !== null)
    .map((q) => ({ symbol: q.symbol, name: idxNames[q.symbol] ?? q.symbol, price: q.price, changePct: q.changePct }));

  return {
    as_of: shanghaiStamp(now),
    trade_date: tradeDate,
    live,
    total: pcts.length,
    advancers,
    decliners,
    flat,
    limit_up: limitUp,
    limit_down: limitDown,
    touched_limit: touched,
    limit_up_broken: broken,
    break_rate: breakRate,
    amount_total_yi: amountSum / 1e8,
    main_net_sum_yi: mainNetYi,
    main_net_known: mainNetKnown,
    median_pct: median,
    indices,
    risk: { level, triggers },
    missing: [
      "北向净流入：交易所自2024-08-19起不再披露，无官方数据源",
      ...(breakRate === null ? [`炸板率（今日触板数为 0，无法计算比率）`] : []),
      ...(mainNetKnown === 0 ? [`主力净额：全 A ${pcts.length} 家里 0 家真实带 mainNet 字段，main_net_sum_yi=${mainNetYi.toFixed(0)} 亿是 ?? 0 累加的结果，不是「今日主力净额为 0」`] : []),
      ...(limitUnknown > 0 ? [`触板判定跳过 ${limitUnknown} 只（N/C开头新股或快照缺 high/prevClose，仅按涨跌幅判封板）`] : []),
    ],
    source: {
      provider: "em（东财 clist 全A快照 + 腾讯指数）",
      universe_endpoint: "push2.eastmoney.com/api/qt/clist",
      indices_endpoint: "qt.gtimg.cn",
    },
  };
}
