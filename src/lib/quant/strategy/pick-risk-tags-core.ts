// AI 优选「风险观察标签」纯核（无 IO / 无 fetch / 无时钟，可单测）。
//
// 背景（2026-10-21 用户批准）：10-15 批舒华体育决策日放量冲高回落（高 13.68 → 收 12.98）、
// 大户在卖散户在接盘、次日（买入日）正好是业绩说明会（利好兑现），最后净亏 -10.57%。
// 这三类形态当时全在数据里，但没有任何一处被系统性标出来。标签的目的只是「标注 + 攒样本」：
//   - 只出现在台账 note 的【风险观察标签】段、版本文件的 riskTags、观察台账 jsonl 里；
//   - 绝不拦截、绝不降权、绝不改选股 / 硬过滤 / 落库语义（样本攒够之前不动规则，用户定的纪律）。
//
// 三类标签：
// A「放量冲高回落」：决策日日 K —— 回落 (high-close)/close ≥ 4%、上影占比 (high-close)/(high-low)
//    ≥ 35%、量比（当日量 / 前 5 交易日均量）≥ 2，三条同时成立才算。high == low 不判。
// B「大户派发·散户接盘」：大户（中单）净卖 ≥ 0.05 亿 且 散户（小单）净买 ≥ 0.05 亿。
//    阈值对齐第 5 种分歧模块的 SIG 口径（0.05 亿才认方向，防噪音）。资金为 null（历史日
//    THS 取不到）→ 不触发、不记命中，绝不拿 0 冒充。
//    ⚠️ 量级门槛（2026-10-24 用户批准先行修正，不等评审）：符号达线只是「疑似」，
//    还须量级达标才算确认命中——大户净卖绝对值 ≥ 0.1 亿 且 占当日成交额 ≥ 3%。
//    起因：10-21 批新华百货大户净卖恰好 0.05 亿（压线）、占成交 2.32 亿仅 2.2%，被盖
//    不合格，结果 +11.43% 全批最好——擦线误伤；真阳性种子舒华体育是 0.20 亿 / 4.5%。
//    量级不足 → 只记 suspected 备忘（进 hits、不进 tags），与 C 的疑似同级处理。
// C「催化落在买入日」：决策日前 20 日内有事件型公告（说明会 / 股东大会 / 集体接待日 /
//    投资者关系活动等），且能从公告标题提取出明确日期、恰好等于买入日（决策日后第 1 个
//    交易日）→ confirmed；有事件型公告但日期提不出 / 对不上 → suspected（如实记“日期
//    未核实”，不算确认命中）；无事件型公告 → none；公告没拉到 → unknown。不解析 PDF 正文。

export const RISK_TAG_VOLUME_FADE = "放量冲高回落";
export const RISK_TAG_RETAIL_CATCH = "大户派发·散户接盘";
export const RISK_TAG_CATALYST_ON_BUYDAY = "催化落在买入日";
// D「薄流动性」（2026-10-23 用户拍板：先标注不拦，攒到 20 天评审一起定）：决策日成交额
// < 1 亿。起因：10-21 批鸥玛软件决策日成交额仅 0.51 亿、平时约 0.3 亿，买入日开盘即全天
// 最高、单边阴跌——薄盘子没承接。自有 33 只样本里 <1 亿仅 2 只（另一只安徽合力还赢了），
// 此标签是实盘卫生标注（滑点/承接），不是战绩信号，不许拿它当拦截理由用（评审前）。
// 盖章定位（2026-10-24 用户定）：D 命中 = 「注意」章（见 riskStampOf），不升「不合格」——
// 全样本 n=2、无区分度证据，只配注意级。
export const RISK_TAG_THIN_LIQUIDITY = "薄流动性";
/** D 阈值（亿）：决策日成交额低于此数 → 薄流动性 */
export const THIN_AMOUNT_MAX_YI = 1;

/** A 阈值：回落 %、上影占比（0~1）、量比 */
export const FADE_PULLBACK_MIN_PCT = 4;
export const FADE_SHADOW_MIN_SHARE = 0.35;
export const FADE_VOL_RATIO_MIN = 2;
/** B 阈值（亿；与分歧模块 SIG_YI 同口径） */
export const DISTRIBUTION_MIN_YI = 0.05;
/** B 确认命中的量级门槛（2026-10-24）：大户净卖绝对值下限（亿） */
export const DISTRIBUTION_HARD_MIN_YI = 0.1;
/** B 确认命中的量级门槛：大户净卖占当日成交额下限（%） */
export const DISTRIBUTION_HARD_MIN_SHARE_PCT = 3;

export interface RiskTagBar {
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
}

export interface RiskTagAnn {
  /** 公告标题（逐字） */
  title: string;
  /** 公告日期 "YYYY-MM-DD" */
  date: string;
}

export interface RiskTagInput {
  symbol: string;
  name?: string;
  /** 决策日当日日 K（缺任一关键字段 → A 不判） */
  bar?: RiskTagBar | null;
  /** 决策日之前 5 个交易日的成交量（股）；不足 5 个按实际个数算均量，0 个 → 量比算不出 */
  prevVolumes?: readonly (number | null)[] | null;
  /** 大户买卖差（亿，THS 中单；null = 没取到） */
  midNetYi?: number | null;
  /** 散户买卖差（亿，THS 小单；null = 没取到） */
  smallNetYi?: number | null;
  /** 决策日前 20 日内该股巨潮公告；null = 没拉到（抓取失败），[] = 拉到了但一条都没有 */
  catalystAnns?: readonly RiskTagAnn[] | null;
  /** 买入日 = 决策日之后第 1 个交易日（"YYYY-MM-DD"；日历取不到为 null） */
  nextTradeDate?: string | null;
  /** 决策日成交额（亿；null = 没取到 → D 不判，绝不拿 0 冒充） */
  amountYi?: number | null;
}

export type CatalystStatus = "confirmed" | "suspected" | "none" | "unknown";

export interface RiskTagHit {
  /** 标签名（C 的 suspected 也记这个名，靠 status 区分，不冒充确认） */
  tag: string;
  /** "suspected" = 疑似/备忘（C 是日期未核实；B 是量级不足）；不填 = 确认命中 */
  status?: "suspected";
  // A 证据
  pullbackPct?: number;
  shadowShare?: number;
  volRatio?: number;
  // B 证据
  midNetYi?: number;
  smallNetYi?: number;
  /** B 证据：大户净卖占当日成交额 %（成交额没取到则不填） */
  midSharePct?: number;
  // D 证据
  amountYi?: number;
  // C 证据
  eventDate?: string | null;
  annTitle?: string;
  annDate?: string;
  /** note 里的一句话证据 */
  line: string;
}

export interface RiskTagResult {
  symbol: string;
  name: string;
  /** 确认命中的标签名（C 只有 confirmed 才进这里；suspected 只进 hits + plain） */
  tags: string[];
  hits: RiskTagHit[];
  catalystStatus: CatalystStatus;
  /** A 的三个证据值（算不出为 null，不编） */
  fadeMetrics: { pullbackPct: number | null; shadowShare: number | null; volRatio: number | null };
  /** note 用的一句话（无任何命中 / 疑似时为 ""） */
  plain: string;
}

function fin(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 事件型公告标题（说明会 / 股东大会 / 集体接待日 / 投资者关系活动 / 业绩发布会）。
 * 标题写明“取消”的不算（事件已不存在）；“延期”的仍算事件，日期靠提取尽力而为。 */
export function isEventAnnouncementTitle(title: string): boolean {
  const t = String(title ?? "");
  if (!t || /取消/.test(t)) return false;
  return /说明会|股东大会|股东会|集体接待日|投资者关系活动|业绩发布会/.test(t);
}

/**
 * 从公告标题提取事件日期 → "YYYY-MM-DD"；提不出返回 null。
 * 支持 "2026年10月16日" 与 "10月16日"（年份取公告日期的年份；若拼出的日期早于公告日，
 * 说明是跨年事件，顺延一年）。只认标题，不读正文。
 */
export function extractEventDate(title: string, annDate: string): string | null {
  const t = String(title ?? "");
  const pad = (n: number) => String(n).padStart(2, "0");
  const full = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(t) ?? /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(t);
  if (full) return `${full[1]}-${pad(Number(full[2]))}-${pad(Number(full[3]))}`;
  const short = /(\d{1,2})月(\d{1,2})日/.exec(t);
  if (!short) return null;
  const refYear = Number(String(annDate ?? "").slice(0, 4));
  if (!Number.isFinite(refYear) || refYear <= 0) return null;
  let y = refYear;
  let out = `${y}-${pad(Number(short[1]))}-${pad(Number(short[2]))}`;
  if (out < annDate) {
    y += 1;
    out = `${y}-${pad(Number(short[1]))}-${pad(Number(short[2]))}`;
  }
  return out;
}

export function judgeRiskTags(inp: RiskTagInput): RiskTagResult {
  const name = inp.name || inp.symbol;
  const hits: RiskTagHit[] = [];
  const tags: string[] = [];

  // ---------- A：放量冲高回落 ----------
  let pullbackPct: number | null = null;
  let shadowShare: number | null = null;
  let volRatio: number | null = null;
  const bar = inp.bar ?? null;
  if (bar && fin(bar.high) && fin(bar.low) && fin(bar.close) && bar.close > 0 && bar.high > bar.low) {
    pullbackPct = ((bar.high - bar.close) / bar.close) * 100;
    shadowShare = (bar.high - bar.close) / (bar.high - bar.low);
    const prevs = (inp.prevVolumes ?? []).filter((v): v is number => fin(v) && v > 0);
    if (fin(bar.volume) && bar.volume > 0 && prevs.length) {
      const avg = prevs.reduce((a, b) => a + b, 0) / prevs.length;
      if (avg > 0) volRatio = bar.volume / avg;
    }
  }
  if (
    pullbackPct != null && pullbackPct >= FADE_PULLBACK_MIN_PCT &&
    shadowShare != null && shadowShare >= FADE_SHADOW_MIN_SHARE &&
    volRatio != null && volRatio >= FADE_VOL_RATIO_MIN
  ) {
    tags.push(RISK_TAG_VOLUME_FADE);
    hits.push({
      tag: RISK_TAG_VOLUME_FADE,
      pullbackPct: round2(pullbackPct),
      shadowShare: round2(shadowShare),
      volRatio: round2(volRatio),
      line: `${RISK_TAG_VOLUME_FADE}（回落 ${pullbackPct.toFixed(2)}%、上影 ${(shadowShare * 100).toFixed(1)}%、量比 ${volRatio.toFixed(2)} 倍）`,
    });
  }

  // ---------- B：大户派发·散户接盘（符号达线 + 量级达标才算确认，2026-10-24 量级门槛） ----------
  const mid = inp.midNetYi ?? null;
  const small = inp.smallNetYi ?? null;
  if (fin(mid) && fin(small) && mid <= -DISTRIBUTION_MIN_YI && small >= DISTRIBUTION_MIN_YI) {
    const amtYi = inp.amountYi ?? null;
    const sharePct = fin(amtYi) && amtYi > 0 ? (Math.abs(mid) / amtYi) * 100 : null;
    const magnitudeOk = Math.abs(mid) >= DISTRIBUTION_HARD_MIN_YI
      && sharePct != null && sharePct >= DISTRIBUTION_HARD_MIN_SHARE_PCT;
    if (magnitudeOk) {
      tags.push(RISK_TAG_RETAIL_CATCH);
      hits.push({
        tag: RISK_TAG_RETAIL_CATCH,
        midNetYi: round2(mid),
        smallNetYi: round2(small),
        midSharePct: round2(sharePct as number),
        line: `${RISK_TAG_RETAIL_CATCH}（大户卖 ${Math.abs(mid).toFixed(2)} 亿、占成交 ${(sharePct as number).toFixed(1)}%，散户买 ${small.toFixed(2)} 亿）`,
      });
    } else {
      // 量级不足：只记疑似备忘，不进 tags、不算确认命中（新华百货擦线误伤的教训）
      hits.push({
        tag: RISK_TAG_RETAIL_CATCH,
        status: "suspected",
        midNetYi: round2(mid),
        smallNetYi: round2(small),
        ...(sharePct != null ? { midSharePct: round2(sharePct) } : {}),
        line: `疑似${RISK_TAG_RETAIL_CATCH}（量级不足·备忘：大户卖 ${Math.abs(mid).toFixed(2)} 亿${sharePct != null ? `、占成交 ${sharePct.toFixed(1)}%` : "、成交额未取到量级未核"}，散户买 ${small.toFixed(2)} 亿）`,
      });
    }
  }

  // ---------- C：催化落在买入日 ----------
  let catalystStatus: CatalystStatus = "unknown";
  if (inp.catalystAnns != null) {
    const eventAnns = inp.catalystAnns.filter((a) => isEventAnnouncementTitle(a.title));
    if (!eventAnns.length) {
      catalystStatus = "none";
    } else {
      let confirmed: RiskTagHit | null = null;
      let firstSuspect: RiskTagHit | null = null;
      for (const a of eventAnns) {
        const eventDate = extractEventDate(a.title, a.date);
        if (eventDate != null && inp.nextTradeDate != null && eventDate === inp.nextTradeDate) {
          confirmed = {
            tag: RISK_TAG_CATALYST_ON_BUYDAY,
            eventDate,
            annTitle: a.title,
            annDate: a.date,
            line: `${RISK_TAG_CATALYST_ON_BUYDAY}（${eventDate} 有事件型公告《${a.title}》，标题日期与买入日一致）`,
          };
          break;
        }
        if (!firstSuspect) {
          firstSuspect = {
            tag: RISK_TAG_CATALYST_ON_BUYDAY,
            status: "suspected",
            eventDate,
            annTitle: a.title,
            annDate: a.date,
            line: `疑似${RISK_TAG_CATALYST_ON_BUYDAY}（有事件型公告《${a.title}》，日期未核实）`,
          };
        }
      }
      if (confirmed) {
        catalystStatus = "confirmed";
        tags.push(RISK_TAG_CATALYST_ON_BUYDAY);
        hits.push(confirmed);
      } else {
        catalystStatus = "suspected";
        if (firstSuspect) hits.push(firstSuspect);
      }
    }
  }

  // ---------- D：薄流动性（决策日成交额 < 1 亿；没取到不判） ----------
  const amountYi = inp.amountYi ?? null;
  if (fin(amountYi) && amountYi < THIN_AMOUNT_MAX_YI) {
    tags.push(RISK_TAG_THIN_LIQUIDITY);
    hits.push({
      tag: RISK_TAG_THIN_LIQUIDITY,
      amountYi: round2(amountYi),
      line: `${RISK_TAG_THIN_LIQUIDITY}（决策日成交额 ${amountYi.toFixed(2)} 亿 < ${THIN_AMOUNT_MAX_YI} 亿）`,
    });
  }

  const plain = hits.length
    ? `${inp.symbol} ${name}：${hits.map((h) => h.line).join("；")}`
    : "";
  return {
    symbol: inp.symbol,
    name,
    tags,
    hits,
    catalystStatus,
    fadeMetrics: {
      pullbackPct: pullbackPct == null ? null : round2(pullbackPct),
      shadowShare: shadowShare == null ? null : round2(shadowShare),
      volRatio: volRatio == null ? null : round2(volRatio),
    },
    plain,
  };
}

/** 排雷章（2026-10-23 定版 + 2026-10-24 两处修正后口径，正式版与回溯共用这一份定义）：
 * - 「不合格」：温度 ≥2 项热；或确认命中 A / B / C 任一（实测硬伤）。
 * - 「注意」：温度 1 项热；或 D 薄流动性命中（2026-10-24 用户定）；或位置红格（胜率 <48%）。
 * - 只记备忘、不扣章：疑似级命中（C 疑似、B 量级不足）、位置灰格（48~52%）与贴线格。
 * 章只标注不拦截（评审前纪律不变）；多个「注意」不叠加升「不合格」。 */
export type RiskStamp = "合格" | "注意" | "不合格";

export function riskStampOf(inp: {
  /** 温度热项数 0..3（当日涨幅 / 20 日涨幅 / RSI 三读数里热的个数） */
  hot: number;
  /** judgeRiskTags 的判定结果 */
  result: RiskTagResult;
  /** 位置格（按当日档位查 790 天位置表）：green ≥52% / gray 48~52% / red <48% / null 未算 */
  position?: "green" | "gray" | "red" | null;
}): { stamp: RiskStamp; reasons: string[] } {
  const reasons: string[] = [];
  const hardTags = inp.result.tags.filter((t) => t !== RISK_TAG_THIN_LIQUIDITY);
  if (inp.hot >= 2) reasons.push(`温度 ${inp.hot} 项热（过热）`);
  for (const t of hardTags) reasons.push(`确认标签：${t}`);
  if (reasons.length) return { stamp: "不合格", reasons };
  if (inp.hot === 1) reasons.push("温度 1 项热");
  if (inp.result.tags.includes(RISK_TAG_THIN_LIQUIDITY)) reasons.push("薄流动性（成交额 <1 亿）");
  if (inp.position === "red") reasons.push("位置红格（历史胜率 <48%）");
  if (reasons.length) return { stamp: "注意", reasons };
  return { stamp: "合格", reasons };
}

/** note 末尾的【风险观察标签】段：逐只一句话，只写有命中（含疑似）的票；整批没命中写“本批无”。 */
export function buildRiskTagSection(results: readonly RiskTagResult[]): string {
  const hit = results.filter((r) => r.hits.length);
  if (!hit.length) return "【风险观察标签】本批无。";
  return `【风险观察标签】（只标注观察、攒样本，不影响选股）${hit.map((r) => r.plain).join(" ")}`;
}
