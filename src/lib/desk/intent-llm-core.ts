// P17-① 稳智对齐 · 意图识别器（LLM 驱动，双引擎）
//
// 与 intent-core.ts 的分工：
//   intent-core.ts = 关键词 + 代码形状规则判定（P7 时代，快、免费、可测）
//   本文件        = LLM 驱动的分类与决策信号抽取（P17 稳智对齐，慢一点但覆盖更全）
//
// 双引擎口径：
//   1) 规则引擎先跑（intent-core.classifyIntent），拿到 scene + symbol；
//   2) 若场景是 general 且启用了 LLM 兜底，才把问题交给 LLM 做二次判定；
//   3) 若 LLM 明确给出交易周期/信号类型/情绪温度，就作为「决策信号块」附在提示词里；
//      LLM 不给就按未选处理，绝不硬编。
//
// 为什么不直接换成 LLM 单引擎：
//   - 规则引擎 3ms 完成，LLM 一轮 2-5 秒；能省就省；
//   - 规则引擎的结果 100% 可测（intent-core 25 条调度断言就是这条口径的验收闸）；
//   - 稳智 AI 自己也是先规则预判再让 LLM 补全决策信号——它不会为每次「我的自选股」都跑 LLM。
//
// 零 IO 纯函数纪律：本文件不 fetch、不读 process.env、不碰时钟。
// LLM 调用由调用方（chat/route.ts）注入结果，纯核只负责「把 LLM 输出解析成结构化字段」。

/** 稳智 5 档交易周期（对齐 aiwuchuan） */
export type WzHorizon = "ultra_short" | "short" | "short_mid" | "mid" | "long";

export const WZ_HORIZONS: { key: WzHorizon; label: string; range: string }[] = [
  { key: "ultra_short", label: "超短", range: "日内或次日" },
  { key: "short", label: "短", range: "1-3 日" },
  { key: "short_mid", label: "短中", range: "1-3 周" },
  { key: "mid", label: "中", range: "1-3 个月" },
  { key: "long", label: "长", range: "3 个月以上" },
];

export const WZ_HORIZON_LABELS: Record<WzHorizon, string> = {
  ultra_short: "超短",
  short: "短",
  short_mid: "短中",
  mid: "中",
  long: "长",
};

export function asWzHorizon(v: unknown): WzHorizon | null {
  return WZ_HORIZONS.some((h) => h.key === v) ? (v as WzHorizon) : null;
}

/** 稳智信号类型 12 类（对齐 aiwuchuan 的决策 widget） */
export type WzSignalType =
  | "trend_breakout"        // 趋势突破
  | "pullback_rebound"      // 回调反弹
  | "range_bound"           // 震荡整理
  | "volume_surge"          // 放量启动
  | "divergence_risk"       // 背离风险
  | "stop_loss_hit"         // 止损触发
  | "stop_profit_hit"       // 止盈触发
  | "capital_inflow"        // 资金流入
  | "capital_outflow"       // 资金流出
  | "event_driven"          // 事件驱动
  | "sector_rotation"       // 板块轮动
  | "no_signal";           // 无信号（明确不表态）

export const WZ_SIGNAL_TYPES: { key: WzSignalType; label: string }[] = [
  { key: "trend_breakout", label: "趋势突破" },
  { key: "pullback_rebound", label: "回调反弹" },
  { key: "range_bound", label: "震荡整理" },
  { key: "volume_surge", label: "放量启动" },
  { key: "divergence_risk", label: "背离风险" },
  { key: "stop_loss_hit", label: "止损触发" },
  { key: "stop_profit_hit", label: "止盈触发" },
  { key: "capital_inflow", label: "资金流入" },
  { key: "capital_outflow", label: "资金流出" },
  { key: "event_driven", label: "事件驱动" },
  { key: "sector_rotation", label: "板块轮动" },
  { key: "no_signal", label: "无信号" },
];

export const WZ_SIGNAL_LABELS: Record<WzSignalType, string> = {
  trend_breakout: "趋势突破",
  pullback_rebound: "回调反弹",
  range_bound: "震荡整理",
  volume_surge: "放量启动",
  divergence_risk: "背离风险",
  stop_loss_hit: "止损触发",
  stop_profit_hit: "止盈触发",
  capital_inflow: "资金流入",
  capital_outflow: "资金流出",
  event_driven: "事件驱动",
  sector_rotation: "板块轮动",
  no_signal: "无信号",
};

export function asWzSignal(v: unknown): WzSignalType | null {
  return WZ_SIGNAL_TYPES.some((s) => s.key === v) ? (v as WzSignalType) : null;
}

/** 决策信号 11 字段（稳智 widget 完整字段集，与 wenzhi-deep-comparison.md 对齐） */
export interface WzDecisionSignal {
  /** 主结论：多/空/观望/无观点 */
  stance: "long" | "short" | "wait" | "neutral";
  /** 交易周期（5 档） */
  horizon: WzHorizon | null;
  /** 信号类型（12 类） */
  signalType: WzSignalType | null;
  /** 置信度 0-100 */
  confidence: number | null;
  /** 情绪温度 0-100 */
  sentimentTemp: number | null;
  /** 关键价位（结构化，非硬编） */
  keyLevels: { support?: number[]; resistance?: number[] };
  /** 止盈止损（结构化） */
  stopPlan: { stopLoss?: number | null; takeProfit?: number | null };
  /** 建议仓位 0-100% */
  positionPct: number | null;
  /** 失效条件（自然语言） */
  invalidation: string | null;
  /** 风险提示 */
  riskNotes: string[];
  /** 数据覆盖度（缺失维度列表） */
  dataGaps: string[];
}

/** stance 中文标签 */
export const STANCE_LABELS: Record<WzDecisionSignal["stance"], string> = {
  long: "偏多",
  short: "偏空",
  wait: "观望",
  neutral: "无观点",
};

export function asStance(v: unknown): WzDecisionSignal["stance"] {
  return v === "long" || v === "short" || v === "wait" || v === "neutral" ? v : "neutral";
}

// ---------- LLM 分类 prompt ----------

/**
 * LLM 分类的输入契约：调用方（chat/route.ts）负责组 prompt，本文件提供模板。
 * 用 JSON 输出模式（Qwen3.8-27b 支持 response_format: {type: "json_object"}），
 * 减少后处理歧义。
 */
export const WZ_INTENT_PROMPT = [
  "你是 Kairo 量化工作台的意图识别器。根据用户的提问，输出一个 JSON 对象，字段如下：",
  "{",
  '  "scene": "sentiment|sector|screener|quote|watchlist|stock_analysis|qimen|general",',
  '  "horizon": "ultra_short|short|short_mid|mid|long|null",',
  '  "signalType": "trend_breakout|pullback_rebound|range_bound|volume_surge|divergence_risk|stop_loss_hit|stop_profit_hit|capital_inflow|capital_outflow|event_driven|sector_rotation|no_signal|null",',
  '  "stance": "long|short|wait|neutral",',
  '  "confidence": 0到100的整数或null,',
  '  "sentimentTemp": 0到100的整数或null,',
  '  "symbol": "6位代码带后缀或null",',
  '  "confidence_reason": "一句话说明为什么这么判，不超过30字"',
  "}",
  "",
  "纪律：",
  "1. 用户没提标的时 symbol 为 null，不要猜；",
  "2. 没有明确信号时 signalType 为 no_signal，不要硬凑；",
  "3. horizon 判不出来就用 null；",
  "4. 用户问大盘/情绪时 sentimentTemp 按提问语义估个 0-100 的分，问个股时 sentimentTemp 为 null；",
  "5. 只输出 JSON，不要任何解释文字、不要用 markdown 代码块包裹。",
].join("\n");

// ---------- LLM 输出解析 ----------

export interface WzLlmParseResult {
  /** 判定成功：JSON 可解析且关键字段合法 */
  ok: boolean;
  /** 解析后的决策信号（ok=false 时可能是部分或空） */
  signal: WzDecisionSignal;
  /** 若 scene 与规则引擎判到的不一致，此字段非空（供调用方决定是否采纳） */
  sceneDivergence: { ruleScene: string; llmScene: string } | null;
  /** 置信度原因原文（调试用） */
  reason: string | null;
}

/**
 * 把 LLM 返回的 JSON 文本解析成 WzDecisionSignal。
 * 容错纪律：
 *   - 剥掉 ```json ... ``` 代码块包裹（模型偶发会加）；
 *   - 每个字段独立 try/catch，一个字段解析失败不影响其他字段；
 *   - 数值字段越界一律 clamp 到 [0,100]，不是 null 就不猜；
 *   - 完全解析不出来时 ok=false，但 signal 仍是全 null 的合法对象（调用方按需兜底）。
 */
export function parseWzDecisionLlmOutput(raw: string, ruleScene?: string | null): WzLlmParseResult {
  const signal: WzDecisionSignal = {
    stance: "neutral",
    horizon: null,
    signalType: null,
    confidence: null,
    sentimentTemp: null,
    keyLevels: {},
    stopPlan: {},
    positionPct: null,
    invalidation: null,
    riskNotes: [],
    dataGaps: [],
  };
  let sceneDivergence: { ruleScene: string; llmScene: string } | null = null;
  let reason: string | null = null;

  // 剥 markdown code block
  let text = (raw ?? "").trim();
  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline > 0) text = text.slice(firstNewline + 1);
    const lastFence = text.lastIndexOf("```");
    if (lastFence > 0) text = text.slice(0, lastFence).trim();
  }

  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, signal, sceneDivergence, reason };
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, signal, sceneDivergence, reason };
  }

  // scene
  const scene = typeof obj.scene === "string" ? obj.scene : null;
  if (scene && ruleScene && scene !== ruleScene) {
    sceneDivergence = { ruleScene, llmScene: scene };
  }

  // stance
  signal.stance = asStance(obj.stance);

  // horizon
  signal.horizon = asWzHorizon(obj.horizon);

  // signalType
  signal.signalType = asWzSignal(obj.signalType);

  // confidence / sentimentTemp / positionPct 都是 0-100
  signal.confidence = clamp0to100(obj.confidence);
  signal.sentimentTemp = clamp0to100(obj.sentimentTemp);
  signal.positionPct = clamp0to100(obj.positionPct);

  // keyLevels
  if (obj.keyLevels && typeof obj.keyLevels === "object") {
    const kl = obj.keyLevels as Record<string, unknown>;
    if (Array.isArray(kl.support)) signal.keyLevels.support = kl.support.map((n) => toNumberOrNull(n)).filter((n) => n !== null) as number[];
    if (Array.isArray(kl.resistance)) signal.keyLevels.resistance = kl.resistance.map((n) => toNumberOrNull(n)).filter((n) => n !== null) as number[];
  }

  // stopPlan
  if (obj.stopPlan && typeof obj.stopPlan === "object") {
    const sp = obj.stopPlan as Record<string, unknown>;
    signal.stopPlan.stopLoss = toNumberOrNull(sp.stopLoss);
    signal.stopPlan.takeProfit = toNumberOrNull(sp.takeProfit);
  }

  // invalidation
  if (typeof obj.invalidation === "string" && obj.invalidation.trim()) {
    signal.invalidation = obj.invalidation.trim().slice(0, 200);
  }

  // riskNotes
  if (Array.isArray(obj.riskNotes)) {
    signal.riskNotes = obj.riskNotes.filter((n): n is string => typeof n === "string" && Boolean(n.trim())).map((n) => n.slice(0, 100)).slice(0, 5);
  }

  // dataGaps
  if (Array.isArray(obj.dataGaps)) {
    signal.dataGaps = obj.dataGaps.filter((n): n is string => typeof n === "string" && Boolean(n.trim())).map((n) => n.slice(0, 60)).slice(0, 5);
  }

  // reason
  if (typeof obj.confidence_reason === "string") {
    reason = obj.confidence_reason.trim().slice(0, 100);
  }

  const ok = signal.stance !== "neutral" || signal.horizon !== null || signal.signalType !== null;
  return { ok, signal, sceneDivergence, reason };
}

function clamp0to100(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = toNumberOrNull(v);
  if (n === null) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(/[^\d.\-]/g, "");
    if (!s) return null;
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ---------- 决策信号块渲染 ----------

/**
 * 把 WzDecisionSignal 渲染成注入系统提示词的中文段。
 * 与 intent-core.scenePrompt 的注入块并列，供调用方决定要不要合并到 scenePrompt 后面。
 * 字段为 null 的一律不渲染——不填字，也不写"未提供"这种废话。
 */
export function renderWzDecisionBlock(signal: WzDecisionSignal): string[] {
  if (!signal) return [];
  const lines: string[] = [];
  const hasAnything =
    signal.horizon || signal.signalType || signal.stance !== "neutral" ||
    signal.confidence !== null || signal.sentimentTemp !== null ||
    (signal.keyLevels.support?.length || signal.keyLevels.resistance?.length) ||
    (signal.stopPlan.stopLoss != null) || (signal.stopPlan.takeProfit != null) ||
    signal.positionPct !== null || signal.invalidation || signal.riskNotes.length;
  if (!hasAnything) return [];

  lines.push("【稳智决策信号块 · 由 LLM 分类器判定，仅作为参考口径，不是模型最终结论】");

  const parts: string[] = [];
  if (signal.stance !== "neutral") parts.push(`结论倾向：${STANCE_LABELS[signal.stance]}`);
  if (signal.horizon) parts.push(`交易周期：${WZ_HORIZON_LABELS[signal.horizon]}`);
  if (signal.signalType && signal.signalType !== "no_signal") parts.push(`信号类型：${WZ_SIGNAL_LABELS[signal.signalType]}`);
  if (signal.confidence !== null) parts.push(`置信度：${signal.confidence}/100`);
  if (signal.sentimentTemp !== null) parts.push(`情绪温度：${signal.sentimentTemp}/100`);
  if (signal.positionPct !== null) parts.push(`建议仓位：${signal.positionPct}%`);
  if (parts.length) lines.push(parts.join("｜"));

  if (signal.keyLevels.support?.length || signal.keyLevels.resistance?.length) {
    const kl: string[] = [];
    if (signal.keyLevels.support?.length) kl.push(`支撑 ${signal.keyLevels.support.join("/")}`);
    if (signal.keyLevels.resistance?.length) kl.push(`阻力 ${signal.keyLevels.resistance.join("/")}`);
    lines.push(`关键价位：${kl.join("｜")}`);
  }

  const sp: string[] = [];
  if (signal.stopPlan.stopLoss != null) sp.push(`止损 ${signal.stopPlan.stopLoss}`);
  if (signal.stopPlan.takeProfit != null) sp.push(`止盈 ${signal.stopPlan.takeProfit}`);
  if (sp.length) lines.push(`止盈止损：${sp.join("｜")}`);

  if (signal.invalidation) lines.push(`失效条件：${signal.invalidation}`);
  if (signal.riskNotes.length) lines.push(`风险提示：${signal.riskNotes.join("；")}`);
  if (signal.dataGaps.length) lines.push(`本轮未取到的数据维度：${signal.dataGaps.join("、")}（回答里如实说明）`);

  return lines;
}

/**
 * 与 Kairo 已有 horizon（short/mid/long）做映射：稳智 5 档 -> Kairo 3 档。
 * 用于在现有 horizon 提示词层做兼容注入，不改现有 UI 交互。
 * 返回 null 表示 LLM 没判出周期，不覆盖用户的显式选择。
 */
export function wzHorizonToKairoH(h: WzHorizon | null): "short" | "mid" | "long" | null {
  if (!h) return null;
  switch (h) {
    case "ultra_short":
    case "short":
    case "short_mid":
      return "short";
    case "mid":
      return "mid";
    case "long":
      return "long";
  }
}
