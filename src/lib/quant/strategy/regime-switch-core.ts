// P36-E6 档位切换条（强势 / 震荡 / 弱势）的纯核：只做纯计算，零 IO、零时钟。
//
// 为什么单独成核：判档口径此前散在回测脚本与 strategy-forecast 接口里，切换条要跟它们
// **同源**（同一处纯核），否则会出现「条上写强势、弹卡写弱势」这种同屏打架（R20b 宽度那格
// 已经栽过一次同样的跟头）。页面只准调这个核，不许自己另算一套。
//
// 命名纪律（用户 2026-09-30 提议「牛市/震荡/熊市」，任务书 E6 采纳后改名）：
// 只用「强势 / 震荡 / 弱势」三个词——判的是**最近几周的方向**，不是月线级别的大行情。
// 写「牛市」用户会理解成大行情来了，那是系统性误导，所以全仓库 UI 禁用这两字（有钉测）。
//
// 文案纪律（第 0 节硬约束）：本文件产出的每一句界面文案都不许出现
// MA20 / 均线 / IC / 截面 / 样本外 / 样本内 / 超额 / 置信区间 / 牛市 / 熊市。

import { REGIMES, regimeSeriesOf, ma20Of, type Regime } from "./regime-core.ts";

/** URL / 接口参数只有四个合法值：auto 或三档之一 */
export type RegimeMode = "auto" | Regime;

export interface RegimeBar {
  date: string;
  close: number;
}

/** 今天（或回放日）的档位读数。算不出的字段一律 null，不猜、不用 0 占位 */
export interface RegimeSnapshot {
  regime: Regime | null;
  /** 判档所用交易日 */
  asOf: string | null;
  close: number | null;
  /** 「最近一个月的平均价」（界面文案口径；接口字段名沿用 ma20 便于对账） */
  ma20: number | null;
  /** 本档从哪天开始（连续同一档的第一天） */
  sinceDate: string | null;
  /** 本档已持续多少个交易日 */
  daysInRegime: number | null;
  /** 算不出时的原因（人话，直接上屏） */
  error: string;
}

/**
 * 由日K序列算档位读数。
 * 纪律：档位序列来自 regime-core（唯一判法），这里只补「起始日/持续天数」两个派生量。
 */
export function regimeSnapshotOf(bars: RegimeBar[]): RegimeSnapshot {
  const empty: RegimeSnapshot = {
    regime: null, asOf: null, close: null, ma20: null, sinceDate: null, daysInRegime: null, error: "",
  };
  if (!bars.length) return { ...empty, error: "上证日K一条都没读到，档位算不出" };
  const closes = bars.map((b) => b.close);
  const series = regimeSeriesOf(closes);
  const i = series.length - 1;
  const regime = series[i];
  if (regime == null) return { ...empty, error: `上证日K不足 20 根（只有 ${bars.length} 根），档位算不出` };
  const ma = ma20Of(closes)[i];
  // 往回数连续同一档的天数：中间断档（null）就停，不跨过「算不出来」的那天继续数
  let days = 0;
  let since: string | null = null;
  for (let j = i; j >= 0; j--) {
    if (series[j] !== regime) break;
    days++;
    since = bars[j].date;
  }
  return {
    regime,
    asOf: bars[i].date,
    close: closes[i],
    ma20: ma,
    sinceDate: since,
    daysInRegime: days,
    error: "",
  };
}

/**
 * 解析 ?regime= 参数。空 / auto = 自动跟随今天；三档原词合法；其余返回 null（调用方回 400）。
 * 不做模糊匹配（"强"不算强势）：口径边界模糊了，分享出去的链接就会指向不同的东西。
 */
export function parseRegimeParam(raw: string | null | undefined): RegimeMode | null {
  const v = (raw ?? "").trim();
  if (!v || v === "auto") return "auto";
  let decoded = v;
  try { decoded = decodeURIComponent(v); } catch { /* 不是合法转义就按原串比 */ }
  return (REGIMES as string[]).includes(decoded) ? (decoded as Regime) : null;
}

/** 手动切到「非当天实判档」= 研究模式（回看），必须出提示条 */
export function isResearchMode(picked: RegimeMode, today: Regime | null): boolean {
  return picked !== "auto" && today != null && picked !== today;
}

/** 研究模式提示条文案；非研究模式返回 null（不为了显得严谨而乱弹提示） */
export function researchBannerOf(picked: RegimeMode, today: Regime | null, todayError = ""): string | null {
  if (picked === "auto") return null;
  if (!today) {
    return `你正在查看【${picked}档】的历史成绩 —— 今天大盘档位没算出来${todayError ? `（${todayError}）` : ""}，下面的数字是回看，不是今天的建议`;
  }
  if (today === picked) return null;
  return `你正在查看【${picked}档】的历史成绩 —— 今天大盘实判【${today}档】，下面的数字是回看，不是今天的建议`;
}

/* ---------------- 弹层文案（数字全部来自 data/regime-reversal.json，不在这里硬编码） ---------------- */

/** 单档事实：涨最猛 / 跌最狠两批票，往后 5 天各自怎么样 */
export interface RegimeReversalFact {
  /** 该档看了多少天 */
  days: number;
  /** 之前涨得最猛的一批，往后 5 天平均涨跌 % */
  hot: number;
  /** 之前跌得最狠的一批，往后 5 天平均涨跌 % */
  cold: number;
  /** cold − hot：两批的差距（正=跌狠的那批之后更强） */
  spread: number;
  /** cold − 市场平均：比随便买一只能多赚多少 % */
  excess: number;
  /** 市场平均（这批票往后 5 天的平均涨跌 %） */
  mkt: number;
}

export interface RegimeReversalFile {
  builtAt: string;
  source: string;
  window: { from: string; to: string; bars: number; universe: number; horizon: number; lookback: number; days: number; skipped?: number };
  byRegime: Partial<Record<Regime, RegimeReversalFact>>;
  note: string;
}

export const fmtPct2 = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

/** 判法一句话（不许出现「MA20/均线」） */
export const REGIME_METHOD_LINE =
  "大盘现在的位置：比最近一个月的平均价高、而且还在往上走 = 强势；比平均价低、而且还在往下走 = 弱势；其余情况算震荡。";

/**
 * 某一档的一句话。**结论跟着数字走**：哪批之后更强由 spread 的符号定，
 * 不写死「弱势抄跌一定赚」——实测扩样本后强势档反而是追涨更强（spread 为负），
 * 写死就等于把运气说成规律。
 */
export function regimeLineOf(regime: Regime, f: RegimeReversalFact | null, horizon = 5): string {
  if (!f) return `${regime}：这一档还没攒够天数，看不出规律。`;
  const head = `${regime}（看了 ${f.days} 天）：之前涨得最猛的一批票，接下来 ${horizon} 天平均 ${fmtPct2(f.hot)}；之前跌得最狠的一批，平均 ${fmtPct2(f.cold)}`;
  // 「少 +0.19%」这种带两个符号的写法读不通：少后面只跟幅度，不带正负号
  const vs = f.excess >= 0 ? `比市场平均多赚 ${fmtPct2(f.excess)}` : `比市场平均少 ${Math.abs(f.excess).toFixed(2)}%`;
  const tail = f.spread > 0.3
    ? "跌得狠的那批之后回得更多一点，抄跌略微占优"
    : f.spread < -0.3
      ? "涨得猛的那批之后还在涨，这时候抄跌反而吃亏"
      : "两批之后差不多，这个档位里追高抄跌基本没区别";
  return `${head}（${vs}）——${tail}。`;
}

/**
 * 样本警示。三条都是这次实测出来的「别当真」的理由，缺一条就是把统计当承诺：
 *  ① 档位是拿同一段历史挑出来的（换一段时间顺序可能变）；
 *  ② 早先只看 43 天时这个差别显得很大，扩到几百天后只剩不到 1 个点；
 *  ③ 看的是最近几周的方向，不是大行情来了/走了，也不能预测明天。
 */
export function regimeCaveatLinesOf(file: RegimeReversalFile | null): string[] {
  if (!file) return ["这组数字还没跑出来（先跑 scripts/build-regime-reversal.ts）。"];
  const w = file.window;
  const out = [
    `以上都来自 ${w.from} 到 ${w.to} 这 ${w.bars} 天里的 ${w.days} 个交易日；而且这些档位是拿同一段历史挑出来的，换另一段时间去看，顺序可能变。`,
    `早先只看 43 天的时候，两批票的差别显得有 2~3 个百分点；样本扩到 ${w.days} 天后只剩不到 1 个点——别把它当成稳赚的规律。`,
    "这个判断看的是最近几周的方向，不代表大行情来了或走了，也不能预测明天。",
    `数字只按成交额最高的 ${w.universe} 只票算（真买得进的那批）；换成成交额最小的一批，差别会变大，但那批票更容易买不到、买卖也更贵。`,
  ];
  return out;
}

/** 弹层全文：判法 + 三档各一句 + 样本警示（第 0 节：全人话，无术语） */
export function regimeExplainLinesOf(file: RegimeReversalFile | null): string[] {
  const horizon = file?.window?.horizon ?? 5;
  return [
    REGIME_METHOD_LINE,
    ...REGIMES.map((r) => regimeLineOf(r, file?.byRegime?.[r] ?? null, horizon)),
    ...regimeCaveatLinesOf(file),
  ];
}

/** 徽章副标：今天什么档、从哪天开始、持续几天（算不出就如实说） */
export function regimeBadgeTextOf(s: RegimeSnapshot): string {
  if (!s.regime) return s.error || "今天大盘档位没算出来";
  if (s.sinceDate && s.daysInRegime != null) return `今天大盘：${s.regime}（从 ${s.sinceDate} 起，已 ${s.daysInRegime} 个交易日）`;
  return `今天大盘：${s.regime}`;
}
