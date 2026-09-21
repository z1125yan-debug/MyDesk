// P8-① 调用前数据新鲜度检查（纯内核：不 fetch、不 import 服务层、不碰时钟，node --test 可直跑）。
//
// 任务书 P8 第 3 条：「调用行情/决策接口前先检查数据新鲜度——K 线最新交易日是否断档；
// 缺数据直接告知用户，不基于过期数据出结论」。判定放这里才能被测试钉住；
// 取交易日历、跑结论卡这些真实动作留在服务层（scene-dispatch），本层只吃调用方传进来的读数。
//
// 三条口径（含用户对四个风险点的裁定）：
// 1) **unknown 不能误判为新鲜**：基准交易日取不到、最后一根取不到、最后一根比基准还晚（日历异常），
//    三种都落 unknown，并且照样要出提示行——「无法判新鲜度」本身就是要告知用户的事，
//    静默放行等于把「没查」说成「没过期」。
// 2) **复用既有 stale 口径**：结论卡那条「日K 日期 ≠ 决策参考日就要说出来」（decision-service 原来
//    是裸字符串比对）的判断搬到这里成 dateMismatch()，decision-service 改为调用本函数——
//    全工程只有一份「什么算没对上」的规则，不再造第二套。
// 3) **时区**：行情日期有两种形态——裸日期串（数据源自报的北京交易日，原样取日期段）与
//    带 Z/±hh:mm 偏移的 ISO 串（必须折算到东八区日历日再比，UTC 凌晨的数会被错当成前一天）。
//
// P8-② 的契约渲染/校验不在这里：按细则钉在 decision-core.ts（与 Decision 类型同文件），
// 本层只负责「新不新鲜」这一件事。

export type FreshState = "fresh" | "stale" | "unknown";

export interface BarFreshness {
  /** 哪一路读数（如「600519.SH 日K」），提示行与步骤都带它 */
  label: string;
  state: FreshState;
  /** 归一后的最后一根日期（北京日历日）；取不到就是 null */
  last_date: string | null;
  /** 基准：不晚于「今日」的最近真实交易日；查不到就是 null（→ unknown） */
  expected_date: string | null;
  /** 自然日差（expected − last），只有 stale 才算得出 */
  lag_days: number | null;
  /** unknown 时的直白原因（界面上要能说出「为什么没法判」） */
  reason: string | null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * 归一成北京日历日（YYYY-MM-DD）。
 * 裸日期串原样取日期段；带 Z 或 ±hh:mm 偏移的按绝对时刻折算到 UTC+8 再看是哪一天；
 * 带时间无偏移的按数据源自报的北京时间原样取日期段（eltdx 给的「2026-09-18 15:00」就是北京交易时间）。
 * 认不出的一律 null——判不了就 unknown，绝不猜。
 */
export function toShanghaiDay(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const [mo, d] = [Number(m[2]), Number(m[3])];
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  // 只有「时间部分后面真的带时区标记」（Z 或 ±hh:mm）才做折算；否则视为数据源自报的北京日期。
  // 带标记的串 Date.parse 会自己按标记折成绝对时刻，这里只需再抬 8 小时读「北京墙钟」：
  // getUTC* 在那一刻度下读到的就是东八区日历日（不能再手动减偏移，那是把偏移算两遍）。
  const tz = /(?:T|\s)\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(s);
  if (!tz) return `${m[1]}-${m[2]}-${m[3]}`;
  const ms = Date.parse(s.replace(" ", "T"));
  if (!Number.isFinite(ms)) return `${m[1]}-${m[2]}-${m[3]}`;
  const bj = new Date(ms + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`;
}

/** 自然日差（to − from），任一不可解析交 null。用 UTC 日序做差，与时区无关 */
export function calendarDayGap(from: unknown, to: unknown): number | null {
  const a = toShanghaiDay(from);
  const b = toShanghaiDay(to);
  if (!a || !b) return null;
  const days = (s: string) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86_400_000);
  return days(b) - days(a);
}

/**
 * 既有 stale 口径的唯一出处（风险点 2 的落点）：两个日期没对上就是没对上。
 * decision-service 原来在装配结论卡时写的是 `tech.bar_date !== tradeDate` 裸比对，
 * 现在改为调用这里——语义逐字等价（不同就是 true），只是规则从「两处各写一遍」收成一处。
 */
export function dateMismatch(a: string | null, b: string | null): boolean {
  const x = toShanghaiDay(a);
  const y = toShanghaiDay(b);
  if (!x || !y) return false;
  return x !== y;
}

/** 交易日历（来自 000001.SH 真实日K的日期，与 /api/quant/screener/trade-dates 同源同口径）里不晚于 today 的最近一个 */
export function latestNotAfter(tradeDates: (string | null | undefined)[], today: string): string | null {
  const ref = toShanghaiDay(today);
  if (!ref) return null;
  let best: string | null = null;
  for (const raw of tradeDates ?? []) {
    const d = toShanghaiDay(raw);
    if (!d) continue;
    if (d <= ref && (best === null || d > best)) best = d;
  }
  return best;
}

/** 判一路 K 线读数的新鲜度。基准取不到 / 读数取不到 / 读数在基准之后，全部落 unknown（不冒充 fresh） */
export function judgeBarFreshness(input: {
  label: string;
  last_date: unknown;
  expected_date: unknown;
}): BarFreshness {
  const last = toShanghaiDay(input.last_date);
  const expected = toShanghaiDay(input.expected_date);
  const base: BarFreshness = {
    label: input.label, state: "unknown", last_date: last, expected_date: expected, lag_days: null, reason: null,
  };
  if (!expected) return { ...base, reason: "没能取到基准交易日（000001.SH 日K无返回或日期不可解析），无法判断这份读数是否过期" };
  if (!last) return { ...base, reason: "这一步没有给出最后一根的日期，无法判断这份读数是否过期" };
  if (last > expected) return { ...base, reason: `最后一根标着 ${last}，晚于基准交易日 ${expected}（日历异常），不按新鲜引用，也不按滞后下结论` };
  if (last === expected) return { ...base, state: "fresh" };
  const lag = calendarDayGap(last, expected);
  return { ...base, state: "stale", lag_days: lag };
}

/** 断档：序列覆盖区间内、日历上有而序列里没有的交易日。序列少于 2 根或没日历时交 null（不谎报「无断档」） */
export function gapTradingDays(
  seriesDates: (string | null | undefined)[],
  tradeDates: (string | null | undefined)[],
): string[] | null {
  const series = [...new Set((seriesDates ?? []).map(toShanghaiDay).filter((x): x is string => !!x))].sort();
  const cal = new Set((tradeDates ?? []).map(toShanghaiDay).filter((x): x is string => !!x));
  if (series.length < 2 || !cal.size) return null;
  const have = new Set(series);
  const out: string[] = [];
  for (const d of [...cal].sort()) {
    if (d > series[0] && d < series[series.length - 1] && !have.has(d)) out.push(d);
  }
  return out;
}

/**
 * 从 stock_kline_summary 的原始返回值里抽「最近 5 日」的日期序列（纯形状读取，判不出的形状交 []）。
 * 为什么放纯核：这是「从工具结果里认日期」的判断，留在服务层就又是一条不受测试盯的规则。
 * 取不到（工具本轮回 missing / 形状不是我们认识的表）返回空数组，调用方据此不做新鲜度结论——那是「没查」，不是「新鲜」。
 */
export function klineLastDatesFromResult(out: unknown): string[] {
  const rows = (out as { 最近5日?: unknown })?.最近5日;
  if (!Array.isArray(rows)) return [];
  const dates: string[] = [];
  for (const r of rows) {
    const d = toShanghaiDay((r as { 日期?: unknown })?.日期);
    if (d) dates.push(d);
  }
  return dates;
}

/**
 * 新鲜度提示行的唯一文案出处：注入给模型的规则、步骤 detail、界面上的说明必须同一份措辞，
 * 否则「告诉模型的那句」和「给用户看的那句」会对不上。fresh 返回 null（没话找话只会稀释指令）。
 */
export function freshnessLine(f: BarFreshness): string | null {
  if (f.state === "stale") {
    const gap = f.lag_days != null ? `（相差 ${f.lag_days} 个自然日）` : "";
    return `数据滞后：${f.label} 的读数只到 ${f.last_date}，基准交易日已到 ${f.expected_date}${gap}。`;
  }
  if (f.state === "unknown") return `新鲜度无法判定：${f.label} —— ${f.reason ?? "原因未给出"}。`;
  return null;
}

export interface FreshnessReport {
  /** 逐路读数的判定结果（步骤时间线吃这份的 detail） */
  items: BarFreshness[];
  /** 需要上屏/进 prompt 的行（fresh 不在里面） */
  lines: string[];
  /** 有没有需要告知用户的（stale 或 unknown 任一） */
  has_issues: boolean;
}

/** 把逐路判定与断档核对并成一份报告；两头的文案都出自 freshnessLine / 固定句式这一处 */
export function buildFreshnessReport(
  items: BarFreshness[],
  gaps?: { label: string; missing: string[] }[],
): FreshnessReport {
  const lines: string[] = [];
  for (const f of items ?? []) {
    const line = freshnessLine(f);
    if (line) lines.push(line);
  }
  for (const g of gaps ?? []) {
    if (g.missing.length) {
      lines.push(
        `序列断档：${g.label} 在覆盖区间内缺 ${g.missing.length} 个交易日（${g.missing.slice(0, 5).join("、")}${g.missing.length > 5 ? " 等" : ""}）。`,
      );
    }
  }
  return { items, lines, has_issues: lines.length > 0 };
}

/** 拼进场景提示词的纪律段：滞后要点名滞后幅度；无法判定不得按新鲜引用 */
export function freshnessPromptRule(lines: string[]): string {
  return [
    "【数据新鲜度检查（系统在取数后比对了真实交易日历（000001.SH 日K），以下每条都是核对结果原文）】",
    ...lines,
    "回答纪律：标了「数据滞后」的读数，必须在回答里点名滞后幅度（读数到哪一天、基准到哪一天），" +
    "不得把过期读数当今日行情下结论；标了「序列断档」的要如实说明断档；" +
    "标了「新鲜度无法判定」的必须说明无法判定，不得写成「数据正常/最新」。",
  ].join("\n");
}
