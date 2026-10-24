// 日报 PDF · 纯核（零 IO、零时钟、零数据库）
//
// 会议用 PDF 的内容模型：标题 / 元信息 / 若干节（段落 + 表格 + 条形图 + AI 11 字段卡）。
// 渲染（PDFKit + 中文字体）与拉取（数据库 / 上游）都不在这里：本文件只做
// “结构化输入 → PDF 内容模型”，方便钉测与复用。
//
// 诚实边界（和日报正文一致）：
// · 缺数据就写“没取到”，不编、不补 0、不拿别的日子的数据冒充；
// · 图表只画真实有的数（板块资金 Top、周涨跌 Top），没有就不画；
// · AI 优选 11 字段缺哪个就标“未取到”，不编。

export const PDF_MISSING = "没取到";
export const AI_PICK_MISSING = "未取到";

export interface PdfTable {
  headers: string[];
  /** 每行与 headers 等长；单元格里的换行会被渲染层压成空格 */
  rows: string[][];
  /** 各列相对宽度（权重），缺省 = 等宽；总和不限，渲染时按比例归一化 */
  widths?: number[];
}

export interface PdfBarItem {
  label: string;
  /** 画条长度用的数值（可正可负；渲染时按组内最大绝对值归一化） */
  value: number;
  /** 条后显示的文字，如“流入 12.34 亿” */
  display: string;
}

export interface PdfBars {
  title: string;
  items: PdfBarItem[];
  note?: string;
}

/** AI 优选逐只 11 字段卡：字段顺序与 ai-pick-note.ts 的 AI_PICK_CARD_FIELDS 一致 */
export interface PdfAiCard {
  symbol: string;
  name?: string;
  reason?: string;
  entryCondition?: string;
  mainRisk?: string;
  /** 11 个字段（研究结论 + 10 个），value 缺失时为 AI_PICK_MISSING */
  fields: { label: string; value: string }[];
}

export interface PdfSection {
  key: string;
  title: string;
  paragraphs: string[];
  table?: PdfTable;
  bars?: PdfBars;
  aiCards?: PdfAiCard[];
}

export interface PdfDocModel {
  /** 如“晚报（收盘后）· 2026-10-16” */
  title: string;
  subtitle: string;
  /** 标题下的元信息行，如“签发日：… / 数据归属：…” */
  meta: string[];
  sections: PdfSection[];
  /** 本期没取到的节（汇总，写进末尾“数据口径与缺失说明”） */
  missing: string[];
  /** 数据来源说明（末尾） */
  sources: string;
}

// ── 通用格式化（纯函数） ──

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return PDF_MISSING;
  return v >= 0 ? `+${v.toFixed(digits)}%` : `${v.toFixed(digits)}%`;
}

export function fmtYi(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return PDF_MISSING;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)} 亿`;
}

/** 去掉 emoji / 变体选择符 / 零宽连接符：Noto Sans CJK 没有彩色 emoji 字形，
 *  不剥掉会在 PDF 里留下方框。箭头、顿号、破折号等常用符号保留。 */
export function stripEmoji(s: string): string {
  return String(s ?? "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{FE0E}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function cleanCell(s: string): string {
  return stripEmoji(s).replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

const toYesterday = (s: string): string => s.replaceAll("今日", "昨天").replaceAll("今天", "昨天");
const toMorning = (s: string): string => s.replaceAll("今日", "上午").replaceAll("今天", "上午");

/** 早报的板块文案是“昨天”，午报是“上午”，晚报/周报不换。 */
export function shiftTimeWord(s: string, shift: "none" | "yesterday" | "morning"): string {
  if (shift === "yesterday") return toYesterday(s);
  if (shift === "morning") return toMorning(s);
  return s;
}

// ── 日报（早上 / 中午 / 晚上）输入 ──

export interface DailyPdfIndexRow {
  label: string; // 如“上证指数”
  date: string | null; // 该收盘价的交易日
  close: number | null;
  changePct: number | null; // vs 前一根日 K；只有一根时为 null
}

export interface DailyPdfInput {
  slotLabel: string; // 早报 / 午报 / 晚报
  slotTitle: string; // 早报（开盘前）…
  issueDate: string;
  dataDate: string;
  dataBelongsTo: string;
  generatedAt: string;
  preliminary: boolean;
  /** 早报→yesterday，午报→morning，晚报→none */
  timeShift: "none" | "yesterday" | "morning";
  market: DailyPdfIndexRow[];
  marketNote: string;
  sectorFlowPlain: string;
  /** 板块资金分支细分段落（用户 2026-10-20 定：拆到分支）；null = 该节不加细分段 */
  branchFlowPlain?: string | null;
  /** 分支细分是否有数据（东财口径，与同花顺大板块榜独立：大榜挂了分支照报） */
  branchFlowHasData?: boolean;
  topInflow: { name: string; changePct: number | null; netYi: number | null }[];
  topOutflow: { name: string; changePct: number | null; netYi: number | null }[];
  sectorFlowHasData: boolean;
  divergences: { name: string; changePct: number; netYi: number; plain: string }[];
  divergenceHasData: boolean;
  limitUp: {
    count: number | null;
    maxBoards: number | null;
    touched: number | null;
    broken: number | null;
    asOf: string | null;
    leaders: { name: string; symbol: string; boards: number; changePct: number | null }[];
    hasData: boolean;
  };
  reduction: {
    total: number;
    bigHolderCount: number;
    rows: { code: string; name: string; holder: string; stage: string; plainLine: string }[];
    plain: string;
    hasData: boolean;
  };
  aiPick: {
    /** 已落库的 AI 优选行是否存在 */
    hasRow: boolean;
    /** 逐只 11 字段卡（解析 symbolsNote 得到；旧格式 note → []） */
    cards: PdfAiCard[];
    /** 解析不出卡时的原文（旧格式 note），已截断并注明 */
    noteText: string;
    pickNames: string[];
  };
  usMarket: {
    quotes: { symbol: string; label: string; changePct: number | null; price: number | null; date: string | null }[];
    plain: string;
    hasData: boolean;
  };
  fed: {
    meetings: { meeting: string; kalshi: number | null; polymarket: number | null; avg: number | null }[];
    plain: string;
    hasData: boolean;
  };
  mainLinePlain: string;
  /** 本期“看什么”等时段叙事节（直接来自三份日报的 sections，标题已在 section 里） */
  watchSections: { title: string; plain: string }[];
  missing: string[];
}

const section = (key: string, title: string, paragraphs: string[], extra?: Partial<PdfSection>): PdfSection => ({
  key, title, paragraphs: paragraphs.map(stripEmoji).filter(Boolean), ...extra,
});

export function buildDailyPdfModel(input: DailyPdfInput): PdfDocModel {
  const missing: string[] = [...input.missing];
  const sections: PdfSection[] = [];
  const shift = (s: string) => shiftTimeWord(s, input.timeShift);

  // 1. 大盘
  const marketParas = [shift(input.marketNote)];
  const marketTable: PdfTable | undefined = input.market.length
    ? {
        headers: ["指数", "日期", "收盘", "涨跌幅"],
        rows: input.market.map((r) => [
          r.label,
          r.date ?? PDF_MISSING,
          r.close == null ? PDF_MISSING : r.close.toFixed(2),
          fmtPct(r.changePct),
        ]),
        widths: [2, 1.5, 1.2, 1.2],
      }
    : undefined;
  if (!input.market.length) missing.push("大盘指数没取到");
  sections.push(section("market", "一、大盘", marketParas, { table: marketTable }));

  // 2. 板块资金（正文 + 分支细分段，同一节内加段，不改版式）
  // 大板块榜（同花顺）与分支细分（东财）是两路独立数据：一路挂了，另一路照常报，不互相吞。
  const flowParas = input.sectorFlowHasData
    ? [shift(input.sectorFlowPlain), ...(input.branchFlowPlain ? [shift(input.branchFlowPlain)] : [])]
    : input.branchFlowHasData && input.branchFlowPlain
      ? ["板块资金（大板块榜）：没取到，先看分支细账。", shift(input.branchFlowPlain)]
      : ["板块资金：没取到，算不出钱去了哪。"];
  const flowTable: PdfTable | undefined = input.sectorFlowHasData
    ? {
        headers: ["方向", "板块", "涨跌幅", "资金净流入"],
        rows: [
          ...input.topInflow.map((r) => ["流入", r.name, fmtPct(r.changePct), fmtYi(r.netYi)]),
          ...input.topOutflow.map((r) => ["流出", r.name, fmtPct(r.changePct), fmtYi(r.netYi)]),
        ],
        widths: [1, 2.2, 1.2, 1.6],
      }
    : undefined;
  const flowBars: PdfBars | undefined = input.sectorFlowHasData && (input.topInflow.length || input.topOutflow.length)
    ? {
        title: "板块资金 Top（亿）",
        items: [
          ...input.topInflow.map((r) => ({ label: r.name, value: r.netYi ?? 0, display: `流入 ${fmtYi(r.netYi)}` })),
          ...input.topOutflow.map((r) => ({ label: r.name, value: r.netYi ?? 0, display: `流出 ${fmtYi(r.netYi)}` })),
        ],
      }
    : undefined;
  if (!input.sectorFlowHasData) missing.push("板块资金没取到");
  sections.push(section("sector-flow", "二、板块资金", flowParas, { table: flowTable, bars: flowBars }));

  // 3. 分歧
  const divParas = input.divergenceHasData
    ? (input.divergences.length
        ? [`分歧（钱和价打架，只报前 ${input.divergences.length} 个）：${input.divergences.map((d) => shift(d.plain)).join(" ")}`]
        : ["分歧：没有板块出现钱和价打架。"])
    : ["分歧：板块数据没取到，算不出分歧。"];
  const divTable: PdfTable | undefined = input.divergences.length
    ? {
        headers: ["板块", "涨跌幅", "资金净流入", "分歧说明"],
        rows: input.divergences.map((d) => [d.name, fmtPct(d.changePct), fmtYi(d.netYi), cleanCell(shift(d.plain))]),
        widths: [1.6, 1, 1.4, 3],
      }
    : undefined;
  if (!input.divergenceHasData) missing.push("分歧没取到");
  sections.push(section("divergence", "三、分歧", divParas, { table: divTable }));

  // 4. 涨停板
  const lu = input.limitUp;
  const luParas = lu.hasData
    ? [
        `涨停板${lu.asOf ? `（${lu.asOf}）` : ""}：涨停 ${lu.count ?? PDF_MISSING} 家，最高 ${lu.maxBoards ?? PDF_MISSING} 连板`
        + (lu.touched != null ? `，触板 ${lu.touched} 家` : "")
        + (lu.broken != null ? `，炸板 ${lu.broken} 家` : "") + "。",
        lu.leaders.length
          ? `涨停龙头（连板最高的前 ${lu.leaders.length} 只）：${lu.leaders.map((s) => `${s.name}（${s.boards} 连板）`).join("、")}。`
          : "涨停龙头：涨停名单为空，没有涨停龙头。",
      ]
    : ["涨停板：涨停梯队没取到，算不出涨停龙头。"];
  const luTable: PdfTable | undefined = lu.leaders.length
    ? {
        headers: ["股票", "代码", "连板", "涨跌幅"],
        rows: lu.leaders.map((s) => [s.name, s.symbol, `${s.boards}`, fmtPct(s.changePct)]),
        widths: [2, 1.8, 1, 1.2],
      }
    : undefined;
  if (!lu.hasData) missing.push("涨停梯队没取到");
  sections.push(section("limit-up", "四、涨停板", luParas, { table: luTable }));

  // 5. 减持风险
  const red = input.reduction;
  const redParas = red.hasData
    ? [shift(red.plain)]
    : ["减持风险：巨潮公告没取到，算不出谁在减持。"];
  const redTable: PdfTable | undefined = red.rows.length
    ? {
        headers: ["股票", "代码", "谁在减", "阶段"],
        rows: red.rows.slice(0, 10).map((r) => [r.name, r.code, r.holder, r.stage]),
        widths: [2, 1.6, 1.4, 1.2],
      }
    : undefined;
  if (red.hasData && red.total > 10) {
    redParas.push(`减持明细只列前 10 条（大股东优先），其余 ${red.total - 10} 只见巨潮公告。`);
  }
  if (!red.hasData) missing.push("减持风险没取到");
  sections.push(section("reduction", "五、减持风险", redParas, { table: redTable }));

  // 6. AI 优选（11 字段卡）
  const ai = input.aiPick;
  const aiParas = !ai.hasRow
    ? [`AI 优选：${input.dataDate} 还没生成（收盘后自动任务还没跑出结果，或当天无候选），不编。`]
    : ai.cards.length
      ? [`AI 优选（${input.dataDate}）：共 ${ai.pickNames.length || ai.cards.length} 只：${ai.pickNames.join("、")}。每只票一张 11 字段卡，缺的字段显示“${AI_PICK_MISSING}”，不编。`]
      : ai.noteText
        ? ["AI 优选：已生成但 symbolsNote 是旧格式，解析不出逐只 11 字段卡，下面保留原文（不冒充有卡）。", ai.noteText]
        : [`AI 优选（${input.dataDate}）：已生成但没有具体票，不编票。`];
  sections.push(section("ai-pick", "六、AI 优选（11 字段卡）", aiParas, {
    aiCards: ai.cards.length ? ai.cards : undefined,
  }));
  if (!ai.hasRow) missing.push("AI 优选没取到");

  // 7. 美股
  const usParas = input.usMarket.hasData
    ? [input.usMarket.plain]
    : ["美股：昨晚收盘没取到，算不出对 A 股的影响。"];
  const usTable: PdfTable | undefined = input.usMarket.quotes.length
    ? {
        headers: ["标的", "代码", "收盘价", "涨跌幅", "日期"],
        rows: input.usMarket.quotes.map((q) => [
          q.label, q.symbol,
          q.price == null ? PDF_MISSING : q.price.toFixed(2),
          fmtPct(q.changePct),
          q.date ?? PDF_MISSING,
        ]),
        widths: [2.2, 1, 1.2, 1.2, 1.4],
      }
    : undefined;
  if (!input.usMarket.hasData) missing.push("美股没取到");
  sections.push(section("us-market", "七、美股", usParas, { table: usTable }));

  // 8. 美联储
  const fedParas = input.fed.hasData ? [input.fed.plain] : ["美联储 / 预测市场：Kalshi 和 Polymarket 都没取到，算不出加息概率。"];
  const fedTable: PdfTable | undefined = input.fed.meetings.length
    ? {
        headers: ["会议", "Kalshi 加息概率", "Polymarket 加息概率", "平均加息概率"],
        rows: input.fed.meetings.map((m) => [
          m.meeting,
          m.kalshi == null ? PDF_MISSING : `${m.kalshi.toFixed(1)}%`,
          m.polymarket == null ? PDF_MISSING : `${m.polymarket.toFixed(1)}%`,
          m.avg == null ? PDF_MISSING : `${m.avg.toFixed(1)}%`,
        ]),
        widths: [1.6, 1.6, 1.8, 1.4],
      }
    : undefined;
  if (!input.fed.hasData) missing.push("美联储 / 预测市场没取到");
  sections.push(section("fed", "八、美联储", fedParas, { table: fedTable }));

  // 9. 主线
  sections.push(section("main-line", "九、主线", [shift(input.mainLinePlain)]));

  // 10+. 本期看什么（时段叙事）：按顺序编中文序号（十、十一、十二…）
  const WATCH_NUMERALS = ["十", "十一", "十二", "十三", "十四"];
  input.watchSections.forEach((w, i) => {
    const numeral = WATCH_NUMERALS[i] ?? `十${i + 1}`;
    sections.push(section(`watch-${i}`, `${numeral}、${w.title}`, [w.plain]));
  });

  return {
    title: `${input.slotTitle} · ${input.issueDate}`,
    subtitle: input.slotLabel === "早报"
      ? "开盘前会议简报：美股昨晚 + 昨天复盘 + 今天看什么"
      : input.slotLabel === "午报"
        ? "午盘会议简报：上午盘复盘 + 下午看什么"
        : "收盘后会议简报：今天收盘 + 分歧 + 涨停 + 减持 + AI 优选",
    meta: [
      `签发日：${input.issueDate}`,
      `数据归属：${input.dataBelongsTo}`,
      `生成时刻：${input.generatedAt}（北京时间）`,
      input.preliminary ? "状态：盘中快照，未到收盘/午盘时刻，不是定稿" : "状态：定稿",
    ],
    sections,
    missing: [...new Set(missing)],
    sources: "数据来源：上证/深证/创业板日 K（大盘）、同花顺行业榜（板块资金/分歧/主线）、东财板块榜（分支细分）、涨停梯队快照（涨停板）、巨潮公告（减持风险）、已落库 AI 优选（AI 优选 11 字段卡）、长桥（美股）、Kalshi + Polymarket（美联储/预测市场）。缺数据写“没取到”，不编。",
  };
}

// ── 周报输入 ──

export interface WeeklyPdfInput {
  sunday: string;
  weekStart: string;
  weekEnd: string;
  tradingDays: string[];
  indexWeeklyPct: number | null;
  allAMedianWeeklyPct: number | null;
  strongest: { name: string; weeklyPct: number }[];
  weakest: { name: string; weeklyPct: number }[];
  mainLine: { name: string; weeklyPct: number }[];
  mainLineChange: string;
  picksPlain: string;
  picksDays: number;
  picksFilledDays: number;
  avgWinPct: number | null;
  avgBenchPct: number | null;
  limitUpLeaders: { name: string; symbol: string; tradeDate: string; boards: number | null; changePct: number | null }[];
  fedPlain: string;
  fedMeetings: { meeting: string; date: string | null }[];
  nextWeekTradingDays: string[];
  nextWeekHolidayWindows: { start: string; end: string; len: number }[];
  nextWeekPlain: string;
  hasData: boolean;
}

export function buildWeeklyPdfModel(input: WeeklyPdfInput): PdfDocModel {
  const missing: string[] = [];
  const sections: PdfSection[] = [];
  const range = `${input.weekStart}～${input.weekEnd}`;

  // 1. 大盘
  const marketParas = [
    input.tradingDays.length
      ? `本周（${range}）共 ${input.tradingDays.length} 个交易日有板块快照。`
      : `本周（${range}）交易日没取到。`,
    input.indexWeeklyPct == null
      ? "大盘：上证指数本周涨跌没取到（日 K 里没有指数行）。"
      : `大盘：上证指数本周${input.indexWeeklyPct >= 0 ? "涨" : "跌"} ${Math.abs(input.indexWeeklyPct).toFixed(2)}%。`,
    input.allAMedianWeeklyPct == null
      ? "全市场中位个股本周涨跌没取到。"
      : `全市场中位个股本周${input.allAMedianWeeklyPct >= 0 ? "涨" : "跌"} ${Math.abs(input.allAMedianWeeklyPct).toFixed(2)}%（复利口径）。`,
  ];
  if (input.indexWeeklyPct == null) missing.push("大盘（上证指数本周涨跌）没取到");
  sections.push(section("market", "一、大盘", marketParas, {
    table: {
      headers: ["指标", "本周"],
      rows: [
        ["上证指数（首收→末收）", fmtPct(input.indexWeeklyPct)],
        ["全市场中位个股（复利）", fmtPct(input.allAMedianWeeklyPct)],
      ],
      widths: [2.5, 1.5],
    },
  }));

  // 2. 板块资金（周度资金归档暂无 → 如实写没取到，不拿单日资金冒充一周资金）
  sections.push(section("sector-flow", "二、板块资金", [
    "板块资金：本周资金汇总没取到（周度资金归档暂无，不拿单日资金冒充一周资金）。下面“板块本周涨跌”只看价格，不代表资金。",
  ]));
  missing.push("板块资金（周度汇总）没取到");

  // 3. 板块本周涨跌 + 分歧提示（分歧是日度口径，周报里不编周分歧）
  const boardParas = [
    input.strongest.length
      ? `最强板块：${input.strongest.map((s) => `${s.name}（${fmtPct(s.weeklyPct)}）`).join("、")}。`
      : "最强板块：本周板块快照没取到，算不出。",
    input.weakest.length
      ? `最弱板块：${input.weakest.map((s) => `${s.name}（${fmtPct(s.weeklyPct)}）`).join("、")}。`
      : "最弱板块：本周板块快照没取到，算不出。",
    "分歧：分歧是日度口径（当天钱和价打架），周报不编一周分歧，看本周各日报的分歧一节。",
  ];
  const boardTable: PdfTable | undefined = (input.strongest.length || input.weakest.length)
    ? {
        headers: ["方向", "板块", "本周涨跌"],
        rows: [
          ...input.strongest.map((s) => ["最强", s.name, fmtPct(s.weeklyPct)]),
          ...input.weakest.map((s) => ["最弱", s.name, fmtPct(s.weeklyPct)]),
        ],
        widths: [1, 2.2, 1.4],
      }
    : undefined;
  const boardBars: PdfBars | undefined = (input.strongest.length || input.weakest.length)
    ? {
        title: "板块本周涨跌（%）",
        items: [
          ...input.strongest.map((s) => ({ label: s.name, value: s.weeklyPct, display: fmtPct(s.weeklyPct) })),
          ...input.weakest.map((s) => ({ label: s.name, value: s.weeklyPct, display: fmtPct(s.weeklyPct) })),
        ],
      }
    : undefined;
  if (!input.strongest.length) missing.push("板块本周涨跌没取到");
  sections.push(section("sector-weekly", "三、板块本周涨跌", boardParas, { table: boardTable, bars: boardBars }));

  // 4. 涨停板（涨停龙头）
  const luParas = input.limitUpLeaders.length
    ? [`涨停龙头（本周连板 3 板以上）：${input.limitUpLeaders.map((r) => `${r.name}（${r.boards ?? "?"} 连板，${r.tradeDate}）`).join("、")}。`]
    : ["涨停龙头：本周没有 3 连板以上的涨停龙头（或涨停名单没取到）。"];
  const luTable: PdfTable | undefined = input.limitUpLeaders.length
    ? {
        headers: ["股票", "代码", "日期", "连板", "涨跌幅"],
        rows: input.limitUpLeaders.map((r) => [r.name, r.symbol, r.tradeDate, r.boards == null ? PDF_MISSING : `${r.boards}`, fmtPct(r.changePct)]),
        widths: [1.8, 1.6, 1.2, 0.8, 1],
      }
    : undefined;
  sections.push(section("limit-up", "四、涨停板", luParas, { table: luTable }));

  // 5. 减持风险（周汇总暂无）
  sections.push(section("reduction", "五、减持风险", [
    "减持风险：本周全周减持汇总没取到（巨潮公告只在日报里按日汇总，不编一周总数）；主线里的票有没有连续减持，看本周各日报的主线减持一节。",
  ]));
  missing.push("减持风险（周汇总）没取到");

  // 6. AI 优选（周报只汇总战绩，逐只 11 字段卡见当日日报）
  const aiParas = [
    input.picksPlain,
    "逐只 11 字段卡：周报只汇总战绩，不重复贴逐只卡；逐只 11 字段卡见当日日报 PDF 的“AI 优选”一节。",
  ];
  sections.push(section("ai-pick", "六、AI 优选（本周战绩）", aiParas, {
    table: {
      headers: ["指标", "本周"],
      rows: [
        ["计入战绩天数", `${input.picksDays} 天`],
        ["已回填天数", `${input.picksFilledDays} 天`],
        ["平均次日净收益（扣费后，等权）", fmtPct(input.avgWinPct)],
        ["同期全 A 中位基准", fmtPct(input.avgBenchPct)],
      ],
      widths: [2.5, 1.5],
    },
  }));
  if (!input.picksDays) missing.push("AI 优选战绩没取到");

  // 7. 美股（周报无美股周汇总数据源）
  sections.push(section("us-market", "七、美股", [
    "美股：本周美股汇总没取到（周报无美股周汇总数据源，不拿某一天收盘冒充一周）；美股昨晚收盘见当日日报 PDF 的“美股”一节。",
  ]));
  missing.push("美股（周汇总）没取到");

  // 8. 美联储
  const fedParas = [input.fedPlain];
  const fedTable: PdfTable | undefined = input.fedMeetings.length
    ? {
        headers: ["会议", "日期"],
        rows: input.fedMeetings.map((m) => [m.meeting, m.date ?? PDF_MISSING]),
        widths: [2, 1.5],
      }
    : undefined;
  sections.push(section("fed", "八、美联储", fedParas, { table: fedTable }));

  // 9. 主线
  const mainParas = [
    input.mainLine.length
      ? `本周主线：${input.mainLine.map((s) => `${s.name}（${fmtPct(s.weeklyPct)}）`).join("、")}。`
      : "本周主线：没有涨的板块，没有明确的主线。",
    input.mainLineChange,
  ];
  sections.push(section("main-line", "九、主线", mainParas, {
    table: input.mainLine.length
      ? {
          headers: ["主线板块", "本周涨跌"],
          rows: input.mainLine.map((s) => [s.name, fmtPct(s.weeklyPct)]),
          widths: [2.5, 1.5],
        }
      : undefined,
  }));

  // 10. 下周看什么
  sections.push(section("next-week", "十、下周看什么", [
    input.nextWeekPlain,
    input.nextWeekTradingDays.length
      ? `下周交易日：${input.nextWeekTradingDays.join("、")}。`
      : "下周交易日：交易日历没取到，算不出下周哪天开盘。",
    input.nextWeekHolidayWindows.length
      ? `下周休市：${input.nextWeekHolidayWindows.map((h) => `${h.start}—${h.end}（${h.len} 天）`).join("、")}。`
      : "下周休市：下周没有连续 2 天以上的休市段（或交易日历没取到）。",
    "财报：没取到（暂无财报日历数据源，不编）。解禁：没取到（暂无解禁日历数据源，不编）。",
  ]));

  return {
    title: `周报 · ${input.weekStart}～${input.sunday}`,
    subtitle: "周日晚上会议简报：本周总结 + 下周看什么",
    meta: [
      `本周：${input.weekStart}～${input.weekEnd}（本周日 ${input.sunday}）`,
      `数据归属：过去一周（周一～周日）`,
      input.hasData ? "状态：有本周板块快照" : "状态：本周板块快照没取到，只有缺数说明",
    ],
    sections,
    missing: [...new Set(missing)],
    sources: "数据来源：板块快照归档（板块本周涨跌/主线）、上证日 K（大盘）、AI 优选战绩（已回填次日净收益）、涨停名单（涨停龙头）、预测市场（美联储）、交易日历（下周交易日/休市）。缺数据写“没取到”，不编。",
  };
}

// ── 历史日报落档（只有正文，无结构化快照）──

export function buildStoredTextPdfModel(input: {
  slotTitle: string;
  issueDate: string;
  dataDate: string;
  dataBelongsTo: string;
  generatedAt: string;
  preliminary: boolean;
  sections: { title: string; plain: string }[];
  missing: string[];
  /** 覆盖默认副标题（默认“历史日报 PDF…”；瘦身版传“非交易日瘦身版…”） */
  subtitle?: string;
  /** 默认 true：追加“历史日报结构化表格未归档”说明；瘦身版传 false */
  historicalNote?: boolean;
}): PdfDocModel {
  return {
    title: `${input.slotTitle} · ${input.issueDate}`,
    subtitle: input.subtitle ?? "历史日报 PDF：仅展示落档正文（当天结构化快照未归档）",
    meta: [
      `签发日：${input.issueDate}`,
      `数据归属：${input.dataBelongsTo}`,
      `生成时刻：${input.generatedAt}（北京时间）`,
      input.preliminary ? "状态：盘中快照，未到收盘/午盘时刻，不是定稿" : "状态：定稿",
    ],
    sections: input.sections.map((s, i) => section(`stored-${i}`, s.title, [s.plain])),
    missing: [
      ...input.missing,
      ...(input.historicalNote === false
        ? []
        : ["历史日报：板块资金/分歧/涨停/减持/美股/美联储的结构化表格只在当天生成时有，落档里只有正文，本 PDF 不拿今天的数据冒充当天的数据。"]),
    ],
    sources: "数据来源：当日落档正文（data/daily-reports）。缺数据写“没取到”，不编。",
  };
}
