// Agent Loop 6 阶段进度条纯核（P18 稳智对齐 / P35 显式 phase_key）。
//
// 稳智逆向扒出的 6 阶段固定视图（对齐 agentStepTimeline phase_key 常量）：
//   intent → skills → local_data → external_data → research → answer
//
// P35 起本仓库也**显式发 phase_key**（对齐稳智：每个工具步骤自带 phase_key，按工具真实归属标）：
//   - 后端路由（模型自取）与自动调度（系统预取）发 step 事件时带 step.phase_key，
//     取值来自 chat-tools.phaseOfTool（工具注册表里的真实归属，单一出处）。
//   - 本文件的角度：优先用 phase_key，没有才回落到下面的语义推导（旧存档/未升级客户端/
//     未标注的动态工具）。
//
// 语义兜底（classifyStep）口径：
//   - intent：IntentBadge 存在 → done
//   - skills：steps 非空 → done（有工具调用就是选了分析方法）
//   - local_data：label/tool 命中行情/快照/报价/技术/RSI/MA 关键词 → done
//   - external_data：label/tool 命中新闻/公告/消息/news → done
//   - research：label/tool 命中因子/回测/筛选/分析/研究 → done
//   - answer：消息有 content 或 streaming=false → done
//
// 状态四态对齐稳智：done(✓) / active(●) / pending(○) / error(⚠)
// 与 StepInfo.status 的映射：ok→done / running→active / error→error / missing→done（不算错）
//
// 为什么单独成文件：阶段推导规则同时被 StepTimeline（画进度条）和钉测消费；
// 写进 tsx 就测不到行为。抽出来才能像 decision-widget-core 一样有单测兜底。
import type { IntentBadge, StepInfo } from "./chat-core.ts";

export type PhaseKey = "intent" | "skills" | "local_data" | "external_data" | "research" | "answer";
export type PhaseStatus = "done" | "active" | "pending" | "error";

/** 6 阶段固定顺序 + 中文名 + emoji（对齐稳智 agentStepTimeline.x 常量表） */
export const AGENT_PHASES: { key: PhaseKey; emoji: string; zh: string }[] = [
  { key: "intent",        emoji: "🧠", zh: "理解问题" },
  { key: "skills",        emoji: "🧩", zh: "选择分析方法" },
  { key: "local_data",    emoji: "📈", zh: "获取行情与市场数据" },
  { key: "external_data", emoji: "📰", zh: "核查新闻与公开信息" },
  { key: "research",      emoji: "🔬", zh: "综合分析" },
  { key: "answer",        emoji: "💡", zh: "生成结论" },
];

export type PhaseState = { key: PhaseKey; emoji: string; zh: string; status: PhaseStatus };

/** 命中"行情/市场数据"的关键词（工具名或 label） */
const LOCAL_DATA_KEYS = ["quote", "行情", "快照", "报价", "价格", "技术", "RSI", "MA", "kline", "k线", "support", "resistance"];
/** 命中"新闻/公开信息"的关键词 */
const EXT_DATA_KEYS = ["news", "新闻", "公告", "消息", "公告", "stock_news", "新闻检索"];
/** 命中"综合分析"的关键词 */
const RESEARCH_KEYS = ["factor", "因子", "screener", "筛选", "回测", "backtest", "analyze", "分析", "research", "研究"];

function hitAny(text: string, keys: string[]): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return keys.some((k) => t.includes(k.toLowerCase()));
}

/** 从工具名/label 反推阶段（本仓库没有 phase_key，只能靠语义映射） */
/** 从工具名/label 反推阶段（本仓库没有 phase_key，只能靠语义映射）
 * P22：导出给 StepTimeline 做步骤分组渲染用（同一份映射规则两处消费，不重造）。 */
export function classifyStep(s: StepInfo): PhaseKey | null {
  const text = `${s.label ?? ""} ${s.tool ?? ""} ${s.detail ?? ""}`;
  if (hitAny(text, LOCAL_DATA_KEYS)) return "local_data";
  if (hitAny(text, EXT_DATA_KEYS)) return "external_data";
  if (hitAny(text, RESEARCH_KEYS)) return "research";
  // 兜底：本地数据（大部分系统预取都是行情/快照类）
  return "local_data";
}

function stepStatusToPhase(s: StepInfo): PhaseStatus {
  if (s.status === "ok") return "done";
  if (s.status === "running") return "active";
  if (s.status === "error") return "error";
  // missing/stale 都算 done：拿不到不是错，是"没取到"（稳智 N() 归一化也是这么处理的）
  return "done";
}

/** 消息是否已经出正文（answer 阶段的完成信号） */
function answerDone(message: { content?: string; streaming?: boolean }): PhaseStatus {
  if (!message.content) return message.streaming ? "active" : "pending";
  if (message.streaming) return "active";
  return "done";
}

/**
 * P22：把 steps 按 6 阶段分组（保序）。StepTimeline 消费这份结果做分组渲染，
 * 避免在 tsx 里嵌 map/filter 逻辑（React 组件只排版，分组口径在纯核）。
 *
 * P27 稳智对齐：优先用 step.phase_key（后端显式发），没有时 fallback 到 classifyStep 语义映射。
 * 后端显式发更精确（不用猜），语义映射是兜底（旧服务端/未升级的客户端）。
 *
 * 分组口径：
 *   - 有 phase_key → 直接用
 *   - 无 phase_key → classifyStep（quote/行情→local_data；news/新闻→external_data；回测/筛选/因子→research；无关键词命中兜底 local_data）
 *
 * intent/skills/answer 三阶段永远空数组——步骤行只可能来自后三阶段（intent 靠徽章字段、
 * skills 靠 steps 存在判定、answer 靠消息流，都不是"步骤行"）。调用方按空数组跳过即可。
 */
export function groupStepsByPhase(steps: StepInfo[] | undefined): Record<PhaseKey, StepInfo[]> {
  const g: Record<PhaseKey, StepInfo[]> = {
    intent: [], skills: [], local_data: [], external_data: [], research: [], answer: [],
  };
  for (const s of steps ?? []) {
    // P27：优先用后端显式发的 phase_key，没有时 fallback 到语义映射
    const phase = s.phase_key ?? classifyStep(s);
    if (phase) g[phase].push(s);
  }
  return g;
}

/**
 * 从本轮消息推导 6 阶段状态。给 StepTimeline 画进度条用。
 *
 * 阶段归类：优先用 step.phase_key（后端显式发，按工具真实归属），没有才回落 classifyStep。
 *
 * 推导纪律（钉在单测里）：
 *  - intent：IntentBadge 存在 → done；否则 streaming 时 active、结束未识别 pending
 *  - skills：任何 steps 存在 → done（有工具调用就是选了分析方法）；否则 pending
 *  - local_data / external_data / research：至少一个 step 归类到这里且状态 done → done；
 *    有 running → active；有 error → error；空 → pending
 *  - answer：见 answerDone
 */
export function deriveAgentPhases(
  steps: StepInfo[] | undefined,
  intent: IntentBadge | null | undefined,
  message: { content?: string; streaming?: boolean },
): PhaseState[] {
  const list = steps ?? [];
  const perPhase: Record<PhaseKey, PhaseStatus[]> = {
    intent: [], skills: [], local_data: [], external_data: [], research: [], answer: [],
  };
  for (const s of list) {
    // P35 稳智对齐：优先用后端/调度层显式发的 phase_key（按工具真实归属标，见 chat-tools.phaseOfTool）。
    // 没有才回落到 classifyStep 语义映射——旧存档/未升级客户端/未标注的动态工具走这条兜底，
    // 与 groupStepsByPhase 同一口径（两处都「phase_key 优先」，进度条与分组不会各说各话）。
    const phase = s.phase_key ?? classifyStep(s);
    if (!phase) continue;
    perPhase[phase].push(stepStatusToPhase(s));
  }
  // 聚合：任何 error → error；任何 active → active；有 done 且无 active/error → done；空 → pending
  const agg = (arr: PhaseStatus[]): PhaseStatus => {
    if (arr.length === 0) return "pending";
    if (arr.some((s) => s === "error")) return "error";
    if (arr.some((s) => s === "active")) return "active";
    return "done";
  };
  // intent 特殊：有 IntentBadge 就 done；**已经开取数（steps 有）或已有正文，也按 done 算**——
  // 都调工具/出正文了，说明问题早就理解完了。否则流式全程会挂「正在进行：理解问题」（P36 实测）。
  const hasProgress = list.length > 0 || !!(message.content && message.content.trim());
  const intentStatus: PhaseStatus = (intent || hasProgress) ? "done" : (message.streaming ? "active" : "pending");
  // skills 特殊：只要有 steps 就 done，不看归类结果
  const skillsStatus: PhaseStatus = list.length > 0 ? "done" : "pending";

  return AGENT_PHASES.map((p) => {
    let status: PhaseStatus;
    if (p.key === "intent") status = intentStatus;
    else if (p.key === "skills") status = skillsStatus;
    else if (p.key === "answer") status = answerDone(message);
    else status = agg(perPhase[p.key]);
    return { key: p.key, emoji: p.emoji, zh: p.zh, status };
  });
}

/** 顶部大字文案（对齐稳智 f() 函数）：
 *   hasAnswer → "结论已形成 ✅"；activeToolLabel → "正在执行工具：xxx"；
 *   activeStepLabel → "正在进行：xxx"；progressPercent≥100 → "本轮研究已完成 ✅"；
 *   否则 → "正在整理研究进度 🔬"
 *
 * P36 修正：answer 阶段在正文流式时天然是 active，但它**不该盖过还在取数的阶段**——
 * 否则取数没完就报「正在进行：生成结论」。所以 active 优先取**非 answer** 的阶段；
 * 只剩 answer 活跃时才报「正在生成结论」（本仓 6 阶段里 answer 的中文名就是「生成结论」）。
 */
export function agentPhasesHeadline(phases: PhaseState[]): string {
  const answer = phases.find((p) => p.key === "answer");
  // P56 稳智对齐：收口后的单行头用户实测要「✨ AI 已完成分析 · 已完成 N 步」（不是「结论已形成」）
  if (answer?.status === "done") return "✨ AI 已完成分析";
  // 报当前正在做啥：先看数据/分析阶段，answer 的 active 放到最后
  const active = phases.find((p) => p.key !== "answer" && p.status === "active");
  if (active) return `${active.emoji} 正在进行：${active.zh}`;
  if (answer?.status === "active") return `${answer.emoji} 正在生成结论`;
  // 有一个 error
  const error = phases.find((p) => p.status === "error");
  if (error) return `⚠️ ${error.zh} 失败`;
  // 全部 pending
  return "🔬 正在整理研究进度";
}
