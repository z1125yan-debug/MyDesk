// P8-⑤ Debug 步骤时间线的纯内核：把 A/B 轮已经在发的数据（意图徽章、步骤、reason/detail/ms、
// trace 摘要、done 的耗时/传输档位）组装成「意图 / 步骤 / 结论」三段视图 + 一组计数。
//
// 分层纪律（与 skills-core 同一条）：只做组装与文案，不 fetch、不判场景、不碰步骤号——
// 判定不外溢到呈现层：这里出现的每个字，都能说清它来自哪一帧、哪一条既有留底。
//
// 三条口径：
//  1) 不产生新事实：没有徽章就写「本轮未做场景判定」，没有留底就整节标「未留底」，绝不拼半成品；
//  2) 轮次分组靠 reason 前缀「补充调用（第 2 轮）」（B 轮 ④ 的原文），认不出按首轮——不猜；
//  3) 五态文案单一出处：stepStatusText 就是 StepTimeline 原来的 STATUS_META.text，
//     搬进纯核后组件只留图标与色——将来加第六态不会出现「帧里解得出、界面没有这个词」。
// R10b 补：标的来源一格也不漏原始键——intent.symbolSource 走判定层的 symbolSourceLabel
//     （认得人话化，认不出的历史留底原样透传），与 SceneBadge 同一份措辞出处。
import { symbolSourceLabel } from "./intent-core.ts";

/** 入参值展示上限（细则 §1.3）；返回摘要的 120 字口径复用 chat-stream-core.stepDetailOf，这里不新写截断 */
export const DEBUG_ARG_MAX_CHARS = 80;

export const STEP_STATUS_TEXT: Record<string, string> = {
  running: "进行中",
  ok: "已取到",
  missing: "缺数据",
  error: "调用失败",
  // 与 missing 分开：一个是「没取到」，一个是「取到了但不是新的」（P8-① 口径）
  stale: "数据滞后",
};

/** 未知状态兜底成 ok 文案——与 asStreamEvent 的解码兜底、StepTimeline 的渲染兜底是同一句话的三个位置 */
export function stepStatusText(status: string | null | undefined): string {
  return STEP_STATUS_TEXT[String(status ?? "")] ?? STEP_STATUS_TEXT.ok;
}

// ---------- 输入形状（结构类型：不 import chat-core/StepInfo，呈现层反向依赖判定层是多余的耦合） ----------

export interface DebugStepLike {
  step: number;
  label: string;
  status: string;
  tool?: string;
  detail?: string;
  ms?: number | null;
  source?: "prefetch" | "model";
  reason?: string;
  /** debug=true 时路由富化进来的入参（值已按 80 字截断） */
  args?: Record<string, unknown>;
  /** debug=true 时的返回摘要（dispatch-core 的 ≤120 字口径） */
  summary?: string;
}

export interface DebugIntentLike {
  scene: string;
  label: string;
  hits?: string[];
  alternates?: string[];
  symbol?: string | null;
  symbolSource?: string;
  inherited?: boolean;
  followUp?: boolean;
  skipped?: string[];
  prefetchChars?: number;
}

/** done 帧的 debug 字段 + 路由已知的留底（契约校验/新鲜度 warning 由调用方接进来，本层不判） */
export interface DebugDoneLike {
  modelMs?: number | null;
  transport?: string | null;
  contractWarning?: string | null;
  freshness?: string | null;
}

export interface DebugTraceLike {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  status: string;
  summary: string;
}

// ---------- 输出形状 ----------

export interface DebugIntentSection {
  present: boolean;
  /** 面板一行话（全部由已回传字段拼，无徽章时是「本轮未做场景判定」） */
  summary: string;
  scene: string | null;
  label: string | null;
  hits: string[];
  alternates: string[];
  symbol: string | null;
  symbolSource: string | null;
  inherited: boolean;
  followUp: boolean;
  skipped: string[];
  prefetchChars: number | null;
}

export interface DebugStepRow {
  step: number;
  tool: string | null;
  label: string;
  status: string;
  statusText: string;
  ms: number | null;
  source: string | null;
  reason: string | null;
  detail: string | null;
  args: Record<string, unknown> | null;
  argsText: string | null;
  summary: string | null;
  /** 1=首轮，2=补充轮（从 reason 前缀识别；两轮并排可见，不折叠失败行） */
  round: number;
}

export const TRANSPORT_TEXT: Record<string, string> = {
  stream: "逐字送达",
  fallback: "一次性返回",
  settle: "断点续收",
};

export interface DebugConclusionSection {
  /** false = 本轮没有任何结论留底，整节如实标「未留底」 */
  noted: boolean;
  transport: string | null;
  transportText: string | null;
  modelMs: number | null;
  contractWarning: string | null;
  freshness: string | null;
}

export interface DebugCounts {
  total: number;
  ok: number;
  error: number;
  missing: number;
  stale: number;
  running: number;
  /** 补充轮（B 轮 ④）产生的步骤数——面板用它标「补」字小徽与「n 步未收口」 */
  supplemented: number;
}

export interface DebugView {
  intentSection: DebugIntentSection;
  stepsSection: DebugStepRow[];
  conclusionSection: DebugConclusionSection;
  counts: DebugCounts;
}

// ---------- 小工具（发帧侧与服务侧共用，测试直钉） ----------

function clipDebugValue(v: unknown): unknown {
  if (typeof v === "string") return v.length > DEBUG_ARG_MAX_CHARS ? `${v.slice(0, DEBUG_ARG_MAX_CHARS - 1)}…` : v;
  if (v && typeof v === "object") {
    try {
      const s = JSON.stringify(v);
      return s.length > DEBUG_ARG_MAX_CHARS ? `${s.slice(0, DEBUG_ARG_MAX_CHARS - 1)}…` : v;
    } catch {
      return "（无法序列化的入参值）";
    }
  }
  return v;
}

/** 入参浅拷贝 + 值超 80 字截断（发帧前过一遍，坏形状直接不收而不是发个假对象） */
export function debugArgsOf(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = clipDebugValue(v);
  return out;
}

/** 补充轮识别：B 轮 planSupplementRound 的 reason 原文前缀「补充调用（第 2 轮）」 */
const SUPPLEMENT_RE = /^补充调用（第\s*(\d+)\s*轮）/;

export function stepRoundOf(reason?: string | null): number {
  const m = SUPPLEMENT_RE.exec(reason ?? "");
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * 把执行记录（trace）富化进最终步骤帧：按「工具名 + 出现次序」FIFO 配对，
 * 对不上就不富化（宁缺勿猜——校验步骤没有 trace 项、同工具两轮重试各配各的，位置配对会串）。
 * 路由拿返回值在轮末重发同序号帧：applyEvent 按步骤号合并不重复计数，这是 dispatch-core 零改动的关键。
 */
export function debugFramesFromSteps(steps: DebugStepLike[], trace: DebugTraceLike[] | undefined): DebugStepLike[] {
  const queues = new Map<string, DebugTraceLike[]>();
  for (const t of trace ?? []) {
    if (!t || typeof t.name !== "string") continue;
    const q = queues.get(t.name);
    if (q) q.push(t);
    else queues.set(t.name, [t]);
  }
  return (steps ?? []).map((s) => {
    const q = s.tool ? queues.get(s.tool) : undefined;
    const t = q?.shift();
    if (!t) return s;
    const args = debugArgsOf(t.args);
    return {
      ...s,
      ...(args ? { args } : {}),
      ...(typeof t.summary === "string" && t.summary ? { summary: t.summary } : {}),
    };
  });
}

// ---------- 三段视图组装 ----------

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function intentSectionOf(intent: DebugIntentLike | null | undefined): DebugIntentSection {
  if (!intent || typeof intent.scene !== "string" || !intent.scene) {
    return {
      present: false, summary: "本轮未做场景判定", scene: null, label: null, hits: [], alternates: [],
      symbol: null, symbolSource: null, inherited: false, followUp: false, skipped: [], prefetchChars: null,
    };
  }
  const hits = strArray(intent.hits);
  const alternates = strArray(intent.alternates);
  const skipped = strArray(intent.skipped);
  const symbol = typeof intent.symbol === "string" && intent.symbol ? intent.symbol : null;
  const symbolSource = typeof intent.symbolSource === "string" && intent.symbolSource ? intent.symbolSource : null;
  const parts = [
    `判定为「${intent.label || intent.scene}」${hits.length ? `（命中词：${hits.join("、")}）` : ""}`,
    alternates.length ? `同时问到：${alternates.join("、")}` : "",
    `股票 ${symbol ?? "无"}${symbol && symbolSource ? `（来源：${symbolSourceLabel(symbolSource)}）` : ""}`,
    intent.inherited === true ? "沿用上一轮场景" : "",
    typeof intent.prefetchChars === "number" ? `随附背景数据 ${Math.max(0, Math.trunc(intent.prefetchChars))} 字` : "本轮没有随附数据",
  ].filter(Boolean);
  return {
    present: true,
    summary: parts.join(" · "),
    scene: intent.scene,
    label: intent.label || intent.scene,
    hits,
    alternates,
    symbol,
    symbolSource,
    inherited: intent.inherited === true,
    followUp: intent.followUp === true,
    skipped,
    prefetchChars: typeof intent.prefetchChars === "number" && isFinite(intent.prefetchChars) ? Math.max(0, Math.trunc(intent.prefetchChars)) : null,
  };
}

export function buildDebugView(input: {
  intent?: DebugIntentLike | null;
  steps?: DebugStepLike[];
  done?: DebugDoneLike | null;
}): DebugView {
  const steps = (input.steps ?? []).filter((s) => s && typeof s.step === "number");
  const rows: DebugStepRow[] = steps.map((s) => {
    const args = s.args && typeof s.args === "object" && !Array.isArray(s.args) ? s.args : null;
    let argsText: string | null = null;
    if (args) {
      try {
        argsText = JSON.stringify(args);
      } catch {
        argsText = "（入参无法序列化）";
      }
    }
    return {
      step: s.step,
      tool: typeof s.tool === "string" && s.tool ? s.tool : null,
      label: s.label,
      status: s.status,
      statusText: stepStatusText(s.status),
      ms: typeof s.ms === "number" && isFinite(s.ms) ? s.ms : null,
      source: typeof s.source === "string" && s.source ? s.source : null,
      reason: typeof s.reason === "string" && s.reason ? s.reason : null,
      detail: typeof s.detail === "string" && s.detail ? s.detail : null,
      args,
      argsText,
      summary: typeof s.summary === "string" && s.summary ? s.summary : null,
      round: stepRoundOf(s.reason),
    };
  });

  const counts: DebugCounts = {
    total: rows.length,
    ok: rows.filter((r) => r.status === "ok").length,
    error: rows.filter((r) => r.status === "error").length,
    missing: rows.filter((r) => r.status === "missing").length,
    stale: rows.filter((r) => r.status === "stale").length,
    running: rows.filter((r) => r.status === "running").length,
    supplemented: rows.filter((r) => r.round >= 2).length,
  };

  const d = input.done ?? null;
  const transport = d && typeof d.transport === "string" && d.transport ? d.transport : null;
  const modelMs = d && typeof d.modelMs === "number" && isFinite(d.modelMs) ? Math.max(0, Math.trunc(d.modelMs)) : null;
  const contractWarning = d && typeof d.contractWarning === "string" && d.contractWarning ? d.contractWarning : null;
  const freshness = d && typeof d.freshness === "string" && d.freshness ? d.freshness : null;
  const conclusionSection: DebugConclusionSection = {
    noted: !!(transport || modelMs != null || contractWarning || freshness),
    transport,
    transportText: transport ? (TRANSPORT_TEXT[transport] ?? transport) : null,
    modelMs,
    contractWarning,
    freshness,
  };

  return { intentSection: intentSectionOf(input.intent), stepsSection: rows, conclusionSection, counts };
}
