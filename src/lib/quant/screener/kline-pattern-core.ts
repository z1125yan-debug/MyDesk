// K线形态识别（纯函数，无 IO）——「产业链研报」与「量化选股」结果表共用的展示列口径。
//
// 为什么单独抽出来：形态判定原先内联在 run.ts 的行装配里，只有 6 种（涨停板/十字星/大阳小阳/大阴小阴/长上影/长下影），
// 而稳智 screener 的「K线形态」列会出现「反转向上 / 看涨吞没 / 贯穿线 / 连续上涨」等组合标签。
// 抽成纯函数后：① 可单测；② run.ts 与其它调用方共用同一份口径，不会各写一份导致不一致。
//
// 口径纪律：只由真实日K序列确定性计算，不做预测、不引入外部数据。
// 标签之间用「|」连接，顺序固定（先单K形态，再组合形态，最后连续性），保证同样输入永远同样输出。

export interface KlineBar {
  o: number; h: number; l: number; c: number;
  v?: number;
}

/** 单根K线的实体/振幅/影线度量 */
interface BarShape {
  body: number;       // 实体绝对值
  range: number;      // 振幅
  upper: number;      // 上影
  lower: number;      // 下影
  bull: boolean;      // 收阳
  bodyRatio: number;  // 实体占振幅比
}

function shape(b: KlineBar): BarShape {
  const body = Math.abs(b.c - b.o);
  const range = Math.max(b.h - b.l, 1e-9);
  const upper = b.h - Math.max(b.o, b.c);
  const lower = Math.min(b.o, b.c) - b.l;
  return { body, range, upper, lower, bull: b.c > b.o, bodyRatio: body / range };
}

/**
 * 识别形态标签。返回形如 ["涨停板", "看涨吞没"] 的数组（可能为空）。
 *
 * @param bars   日K序列（时间升序，最后一根是当日）
 * @param opts.limitRatio 该股涨停幅度（0.1 / 0.2 / 0.3 / ST 0.05），用于判涨停
 * @param opts.maxLabels  最多返回几个标签（默认 3，避免列里堆一大串）
 */
export function detectKlinePatterns(
  bars: KlineBar[],
  opts: { limitRatio?: number; maxLabels?: number } = {},
): string[] {
  const maxLabels = opts.maxLabels ?? 3;
  if (!bars || bars.length < 2) return [];
  const b1 = bars[bars.length - 1];
  const b0 = bars[bars.length - 2];
  const lr = opts.limitRatio ?? 0.1;

  const s1 = shape(b1), s0 = shape(b0);
  const parts: string[] = [];

  // ── 1) 涨停板（最高优先级：涨停当日的其他影线形态意义不大） ──
  const zt = b1.c >= +(b0.c * (1 + lr)).toFixed(2) - 1e-9;
  if (zt) {
    parts.push("涨停板");
  } else {
    // ── 2) 单K形态 ──
    if (s1.bodyRatio < 0.12) parts.push("十字星");
    else if (s1.bull) parts.push(s1.bodyRatio > 0.6 ? "大阳线" : "小阳线");
    else parts.push(s1.bodyRatio > 0.6 ? "大阴线" : "小阴线");

    // ── 3) 影线（涨停日不叠，避免标签过载） ──
    if (s1.upper / s1.range > 0.5) parts.push("长上影");
    if (s1.lower / s1.range > 0.5) parts.push("长下影");
  }

  // ── 4) 两根组合形态（吞没 / 贯穿线 / 乌云盖顶） ──
  // 看涨吞没：今收阳，且今实体完全包住昨实体（昨为阴）
  const bullEngulf = s1.bull && !s0.bull && b1.c >= b0.o && b1.o <= b0.c && s1.body >= s0.body;
  // 看跌吞没：镜像
  const bearEngulf = !s1.bull && s0.bull && b1.c <= b0.o && b1.o >= b0.c && s1.body >= s0.body;
  // 贯穿线（刺透）：昨阴今阳，今开低于昨收，今收超过昨实体中点但未完全吞没
  const piercing = !s0.bull && s1.bull && b1.o < b0.c && b1.c > (b0.o + b0.c) / 2 && b1.c < b0.o;
  // 乌云盖顶：镜像
  const darkCloud = s0.bull && !s1.bull && b1.o > b0.c && b1.c < (b0.o + b0.c) / 2 && b1.c > b0.o;
  if (bullEngulf) parts.push("看涨吞没");
  else if (bearEngulf) parts.push("看跌吞没");
  else if (piercing) parts.push("贯穿线");
  else if (darkCloud) parts.push("乌云盖顶");

  // ── 5) 趋势反转（反转向上 / 反转向下）：昨日阴、今日阳且收复昨日实体 ──
  // 与「吞没」区分：反转向上只要求方向翻转 + 收复昨收，不要求实体完全包住。
  const reversalUp = !s0.bull && s1.bull && b1.c > b0.o && !bullEngulf && !piercing;
  const reversalDown = s0.bull && !s1.bull && b1.c < b0.o && !bearEngulf && !darkCloud;
  if (reversalUp) parts.push("反转向上");
  else if (reversalDown) parts.push("反转向下");

  // ── 6) 连续性（连续上涨 / 连续下跌）：从最后一根往前数同向连续天数 ──
  // 口径：收阳且收盘价高于前一日收盘价算「涨」；连续 ≥3 天（含当日）才标注。
  let upStreak = 0, downStreak = 0;
  for (let i = bars.length - 1; i >= 1; i--) {
    if (bars[i].c > bars[i - 1].c) { if (downStreak > 0) break; upStreak++; }
    else if (bars[i].c < bars[i - 1].c) { if (upStreak > 0) break; downStreak++; }
    else break;
  }
  if (upStreak >= 3) parts.push("连续上涨");
  else if (downStreak >= 3) parts.push("连续下跌");

  // 去重（同一标签不重复）并截断
  const uniq = [...new Set(parts)];
  return uniq.slice(0, maxLabels);
}

/** 形态标签数组 → 展示串（稳智同款用「|」连接） */
export function formatKlinePatterns(parts: string[]): string | null {
  return parts.length ? parts.join("|") : null;
}

/** 趋势压力线_N：最近 N 根的最高价（确定性口径，非预估） */
export function trendPressure(bars: KlineBar[], n = 60): number | null {
  if (!bars?.length) return null;
  const win = bars.slice(-n);
  if (!win.length) return null;
  return +Math.max(...win.map((b) => b.h)).toFixed(2);
}
