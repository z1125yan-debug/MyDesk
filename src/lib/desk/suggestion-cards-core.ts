// P58 稳智「试试这样问」8 卡 —— 按前端产物原文重建（2026-09-27 实扒 AiMatrixHome-BfRKOdmM.js）。
//
// 为什么这一版把「弹窗要问哪几个条件」和「提问怎么拼」都收进同一份代码：
// 稳智那八张卡不是八段固定文案，而是 { label, mode, text } 三元组——
//   · mode 决定这张卡弹不弹参数窗、窗里要用户补哪些条件（股票/成本/仓位/操作/周期/均线）
//   · 拼装函数决定补完条件后**最终发给模型的那一句长什么样**
//   · direct 类卡不弹任何窗，整句一字不差直接发
// 本页此前（P57）用的是改写版文案、又把品种一律换成 focusSymbol 直接发，条件那一半丢了；
// 而 AiHomePage 早在 2026-09-26 就自己抄了一份 QUICK_CARDS（同样的 8 张、另一套字段名）。
// 两份 8 卡迟早漂，这里收成唯一定义处，两个页面都从这里出。
//
// 文案口径：8 张主卡的提问模板与稳智逐字符对齐（含"本地没有的数据直接实时搜索"这类
// 它们写死在提问里的指令）；另附 7 个稳智有、但没摆在首页的隐藏模板，同一引擎可直接取用。

// 值导入带 .ts 后缀是本仓 *-core 的既有纪律（tests/ 下用 node --test 直跑，扩展名不写全会解析不到）
import type { ChatHorizon, ChatMode } from "./modes.ts";
import { CHAT_HORIZONS } from "./modes.ts";
// 建仓日期：清洗与「怎么用」的规则在 hold-core 一处定义（composer 小窗 / 服务端提示词同吃这一份），
// 这里只借它的 normalizeOpenDate——卡片弹窗里填的日期和 composer 里填的必须是同一个形状。
import { normalizeOpenDate, type HoldCtx } from "./hold-core.ts";

/* ---------------- 条件窗字段 ---------------- */

/** 一张卡的条件槽位。顺序即弹窗里的出现顺序（对齐稳智 message() 的渲染顺序）。 */
export type CardFieldKey =
  | "subject"    // 股票名称或代码 / 板块名 / 多只股票
  | "cost"       // 当前大概成本价
  | "position"   // 当前仓位占比（选填）
  | "openDate"   // 建仓日期（选填，YYYY-MM-DD）——只出现在持仓类卡上
  | "action"     // 操作方向（单选）
  | "horizon"    // 分析周期（单选）
  | "ma";        // 关键均线（单选）

export type SubjectKind = "stock" | "sector" | "stock_or_sector" | "multi_stock";

export interface FieldSpec {
  key: CardFieldKey;
  label: string;
  placeholder?: string;
  required?: boolean;
  /** 缺失时的提示语（稳智是 El.warning(这一句)） */
  missing?: string;
}

/** 用户在条件窗里填出来的东西 */
export interface CardInput {
  subject: string;
  /** 多股卡的解析结果（其余卡在非空时也只有一份） */
  subjects: string[];
  cost: string;
  position: string;
  /** 建仓日期（YYYY-MM-DD）。空串＝用户没填，问句里一个字都不提 */
  openDate: string;
  /** 周期裸标签（"短线"），给 chip / 徽章这类要短字的地方 */
  horizonLabel: string;
  /** 进问句的周期口径短语（"短线（1-3 天）"）——稳智就是把 "短线3-5天" 整串塞进句子的 */
  horizonEmbed: string;
  actionLabel: string;
  maLabel: string;
  /** 周期键，用于写回 store.assistantHorizon；null = 不动用户当前选择 */
  horizonKey: ChatHorizon | null;
  /** 从 subject 里拆出的名称与 6 位代码，随请求带给服务端省一次识别 */
  stockName: string;
  stockSymbol: string;
}

export const EMPTY_CARD_INPUT: CardInput = {
  subject: "", subjects: [], cost: "", position: "", openDate: "",
  horizonLabel: "", horizonEmbed: "", actionLabel: "", maLabel: "", horizonKey: null,
  stockName: "", stockSymbol: "",
};

/* ---------------- 三组单选项 ---------------- */

export const CARD_ACTIONS: { value: string; label: string }[] = [
  { value: "buy", label: "买入" },
  { value: "reduce", label: "减仓" },
  { value: "absorb", label: "低吸" },
  { value: "trade_t", label: "做T" },
];

export const CARD_MAS = ["MA5", "MA10", "MA20"] as const;

/**
 * 弹窗里的周期选项。
 * 稳智把三档写死成 "超短1-2天 / 短线3-5天 / 中线1-2个月" 并整串塞进问句。本仓 composer 的周期
 * chip 是 5 档、且 HORIZON_NOTES 交给服务端的口径是 short=1-3天 / mid=5-20天，
 * 照抄稳智括号里的天数会让「问句说的」「chip 显示的」「系统提示词告诉模型的」三处对不上。
 * 所以 key 用本仓的（写回 store、进提示词），embed 用本仓口径拼出的短语（进问句）。
 */
export const CARD_HORIZONS: { key: ChatHorizon; label: string; embed: string }[] = CHAT_HORIZONS.map((h) => ({
  key: h.key,
  label: h.label,
  embed: `${h.label}（${h.desc}）`,
}));

export function horizonLabelOf(key: ChatHorizon | null): string {
  return CHAT_HORIZONS.find((h) => h.key === key)?.label ?? "";
}

export function horizonEmbedOf(key: ChatHorizon | null): string {
  return CARD_HORIZONS.find((h) => h.key === key)?.embed ?? "";
}

/* ---------------- 输入清洗（对齐稳智的 Ze/On 与 jn/Ji 两组函数） ---------------- */
// 稳智有两套几乎一样的清洗：Ze/On 把连续空白压成一个空格，jn/Ji 直接删掉所有空白。
// 差别是有用的：成本价 "2 3.80" 应该变成 "23.80"，而股票名 "宁德 时代" 不该粘成 "宁德时代"。

const collapse = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ");
const stripAll = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, "");

/** 多股解析（稳智 `Wi`）：按 换行/半全角逗号/顿号/分号/斜杠 切，trim，去重，取前 8 只 */
export function parseSubjects(raw: string): string[] {
  const seen = new Set<string>();
  return String(raw ?? "")
    .split(/[\n\r,，、;；/]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => (seen.has(s) ? false : (seen.add(s), true)))
    .slice(0, 8);
}

/** 从「伟创电气 / 688698」这类写法里拆出名称与 6 位代码（稳智 `$n`） */
export function splitSubject(raw: string): { stockName: string; stockSymbol: string } {
  const s = collapse(raw);
  if (!s) return { stockName: "", stockSymbol: "" };
  const parts = s.split(/[\/|｜,，;；\s]+/).map((p) => p.trim()).filter(Boolean);
  let name = "";
  let code = "";
  for (const p of parts) {
    if (!code && /^\d{6}$/.test(p)) { code = p; continue; }
    if (!name) name = p;
  }
  if (!name && !code && /^\d{6}$/.test(s)) code = s;
  if (!name && s !== code) name = s;
  return { stockName: name, stockSymbol: code };
}

/* ---------------- 提问拼装函数（稳智原文逐条） ---------------- */
// 每个函数都照搬稳智的模板字符串；条件不全返回 ""，调用方据此不发（稳智同口径）。

/** 卡1 七维个股分析（稳智 `Qi`） */
export const buildSevenDimension = (subject: string) => {
  const s = collapse(subject);
  return s
    ? `请用七维框架全面分析${s}：市场环境15%、产业逻辑20%、基本面20%、资金行为20%、技术面20%、综合判断5%，并给出可执行的入局计划。每一维都要列出关键数据、证据和结论，进行多源交叉验证；本地没有的数据直接实时搜索，盘中必须加载实时行情。最后明确现在适合参与、等待还是回避，并给入场条件、仓位建议、失效条件和主要风险。`
    : "";
};

/** 建仓日期那一句：没填返回 ""（问句里一个字都不提，不写「建仓日期未提供」） */
const openDateClause = (openDate: string) => {
  const d = normalizeOpenDate(openDate);
  return d ? `，${d} 建的仓` : "";
};

/**
 * 只在真给了建仓日期时才加的那句「怎么用它」。
 * 没给日期时挂上去等于往问句里塞一句用不上的指令——稳智自己也是「条件决定问句」，不是八股。
 *
 * 注意：这里**不带结尾标点**。原来写成了「…；」，没填日期时那一句就悬在句尾变成分号，
 * 把整句的句号顶掉了（p58 逐字对齐钉测当场抓到）。收口统一交给下面的 joinTail()。
 */
const openDateInstruction = (openDate: string) =>
  normalizeOpenDate(openDate)
    ? "按它到最近交易日的跨度算已持有几个交易日，再按那个持有长度给节奏，不要一律按短线答"
    : "";

/** 若干条指令拼成一句：中间用分号、末尾一个句号。空条目不占位，不留悬空标点。 */
const joinTail = (...parts: string[]) => `${parts.filter(Boolean).join("；")}。`;

/**
 * 卡2 持仓按成本处理（稳智 `Zi`）：成本必填，仓位/建仓日期选填。
 * 建仓日期是本地加的一档（稳智没有）：多了它，模型才知道「拿了多久」，
 * 否则同一句「我持有 X，成本 C」在拿了 2 天和拿了 2 个月的人身上是两种答案。
 * 「怎么用它」写成问句里的一条指令——稳智自己也是这么干的（把要求写死在提问里）。
 */
export const buildCostPlan = (subject: string, cost: string, position: string, openDate = "") => {
  const s = collapse(subject);
  const c = stripAll(cost);
  const p = stripAll(position);
  if (!s || !c) return "";
  return `我持有${s}，当前成本大概${c}${p ? `，当前仓位约${p}` : ""}${openDateClause(openDate)}。请结合最新行情，先判断当前持仓状态，再给继续持有、分批减仓和重新评估的条件。${joinTail("不要以回本作为判断依据", "仓位未知时请说明", openDateInstruction(openDate))}`;
};

/** 卡3 盘中买点策略（稳智 `Yi`）：股票 + 周期，两者缺一不发 */
export const buildBuyDecision = (subject: string, horizon: string) => {
  const s = collapse(subject);
  const h = String(horizon ?? "").trim();
  if (!s || !h) return "";
  return `我考虑买入${s}，计划持有${h}。请核对最新行情和重要消息，先判断现在参与还是等待，再给有依据的入场条件、失效条件和主要风险；没有合适机会就直接说明。`;
};

/** 卡4 多股强弱对比（稳智 `Gi`）：吃解析出来的数组，拼成「A、B、C」 */
export const buildCompare = (subjects: string[]) => {
  const list = Array.isArray(subjects) ? subjects.map((s) => String(s ?? "").trim()).filter(Boolean) : [];
  if (!list.length) return "";
  return `请对比${list.join("、")}，结合最新行情、产业逻辑、基本面、资金行为和技术面做多维交叉验证，给出强弱排序、各自参与条件、失效条件和主要风险；本地缺少的数据请实时搜索，盘中加载实时行情。`;
};

/** 卡5 板块低吸窗口（稳智 `io`） */
export const buildSectorStage = (sector: string) => {
  const s = collapse(sector);
  return s
    ? `帮我看${s}板块的资金流、均线广度占比和情绪强弱，目前处于什么阶段、是否值得观察？请先给判断，再给参与条件和退潮信号，不预设低吸有效。`
    : "";
};

/** 卡8 灵活策略模板（稳智 `oo`）：标的 + 操作 + 周期，三者齐了才发 */
export const buildFlexPlan = (subject: string, actionLabel: string, horizon: string) => {
  const s = collapse(subject);
  const a = String(actionLabel ?? "").trim();
  const h = String(horizon ?? "").trim();
  if (!s || !a || !h) return "";
  return `结合实时行情，分析${s}现在能不能${a}，按${h}思路，先判断是否可行，再给有依据的触发条件、失效条件、仓位口径和风险；做T需考虑已有底仓与当日可卖数量。`;
};

/* ---- 稳智有、但没排在首页的 7 个隐藏模板（同一引擎，扩展卡直接用） ---- */

/** 持仓先拿还是减（稳智 `Xi`）：成本选填，填了多一句；建仓日期选填，填了多一句 */
export const buildHoldOrReduce = (subject: string, cost: string, openDate = "") => {
  const s = collapse(subject);
  const c = stripAll(cost);
  if (!s) return "";
  const tail = "盘中该继续拿还是先减一点？结合实时行情给我减仓条件、失效条件和仓位建议。";
  if (c) return `我现在持有${s}，当前成本大概${c}${openDateClause(openDate)}。${tail}${joinTail("别以回本当卖点", openDateInstruction(openDate))}`;
  if (normalizeOpenDate(openDate)) return `我现在持有${s}${openDateClause(openDate)}（成本未提供，按不知道成本处理）。${tail}${joinTail(openDateInstruction(openDate))}`;
  return `我现在持有${s}，${tail}`;
};

/** 回踩低吸判断（稳智 `eo`） */
export const buildPullbackCheck = (subject: string) => {
  const s = collapse(subject);
  return s ? `${s}最近回落，这是正常回踩还是趋势转弱？请先核对最新行情、量能和资金数据，给出确认信号、参与条件及失效条件；没有机会就说明等待。` : "";
};

/** 接飞刀还是回踩（稳智 `to`） */
export const buildKnifeOrPullback = (subject: string) => {
  const s = collapse(subject);
  return s ? `${s}现在是接飞刀还是接回踩？请结合实时走势、最新消息面/公告、量能、承接和资金流给我低吸纪律。` : "";
};

/** 跌到一个月均价附近还能买吗（稳智 `no`）：选哪条均价必填 */
export const buildMaAbsorb = (subject: string, maLabel: string) => {
  const s = collapse(subject);
  const m = String(maLabel ?? "").trim();
  if (!s || !m) return "";
  return `${s}回踩${m}附近，现在还能不能吸一口？结合盘中实时行情给我低吸策略和风险提示。`;
};

/** 现价还能不能参与（稳智 `ro`）：周期必选 */
export const buildCurrentEntry = (subject: string, horizon: string) => {
  const s = collapse(subject);
  const h = String(horizon ?? "").trim();
  if (!s || !h) return "";
  return `${s}现价还能不能参与？结合最新消息面/公告，按${h}看，给我操作计划、买点、风险点和仓位安排。`;
};

/** 跌破一个月均价怎么办（稳智 `ao`）：选哪条均价必填 */
export const buildBreakMa = (subject: string, maLabel: string) => {
  const s = collapse(subject);
  const m = String(maLabel ?? "").trim();
  if (!s || !m) return "";
  return `如果${s}盘中跌破${m}怎么办？请区分盘中短暂跌破与收盘确认，结合量能给出持仓纪律、减仓条件和重新评估信号。`;
};

/** 超短轻仓试错（稳智 `so`） */
export const buildUltraShortProbe = (subject: string) => {
  const s = collapse(subject);
  return s ? `我想做${s}的1到2天超短，结合最新消息面/公告，当前能不能轻仓试错抄底博反弹？请直接告诉我能不能做、怎么买、哪里止损。` : "";
};

/* ---------------- 卡定义 ---------------- */

export type WzMode =
  | "direct"
  | "stock_seven_dimension_input"
  | "stock_cost_input"
  | "stock_and_horizon_input"
  | "stock_input"
  | "sector_low_absorb_input"
  | "subject_action_horizon_input"
  | "stock_reduce_input"
  | "stock_low_absorb_input"
  | "stock_catch_falling_input"
  | "stock_ma_pullback_input"
  | "stock_current_entry_input"
  | "stock_break_ma_input"
  | "stock_ultra_short_probe_input";

export interface SuggestionCard {
  /** 卡面短文案（稳智同款） */
  label: string;
  /** 稳智的 mode：决定这张卡弹不弹窗、弹哪个窗 */
  wzMode: WzMode;
  /** 条件窗标题/副标题（稳智 dialogs 原文；direct 卡为空） */
  dialogTitle: string;
  dialogSubtitle: string;
  /** 确认按钮文案。稳智只有两处不是「生成并发送」：多股卡是「开始分析」，direct 卡压根没窗 */
  confirmText: string;
  subjectKind: SubjectKind;
  subjectLabel: string;
  subjectPlaceholder: string;
  /** subject 之外的附加槽位，按弹窗出现顺序 */
  fields: FieldSpec[];
  /** 单选项的默认值（稳智 defaultHorizon:"short_term" / defaultAction:"buy" / 均线默认 MA20 或 MA10） */
  defaults: { horizon?: ChatHorizon; action?: string; ma?: string };
  /** 回答风格：点卡时写进 store.assistantMode（稳智没有这一档，是本仓 mode 体系的等价物） */
  chatMode: ChatMode;
  /** 拼装：条件不全返回 ""，调用方一律不发 */
  build: (v: CardInput) => string;
}

const noDefaults = {} as const;

/** 首页那 8 张，顺序与稳智 ai-matrix 落地页一致 */
export const SUGGESTION_CARDS_CORE: SuggestionCard[] = [
  {
    label: "七维分析一只股票",
    wzMode: "stock_seven_dimension_input",
    dialogTitle: "七维个股分析",
    dialogSubtitle: "从市场、产业、基本面、资金和技术等维度交叉验证，并形成入局计划。",
    confirmText: "生成并发送",
    subjectKind: "stock",
    subjectLabel: "股票名称或代码",
    subjectPlaceholder: "例如：科大讯飞 / 002230",
    fields: [],
    defaults: noDefaults,
    chatMode: "deep",
    build: (v) => buildSevenDimension(v.subject),
  },
  {
    label: "按成本制定持仓计划",
    wzMode: "stock_cost_input",
    dialogTitle: "持仓按成本处理",
    dialogSubtitle: "补上股票和你的成本价，方便模型直接给持仓处理计划。",
    confirmText: "生成并发送",
    subjectKind: "stock",
    subjectLabel: "股票名称或代码",
    subjectPlaceholder: "例如：伟创电气 / 688698",
    fields: [
      { key: "cost", label: "当前大概成本价", placeholder: "例如：23.80", required: true, missing: "请先输入持仓成本价" },
      { key: "position", label: "当前仓位占比（选填）", placeholder: "例如：总仓位的20% / 2成仓" },
      { key: "openDate", label: "建仓日期（选填）", placeholder: "选填：哪天买的，用来判断已持有几个交易日" },
    ],
    defaults: noDefaults,
    chatMode: "decision",
    build: (v) => buildCostPlan(v.subject, v.cost, v.position, v.openDate),
  },
  {
    label: "判断现在能否买入",
    wzMode: "stock_and_horizon_input",
    dialogTitle: "盘中买点策略",
    dialogSubtitle: "输入股票名并选择这次分析周期，我会帮你生成一条更容易命中实时策略分析的问句。",
    confirmText: "生成并发送",
    subjectKind: "stock",
    subjectLabel: "股票名称或代码",
    subjectPlaceholder: "例如：伟创电气 / 688698",
    fields: [{ key: "horizon", label: "选择分析周期", required: true, missing: "请先选择分析周期" }],
    defaults: { horizon: "short" },
    chatMode: "decision",
    build: (v) => buildBuyDecision(v.subject, v.horizonEmbed),
  },
  {
    label: "对比多只股票强弱",
    wzMode: "stock_input",
    dialogTitle: "输入股票",
    dialogSubtitle: "可直接输入股票名称、6位代码，或把多只股票一起贴进来。支持逗号、顿号、分号、斜杠或换行分隔，最多 8 只。",
    confirmText: "开始分析",
    subjectKind: "multi_stock",
    subjectLabel: "多只股票（一行一只或用分隔符）",
    subjectPlaceholder: "例如：\n贵州茅台\n600519\n宁德时代，比亚迪",
    fields: [],
    defaults: noDefaults,
    chatMode: "judge",
    build: (v) => buildCompare(v.subjects),
  },
  {
    label: "分析板块当前阶段",
    wzMode: "sector_low_absorb_input",
    dialogTitle: "板块低吸窗口",
    dialogSubtitle: "适合直接问指定板块的资金流、均线广度占比、情绪强弱，以及当前是否具备低吸机会。",
    confirmText: "生成并发送",
    subjectKind: "sector",
    subjectLabel: "板块名称",
    subjectPlaceholder: "例如：电力 / 风电 / 银行 / 机器人",
    fields: [],
    defaults: noDefaults,
    chatMode: "judge",
    build: (v) => buildSectorStage(v.subject),
  },
  {
    label: "判断今日仓位策略",
    wzMode: "direct",
    dialogTitle: "",
    dialogSubtitle: "",
    confirmText: "",
    subjectKind: "stock",
    subjectLabel: "",
    subjectPlaceholder: "",
    fields: [],
    defaults: noDefaults,
    chatMode: "decision",
    // direct：稳智整句直发，一字不差（提问里就写了"注明数据时间"）
    build: () => "请结合最新可获取的大盘、成交额、涨跌分布和板块轮动，判断今天更适合积极参与还是控制仓位。先给判断，再说依据、值得观察的方向和判断失效的信号，注明数据时间。",
  },
  {
    label: "筛选持续流入板块",
    wzMode: "direct",
    dialogTitle: "",
    dialogSubtitle: "",
    confirmText: "",
    subjectKind: "sector",
    subjectLabel: "",
    subjectPlaceholder: "",
    fields: [],
    defaults: noDefaults,
    chatMode: "search",
    build: () => "近期哪些板块的资金流入更持续？请在数据支持的范围内筛选最多3个观察方向，比较持续性、拥挤程度和风险，并说明参与条件。没有足够证据或没有合格方向时直接说明，不凑数量。",
  },
  {
    label: "制定股票交易计划",
    wzMode: "subject_action_horizon_input",
    dialogTitle: "灵活策略模板",
    dialogSubtitle: "可输入股票名或板块名，再选择操作方向和周期，快速生成一条泛化盘中策略问句。",
    confirmText: "生成并发送",
    subjectKind: "stock_or_sector",
    subjectLabel: "股票名、代码或板块名",
    subjectPlaceholder: "例如：伟创电气 / 机器人板块",
    fields: [
      { key: "action", label: "选择操作方向", required: true, missing: "请先选择操作方向" },
      { key: "horizon", label: "选择分析周期", required: true, missing: "请先选择分析周期" },
    ],
    defaults: { action: "buy", horizon: "short" },
    chatMode: "decision",
    build: (v) => buildFlexPlan(v.subject, v.actionLabel, v.horizonEmbed),
  },
];

/** 稳智有、首页没排的 7 张（同一引擎，「更多问法」面板直接吃这份） */
export const EXTRA_SUGGESTION_CARDS: SuggestionCard[] = [
  {
    label: "持仓先拿还是减", wzMode: "stock_reduce_input",
    dialogTitle: "持仓先拿还是减",
    dialogSubtitle: "适合盘中问“继续拿、先减一点、怎么控仓”这类持仓执行问题。成本价选填，填了结论会更贴近你的持仓位置。",
    confirmText: "生成并发送", subjectKind: "stock",
    subjectLabel: "股票名称或代码", subjectPlaceholder: "例如：中控技术 / 688777",
    fields: [{ key: "cost", label: "当前大概成本价（选填）", placeholder: "例如：23.80" },
      { key: "openDate", label: "建仓日期（选填）", placeholder: "选填：哪天买的，用来判断已持有几个交易日" }],
    defaults: noDefaults, chatMode: "decision",
    build: (v) => buildHoldOrReduce(v.subject, v.cost, v.openDate),
  },
  {
    label: "回踩低吸判断", wzMode: "stock_low_absorb_input",
    dialogTitle: "回踩低吸判断",
    dialogSubtitle: "适合盘中看回踩承接、量能和资金流是否支持低吸。",
    confirmText: "生成并发送", subjectKind: "stock",
    subjectLabel: "股票名称或代码", subjectPlaceholder: "例如：宁德时代 / 300750",
    fields: [], defaults: noDefaults, chatMode: "decision",
    build: (v) => buildPullbackCheck(v.subject),
  },
  {
    label: "接飞刀还是回踩", wzMode: "stock_catch_falling_input",
    dialogTitle: "接飞刀还是回踩",
    dialogSubtitle: "适合区分当前位置到底是危险接飞刀，还是可观察的回踩承接。",
    confirmText: "生成并发送", subjectKind: "stock",
    subjectLabel: "股票名称或代码", subjectPlaceholder: "例如：东方财富 / 300059",
    fields: [], defaults: noDefaults, chatMode: "judge",
    build: (v) => buildKnifeOrPullback(v.subject),
  },
  {
    label: "跌到一个月均价附近还能买吗", wzMode: "stock_ma_pullback_input",
    dialogTitle: "跌到一个月均价附近还能买吗",
    dialogSubtitle: "适合盘中问回踩 MA10 或 MA20 附近还能不能低吸。",
    confirmText: "生成并发送", subjectKind: "stock",
    subjectLabel: "股票名称或代码", subjectPlaceholder: "例如：宁德时代 / 300750",
    fields: [{ key: "ma", label: "选择回踩均线", required: true, missing: "请先选择回踩均线" }],
    defaults: { ma: "MA20" }, chatMode: "decision",
    build: (v) => buildMaAbsorb(v.subject, v.maLabel),
  },
  {
    label: "现价还能不能参与", wzMode: "stock_current_entry_input",
    dialogTitle: "现价还能不能参与",
    dialogSubtitle: "适合盘中直接问现价还能不能参与，并明确短线或中线的执行计划。",
    confirmText: "生成并发送", subjectKind: "stock",
    subjectLabel: "股票名称或代码", subjectPlaceholder: "例如：五粮液 / 000858",
    fields: [{ key: "horizon", label: "选择分析周期", required: true, missing: "请先选择分析周期" }],
    defaults: { horizon: "short" }, chatMode: "decision",
    build: (v) => buildCurrentEntry(v.subject, v.horizonEmbed),
  },
  {
    label: "跌破一个月均价怎么办", wzMode: "stock_break_ma_input",
    dialogTitle: "跌破一个月均价怎么办",
    dialogSubtitle: "适合盘中问跌破 MA5、MA10 或 MA20 后的持仓纪律与止损处理。",
    confirmText: "生成并发送", subjectKind: "stock",
    subjectLabel: "股票名称或代码", subjectPlaceholder: "例如：中控技术 / 688777",
    fields: [{ key: "ma", label: "选择关键均线", required: true, missing: "请先选择关键均线" }],
    defaults: { ma: "MA10" }, chatMode: "decision",
    build: (v) => buildBreakMa(v.subject, v.maLabel),
  },
  {
    label: "超短轻仓试错", wzMode: "stock_ultra_short_probe_input",
    dialogTitle: "超短轻仓试错",
    dialogSubtitle: "适合盘中明确问 1 到 2 天超短、轻仓试错、抄底博反弹这类执行型问题。",
    confirmText: "生成并发送", subjectKind: "stock",
    subjectLabel: "股票名称或代码", subjectPlaceholder: "例如：伟创电气 / 688698",
    fields: [], defaults: noDefaults, chatMode: "decision",
    build: (v) => buildUltraShortProbe(v.subject),
  },
];

/** 15 张全池（首页 8 + 隐藏 7），按模式分组时从这里取，不复制第二份定义 */
export const ALL_SUGGESTION_CARDS: SuggestionCard[] = [...SUGGESTION_CARDS_CORE, ...EXTRA_SUGGESTION_CARDS];
// 「当前模式该展示哪 8 张」不放在本文件：那是另一件事（按模式选卡 vs 卡片自身定义），
// 且那份映射是一串卡面标签字面量——留在 core 里会被「扫源码找快捷问」的钉测当成
// 递到用户嘴边的快捷问抓去分类（p7-intent 实测抓到「判断现在能否买入」判成 general）。
// 见 @/lib/desk/mode-cards.ts。

/* ---------------- 弹窗渲染与校验要用到的派生量 ---------------- */

/** 这张卡要不要弹条件窗（direct 不弹） */
export function needsDialog(card: SuggestionCard): boolean {
  return card.wzMode !== "direct";
}

/** 卡面 hover 提示：稳智用副标题，本地没弹窗的卡说清"直接开始分析" */
export function cardTitle(card: SuggestionCard): string {
  return needsDialog(card) ? card.dialogSubtitle || "填写条件后生成并发送" : "直接开始分析";
}

/** subject 那一栏的规格（标签/占位/缺失提示按 subjectKind 变） */
export function subjectSpec(card: SuggestionCard): FieldSpec {
  const missing =
    card.subjectKind === "sector" ? "请先输入板块名称"
    : card.subjectKind === "multi_stock" ? "请至少输入一只股票名称或代码"
    : card.subjectKind === "stock_or_sector" ? "请先输入股票名称、代码或板块名称"
    : "请先输入股票名称或代码";
  return { key: "subject", label: card.subjectLabel, placeholder: card.subjectPlaceholder, required: true, missing };
}

/** 该卡要渲染的全部槽位（subject 打头，顺序即稳智 message() 的顺序） */
export function fieldsOf(card: SuggestionCard): FieldSpec[] {
  return [subjectSpec(card), ...card.fields];
}

/** 打开弹窗时的初始值（单选按卡自带 defaults 落好，稳智同规则） */
export function initialFormState(card: SuggestionCard): Record<CardFieldKey, string> {
  const init: Record<CardFieldKey, string> = {
    subject: "", cost: "", position: "", openDate: "", action: "", horizon: "", ma: "",
  };
  if (card.defaults.action) init.action = card.defaults.action;
  if (card.defaults.horizon) init.horizon = card.defaults.horizon;
  if (card.defaults.ma) init.ma = card.defaults.ma;
  return init;
}

/**
 * 表单原始值 → CardInput。
 * 单选存的是 key（short / buy / MA20），拼句子要的是中文，换标签这一步就在这里做——
 * 稳智也是同一套路：窗口里存 short_term，buildPrompt 吃 me?.label。
 */
export function toCardInput(card: SuggestionCard, form: Partial<Record<CardFieldKey, string>>): CardInput {
  const rawSubject = String(form.subject ?? "");
  const subject = collapse(rawSubject);
  const horizonKey = (CARD_HORIZONS.find((h) => h.key === form.horizon)?.key ?? null);
  const { stockName, stockSymbol } = splitSubject(subject);
  return {
    subject,
    subjects: card.subjectKind === "multi_stock" ? parseSubjects(rawSubject) : subject ? [subject] : [],
    cost: stripAll(form.cost),
    position: stripAll(form.position),
    openDate: normalizeOpenDate(form.openDate),
    horizonLabel: horizonLabelOf(horizonKey),
    horizonEmbed: horizonEmbedOf(horizonKey),
    actionLabel: CARD_ACTIONS.find((a) => a.value === form.action)?.label ?? "",
    maLabel: String(form.ma ?? ""),
    horizonKey,
    stockName,
    stockSymbol,
  };
}

/** 某槽位在 CardInput 里对应哪个值（校验用；subject 走 subjects 判定，这里不看它） */
function fieldValueOf(v: CardInput, key: CardFieldKey): string {
  switch (key) {
    case "cost": return v.cost;
    case "position": return v.position;
    case "openDate": return v.openDate;
    case "action": return v.actionLabel;
    case "horizon": return v.horizonEmbed;
    case "ma": return v.maLabel;
    default: return v.subject;
  }
}

/**
 * 校验：返回第一条不满足的提示语；null = 可以发。
 * 稳智口径（弹窗 beforeClose）——不满足就 El.warning 并把弹窗留着，**不关闭、不发送**。
 */
export function validateCard(card: SuggestionCard, v: CardInput): string | null {
  if (card.subjectKind === "multi_stock") {
    if (!v.subjects.length) return subjectSpec(card).missing ?? "请先输入股票";
  } else if (!v.subject) {
    return subjectSpec(card).missing ?? "请先输入股票名称或代码";
  }
  for (const f of card.fields) {
    if (!f.required) continue;
    if (!fieldValueOf(v, f.key)) return f.missing ?? `请先填写${f.label}`;
  }
  // 拼装函数自己也可能判定条件不全（例如 Zi 要标的+成本双全），最后再拦一次
  if (!card.build(v)) return "条件没填全，补完再生成";
  return null;
}

/* ---------------- 派发产物 ---------------- */

/** 卡点击后交给页面的东西：要不要弹窗 + 拼好的提问 + 该写回 store 的条件 */
export interface CardDispatch {
  needsDialog: boolean;
  prompt: string;
  chatMode: ChatMode;
  /** null = 这张卡不涉及周期，别动用户当前选择 */
  horizon: ChatHorizon | null;
  /** 随请求带给服务端的结构化标的（省一次识别；空串 = 没识别出来） */
  stockName: string;
  stockSymbol: string;
  /**
   * 这一轮问句里带出去的持仓条件（成本/仓位/建仓日期）。
   * 写回 store 后 composer 的「持仓」小窗会显示同一份，之后追问也沿用——
   * 否则用户填一次成本，第二句「那现在要不要减」就又变成没有成本的泛泛之谈。
   */
  hold: HoldCtx | null;
}

/** direct 卡的一键产物（不弹窗，整句直接发） */
export function directDispatch(card: SuggestionCard): CardDispatch {
  return {
    needsDialog: false,
    prompt: card.build(EMPTY_CARD_INPUT),
    chatMode: card.chatMode,
    horizon: null,
    stockName: "",
    stockSymbol: "",
    hold: null,
  };
}

/** 弹窗「生成并发送」后的产物 */
export function dialogDispatch(card: SuggestionCard, v: CardInput): CardDispatch {
  return {
    needsDialog: true,
    prompt: card.build(v),
    chatMode: card.chatMode,
    horizon: v.horizonKey,
    stockName: v.stockName,
    stockSymbol: v.stockSymbol,
    hold: holdFromCardInput(v),
  };
}

/** CardInput → 持仓上下文。四个字段一个都没有就返回 null（不注入空壳） */
export function holdFromCardInput(v: CardInput): HoldCtx | null {
  const out: HoldCtx = {};
  if (v.subject) out.symbol = v.subject;
  if (v.cost) out.cost = v.cost;
  if (v.position) out.position = v.position;
  if (v.openDate) out.openDate = v.openDate;
  return Object.keys(out).length ? out : null;
}

/**
 * 没有条件窗时的退化路径：拿当前关注品种拼一句。
 * 首页大输入框旁边的「快捷问」还想要一句话时用这个；
 * 正经点卡请走弹窗（dialogDispatch）——那才是稳智的「先补条件再拼句」。
 */
export function renderCardPrompt(card: SuggestionCard, symbol: string): string {
  const subject = collapse(symbol);
  const v: CardInput = {
    ...EMPTY_CARD_INPUT,
    subject,
    subjects: card.subjectKind === "multi_stock" ? parseSubjects(symbol) : subject ? [subject] : [],
    horizonLabel: horizonLabelOf(card.defaults.horizon ?? null),
    horizonEmbed: horizonEmbedOf(card.defaults.horizon ?? null),
    actionLabel: CARD_ACTIONS.find((a) => a.value === card.defaults.action)?.label ?? "",
    maLabel: card.defaults.ma ?? "",
  };
  return card.build(v);
}
