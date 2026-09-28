// 节假日日历效应（真实统计，非预测、非编造）。
//
// 为什么有这个文件：研判骨架的「日历效应」节之前只能写「本仓暂无该统计」——
// 因为项目没有历史统计源，模型一度自行编造百分比（如「过去5年平均跌1.2%」）。
// 现用 akshare 上证指数日线（2016-2025）按机构同口径独立复算，落盘到
// data/calendar-effect-national-day.json（生成脚本 scripts/quant/calendar-effect-national-day.py）。
//
// 数据溯源与口径说明（务必如实呈现，不得冒充机构原话）：
// - 稳智/券商常见的「国庆前一周下跌概率 87.5%、平均跌 1.1%」出自**中信建投证券**研报
//   （2026-09-28 东方财富文引用），是机构按「2016年以来剔除2018/2024两个大波动年」口径算的二手统计。
// - 本仓独立复算（同「节前最后交易日及往前4交易日 / 节后首个交易日及往后4交易日」口径）
//   得到的是 75.0% / -0.88%（前）、75.0% / +1.45%（后）——方向一致（节前偏弱、节后偏强），
//   但精确概率对口径敏感，因此一律报本仓复算值 + 标注算法，不照抄机构数字。
//
// 读不到 JSON 时返回 null（绝不编一个统计出来）。

import fs from "node:fs";
import path from "node:path";

interface PerYear {
  year: number;
  last_pre: string;
  resume: string;
  pre5_start: string;
  post5_end: string;
  pre_return: number;
  post_return: number;
  excluded: boolean;
}
interface Summary {
  n: number;
  pre_down_prob: number;
  pre_avg_return: number;
  post_up_prob: number;
  post_avg_return: number;
}
interface EffectJson {
  source: string;
  method: string;
  exclude_years: number[];
  citic_reference: { pre_down_prob: number; pre_avg_return: number; post_up_prob: number; post_avg_return: number };
  per_year: PerYear[];
  summary_full: Summary;
  summary_trimmed: Summary;
}

let cache: EffectJson | null | undefined;

function load(): EffectJson | null {
  if (cache !== undefined) return cache;
  try {
    const p = path.resolve(process.cwd(), "data", "calendar-effect-national-day.json");
    cache = JSON.parse(fs.readFileSync(p, "utf8")) as EffectJson;
  } catch {
    cache = null; // 读不到就 null：所有查询返回 null，绝不猜一个统计
  }
  return cache;
}

export interface HolidayEffect {
  holiday: string;
  method: string;
  source: string;
  excludeYears: number[];
  /** 本仓复算（剔除大波动年），用于正文引用 */
  trimmed: Summary;
  /** 全样本，用于对照 */
  full: Summary;
  /** 中信建投研报公开口径（仅作机构对照，不冒充本仓结论） */
  citicReference: EffectJson["citic_reference"];
  perYear: PerYear[];
}

const NATIONAL_DAY: HolidayEffect = (() => {
  const j = load();
  if (!j) return null as unknown as HolidayEffect; // 调用方用 getNationalDayEffect() 拿，NULL 安全
  return {
    holiday: "国庆",
    method: j.method,
    source: j.source,
    excludeYears: j.exclude_years,
    trimmed: j.summary_trimmed,
    full: j.summary_full,
    citicReference: j.citic_reference,
    perYear: j.per_year,
  };
})();

/** 国庆日历效应（真实复算）；数据缺失返回 null。 */
export function getNationalDayEffect(): HolidayEffect | null {
  return load() ? NATIONAL_DAY : null;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** 给 AI 用的纯文本摘要（已含「非预测」与算法标注）。 */
export function formatNationalDayEffect(): string | null {
  const e = getNationalDayEffect();
  if (!e) return null;
  const t = e.trimmed;
  const lines = [
    "【国庆日历效应·本仓复算（历史统计，非预测）】",
    `数据：${e.source}；样本 2016-2025，剔除大波动年 ${e.excludeYears.join("/")}（共 ${t.n} 年）。`,
    `算法：${e.method}。`,
    `节前一周（节前最后交易日及往前4交易日）：下跌概率 ${pct(t.pre_down_prob)}，平均涨跌 ${pct(t.pre_avg_return)}。`,
    `节后一周（节后首个交易日及往后4交易日）：上涨概率 ${pct(t.post_up_prob)}，平均涨跌 ${pct(t.post_avg_return)}。`,
    `对照（中信建投研报公开口径，仅供参考，非本仓结论）：前一周下跌概率 87.5%/平均-1.1%，后一周上涨概率 62.5%/平均+1.3%。`,
    `逐年：`,
  ];
  for (const y of e.perYear) {
    const tag = y.excluded ? "（剔除）" : "";
    lines.push(
      `  ${y.year}${tag} 节前${y.last_pre} 前周${pct(y.pre_return)} / 节后${y.resume} 后周${pct(y.post_return)}`
    );
  }
  return lines.join("\n");
}
