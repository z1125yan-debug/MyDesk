// P7-⑥④ 场景自动调度的服务层：把 intent-core 的计划用 chat-tools 的真实取数执行掉。
//
// 这一层只有「接线」：计划怎么定、结果怎么说，分别由 intent-core（判定）和 dispatch-core（编排）负责，
// 两边都能被 node --test 直接跑。本层 import 了工具注册表，所以它不可测——这是有意的：
// 一旦在这里写 if/else 决定「取什么」，那些判断就脱离测试了（P7-⑤ 之前的老路）。
//
// 与工具调用环共用同一份 chat-tools：同一个「今天大盘情绪」在预取和模型自取两条路上只能算出一个数。
import { backtestWhitelist, findTool, BACKTEST_READY, type ToolCtx } from "./chat-tools";
import { whitelistPromptLine, type WhitelistRow } from "./backtest-core";
import {
  asScene,
  classifyIntent,
  extractSymbols,
  planDispatch,
  renderDispatchBlock,
  scenePrompt,
  type Intent,
} from "./intent-core";
import { runDispatchPlan, type DispatchTrace } from "./dispatch-core";
import { intentBadgeOf, splitSnapshotMessage, type IntentBadge, type StepInfo } from "./chat-core";
import type { StreamEvent } from "./chat-stream-core";

export interface PrefetchResult {
  /** 注入模型的取数块（含「本轮未取到」清单）；一条都没取到时是空串，调用方据此不注入 */
  block: string;
  /** 预取占用的步骤（running 与终态都在里面） */
  steps: StepInfo[];
  /** 非流式路径用的执行记录，与工具调用环的 trace 同形 */
  trace: DispatchTrace[];
  /** 计划阶段就没取的项（自选为空 / 选股条件待抽取 / 奇门不取数…） */
  skipped: string[];
  /** 模型自己的工具调用要接着这个序号往下编，两套步骤不能都从 1 开始 */
  nextStep: number;
}

/**
 * 按场景预取一次。
 * 说清楚它不做什么：它不替模型决定答案，也不关掉模型的工具调用能力（预取＝先给数据，不是限制）；
 * 更不参与「判成哪个场景」——那是 intent-core.classifyIntent 的活，这里只吃它给的 Intent。
 */
export async function prefetchForScene(opts: {
  intent: Intent;
  ctx: ToolCtx;
  /** 客户端随提问带回来的快照里已含品种（只用于抵掉重复的实时快照） */
  snapshotSymbols?: string[];
  /** 流式下把步骤事件推给前端；非流式下省略即可，步骤照样收集进返回值 */
  emit?: (ev: StreamEvent) => void;
  isCancelled?: () => boolean;
  stepStart?: number;
}): Promise<PrefetchResult> {
  const { calls, skipped } = planDispatch({
    intent: opts.intent,
    snapshotSymbols: opts.snapshotSymbols,
    watchlistCount: opts.ctx.watchlist?.length ?? 0,
  });
  const stepStart = opts.stepStart ?? 0;
  const result = await runDispatchPlan({
    calls,
    stepStart,
    isCancelled: opts.isCancelled,
    onStep: (s) => opts.emit?.({ type: "step", data: s }),
    execute: async (call) => {
      const tool = findTool(call.tool);
      // 计划里的工具名不在注册表＝代码对不上，不是「数据缺失」：写得直白一点，方便定位
      if (!tool) return { missing: `调度计划里的工具「${call.tool}」未注册（代码与工具表不一致，本轮该块无数据）` };
      // args 由 planDispatch 按各工具的入参形状写死（不是模型给的），所以这里不需要再容错解析
      return tool.fn(call.args, opts.ctx);
    },
  });
  return {
    block: renderDispatchBlock(result.rows, result.missing),
    steps: result.steps,
    trace: result.trace,
    // 没执行的调用（客户端断开）也要留痕：静默消失会被当成「取过了但没内容」
    skipped: [...skipped, ...result.notRun.map((t) => `${t}：客户端已断开，本轮未执行`)],
    nextStep: stepStart + result.steps.length,
  };
}

// ---------- 一轮对话的场景准备（两个聊天端点共用这一份） ----------

export interface SceneTurn {
  intent: Intent;
  /** 给用户看的徽章：命中的场景词、标的从哪来、本轮没取什么数，全部是判定层给的真实结果 */
  badge: IntentBadge;
  /** 场景系统提示词（调用方作为额外 system 件注入） */
  prompt: string;
  /** 预取数据块；空串表示本轮没有可注入的真实数据 */
  block: string;
  steps: StepInfo[];
  trace: DispatchTrace[];
  skipped: string[];
  /** 模型工具调用环要从这个序号接着编 */
  nextStep: number;
}

/**
 * 拿到用户这句话以后：判场景 -> 出场景提示词 -> 按场景预取真实数据 -> 出徽章。
 *
 * 为什么抽成一个函数：/api/ai/chat（工具调用环）和 /api/ai/proxy（无工具环的服务商）
 * 必须对同一句话判出同一个场景、取同一批数。分两处写迟早一边注入了场景提示词、另一边没有，
 * 用户在两个入口问同一句话会得到两套口径 —— 那正是本轮要消掉的「两边各做一套」。
 *
 * 它不改写用户的问题，也不替模型决定答案；判不出来就是 general（提示词会如实说没按交易场景取数）。
 */
export async function prepareSceneTurn(opts: {
  /** 最后一条用户消息原文（可能带快照标记，本函数负责拆） */
  userContent: string;
  ctx: ToolCtx;
  /** 分析页当前品种 */
  focusSymbol?: string | null;
  /** 本会话前面用到的标的（客户端从上一条助手消息的徽章里取，不是会话字段） */
  sessionSymbol?: string | null;
  /** 上一轮判到的场景，字符串按外部输入处理（不认就当没判过） */
  prevScene?: unknown;
  /** 服务端日期（shanghaiDate()）：纯层不碰时钟 */
  today?: string;
  /** 回测是否接入对话链路：不传按工具层实际注册情况定（见 chat-tools 的 BACKTEST_READY），
   *  而不是在这里写死 true/false —— 写死过一次，接上回测之后就没人记得回来改它 */
  backtestReady?: boolean;
  emit?: (ev: StreamEvent) => void;
  isCancelled?: () => boolean;
  stepStart?: number;
}): Promise<SceneTurn> {
  // 客户端会把当前图表的实时快照拼在提问后面（带 SNAPSHOT_MARK）。
  // 判场景只看用户原话：快照里的「涨停」「成交额」这些字眼会把一句闲聊判成大盘情绪。
  const { question, snapshot } = splitSnapshotMessage(opts.userContent);
  const intent = classifyIntent({
    question,
    focusSymbol: opts.focusSymbol ?? null,
    sessionSymbol: opts.sessionSymbol ?? null,
    prevScene: asScene(opts.prevScene),
  });
  const backtestReady = opts.backtestReady ?? BACKTEST_READY;
  // 白名单只在这句话真的提到「回测」时才查：因子表是「每个 factorKey 一次查询」，
  // 为一句闲聊跑它不值。没看到名单就自己调工具的模型也不会跑偏——工具那侧还有同一道校验，
  // 拒绝时会把名单一起带回去，它下一轮就照着改。
  let whitelist: WhitelistRow[] | null = null;
  let whitelistError: string | null = null;
  if (backtestReady && /回测/.test(question)) {
    try {
      whitelist = await backtestWhitelist();
    } catch (e) {
      whitelistError = (e as Error).message || "因子白名单查询失败";
    }
  }
  const backtestPromptLine = whitelist
    ? whitelistPromptLine(whitelist)
    : whitelistError
      ? `可回测因子白名单本轮没读到（${whitelistError}）：不要凭记忆猜因子，先如实说明名单没读到，再让用户改问法或去量化研究页跑。`
      : null;
  const prompt = scenePrompt(intent.scene, {
    intent,
    today: opts.today,
    watchlistCount: opts.ctx.watchlist?.length ?? null,
    backtestReady,
    ...(backtestPromptLine ? { backtestPromptLine } : {}),
  });
  const prefetched = await prefetchForScene({
    intent,
    ctx: opts.ctx,
    // 快照里出现的代码只用来抵重复的实时快照（K 线技术状态/资金流快照里没有，planDispatch 里没抵）
    snapshotSymbols: snapshot ? extractSymbols(snapshot) : [],
    emit: opts.emit,
    isCancelled: opts.isCancelled,
    stepStart: opts.stepStart,
  });
  return {
    intent,
    badge: intentBadgeOf(intent, { skipped: prefetched.skipped, prefetchChars: prefetched.block.length }),
    prompt,
    block: prefetched.block,
    steps: prefetched.steps,
    trace: prefetched.trace,
    skipped: prefetched.skipped,
    nextStep: prefetched.nextStep,
  };
}
