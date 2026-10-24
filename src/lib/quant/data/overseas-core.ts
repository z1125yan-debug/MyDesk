// P15-R20b 外盘与 A50 —— 纯解析 + 背离判定核（零 IO、零时钟：文本与「今天」都由调用方喂进来）
//
// 为什么要这一份：见顶压力分的第六分量「外盘催化」要的是**隔夜与盘前的前瞻**，
// 而全仓此前没有任何一条外盘通路（`em.ts` 的 symbolToSecid 只认 6 位 A 股代码与 90.BK 板块，
// 外盘一律给 null）。免 key 通路在方案轮 §5 已实测，本轮落到代码：
//   · 腾讯批量报价  https://qt.gtimg.cn/q=usIXIC,usINX,usDJI,usSMH,usNVDA,hkHSI （GBK）
//   · 新浪期货      https://hq.sinajs.cn/list=hf_CHA50CFD （要 Referer: https://finance.sina.com.cn）
// 两条都不需要 key、不需要新依赖，和 `tc-universe.ts` / `sina-kline.ts` 用的是同一套打法。
//
// 字段口径**不是抄文档抄来的**，是 2026-09-28 本机两次快照 + 一路独立的日K接口交叉核对出来的：
// 见 parseA50 上面的对照表。认不出的形状一律返回 null，不猜字段。

// ---------- 腾讯外盘 ----------

/** 要取的外盘代码（顺序即页面呈现顺序：先看科技、再看宽基、最后恒指） */
export const OVERSEAS_CODES = ["usIXIC", "usINX", "usDJI", "usSMH", "usNVDA", "hkHSI"] as const;
export type OverseasCode = (typeof OVERSEAS_CODES)[number];

export function tcOverseasUrl(codes: readonly string[] = OVERSEAS_CODES): string {
  return `https://qt.gtimg.cn/q=${codes.join(",")}`;
}

/** 中文标签（上游给的名字混着中英且会改，页面要稳定；代码对不上时退回上游原名，不硬套） */
export const OVERSEAS_LABELS: Record<string, string> = {
  usIXIC: "纳斯达克", usINX: "标普500", usDJI: "道琼斯", usSMH: "半导体ETF(SMH)", usNVDA: "英伟达", hkHSI: "恒生指数",
};

/**
 * 把 qt.gtimg.cn 的一段响应切成 `键 → 引号内正文`。
 * 已有的 `splitTcQuoteText` 只认 `(sh|sz|bj)\d{6}`，外盘键（usIXIC/hkHSI）进不去；
 * 那个函数被钉测钉着，所以这里另开一条通用切法，不改它。
 */
export function splitTcVars(text: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  for (const line of text.split(";")) {
    const m = /v_([A-Za-z0-9_.]+)="([^"]*)"/.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

export interface OverseasRow {
  key: string;
  label: string; // 中文标签（认得出的代码用本表，认不出用上游名字）
  upstreamName: string; // 上游原样名字（留档，页面不显示第二份）
  code: string; // .IXIC / HSI / SMH.OQ
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** 上游给的行情时刻，**原样不折算**（美股那几条是美东时间，恒指是北京时间） */
  stamp: string;
  stampDate: string; // YYYY-MM-DD，从 stamp 里切出来的日期部分
  tz: "美东" | "北京" | "";
  /** 自算涨跌幅与上游字段差多少个点：对不上就是上游变了，要能自己发现 */
  pctCheck: number | null;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 日期前缀提取：`2026-09-25 17:15:59` → `2026-09-25`；`20260924161430` 那种紧凑戳也认。
 * 分隔符必须同时认 `-` 与 `/`：2026-09-28 实测腾讯**美股**给 `2026-09-25 17:15:59`、
 * **恒指**给 `2026/09/28 10:29:09`（od 看过字节，是 0x2f 不是 0x2d）。只认连字符时恒指的
 * `stampDate` 会是空串——行情时刻照样显示，但「美股距今几天」那类按日期算的口径就悄悄失效了。
 */
function dateOfStamp(stamp: string): string {
  const s = stamp.trim();
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const c = /^(\d{4})(\d{2})(\d{2})\d{4}/.exec(s);
  if (c) return `${c[1]}-${c[2]}-${c[3]}`;
  return "";
}

/**
 * 腾讯外盘单行（~ 分隔正文）→ 结构。字段位与 A 股那条 `parseTcQuote` 同一份布局：
 * 1 名称、2 代码、3 现价、4 昨收、30 行情时刻、31 涨跌额、32 涨跌幅%、33 最高、34 最低。
 * 现价拿不到（≤0）→ 整行不要：外盘停牌/未开盘回 0 的情况真有，0 不是「跌到 0」。
 */
export function parseTcOverseasRow(key: string, body: string): OverseasRow | null {
  if (!body) return null;
  const f = body.split("~");
  if (f.length < 35) return null;
  const price = num(f[3]);
  if (price === null || price <= 0) return null;
  const prev = num(f[4]);
  const stamp = (f[30] ?? "").trim();
  const reported = num(f[32]);
  const computed = prev && prev > 0 ? ((price - prev) / prev) * 100 : null;
  return {
    key,
    label: OVERSEAS_LABELS[key] ?? (f[1] ?? "").trim() ?? key,
    upstreamName: (f[1] ?? "").trim(),
    code: (f[2] ?? "").trim(),
    price,
    prevClose: prev,
    change: num(f[31]),
    changePct: reported ?? computed,
    stamp,
    stampDate: dateOfStamp(stamp),
    tz: /^us/i.test(key) ? "美东" : /^hk/i.test(key) ? "北京" : "",
    pctCheck: reported !== null && computed !== null ? +(reported - computed).toFixed(3) : null,
  };
}

// ---------- 新浪外盘（腾讯那条的备用路：2026-10-23 实测本机连不上 qt.gtimg.cn、hq.sinajs.cn 正常） ----------

/** 新浪代码 → 本项目外盘键。gb_ 是新浪美股/ETF 的前缀，hkHSI 是港股指数 */
export const SINA_OVERSEAS_CODES: Record<string, string> = {
  gb_ixic: "usIXIC", gb_inx: "usINX", gb_dji: "usDJI", gb_smh: "usSMH", gb_nvda: "usNVDA", hkHSI: "hkHSI",
};

export function sinaOverseasUrl(): string {
  return `https://hq.sinajs.cn/list=${Object.keys(SINA_OVERSEAS_CODES).join(",")}`;
}

/** 把 hq.sinajs.cn 的响应切成 `键 → 引号内正文`（`var hq_str_gb_ixic="..."`） */
export function splitSinaVars(text: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  for (const line of text.split(";")) {
    const m = /hq_str_([A-Za-z0-9_]+)="([^"]*)"/.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/** 代码列（页面/留档用的上游代码字面，与腾讯那条的口径对齐） */
const OVERSEAS_DISPLAY_CODES: Record<string, string> = {
  usIXIC: ".IXIC", usINX: ".INX", usDJI: ".DJI", usSMH: "SMH", usNVDA: "NVDA", hkHSI: "HSI",
};

/**
 * 新浪外盘单行 → 结构。字段位 2026-10-23 本机实测（与 Z 本地部署同刻读数交叉核对：恒指 +0.843%、SMH −5.99% 两边一致）：
 *   gb_（美股指数/ETF）：0 名称、1 现价、2 涨跌幅%、3 行情时刻（**北京时间**，如 `2026-10-23 05:30:00` 是美东 10-22 收盘）、
 *     4 涨跌额、5 今开、6 最高、7 最低。昨收不用尾部字段（位置会变），用「现价 − 涨跌额」自洽反推。
 *   hkHSI：0 代码、1 名称、2 今开、3 昨收、4 最高、5 最低、6 现价、7 涨跌额、8 涨跌幅%、…、17 日期（`2026/10/23`）、18 时间。
 * 现价拿不到（≤0）→ 整行不要，与腾讯那条同一纪律。
 */
export function parseSinaOverseasRow(key: string, sinaCode: string, body: string): OverseasRow | null {
  if (!body) return null;
  const f = body.split(",");
  if (sinaCode === "hkHSI") {
    if (f.length < 19) return null;
    const price = num(f[6]);
    if (price === null || price <= 0) return null;
    const prev = num(f[3]);
    const reported = num(f[8]);
    const computed = prev && prev > 0 ? ((price - prev) / prev) * 100 : null;
    const stamp = `${(f[17] ?? "").trim()} ${(f[18] ?? "").trim()}`.trim();
    return {
      key,
      label: OVERSEAS_LABELS[key] ?? (f[1] ?? "").trim() ?? key,
      upstreamName: (f[1] ?? "").trim(),
      code: OVERSEAS_DISPLAY_CODES[key] ?? "",
      price,
      prevClose: prev,
      change: num(f[7]),
      changePct: reported ?? computed,
      stamp,
      stampDate: dateOfStamp(stamp),
      tz: "北京",
      pctCheck: reported !== null && computed !== null ? +(reported - computed).toFixed(3) : null,
    };
  }
  if (f.length < 8) return null;
  const price = num(f[1]);
  if (price === null || price <= 0) return null;
  const change = num(f[4]);
  const reported = num(f[2]);
  const prev = change !== null ? price - change : null;
  const computed = prev && prev > 0 && change !== null ? (change / prev) * 100 : null;
  const stamp = (f[3] ?? "").trim();
  return {
    key,
    label: OVERSEAS_LABELS[key] ?? (f[0] ?? "").trim() ?? key,
    upstreamName: (f[0] ?? "").trim(),
    code: OVERSEAS_DISPLAY_CODES[key] ?? "",
    price,
    prevClose: prev,
    change,
    changePct: reported ?? computed,
    stamp,
    stampDate: dateOfStamp(stamp),
    // 新浪 gb_ 的时刻已经是北京时间（上游自己折算过），不能再标「美东」
    tz: "北京",
    pctCheck: reported !== null && computed !== null ? +(reported - computed).toFixed(3) : null,
  };
}

// ---------- 新浪 A50 期货 ----------

export const A50_CODE = "hf_CHA50CFD";

export function a50Url(code: string = A50_CODE): string {
  return `https://hq.sinajs.cn/list=${code}`;
}

/**
 * `hf_` 那条的字段位（2026-09-28 本机实测定位，不是抄文档）：
 *   0 现价 · 1 恒空 · 2 买价 · 3 卖价 · 4 最高 · 5 最低 · 6 时间(HH:mm:ss)
 *   7 昨收 · 8 今开 · 9 持仓量 · 10 买量 · 11 卖量 · 12 日期 · 13 名称 · 14 累计成交量
 * 三条独立证据：
 *   ① 同一合约连取三次：0/2/3/5/6/10/11/14 在变，4/7/8/9/12/13 不动 → 前者是盘中活值；
 *   ② 另一路独立端点 `GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=CHA50CFD`
 *      给 2026-09-25 close=14181.000、2026-09-28 open=14181.000 high=14210.000 position=575819
 *      → 分别对上了本行的 7（昨收）、8（今开）、4（最高）、9（持仓量）；
 *   ③ 14 随时间单调增（206671→209102→209618）而 9 不动 → 14 是累计成交量、9 是持仓量。
 * 14 不往外传：日K 那一路的 volume 是另一个取样时刻的数，两者不同值，摆在一起会被当成对不上。
 */
export interface A50Quote {
  name: string;
  price: number;
  prevSettle: number | null; // 昨收/昨结：涨跌幅的分母
  open: number | null;
  high: number | null;
  low: number | null;
  changePct: number | null;
  openInterest: number | null;
  /** 上游日期 + 时间（原样）。A50 有隔夜时段，日期不一定是北京时间的「今天」，所以照实带 */
  date: string;
  time: string;
}

export function parseA50(text: string): A50Quote | null {
  const m = /="([^"]*)"/.exec(text ?? "");
  if (!m) return null;
  const f = m[1].split(",");
  if (f.length < 13) return null;
  const price = num(f[0]);
  if (price === null || price <= 0) return null;
  const prev = num(f[7]);
  return {
    name: (f[13] ?? "").trim() || "富时中国A50期货",
    price,
    prevSettle: prev,
    open: num(f[8]),
    high: num(f[4]),
    low: num(f[5]),
    changePct: prev && prev > 0 ? ((price - prev) / prev) * 100 : null,
    openInterest: num(f[9]),
    date: (f[12] ?? "").trim(),
    time: (f[6] ?? "").trim(),
  };
}

// ---------- 汇总成一份快照 ----------

export interface OverseasSnapshot {
  /** 腾讯那几条（按 OVERSEAS_CODES 顺序，取不到的不占位） */
  rows: OverseasRow[];
  a50: A50Quote | null;
  /** 北京时间「今天」，由调用方给（纯核不看钟） */
  today: string;
  /** 隔夜判定：美股那几条的日期与今天的日历日差 */
  us_age_days: number | null;
  missing: string[];
  basis: string;
}

const dayDiff = (a: string, b: string): number | null => {
  const t = (s: string): number | null => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : null);
  const x = t(a);
  const y = t(b);
  if (x === null || y === null) return null;
  return Math.round((y - x) / 864e5);
};

/** 把两条路的原文本拼成一份快照。任何一路失败都不拖垮另一路：错误文本由调用方喂进来 */
export function buildOverseasSnapshot(args: {
  tcText: string | null;
  a50Text: string | null;
  today: string;
  tcError?: string;
  a50Error?: string;
  /** 新浪备用路（gb_/hkHSI）：腾讯缺哪条补哪条；不传 = 行为与加备用路之前完全一致 */
  sinaText?: string | null;
  sinaError?: string;
}): OverseasSnapshot {
  const missing: string[] = [];
  const byKey = new Map<string, OverseasRow>();
  // 腾讯那条的逐条缺报先攒着：新浪备用路补上的就不报了（补完还报「没回」会跟屏上的数打架）
  const tcMissing = new Map<string, string>();
  if (args.tcText) {
    const vars = splitTcVars(args.tcText);
    for (const code of OVERSEAS_CODES) {
      const body = vars.get(code);
      if (!body) { tcMissing.set(code, `外盘 ${code}：腾讯这次没回这一行（未覆盖或代码变了）`); continue; }
      const row = parseTcOverseasRow(code, body);
      if (!row) { tcMissing.set(code, `外盘 ${code}：腾讯回了但现价为空/≤0（未开盘或停牌），不按 0 处理`); continue; }
      if (row.pctCheck !== null && Math.abs(row.pctCheck) > 0.05) {
        missing.push(`外盘 ${row.label}：上游涨跌幅与「现价/昨收」自算差 ${row.pctCheck} 个点，字段位置可能变了，数先照上游显示`);
      }
      byKey.set(code, row);
    }
  }
  // 新浪备用路补缺：只补腾讯没有的键，不覆盖主路读数
  let sinaFilled = 0;
  if (args.sinaText) {
    const vars = splitSinaVars(args.sinaText);
    for (const [sinaCode, key] of Object.entries(SINA_OVERSEAS_CODES)) {
      if (byKey.has(key)) continue;
      const body = vars.get(sinaCode);
      if (!body) continue;
      const row = parseSinaOverseasRow(key, sinaCode, body);
      if (!row) continue;
      byKey.set(key, row);
      sinaFilled += 1;
    }
  }
  if (!args.tcText) {
    missing.push(sinaFilled > 0
      ? `外盘主路（腾讯）未取到：${args.tcError || "无返回"}；已由新浪备用路补 ${sinaFilled} 条`
      : `外盘（腾讯）未取到：${args.tcError || "无返回"}`);
  }
  for (const code of OVERSEAS_CODES) {
    const note = tcMissing.get(code);
    if (note && !byKey.has(code)) missing.push(note);
  }
  const rows = OVERSEAS_CODES.map((c) => byKey.get(c)).filter((r): r is OverseasRow => !!r);
  const a50 = args.a50Text ? parseA50(args.a50Text) : null;
  if (!a50) missing.push(`A50 期货未取到：${args.a50Error || "返回形状不认（字段位变了？）"}`);

  const usDates = rows.filter((r) => /^us/i.test(r.key) && r.stampDate).map((r) => r.stampDate);
  const newest = usDates.sort().slice(-1)[0] ?? "";
  const usAge = newest ? dayDiff(newest, args.today) : null;
  if (usAge !== null && usAge > 4) {
    missing.push(`美股那几条的行情时刻是 ${newest}（上游原样，美东时间），距今 ${usAge} 天：超出一个正常周末，别当隔夜读数用`);
  }
  return {
    rows,
    a50,
    today: args.today,
    us_age_days: usAge,
    missing,
    basis: "外盘：腾讯 qt.gtimg.cn（主路，美股/港股）+ 新浪 hq.sinajs.cn gb_/hkHSI（备用路，腾讯缺哪条补哪条）；A50：新浪 hf_CHA50CFD · 免 key、探测时一口价",
  };
}

// ---------- 背离判定（只判形状，不出分：分在 top-pressure-core 里合成） ----------

/** 判背离用的刻度：本机定的数，不是交易所规则；要改只改这一处 */
export const A50_WEAK_PCT = -0.5; // A50 当日跌幅到这个数以下算「外盘弱」
export const A50_STRONG_PCT = 0.5;
export const US_TECH_WEAK_PCT = -1.0; // 纳指 / 半导体ETF 隔夜跌幅
export const A_SHARE_FLAT_PCT = -0.2; // A 股中位涨跌幅高于它 = 当天没跟
export const A_SHARE_WEAK_PCT = -0.5; // 低于它 = 已经同步跌了

export type DivergenceKind = "外盘弱而A股没跟" | "外盘与A股同向下跌" | "外盘强而A股弱" | "无显著背离" | "读数不足";

export interface Divergence {
  kind: DivergenceKind;
  a50_pct: number | null;
  hk_pct: number | null;
  us_tech_pct: number | null; // 纳指与半导体ETF 里更差的那个
  a_share_median: number | null;
  /** 前瞻成分还有多少没进 A 股的价格：true = 外盘弱但 A 股当天扛住了 */
  not_priced_in: boolean;
  line: string;
  evidence: string[];
  missing: string[];
}

const pctText = (v: number | null): string => (v === null ? "无读数" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

/** A 股当日中位涨跌幅由调用方从同一份快照带进来（不看钟、不取数，所以能单测） */
export function judgeDivergence(snap: OverseasSnapshot, aShareMedian: number | null): Divergence {
  const get = (k: string): number | null => snap.rows.find((r) => r.key === k)?.changePct ?? null;
  const usTech = [get("usIXIC"), get("usSMH")].filter((v): v is number => v !== null);
  const usTechPct = usTech.length ? Math.min(...usTech) : null;
  const a50Pct = snap.a50?.changePct ?? null;
  const hkPct = get("hkHSI");
  const base: Divergence = {
    kind: "读数不足",
    a50_pct: a50Pct,
    hk_pct: hkPct,
    us_tech_pct: usTechPct,
    a_share_median: aShareMedian,
    not_priced_in: false,
    line: "",
    evidence: [],
    missing: [...snap.missing],
  };
  const evidence = [
    `A50 期货 ${pctText(a50Pct)}${snap.a50 ? `（${snap.a50.date} ${snap.a50.time}，上游原样）` : ""}`,
    `恒指 ${pctText(hkPct)}（与 A 股同一时段，只能算同步、不算前瞻）`,
    `纳指/半导体取更差的一档 ${pctText(usTechPct)}${snap.us_age_days !== null ? `（美股行情时刻距今 ${snap.us_age_days} 天）` : ""}`,
    `A 股今日中位涨跌幅 ${pctText(aShareMedian)}`,
  ];

  if (a50Pct === null && usTechPct === null) {
    return { ...base, evidence, line: "外盘与期货都没有读数，背离判不了——不是「没有背离」" };
  }
  const overseasWeak = (a50Pct !== null && a50Pct <= A50_WEAK_PCT) || (usTechPct !== null && usTechPct <= US_TECH_WEAK_PCT);
  const overseasStrong = a50Pct !== null && a50Pct >= A50_STRONG_PCT;
  const aShareKnown = aShareMedian !== null;

  let kind: DivergenceKind = "无显著背离";
  let notPriced = false;
  if (overseasWeak && !aShareKnown) kind = "读数不足";
  else if (overseasWeak && (aShareMedian as number) >= A_SHARE_FLAT_PCT) { kind = "外盘弱而A股没跟"; notPriced = true; }
  else if (overseasWeak && (aShareMedian as number) <= A_SHARE_WEAK_PCT) kind = "外盘与A股同向下跌";
  else if (overseasStrong && aShareKnown && (aShareMedian as number) <= A_SHARE_WEAK_PCT) kind = "外盘强而A股弱";

  const why = kind === "外盘弱而A股没跟"
    ? "外盘那口气还没进 A 股的价格里：这是前瞻背离，压力要按满额记"
    : kind === "外盘与A股同向下跌"
      ? "A 股当天已经跟着跌了：同一件事不该扣两次，压力减半记"
      : kind === "外盘强而A股弱"
        ? "外盘不差而 A 股自己弱：问题在内部，外盘这一格不加分"
        : kind === "读数不足"
          ? "A 股当日中位涨跌幅没读到，判不了是不是背离"
          : "外盘与 A 股当天没有明显反向";

  return {
    kind,
    a50_pct: a50Pct,
    hk_pct: hkPct,
    us_tech_pct: usTechPct,
    a_share_median: aShareMedian,
    not_priced_in: notPriced,
    line: `背离判定：${kind}。${why}`,
    evidence,
    missing: base.missing,
  };
}
