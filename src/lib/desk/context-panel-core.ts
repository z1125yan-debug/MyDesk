// P7-⑧③ 对话页右侧上下文面板的读数口径（纯内核：不 fetch、不碰 DOM、不碰库，node --test 可直跑）。
//
// 为什么单独一层：这一面板的全部风险是「把没有的读数画成有」。
// 「面板顶上该显示哪只」「这一步是谁取的」「这个格子是没取到还是就是 0」都是判断，
// 写在组件里既测不住，也保不住和别处的说法一致（同一个来源两种措辞是 P6 就吃过的亏）。
// 所以组件只把内核给的行画出来，自己不认代码、不算数、不猜来源 —— 与 P7-⑧② 的 link-core 同理。
//
// 四条口径（一条都不放松）：
//  1) **不重算**：数字一律来自既有取数服务（/api/market/quote、K 线快照、/api/quant/decision 的读数），
//     本层只做「格式化 + 标注出处」。前端再算一遍 RSI 或综合分，就会出现第二套结论跟引擎对不上。
//  2) **MISSING ≠ 0**：取数服务在没取到时会给占位值（报价卡是 price=0 + missing=true），
//     所以先判来源再取值；MISSING 那一律显示「本次未取到」。反过来 0 也得照原样显示成 0.00。
//  3) **演示值不冒充行情**：非 A 股品种走本机演示数据，值照常显示但整行标 DEMO，
//     文案与注入模型那份共用 ai-context-core 的 provenanceBadgeText（两边说法不会各写一套）。
//  4) **每一步说清是谁取的**：系统预取（提问前按场景替你取的）与模型自取分开，
//     状态词直接复用 chat-core 那份（发给模型的取数记录行用的就是它），面板不另造一套词。
import { symbolSourceText, type Intent } from "./intent-core.ts";
import { provenanceBadgeText, provenanceOfQuote, provenanceOfTechSnapshot, type Provenance } from "./ai-context-core.ts";
import { toSymbol } from "./link-core.ts";
import { STEP_STATUS_WORD, type IntentBadge, type StepInfo } from "./chat-core.ts";
import { decisionSections, type Decision } from "../quant/screener/decision-core.ts";

/** 缺数据的统一措辞。绝不写成 0、—、「暂无」之类让人以为读到了什么 */
export const MISSING_TEXT = "本次未取到";

/** 面板里的一行读数 */
export interface PanelRow {
  label: string;
  /** 已格式化的显示值：取不到就是 MISSING_TEXT */
  value: string;
  /** 行情/派生读数的来源分层（与注入模型那份同源）；本轮调用记录不带它 */
  provenance?: Provenance;
  /** 不带 provenance 时给人看的出处词（「服务端意图判定」「本机调用记录」） */
  badge?: string;
  /** 这一行为什么是这个来源、缺的是哪一路、值是谁算的 */
  note?: string;
}

/** 数字 → 文本：非有限值一律 MISSING_TEXT；**0 照常显示 0**（缺和零是两件事，混了就等于把「没读到」说成「没有」） */
export function numText(v: number | null | undefined, digits = 2, suffix = ""): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return MISSING_TEXT;
  return `${v.toFixed(digits)}${suffix}`;
}

/** 涨跌幅文本：红涨绿跌由渲染层着色，这里只管正负号与「未取到」 */
export function pctText(v: number | null | undefined, digits = 2): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return MISSING_TEXT;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

// ---------- 面板显示哪个标的 ----------

export interface PanelSymbol {
  symbol: string;
  /** 这个标的是怎么来的（必须写在面板上，不能只写个代码） */
  basis: string;
}

function normSymbol(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  // 裸六位按号段补后缀走 link-core 的唯一一份口径，这里不再抄第二张号段表
  return /^\d{6}$/.test(s) ? toSymbol(s) : s.toUpperCase();
}

/**
 * 标的优先级：本轮识别 > 会话已关联 > 界面焦点。三条各自留下一句出处。
 * 为什么出处比代码更重要：面板顶上光秃秃一个 600519.SH，用户会以为「AI 认出了贵州茅台」，
 * 而真实情况可能只是分析页恰好停在那只票上（symbolSource=focus 那种兜底）。
 *
 * 一条特例：**服务端明说「未识别到标的」时不往下兜**。
 * intent 在场而 symbol 为 null，说的是「这轮问的是大盘 / 板块 / 选股，不需要一只票」；
 * 这时候拿界面焦点凑一个代码上去，等于把用户没问的票画成这一轮的上下文。
 * intent 不在场（P7-⑥④ 之前的老会话、或纯对话端点没回 done）才按会话 → 焦点往下走。
 */
export function pickPanelSymbol(src: {
  intent?: { symbol?: string | null; symbolSource?: string | null } | null;
  sessionStock?: string | null;
  focusSymbol?: string | null;
} = {}): PanelSymbol {
  if (src.intent) {
    const hit = normSymbol(src.intent.symbol);
    if (hit) return { symbol: hit, basis: `本轮标的出处：${symbolSourceNote(src.intent.symbolSource)}` };
    return { symbol: "", basis: "本轮判定为不需要具体标的（服务端明说未识别到），面板不拿界面焦点凑" };
  }
  const session = normSymbol(src.sessionStock);
  if (session) return { symbol: session, basis: "本会话前面问的那只（追问沿用，本轮未重新识别）" };
  const focus = normSymbol(src.focusSymbol);
  if (focus) return { symbol: focus, basis: "分析页当前品种兜底：本轮没有识别到标的，这不是 AI 认出来的" };
  return { symbol: "", basis: "本轮没有可展示的标的（大盘 / 板块 / 选股类问题不需要具体标的）" };
}

/**
 * 标的来源的一句话说明。
 * 文案走 intent-core.symbolSourceText（提示词用的就是它），面板不另写一套；
 * 认不出的值原样带出来并说明「不在已知口径里」——把未知翻成任何一个已知说法都是猜。
 */
export function symbolSourceNote(source: string | null | undefined): string {
  const known: Intent["symbolSource"][] = ["question", "session", "focus", "none"];
  const s = (source ?? "").trim();
  if (!s) return "服务端本轮没标标的来源";
  if (!known.includes(s as Intent["symbolSource"])) return `来源标记「${s}」不在已知口径里（不翻译、不猜）`;
  return symbolSourceText(s as Intent["symbolSource"]);
}

// ---------- 实时行情快照 ----------

/** 报价卡的最小形状：只约束用到的字段，调用方可以直接传整张 QuoteCard */
export interface QuoteLike {
  name?: string;
  price?: number | null;
  changePct?: number | null;
  prevClose?: number | null;
  missing?: boolean;
  data_status?: string;
  series_synthetic?: boolean;
}

/**
 * 行情快照行。先判来源再取值：真实报价缺失时服务给的是 price=0 的占位卡，
 * 直接格式化就会显示「0.00 元」——那是把「没取到」写成行情，REAL_DATA_ONLY 不允许。
 */
export function quoteRowsOf(card: QuoteLike | null | undefined, isDemo: boolean, takenAt = ""): PanelRow[] {
  const prov = provenanceOfQuote(card, isDemo);
  const note =
    prov === "MISSING"
      ? "数据源断开或停牌：这一格本次没有值，不用 0、也不用昨收顶上"
      : prov === "DEMO"
        ? "非 A 股代码走本机演示数据，是展示值不是行情，不能当价格事实引用"
        : prov === "REAL" && card?.series_synthetic
          ? "报价为直连真实值；缩略图分时序列缺失时按现价合成，只用于画图"
          : undefined;
  const rows: PanelRow[] = [
    {
      label: "最新价",
      value: prov === "REAL" || prov === "DEMO" ? numText(card?.price, 2, " 元") : MISSING_TEXT,
      provenance: prov,
      note,
    },
    { label: "涨跌幅", value: prov === "REAL" || prov === "DEMO" ? pctText(card?.changePct) : MISSING_TEXT, provenance: prov },
    {
      label: "昨收",
      value: prov === "REAL" || prov === "DEMO" ? numText(card?.prevClose, 2, " 元") : MISSING_TEXT,
      provenance: prov,
      ...(prov !== "MISSING" && card?.prevClose == null ? { note: "接口本次没给昨收" } : {}),
    },
  ];
  if (takenAt) rows.unshift({ label: "取数时刻（本机）", value: takenAt, badge: "面板现取", note: "面板自己现取的一份，与本轮注入模型的快照时刻不一定是同一秒" });
  return rows;
}

/** 技术快照的最小形状（fetchTechSnapshot 的返回可直接传） */
export interface TechLike {
  tfs: { tf: string; trend: string; rsi: number | null }[];
  support: number | null;
  resistance: number | null;
  rr: number | null;
  rangePos: number | null;
  rangeLow: number | null;
  rangeHigh: number | null;
  source: "real" | "demo";
}

/**
 * 技术面行：趋势 / RSI / 关键位 / 盈亏比 / 区间位置。
 * 一水的 DERIVED：这些是本机引擎算出来的，不是交易所发布的指标；K 线本身是演示数据时降级成 DERIVED_ON_DEMO。
 */
export function techRowsOf(snap: TechLike | null | undefined): PanelRow[] {
  const prov = provenanceOfTechSnapshot(snap?.source);
  const note =
    prov === "DERIVED"
      ? "由本机引擎对真实 K 线计算（MA/RSI/区间），不是交易所发布的指标"
      : prov === "DERIVED_ON_DEMO"
        ? "算法是真的，输入是演示 K 线：只能当演示，不构成任何结论"
        : "K 线未取得：趋势/RSI/关键位全部缺，不凭印象补";
  const row = (label: string, value: string, extra?: string): PanelRow =>
    ({ label, value, provenance: prov, note: extra ?? note });
  if (!snap) {
    return [
      row("多周期趋势", MISSING_TEXT),
      row("RSI(14)", MISSING_TEXT),
      row("最近支撑 / 阻力", MISSING_TEXT),
      row("盈亏比", MISSING_TEXT),
      row("近半年区间位置", MISSING_TEXT),
    ];
  }
  const rsi = snap.tfs.map((t) => `${t.tf} ${t.rsi == null ? MISSING_TEXT : t.rsi.toFixed(0)}`).join("｜");
  return [
    row("多周期趋势", snap.tfs.length ? snap.tfs.map((t) => `${t.tf}=${t.trend}`).join("｜") : MISSING_TEXT),
    row("RSI(14)", rsi || MISSING_TEXT),
    row("最近支撑 / 阻力", snap.support == null && snap.resistance == null
      ? MISSING_TEXT
      : `${numText(snap.support)} / ${numText(snap.resistance)}`),
    // 盈亏比只在「现价确实夹在支撑与阻力之间」时才有值，算法层给 null 就是没读数，不折成 0
    row("盈亏比", snap.rr == null ? MISSING_TEXT : `${numText(snap.rr)}（(阻力-现价)/(现价-支撑)）`),
    row("近半年区间位置", snap.rangePos == null ? MISSING_TEXT
      : `${snap.rangePos.toFixed(0)}%（${numText(snap.rangeLow)} ~ ${numText(snap.rangeHigh)}）`),
  ];
}

// ---------- 数据来源：本轮到底调过哪些真实接口 ----------

export interface PanelSourceRow {
  step: number;
  label: string;
  tool: string;
  status: StepInfo["status"];
  /** 状态词与发给模型的取数记录行同源（chat-core.STEP_STATUS_WORD） */
  statusText: string;
  /** 谁要来的这一步：prefetch=系统预取、model=模型自取、未标=老会话存档里没这个字段 */
  who: string;
  reason?: string;
  detail?: string;
  ms?: number | null;
}

export interface PanelSourceCounts {
  total: number;
  ok: number;
  missing: number;
  error: number;
  running: number;
  prefetch: number;
  model: number;
  unmarked: number;
}

/** 步骤 → 来源行（顺序原样保留：第几步就是第几步，面板不替它排序，排序等于把调用顺序说成别的样子） */
export function sourceRowsOf(steps: StepInfo[] | undefined): PanelSourceRow[] {
  return (steps ?? []).map((s) => ({
    step: s.step,
    label: s.label,
    tool: s.tool ?? s.label,
    status: s.status,
    statusText: STEP_STATUS_WORD[s.status] ?? s.status,
    who: s.source === "prefetch" ? "系统预取" : s.source === "model" ? "模型自取" : "未标注来源",
    ...(s.reason ? { reason: s.reason } : {}),
    ...(s.detail ? { detail: s.detail } : {}),
    ...(s.ms != null ? { ms: s.ms } : {}),
  }));
}

export function sourceCountsOf(steps: StepInfo[] | undefined): PanelSourceCounts {
  const list = steps ?? [];
  const n = (f: (s: StepInfo) => boolean) => list.filter(f).length;
  return {
    total: list.length,
    ok: n((s) => s.status === "ok"),
    missing: n((s) => s.status === "missing"),
    error: n((s) => s.status === "error"),
    running: n((s) => s.status === "running"),
    prefetch: n((s) => s.source === "prefetch"),
    model: n((s) => s.source === "model"),
    unmarked: n((s) => s.source !== "prefetch" && s.source !== "model"),
  };
}

// ---------- 分析依据：这一轮的回答站在哪些证据上 ----------

/**
 * 本轮的分析依据（零额外请求：全部来自服务端已经回下来的判定与调用记录）。
 * 每条都要能回答「凭什么这么写」，包括「这一条没标出来」本身也要出现在面板上。
 */
export function evidenceRowsOf(intent: IntentBadge | null | undefined, steps: StepInfo[] | undefined, warning?: string): PanelRow[] {
  const rows: PanelRow[] = [];
  if (intent) {
    rows.push({
      label: "本轮按哪个场景答",
      value: intent.label,
      badge: "服务端意图判定",
      note: [
        intent.hits.length ? `命中词：${intent.hits.join("、")}` : "没有命中场景词（按通用问答处理）",
        intent.alternates?.length ? `同句还问到：${intent.alternates.join("、")}` : "",
        intent.inherited ? "沿用上一轮场景（追问）" : "",
      ].filter(Boolean).join("｜"),
    });
    rows.push({
      label: "本轮标的",
      value: intent.symbol ?? MISSING_TEXT,
      badge: "服务端意图判定",
      note: `${symbolSourceNote(intent.symbolSource)}${intent.symbol ? "" : "；标的类问题没有标的时，回答里的个股读数都不可信"}`,
    });
    const chars = intent.prefetchChars ?? 0;
    rows.push({
      label: "随提问注入的真实数据块",
      value: chars ? `${chars} 字` : MISSING_TEXT,
      badge: "本机调用记录",
      note: chars ? "本轮自动调度替你预取的行情/板块/事件块（逐条带来源分层）" : "本轮没有注入数据块：模型手里没有行情，回答里的价格类表述都缺依据",
    });
    rows.push({
      label: "本轮没预取的项",
      value: intent.skipped?.length ? intent.skipped.join("；") : "无登记",
      badge: "本机调度登记",
      note: intent.skipped?.length ? "「没预取」是本轮没去取，不等于市场没有这条信息" : "调度层没登记缺项；这不等于每样都取到了（取到没有看上面几步）",
    });
  } else {
    rows.push({
      label: "本轮按哪个场景答",
      value: MISSING_TEXT,
      badge: "服务端意图判定",
      note: "这次回答没回带场景判定（纯对话端点或本轮出错），面板不替它编一个场景",
    });
  }
  const c = sourceCountsOf(steps);
  rows.push({
    label: "本轮取数步骤",
    value: c.total ? `${c.ok}/${c.total} 步已取到` : MISSING_TEXT,
    badge: "本机调用记录",
    note: c.total
      ? `缺数据 ${c.missing} 步｜失败 ${c.error} 步｜未结束 ${c.running} 步；系统预取 ${c.prefetch} 步、模型自取 ${c.model} 步${c.unmarked ? `、未标注 ${c.unmarked} 步` : ""}`
      : "本轮没有任何工具调用：这一屏的行情全部来自面板自己现取的那份",
  });
  if (warning) rows.push({ label: "本轮登记的提示", value: warning, badge: "本机调用记录", note: "降级、断流、价格校验之类都记在这里" });
  return rows;
}

// ---------- 决策结论读数（按需取，面板不自动打四路接口） ----------

export interface DecisionSummary {
  headline: string;
  basis: string[];
  risk: string[];
  asOf: string;
  tradeDate: string;
  subjectName: string | null;
  /** 逐路来源原样转出去：用没用到、所属日，都是接线层已经记好的账，这里不加判断 */
  sources: { id: string; label: string; detail: string; used: boolean; as_of: string | null }[];
  excludedCount: number;
}

/**
 * 结论卡的四路读数压成面板那么宽的一份摘要。
 * 用 decisionSections（页面与 AI 上下文共用的那一份三段式），所以面板上的每一句都能在结论卡上找到原文；
 * 只截前 limit 条并如实写「另有 N 条未列」，不静默截断。
 */
export function decisionSummaryOf(
  view: {
    subject_name: string | null;
    as_of: string;
    trade_date: string;
    decision: Decision;
    sources: { id: string; label: string; detail: string; used: boolean; as_of: string | null }[];
  },
  limit = 3
): DecisionSummary {
  const sec = decisionSections(view.decision);
  const n = Math.max(1, limit);
  const cut = (list: string[]) => (list.length > n ? [...list.slice(0, n), `另有 ${list.length - n} 条未列（点「打开结论卡」看全量归因）`] : list);
  return {
    headline: sec.headline,
    basis: cut(sec.basis),
    risk: cut(sec.risk),
    asOf: view.as_of,
    tradeDate: view.trade_date,
    subjectName: view.subject_name,
    sources: view.sources.map((s) => ({ ...s })),
    excludedCount: view.decision.excluded.length,
  };
}

/** 结论那一屏的取数状态文案（未点 = 没取，不能写成「本次未取到」以外的任何一种「好像取过了」） */
export const DECISION_IDLE_TEXT = "未取（点一下才打四路接口）";
export const DECISION_BUSY_TEXT = "正在取日K / 全A快照 / 板块主线 / 事件解读…";

export function decisionStateText(opts: { fetched: boolean; busy: boolean; error?: string }): string {
  if (opts.busy) return DECISION_BUSY_TEXT;
  if (opts.error) return `本次未取到：${opts.error}`;
  if (!opts.fetched) return DECISION_IDLE_TEXT;
  return "";
}

/** 面板上「这行是什么来源」的徽章文案：来源分层的词与注入模型那份同源 */
export function panelBadgeText(row: PanelRow): string {
  return row.provenance ? provenanceBadgeText(row.provenance) : row.badge ?? "未标注来源";
}
