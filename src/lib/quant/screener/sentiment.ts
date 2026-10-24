// Quant Screener — 市场状态/大盘情绪（服务端）
// 数据：全A快照（东财榜单接口，em 数据源缓存）+ 指数实时（腾讯）。
// 风险等级按需求文档九的口径，但只用「有真实数据源的指标」；
// 没有数据源的指标（北向等）显式列入 missing，绝不编造。
// P0补齐（任务A）：炸板率——用同一份全A快照的 high(f15)/prevClose(f18) 判触板/封板，
//   涨停价 = round(昨收 × (1+限制比例), 2)；比例：创业板/科创板(300/301/688/689) 20%（含ST，
//   交易所规则注册制板块ST不降比例）→ 北交所 30% → 主板ST 5% → 其余 10%；名称 N 开头（上市首日）不参与判定。
//   触板 = high ≥ 涨停价；收盘涨停 = price ≥ 涨停价；炸板 = 触板 且 未封板。
// P15-R20：已有五条风险阈值一字未改，只补一条升档判据——同拍命中 ≥2 条「偏高」级读数即升「高风险」。
//   为什么原来「高风险」是死档：类型里有这一档、页面样式也备好了，但五条规则没有一条会把档位抬到那儿，
//   单条读数再差也只到「偏高」，所以那一档从来没被命中过。判据与理由在 top-risk-core.ts，不在这里重复。

import { getProvider } from "@/lib/quant/data/index";
import { universeSource } from "@/lib/quant/data/tc-universe";
import { fetchQuotesReal, type RealQuote } from "@/lib/desk/em";
import { marketSessionHolidayAware } from "@/lib/desk/session-server";
import { latestTradeDate } from "@/lib/desk/trade-date";
// R20：「高风险」档位的同拍升档判据（纯核，阈值只有一份、写在文件里）
import { escalateToHighRisk } from "./top-risk-core.ts";
import type { AssetMeta } from "../types.ts";

export interface SentimentResult {
  as_of: string; // 行情时刻（YYYY-MM-DD HH:mm:ss 或 YYYY-MM-DD），来自数据源 quoteTime/quoteDate，非本地时间
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
  /** 全A涨跌幅分布（10档直方）：≤-10% / -10~-7 / -7~-5 / -5~-3 / -3~0 / 0~3 / 3~5 / 5~7 / 7~10 / ≥10%。
   * P67 体检 #2：首末桶按数值语义命名——20cm 股 ±10~20% 的普通涨跌也会落进这两桶，标「涨停/跌停」是说谎。 */
  pct_distribution: { label: string; from: number | null; to: number | null; count: number }[];
  amount_total_yi: number;
  /**
   * 全 A 快照里 **amount 真实有值**的家数（P7-⑦ 为 M-TURNOVER 补的口径登记，与 main_net_known 同理）。
   * `amount_total_yi` 是 `+= m.amount ?? 0` 累加出来的：一家都没抓到该字段时它同样是 0，
   * 而「今日全 A 成交 0 亿」是个结论，「这个数没读到」是另一回事。
   */
  amount_known: number;
  main_net_sum_yi: number;
  /**
   * 全 A 快照里 **mainNet 真实有值**的家数（P7-④ 接线补的口径登记）。
   * 为什么要有它：`main_net_sum_yi` 是 `+= m.mainNet ?? 0` 累加出来的，一家都没抓到该字段时它同样是 0。
   * 下游（市场面打分表）必须能区分「今日主力净额 0 亿」与「这个数根本没读到」，否则缺失会被算成中性。
   */
  main_net_known: number;
  median_pct: number;
  indices: { symbol: string; name: string; price: number; changePct: number | undefined }[];
  risk: {
    level: "正常" | "注意" | "偏高" | "高风险";
    triggers: string[];
    /**
     * R20：本次命中的「偏高」级读数短名（升高风险就靠数它，`>=2` 同拍才升）。
     * 可选是为了不破旧快照测试里的 risk 字面量；读侧当空数组处理即可。
     */
    severe_signals?: string[];
  };
  missing: string[];
  source: { provider: string; universe_endpoint: string; indices_endpoint: string };
}

/** P67 体检 #8：涨跌幅口径的涨/跌停阈值改吃 fields.limitRatio 同一份分板规则——
 * 主板 ST 5% 有名有姓地计入，不再被 9.8 一刀切漏掉；注册制板块（含ST）20%、北交所 30%。
 * 容差 0.2pp 吃涨停价四舍五入（与旧 9.8/19.8/29.8 同档）。 */
function limitPctOf(m: { symbol: string; name: string }): number {
  return limitRatio(m.symbol, m.name) * 100 - 0.2;
}

/** 涨停比例 / 快照口径涨停判定：纯逻辑已上移至 fields.ts（node:test 可直跑），此处转导保持既有引用不变 */
export { limitRatio, evalLimitSnapshot } from "../factors/fields.ts";
export type { LimitEval } from "../factors/fields.ts";
import { evalLimitSnapshot, limitRatio } from "../factors/fields.ts";

export async function computeSentiment(): Promise<SentimentResult> {
  const provider = await getProvider("em");
  const now = new Date();
  const tradeDate = await latestTradeDate(now);
  const session = marketSessionHolidayAware(now);
  const live = session.phase === "trading";
  const metas: AssetMeta[] = await provider.listUniverse({ kind: "all" }, tradeDate);
  if (!metas.length) throw new Error("全A快照为空（数据源无返回）");

  // 行情时刻：以数据源自带的 quoteTime / quoteDate（腾讯 f[30] / 东财 f124 解析）为准，
  // 而不是本地 new Date()。休市日/盘前上游仍返回上一交易日的快照，
  // 用 quoteTime 才能如实标注「数据截至 X 日 HH:mm:ss」，避免把旧数据标成「今天实时」。
  const quoteTimes = metas
    .map((m) => m.quoteTime)
    .filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d));
  const quoteDates = metas
    .map((m) => m.quoteDate)
    .filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));
  const asOf = quoteTimes.length
    ? quoteTimes.reduce((a, b) => (a > b ? a : b))
    : quoteDates.length
      ? quoteDates.reduce((a, b) => (a > b ? a : b))
      : tradeDate; // 兜底：全A快照没有任何行情时刻字段时，退回交易日（宁可保守，不冒充实时）

  let advancers = 0, decliners = 0, flat = 0, limitUp = 0, limitDown = 0;
  let touched = 0, broken = 0, limitUnknown = 0;
  let amountSum = 0, amountKnown = 0, mainNetSum = 0, mainNetKnown = 0;
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
    if (/^[NC]/.test(m.name)) {
      // 新股（N=首日、C=上市2~5日）无涨跌幅限制：涨停/触板/跌停判定整体不参与。
      // P67 体检 #8：旧码只在涨停侧豁免，跌停侧照数——新股跌 10% 会被计成「跌停」。
    } else if (ev) {
      if (ev.touched) touched++;
      if (ev.sealed) limitUp++;
      if (ev.touched && !ev.sealed) broken++;
      if (pct <= -limitPctOf(m)) limitDown++;
    } else {
      limitUnknown++;
      // 快照缺 high/prevClose 时退回涨跌幅口径，只判封板不判触板；
      // 阈值与 fields.limitRatio 同一份分板规则（主板ST 4.8 / 9.8 / 19.8 / 29.8）
      const lim = limitPctOf(m);
      if (pct >= lim) limitUp++;
      if (pct <= -lim) limitDown++;
    }
    amountSum += m.amount ?? 0;
    mainNetSum += m.mainNet ?? 0;
    // 家数登记：上面那行 `?? 0` 让「字段缺失」和「净额正好 0」长得一样，下游需要一个能区分的口径
    if (typeof m.mainNet === "number" && Number.isFinite(m.mainNet)) mainNetKnown++;
    if (typeof m.amount === "number" && Number.isFinite(m.amount)) amountKnown++;
  }
  const breakRate = touched > 0 ? (broken / touched) * 100 : null;
  pcts.sort((a, b) => a - b);
  const median = pcts.length ? pcts[Math.floor(pcts.length / 2)] : 0;
  // 涨跌幅分布直方（10档，与行情软件「涨跌分布」口径一致；首末桶是数值语义 ≥10%/≤-10%，不冒充涨跌停）
  const distBounds = [-Infinity, -10, -7, -5, -3, 0, 3, 5, 7, 10, Infinity];
  const distLabels = ["≤-10%", "-10~-7", "-7~-5", "-5~-3", "-3~0", "0~3", "3~5", "5~7", "7~10", "≥10%"];
  const pctDistribution = distLabels.map((label, i) => {
    const lo = distBounds[i];
    const hi = distBounds[i + 1];
    const count = pcts.filter((p) => p > lo && p <= hi).length;
    return { label, from: lo, to: hi, count };
  });
  const advRatio = decliners > 0 ? advancers / decliners : advancers > 0 ? 99 : 1;

  const triggers: string[] = [];
  // P15-R20：「偏高」级读数的短名。只用来数「同一时刻几条一起差」，不参与任何既有阈值判定。
  const severe: string[] = [];
  let level: SentimentResult["risk"]["level"] = "正常";
  const worse = (next: SentimentResult["risk"]["level"]): void => {
    const order = ["正常", "注意", "偏高", "高风险"];
    if (order.indexOf(next) > order.indexOf(level)) level = next;
  };
  if (advRatio < 0.5) { triggers.push(`涨跌家数比 ${advRatio.toFixed(2)}（阈值 <0.5）`); severe.push("涨跌家数比<0.5"); worse("偏高"); }
  else if (advRatio < 0.8) { triggers.push(`涨跌家数比 ${advRatio.toFixed(2)}（<0.8 弱势）`); worse("注意"); }
  if (limitDown > limitUp && limitDown > 0) { triggers.push(`跌停 ${limitDown} 家 > 涨停 ${limitUp} 家`); severe.push("跌停家数反超涨停"); worse("偏高"); }
  else if (limitDown >= 5) { triggers.push(`跌停 ${limitDown} 家`); worse("注意"); }
  const mainNetYi = mainNetSum / 1e8;
  if (mainNetYi < -500) { triggers.push(`全A主力净流出 ${mainNetYi.toFixed(0)} 亿（阈值 -500）`); severe.push("全A主力净流出<-500亿"); worse("偏高"); }
  else if (mainNetYi < -300) { triggers.push(`全A主力净流出 ${mainNetYi.toFixed(0)} 亿（阈值 -300）`); worse("注意"); }
  if (median < -1.5) { triggers.push(`全A中位涨跌幅 ${median.toFixed(2)}%`); worse("注意"); }
  // 炸板率触发（需求文档九）：>40% → 升到「偏高」
  if (breakRate !== null && breakRate > 40) {
    triggers.push(`炸板率升至 ${breakRate.toFixed(0)}%（触板 ${touched}/炸板 ${broken}，阈值 >40%）`);
    severe.push("炸板率>40%");
    worse("偏高");
  }
  // P15-R20：补活「高风险」这一档。上面五条阈值一个字没改；这里只加一条同拍判据
  //（两条及以上「偏高」级读数同时命中 → 升高风险）。取舍理由见 top-risk-core.ts 文件头。
  const esc = escalateToHighRisk(level, severe);
  if (esc.escalated) { level = esc.level; triggers.push(esc.text); }
  if (!triggers.length) triggers.push("各项可用指标均在正常范围");

  const idxQuotes = await fetchQuotesReal(["000001.SH", "399001.SZ", "399006.SZ"]).catch(() => [] as (RealQuote | null)[]);
  const idxNames: Record<string, string> = { "000001.SH": "上证指数", "399001.SZ": "深证成指", "399006.SZ": "创业板指" };
  const indices = (idxQuotes ?? [])
    .filter((q): q is RealQuote => q !== null)
    .map((q) => ({ symbol: q.symbol, name: idxNames[q.symbol] ?? q.symbol, price: q.price, changePct: q.changePct }));

  return {
    as_of: asOf,
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
    pct_distribution: pctDistribution,
    amount_total_yi: amountSum / 1e8,
    amount_known: amountKnown,
    main_net_sum_yi: mainNetYi,
    main_net_known: mainNetKnown,
    median_pct: median,
    indices,
    risk: { level, triggers, severe_signals: severe },
    missing: [
      "北向净流入：交易所自2024-08-19起不再披露，无官方数据源",
      ...(breakRate === null ? [`炸板率（今日触板数为 0，无法计算比率）`] : []),
      ...(mainNetKnown === 0 ? [`主力净额：全 A ${pcts.length} 家里 0 家真实带 mainNet 字段，main_net_sum_yi=${mainNetYi.toFixed(0)} 亿是 ?? 0 累加的结果，不是「今日主力净额为 0」`] : []),
      ...(limitUnknown > 0 ? [`触板判定跳过 ${limitUnknown} 只（N/C开头新股或快照缺 high/prevClose，仅按涨跌幅判封板）`] : []),
    ],
    source: {
      provider:
        universeSource() === "tdx"
          ? "通达信网关 + 本地库（TDX实时快照 + DB收盘价；市盈率/市值/主力净额标缺）+ 腾讯指数"
          : universeSource() === "tc"
            ? "腾讯批量快照兜底（东财榜单接口 断源；主力净额/行业/上市日不可得）+ 腾讯指数"
            : "em（东财榜单接口 全A快照 + 腾讯指数）",
      universe_endpoint:
        universeSource() === "tdx" ? "通达信网关 quotes.get_snapshots × 本地库 stock_daily_close"
          : universeSource() === "tc" ? "腾讯批量行情×本机代码表" : "东财榜单接口",
      indices_endpoint: "腾讯行情",
    },
  };
}
