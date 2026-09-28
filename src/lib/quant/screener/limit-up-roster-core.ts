// P15-R20 涨停名单纯核：把「按日的涨停名单」读成晋级率 / 梯队断层 / 赚钱效应三组读数。
// 零 IO 零时钟：输入是取数层已经拉回来的池子行（或库里读出的行），输出判定结构；
// 页面、接口、采集器转述同一份口径，不在下游各写一套拆法。
//
// 为什么这一层要单独存在：market_daily_stats 只有**计数**（涨停 52 家、t3/t4/t5、最高板），
// 而「昨天首板 39 只今天有几个变二板」问的是名单里**谁**晋级了。计数换算不出名单，
// 所以晋级率必须落在名单层，口径也得落在这里。
//
// 四条写死的口径（跟项目一贯的「缺读数 ≠ 0」同源）：
// 1) boards（连板数）取不到就不是首板：不进任何板数桶，单独记 unknownBoards 并报出来。
// 2) 晋级率的分母是**昨日那一档的家数**，不是今日涨停家数。昨日该档 0 家 → rate 是 null，
//    不是 0%：「昨天没有首板」和「首板全军覆没」是两件不同的事，后者才是坏消息。
// 3) 昨日或今日名单为空（断源 / 休市 / 超留存窗口）→ 整组 rate 全 null + 一句原因，
//    绝不回一个 0% 让页面画出一条看着像结论的线。
// 4) 晋级判据取严：**今日仍在涨停池 且 今日 boards ≥ 昨日 boards + 1**。
//    两天不是相邻交易日时（隔休市日、或中间缺了一天），"今天又涨停" 并不代表接力成功，
//    放松成「仍在池」会造出假晋级；这里宁可少算。
//
// 蓝本口径来自 `vibe-astock/duanxian/emotion_metrics.py`（晋级率分 1进2 / 2进3 / 3板以上、
// 梯队断层 = 2..最高板之间无人对应的板数、赚钱效应覆盖率不足即判不可用），逐条对照过，
// 数据源与阈值是自己的。

import { suffixOf } from "../../desk/intent-core.ts";

/** 名单里的一行（一票一日）。null 一律表示「没读到」，不是 0。 */
export interface RosterRow {
  symbol: string; // 601811.SH
  name: string;
  industry: string;
  boards: number | null; // 连板数，1=首板
  changePct: number | null; // 当日涨跌幅 %
  firstSeal: string | null; // 首次封板时刻 HH:MM:SS（北京）
  lastSeal: string | null; // 最后封板时刻 HH:MM:SS（北京）
  breakCount: number | null; // 当日炸板次数
  sealFund: number | null; // 封单额（元）
  floatCap: number | null; // 流通市值（元）——只留档，本轮不做任何分组
}

/** 东财涨停池（push2ex getTopicZTPool）一行里我们认的字段 */
export interface RawPoolRow {
  c?: unknown; // 6 位代码
  n?: unknown; // 名称
  m?: unknown; // 市场号（**不用它**：北交所 920xxx 与深市同样返回 0，认市别看号）
  lbc?: unknown; // 连板数
  zdp?: unknown; // 涨跌幅 %
  fbt?: unknown; // 首次封板 HHMMSS（整数，可能少一位）
  lbt?: unknown; // 最后封板 HHMMSS
  zbc?: unknown; // 炸板次数
  fund?: unknown; // 封单额
  ltsz?: unknown; // 流通市值
  hybk?: unknown; // 行业板块名
}

export interface ParseResult {
  rows: RosterRow[];
  dropped: number; // 形状不对、认不出代码的行数（不静默吞）
}

function numOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

/** 正整数读数（ boards / 炸板次数 用）：0 是合法值，负数与小数不算 */
function intOf(v: unknown, min = 0): number | null {
  const n = numOf(v);
  if (n === null || n < min || !Number.isInteger(n)) return null;
  return n;
}

/**
 * 东财把封板时刻给成整数秒针（93006=09:30:06、92500=09:25:00，位数不定宽）。
 * 补零到 6 位再切；越界（分/秒 ≥60）判不可信，返回 null，不猜一个时间上去。
 */
export function sealClock(v: unknown): string | null {
  const n = numOf(v);
  if (n === null || n < 0) return null;
  const s = String(Math.trunc(n)).padStart(6, "0");
  if (s.length !== 6) return null;
  const h = Number(s.slice(0, 2));
  const mi = Number(s.slice(2, 4));
  const sec = Number(s.slice(4, 6));
  if (h > 23 || mi > 59 || sec > 59) return null;
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

/** 裸 6 位代码 → 带后缀 symbol：号段口径只认 intent-core 那一份，不在这抄第二份 */
export function poolSymbol(code: unknown): string | null {
  const c = String(code ?? "").trim();
  return /^\d{6}$/.test(c) ? `${c}.${suffixOf(c)}` : null;
}

export function parsePoolRows(raw: unknown[]): ParseResult {
  const rows: RosterRow[] = [];
  let dropped = 0;
  for (const item of raw ?? []) {
    const r = (item ?? {}) as RawPoolRow;
    const symbol = poolSymbol(r.c);
    if (!symbol) { dropped++; continue; }
    const boards = intOf(r.lbc, 1); // 连板数最少 1；读不到就 null，不当首板
    rows.push({
      symbol,
      name: String(r.n ?? "").trim(),
      industry: String(r.hybk ?? "").trim(),
      boards,
      changePct: numOf(r.zdp),
      firstSeal: sealClock(r.fbt),
      lastSeal: sealClock(r.lbt),
      breakCount: intOf(r.zbc),
      sealFund: numOf(r.fund),
      floatCap: numOf(r.ltsz),
    });
  }
  return { rows, dropped };
}

/** 库里读出的行 → RosterRow（回填/沉淀之后读侧用；空串/缺列一律回落 null） */
export function rosterFromDb(row: {
  symbol: string; name?: string | null; industry?: string | null;
  boards?: number | null; changePct?: number | null;
  firstSeal?: string | null; lastSeal?: string | null;
  breakCount?: number | null; sealFund?: number | null; floatCap?: number | null;
}): RosterRow {
  return {
    symbol: row.symbol,
    name: row.name ?? "",
    industry: row.industry ?? "",
    boards: typeof row.boards === "number" && Number.isInteger(row.boards) && row.boards >= 1 ? row.boards : null,
    changePct: typeof row.changePct === "number" && Number.isFinite(row.changePct) ? row.changePct : null,
    firstSeal: row.firstSeal || null,
    lastSeal: row.lastSeal || null,
    breakCount: typeof row.breakCount === "number" && Number.isFinite(row.breakCount) ? row.breakCount : null,
    sealFund: typeof row.sealFund === "number" && Number.isFinite(row.sealFund) ? row.sealFund : null,
    floatCap: typeof row.floatCap === "number" && Number.isFinite(row.floatCap) ? row.floatCap : null,
  };
}

export interface Ladder {
  highest: number | null; // 当日最高板；名单里一个 boards 都没有 → null（不是 0 板）
  counts: { boards: number; n: number }[]; // 升序，逐板家数
  gaps: number[]; // 2..最高板之间无人对应的板数（断层）
  unknownBoards: number; // boards 缺到的行数：报出来，不塞进任何桶
  total: number;
}

export function ladderOf(rows: RosterRow[]): Ladder {
  const hist = new Map<number, number>();
  let unknownBoards = 0;
  for (const r of rows) {
    if (r.boards === null) { unknownBoards++; continue; }
    hist.set(r.boards, (hist.get(r.boards) ?? 0) + 1);
  }
  const counts = [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([boards, n]) => ({ boards, n }));
  const highest = counts.length ? counts[counts.length - 1].boards : null;
  // 照抄蓝本拆法：断层只在 2..最高板 之间找，1 板永远有（涨停名单本身），最高板自己不算缺口
  const present = new Set(hist.keys());
  const gaps: number[] = [];
  for (let b = 2; highest !== null && b < highest; b++) if (!present.has(b)) gaps.push(b);
  return { highest, counts, gaps, unknownBoards, total: rows.length };
}

export interface PromoBucket {
  base: number; // 昨日该档家数（分母）
  promoted: number; // 今日仍涨停且板数 +1 的家数
  rate: number | null; // 晋级率 %；base=0 → null（缺读数，不是 0%）
}

export interface PromotionResult {
  prevPool: number;
  todayPool: number;
  oneToTwo: PromoBucket;
  twoToThree: PromoBucket;
  threePlus: PromoBucket;
  /** 三档里有没有任何一档算得出来（两日名单都空 / 昨日整批缺 boards 时是 false） */
  computed: boolean;
  /** 算不出时的原因，页面原样显示；算得出时是空串 */
  reason: string;
}

function bucket(base: RosterRow[], today: Map<string, RosterRow>, minBoards: number, maxBoards: number | null): PromoBucket {
  const hit = base.filter((p) => {
    const t = today.get(p.symbol);
    return !!t && t.boards !== null && p.boards !== null && t.boards >= p.boards + 1;
  });
  return {
    base: base.length,
    promoted: hit.length,
    rate: base.length ? (hit.length / base.length) * 100 : null,
  };
}

/**
 * 晋级率：昨日 boards=k 的票，今天有几个变成 k+1。
 * `prev` / `today` 是**两个相邻交易日**的名单；调用方负责保证相邻（跨休市日要在外面判好并标注），
 * 本函数只认「今日仍在池且板数 +1」这个严判据——放松成「仍在池」会在隔日缺口上造出假晋级。
 */
export function promotionRates(prev: RosterRow[], today: RosterRow[]): PromotionResult {
  const prevRows = prev ?? [];
  const todayRows = today ?? [];
  const base1 = prevRows.filter((r) => r.boards === 1);
  const base2 = prevRows.filter((r) => r.boards === 2);
  const base3 = prevRows.filter((r) => r.boards !== null && r.boards >= 3);
  const map = new Map(todayRows.map((r) => [r.symbol, r]));
  const oneToTwo = bucket(base1, map, 1, 2);
  const twoToThree = bucket(base2, map, 2, 3);
  const threePlus = bucket(base3, map, 3, null);
  const anyBase = oneToTwo.base + twoToThree.base + threePlus.base;
  let reason = "";
  if (!prevRows.length) reason = "昨日名单为空（未沉淀 / 断源 / 超出涨停池留存窗口）";
  else if (!todayRows.length) reason = "今日名单为空（未收盘或未取到，不拿 0% 冒充「无人接力」）";
  else if (!anyBase) reason = `昨日 ${prevRows.length} 只里 boards 一个都没读到，分母为 0`;
  return {
    prevPool: prevRows.length,
    todayPool: todayRows.length,
    oneToTwo,
    twoToThree,
    threePlus,
    computed: anyBase > 0 && todayRows.length > 0,
    reason,
  };
}

const pct = (v: number | null): string => (v === null ? "—" : `${v.toFixed(0)}%`);
const frac = (b: PromoBucket): string => (b.base ? `${b.promoted}/${b.base}（${pct(b.rate)}）` : "0 家（无分母）");

/** 一日的接力口径行（页面/接口/日志同一个出处，别让三个地方各拼一遍） */
export function promotionDayLine(date: string, prevDate: string, p: PromotionResult, ladder: Ladder): string {
  if (!p.computed) return `${date} 接力：算不出——${p.reason || "无数据"}`;
  const gap = ladder.highest === null ? "最高板未知"
    : ladder.gaps.length ? `最高 ${ladder.highest} 板、中间断 ${ladder.gaps.join("/")} 板` : `最高 ${ladder.highest} 板、梯队连续`;
  return `${date} 接力（对 ${prevDate}）：1进2 ${frac(p.oneToTwo)} · 2进3 ${frac(p.twoToThree)} · `
    + `3板以上续住 ${frac(p.threePlus)} · ${gap}`;
}

export interface MoneyEffect {
  coverage: number; // 昨日名单里今日读到涨跌幅的家数占比 0~1
  sample: number; // 参与统计的家数
  avg: number | null;
  median: number | null;
  positiveRate: number | null; // 上涨家数占比 %
  limitUpAgainRate: number | null; // 今日又涨停的家数占比 %
  available: boolean; // 覆盖率不够就不给数（宁缺不假）
  reason: string;
}

/** 覆盖率低于这个数就不报「赚钱效应」——昨日 52 只只查到 10 只涨跌，均值是噪声不是结论 */
export const MONEY_EFFECT_MIN_COVERAGE = 0.5;

/**
 * 赚钱效应（涨停口径）：**昨日涨停股在今天的平均表现**。
 * 与 `market-inference.ts` 里那个被叫作「赚钱效应」的 MA5 上方占比是两回事，
 * 同名不同义已经坑过一次，所以这里函数名、字段名、页面文案都必须带「昨日涨停」四个字。
 * `todayPct` 是 symbol → 今日涨跌幅（来自行情快照，缺一天不补 0）。
 */
export function moneyEffect(prev: RosterRow[], todayPct: Map<string, number | null>): MoneyEffect {
  const rows = prev ?? [];
  if (!rows.length) {
    return { coverage: 0, sample: 0, avg: null, median: null, positiveRate: null, limitUpAgainRate: null, available: false, reason: "昨日无涨停名单" };
  }
  const vals: number[] = [];
  let again = 0;
  for (const r of rows) {
    const v = todayPct.get(r.symbol);
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    vals.push(v);
    if (r.boards !== null && v >= 9.8 && v > 0) again++; // 粗略「又涨停」由调用方给准数时以调用方为准
  }
  const coverage = vals.length / rows.length;
  const sorted = [...vals].sort((a, b) => a - b);
  const base: MoneyEffect = {
    coverage,
    sample: vals.length,
    avg: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    positiveRate: vals.length ? (vals.filter((v) => v > 0).length / vals.length) * 100 : null,
    limitUpAgainRate: vals.length ? (again / vals.length) * 100 : null,
    available: false,
    reason: "",
  };
  if (coverage < MONEY_EFFECT_MIN_COVERAGE) {
    return { ...base, available: false, reason: `昨日 ${rows.length} 只里只读到 ${vals.length} 只今日涨跌幅（覆盖 ${(coverage * 100).toFixed(0)}% < ${(MONEY_EFFECT_MIN_COVERAGE * 100).toFixed(0)}%），不报均值` };
  }
  return { ...base, available: true, reason: vals.length < rows.length ? `覆盖率 ${(coverage * 100).toFixed(0)}%，缺 ${rows.length - vals.length} 只今日读数` : "" };
}

/**
 * 读侧带出去的那一整块（接力 + 梯队 + 昨日涨停表现）。
 * 字段全是纯数据，所以结构放在纯核里 —— 服务端读侧与客户端类型认同一份定义，
 * 免得接口加一个字段、页面那侧要抄第二遍。
 */
export interface PromotionBlock {
  as_of: string;
  /** 名单里最新的一天（不一定是「今天」：没收盘沉淀就没有今天） */
  today_date: string | null;
  prev_date: string | null;
  /** 库里攒了多少个交易日的名单 */
  roster_days: number;
  /** 最早一天：页面据此写「名单只回溯到 X 日」 */
  earliest: string | null;
  promotion: PromotionResult | null;
  ladder: Ladder | null;
  money: MoneyEffect | null;
  /** 一行接力口径（纯核给的文本，页面原样显示） */
  line: string;
  /** 两份名单之间是否相邻交易日；null = 还判不了 */
  adjacent: boolean | null;
  missing: string[];
  source: string;
}

// ---------- 龙头滞涨（R20b：见顶压力分第三个分量） ----------

/** 组内至少读到两只的今日涨跌幅才出结论——一只高标股的当天涨跌是噪声，不是「龙头滞涨」 */
export const LEADER_MIN_READ = 2;
/** 跑输基准多少个「百分点」算滞涨、多少算领涨（本机定的刻度，不是交易所规则；改只改这一处） */
export const LEADER_STALL_PT = 1.5;
export const LEADER_LEAD_PT = 1.5;

/**
 * 龙头组 = 昨日板数 ≥ 最高板 − 1 的那批（含最高板自己）。
 * 只取最高板那一档时经常只剩 1~2 只，一天的涨跌全看一只票脸色，所以往下带一档；
 * 带了几个门槛、组里几只，最后都会写进 LeaderStall.tier / sample，页面上看得见——不偷偷扩样本。
 */
export function topTierOf(rows: RosterRow[]): { tier: number; highest: number; rows: RosterRow[] } {
  const withBoards = (rows ?? []).filter((r): r is RosterRow & { boards: number } => typeof r.boards === "number");
  if (!withBoards.length) return { tier: 0, highest: 0, rows: [] };
  const highest = Math.max(...withBoards.map((r) => r.boards));
  for (const tier of [highest, highest - 1, highest - 2]) {
    if (tier < 1) break;
    const picked = withBoards.filter((r) => r.boards >= tier);
    if (picked.length >= LEADER_MIN_READ) return { tier, highest, rows: picked };
  }
  // 一天最高板只有 1~2 只时如实返回那一小撮，够不够出结论交给 leaderStall 判（它会把 available 关掉）
  return { tier: highest, highest, rows: withBoards.filter((r) => r.boards === highest) };
}

export interface LeaderStall {
  date: string | null; // 龙头梯队所属的那个交易日（= 名单最新一天，不是「今天」）
  highest: number | null;
  tier: number | null; // 实际取板的门槛
  sample: number; // 组内家数
  read: number; // 读到今日涨跌幅的家数
  avg: number | null;
  median: number | null;
  benchmark: number | null; // 对比基准（全 A 中位涨跌幅），缺读数时 null
  gap: number | null; // 龙头中位 − 基准（负=跑输）
  verdict: "滞涨" | "同步" | "领涨" | "";
  available: boolean;
  reason: string;
  line: string; // 一行结论（页面原样显示）
}

/**
 * 龙头滞涨：**昨日最高板梯队今天的表现 vs 全 A 中位涨跌幅**。
 * 为什么基准用中位数而不是上证指数：指数被几只权重股拉着走，高标股集体跑输中位数才是
 * 「接力资金撤退」的形状。这也和 R20a 那条「赚钱效应」区分开——那条看的是整张昨日涨停名单，
 * 这条只看梯队顶上那一小撮，两个数不一样是正常的，不要合并成一个。
 */
export function leaderStall(
  date: string | null,
  rows: RosterRow[],
  todayPct: Map<string, number | null>,
  benchmark: number | null,
  /** 取数层的失败说明（比如今日行情整批没取到）。纯核不看 IO，只把它并进 reason 里说清楚 */
  ioNote?: string,
): LeaderStall {
  const withIo = (s: LeaderStall): LeaderStall =>
    ioNote ? { ...s, reason: [s.reason, `取数：${ioNote}`].filter(Boolean).join("；") } : s;
  const empty: LeaderStall = {
    date, highest: null, tier: null, sample: 0, read: 0, avg: null, median: null,
    benchmark, gap: null, verdict: "", available: false, reason: "", line: "",
  };
  if (!rows?.length) return withIo({ ...empty, reason: "库里没有昨日涨停名单，龙头梯队无从取组" });
  const group = topTierOf(rows);
  if (!group.rows.length) return withIo({ ...empty, reason: "昨日名单里没有一只带连板数，取不出龙头组" });
  const vals: number[] = [];
  for (const r of group.rows) {
    const v = todayPct.get(r.symbol);
    if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const base: LeaderStall = {
    date, highest: group.highest, tier: group.tier, sample: group.rows.length, read: vals.length,
    avg: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    benchmark, gap: null, verdict: "", available: false, reason: "", line: "",
  };
  if (vals.length < LEADER_MIN_READ) {
    return withIo({ ...base, reason: `龙头组 ${group.rows.length} 只里只读到 ${vals.length} 只今日涨跌幅（<${LEADER_MIN_READ} 只），不出结论` });
  }
  if (benchmark === null || !Number.isFinite(benchmark)) {
    return withIo({ ...base, reason: "全 A 中位涨跌幅没读到，没有基准就不判滞涨（不拿 0 当基准）" });
  }
  const gap = (base.median as number) - benchmark;
  const verdict: LeaderStall["verdict"] = gap <= -LEADER_STALL_PT ? "滞涨" : gap >= LEADER_LEAD_PT ? "领涨" : "同步";
  const why = verdict === "领涨"
    ? "梯队顶上的票仍在领涨，不像见顶形状"
    : verdict === "滞涨"
      ? `跑输基准 ${Math.abs(gap).toFixed(2)} 个百分点（阈值 ≤-${LEADER_STALL_PT}）——高位接力不认账`
      : `与基准相差 ${gap >= 0 ? "+" : ""}${gap.toFixed(2)} 个百分点，在 ±${LEADER_STALL_PT} 以内算同步`;
  return withIo({
    ...base,
    gap,
    verdict,
    available: true,
    reason: vals.length < group.rows.length ? `缺 ${group.rows.length - vals.length} 只今日读数（停牌/无成交不计入）` : "",
    line: `龙头梯队（${date ?? "—"} 的 ${group.tier} 板及以上 ${group.rows.length} 只，读到 ${vals.length} 只）`
      + `今日中位 ${fmtSigned(base.median as number)}%、平均 ${fmtSigned(base.avg as number)}%，`
      + `基准（全A中位）${fmtSigned(benchmark)}% → ${verdict}。${why}`,
  });
}

function fmtSigned(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}
