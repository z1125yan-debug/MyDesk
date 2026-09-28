// 市场环境推理（本地规则版）—— 复刻「稳智市场环境理由」的输入口径，用本地复盘种子的真实读数
// 模板化生成，不接 LLM、不猜数：每个数字都来自 review-stats / index-changes 种子行。
//
// 稳智理由的输入口径（从 theme-heat-seed.inference.reason 逆推）：
//   · 当日指数表现（上证/深成/创业板涨跌幅、日内形态）
//   · MA5 上方个股占比的连续 4 个交易日序列（看赚钱效应的斜率）
//   · 下跌家数 / 跌破 MA3 / 跌破 MA5 家数（当日宽度）
//   · 涨停 / 跌停家数、最高连板（含近期极值对照）
//   · （成交额稳智用了 3 日序列，本地种子没有这个字段——不编，理由里不写成交额）
// 覆盖范围：review-stats 种子 2026-04-20 ~ 2026-09-24（110 个交易日）。
// 请求日期落在覆盖内 → 用 ≤ 该日期的最近 4 行；覆盖外 → 返回 null，由页面如实说「无读数」。

import reviewSeed from "./review-stats-seed.json";
import indexSeed from "./index-changes-seed.json";

export interface MarketInference {
  as_of_date: string;
  confidence: number;
  market_bucket: string;
  market_phase: string;
  reason: string;
}

interface ReviewRow {
  date: string; limitUp: number; limitDown: number;
  t3: number; t4: number; t5: number; maxBoards: number;
  decliners: number; belowMa5: number; belowMa3: number;
  aboveMa5Pct: number | null;
}

const ROWS: ReviewRow[] = (reviewSeed as unknown as (string | number)[][]).map((r) => ({
  date: String(r[0]),
  limitUp: Number(r[1]), limitDown: Number(r[2]),
  t3: Number(r[3]), t4: Number(r[4]), t5: Number(r[5]), maxBoards: Number(r[6]),
  decliners: Number(r[7]), belowMa5: Number(r[8]), belowMa3: Number(r[9]),
  aboveMa5Pct: typeof r[10] === "number" ? (r[10] as number) : null,
}));

const IDX = indexSeed as unknown as { d: string; allA: number; sh: number; dividend: number; small: number; mid: number; sz: number; cyb: number }[];

/** ≤ date 的最近 n 行（种子按日期升序） */
function rowsUpTo(date: string, n: number): ReviewRow[] {
  const eligible = ROWS.filter((r) => r.date <= date);
  return eligible.slice(-n);
}

function idxOf(date: string) {
  return IDX.find((r) => r.d === date) ?? null;
}

/**
 * 阶段判定（透明规则，阈值写死在这里便于复核）：
 *   赚钱效应 = 最新 MA5 上方占比；斜率 = 4 日首尾差
 *   · 占比 ≥ 60 且斜率 ≥ 0        → 主升 / 强势
 *   · 占比 ≥ 40                    → 震荡（斜率 < -15 记「高位分歧」）
 *   · 占比 < 40 且斜率 < 0         → 退潮（最近 1 日跌幅收窄/占比回升记「退潮反抽」）
 *   · 占比 < 40 且斜率 ≥ 0         → 修复
 * 置信度 = 数据完整度（占比/指数/宽度三项齐不齐）× 信号一致度，封顶 0.85：
 * 规则版不把话说满，稳智 LLM 版给到 0.66 上下，本地规则不应比它更自信。
 */
export function inferMarketEnv(date: string): MarketInference | null {
  const win = rowsUpTo(date, 4);
  if (!win.length) return null;
  const last = win[win.length - 1];
  if (last.aboveMa5Pct === null) return null;

  const first = win[0];
  const slope = first.aboveMa5Pct !== null ? last.aboveMa5Pct - first.aboveMa5Pct : 0;
  const prev = win.length >= 2 ? win[win.length - 2] : null;
  const pct = last.aboveMa5Pct;

  let bucket: string; let phase: string;
  if (pct >= 60 && slope >= 0) { bucket = "主升"; phase = "强势上行"; }
  else if (pct >= 40) { bucket = "震荡"; phase = slope <= -15 ? "高位分歧" : "震荡整理"; }
  else if (slope < 0) {
    bucket = "退潮";
    phase = prev && last.aboveMa5Pct > (prev.aboveMa5Pct ?? 0) ? "退潮反抽" : "退潮下跌";
  } else { bucket = "修复"; phase = "低位修复"; }

  // 情绪极值佐证：涨停 < 30 且跌停 > 涨停 → 偏弱；最高板 ≤ 2 → 接力冰点
  const sentimentWeak = last.limitUp < 30 || last.limitDown > last.limitUp;
  const icePoint = last.maxBoards <= 2;

  // 置信度：数据齐 0.55 起；占比与斜率同向 +0.1；宽度（下跌家数>3000 或 <1500）与判定同向 +0.1；
  // 有指数涨跌佐证 +0.05；情绪极端读数 ±0.05。封顶 0.85，保两位小数。
  let conf = 0.55;
  if (Math.abs(slope) >= 10) conf += 0.1;
  const breadthAgrees =
    (bucket === "退潮" && last.decliners >= 3000) ||
    (bucket === "主升" && last.decliners <= 1500) ||
    bucket === "震荡" || bucket === "修复";
  if (breadthAgrees) conf += 0.1;
  const idx = idxOf(last.date);
  if (idx) conf += 0.05;
  if ((bucket === "退潮" && sentimentWeak) || icePoint) conf += 0.05;
  conf = Math.min(0.85, Math.round(conf * 100) / 100);

  // ---- 理由正文（稳智句式：指数 → 宽度序列 → 情绪读数 → 判定）----
  const parts: string[] = [];
  if (idx) {
    parts.push(
      `上证指数${last.date}${idx.sh >= 0 ? "收涨" : "收跌"}${Math.abs(idx.sh).toFixed(2)}%` +
      `，深证成指${idx.sz >= 0 ? "+" : ""}${idx.sz.toFixed(2)}%、创业板指${idx.cyb >= 0 ? "+" : ""}${idx.cyb.toFixed(2)}%` +
      (Math.abs(idx.cyb) > Math.abs(idx.sh) ? "，中小盘波动更大" : "") + "。"
    );
  } else {
    parts.push(`截至${last.date}的复盘数据（指数涨跌读数超出本地种子覆盖，本段从略）。`);
  }
  if (win.length >= 2) {
    const series = win.map((r) => `${r.date.slice(5)}的${r.aboveMa5Pct?.toFixed(2)}%`).join("、");
    parts.push(
      `MA5上方个股占比由${series}` +
      (slope <= -20 ? "，连续骤降、赚钱效应快速崩塌" : slope <= -5 ? "，持续回落" : slope >= 10 ? "，持续修复" : "，变化不大") +
      `；最新一日下跌家数${last.decliners}家、跌破MA3家数${last.belowMa3}家、跌破MA5家数${last.belowMa5}家。`
    );
  } else {
    parts.push(`最新一日MA5上方个股占比${pct.toFixed(2)}%，下跌家数${last.decliners}家。`);
  }
  // 最高连板对照近 20 个交易日极值（稳智句式里也有「由 X 板降至 Y 板」）
  const recent = rowsUpTo(date, 20);
  const peakBoards = recent.reduce((m, r) => Math.max(m, r.maxBoards), 0);
  parts.push(
    `涨停${last.limitUp}家、跌停${last.limitDown}家，最高连板${last.maxBoards}板` +
    (peakBoards > last.maxBoards ? `（近20个交易日峰值${peakBoards}板），题材接力高度回落` : "，为近期连板高度极值") +
    "。"
  );
  parts.push(`综合宽度与情绪读数，市场当前归为「${phase}」（${bucket}桶）。`);

  return { as_of_date: last.date, confidence: conf, market_bucket: bucket, market_phase: phase, reason: parts.join("") };
}
