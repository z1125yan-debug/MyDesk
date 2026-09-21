// P7-⑥④ 场景自动调度的服务层：把 intent-core 的计划用 chat-tools 的真实取数执行掉。
//
// 这一层只有「接线」：计划怎么定、结果怎么说，分别由 intent-core（判定）和 dispatch-core（编排）负责，
// 两边都能被 node --test 直接跑。本层 import 了工具注册表，所以它不可测——这是有意的：
// 一旦在这里写 if/else 决定「取什么」，那些判断就脱离测试了（P7-⑤ 之前的老路）。
//
// 与工具调用环共用同一份 chat-tools：同一个「今天大盘情绪」在预取和模型自取两条路上只能算出一个数。
//
// P8-①/② 在这层加的接线（判定都不在这层，全在可测的纯核里）：
//  - 新鲜度：预取完先拿 000001.SH 日K 当交易日历，把每路日K读数与基准比对（freshness-core 判），
//    滞后/无法判定既进提示词纪律段、也在步骤时间线留一条 stale 步骤（缺数据直接告知用户）；
//  - 结论契约：仅个股研判场景现场算一张 v3 结论卡（与结论卡页同一入口 buildDecisionForSymbol），
//    算出来才把「引擎全文 + 锁死数字的契约 JSON」注入本轮；纯行情查询走不到这条路（风险点 3 的闸）。
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
import { shanghaiDate } from "./session";
import { fetchBarsHybridTracked } from "@/lib/quant/data/hybrid";
import { buildDecisionForSymbol, type DecisionView } from "@/lib/quant/screener/decision-service";
import {
  CONTRACT_QUOTE_RULE, buildDecisionContract, contractWarningText, renderDecisionContract,
  shouldBuildDecisionContract, verifyContractCitations, type DecisionContract,
} from "@/lib/quant/screener/decision-core";
import {
  buildFreshnessReport, gapTradingDays, judgeBarFreshness, klineLastDatesFromResult,
  latestNotAfter, freshnessPromptRule, type BarFreshness, type FreshnessReport,
} from "./freshness-core";

/** 结论卡现场构建的时间闸：超了按「本轮没有决策结果」处理，不给对话加无上限的等待 */
const CONTRACT_BUILD_TIMEOUT_MS = 30_000;
/** 交易日历回溯根数：够覆盖长假断档判定，40 根与结论卡同批取数不超一个量级 */
const CALENDAR_LOOKBACK = 40;

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
  /**
   * P8-①：每个成功返回的工具的原始结果（与 steps 同序收集，序列化前的一份）。
   * 新鲜度要看的是「最近5日」这种结构里的日期，注入块是截断过的文本，不能拿它当判据来源。
   */
  raws: { tool: string; args: Record<string, unknown>; out: unknown }[];
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
  // P8-①：新鲜度判的是结构里的日期（「最近5日」最后一根的日期），注入块截断过、不能当判据，
  // 所以在 execute 这一层顺手留一份序列化前的原始结果。未注册的工具不算「取到了」，不入列。
  const raws: PrefetchResult["raws"] = [];
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
      const out = await tool.fn(call.args, opts.ctx);
      raws.push({ tool: call.tool, args: call.args, out });
      return out;
    },
  });
  return {
    block: renderDispatchBlock(result.rows, result.missing),
    steps: result.steps,
    trace: result.trace,
    // 没执行的调用（客户端断开）也要留痕：静默消失会被当成「取过了但没内容」
    skipped: [...skipped, ...result.notRun.map((t) => `${t}：客户端已断开，本轮未执行`)],
    nextStep: stepStart + result.steps.length,
    raws,
  };
}

// ---------- 一轮对话的场景准备（两个聊天端点共用这一份） ----------

export interface SceneTurn {
  intent: Intent;
  /** 给用户看的徽章：命中的场景词、标的从哪来、本轮没取什么数，全部是判定层给的真实结果 */
  badge: IntentBadge;
  /** 场景系统提示词（含新鲜度纪律段与契约引用规则，若有）；调用方作为额外 system 件注入 */
  prompt: string;
  /** 预取数据块；空串表示本轮没有可注入的真实数据 */
  block: string;
  steps: StepInfo[];
  trace: DispatchTrace[];
  skipped: string[];
  /** 模型工具调用环要从这个序号接着编 */
  nextStep: number;
  /** P8-①：本轮新鲜度核对结果（没有可核对的读数时为 null，表示「没查」，不是「都新鲜」） */
  freshness: FreshnessReport | null;
  /**
   * P8-②：本轮注入的结论契约（仅个股研判且结论卡真算出来时非 null）。
   * 路由在回答完成后拿它核对模型引用的数字——只在有契约时核对，纯行情查询不注入也不核对（风险点 3）。
   */
  contract: DecisionContract | null;
}

/** 结论卡构建超时/失败的收口形状：不 throw 到调用方，失败也要如实带进步骤 */
interface DecisionOutcome {
  view: DecisionView | null;
  error: string | null;
}

function buildDecisionWithTimeout(symbol: string): Promise<DecisionOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ view: null, error: `结论卡构建超过 ${Math.round(CONTRACT_BUILD_TIMEOUT_MS / 1000)} 秒，本轮按「没有决策结果」处理` });
    }, CONTRACT_BUILD_TIMEOUT_MS);
    // 不阻止进程退出（回答早已结束时没必要留着这个计时器）
    (timer as unknown as { unref?: () => void }).unref?.();
    buildDecisionForSymbol(symbol).then(
      (view) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ view, error: null }); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ view: null, error: (e as Error)?.message || "结论卡构建失败" }); } },
    );
  });
}

/**
 * P8-②：回答写完后拿契约核对模型引用的数字（风险点 4：只出警告，不改模型输出、不自动重试）。
 * 放这层是因为两个聊天端点都要用同一份口径；判定本身（怎么算引用了数字、对不对得上）全在 decision-core 纯核里。
 */
export function contractWarningOf(turn: Pick<SceneTurn, "contract">, fullText: string): string | null {
  if (!turn.contract) return null;
  const bad = verifyContractCitations(fullText, turn.contract);
  return bad.length ? contractWarningText(bad) : null;
}

/**
 * 拿到用户这句话以后：判场景 -> 出场景提示词 -> 按场景预取真实数据 -> 核对新鲜度（P8-①）
 * -> 个股研判场景现场构建结论契约（P8-②）-> 出徽章。
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

  // ---------- P8-①/②：取完数之后的新鲜度核对与结论契约（接线在这，判定全在纯核） ----------
  const today = opts.today ?? shanghaiDate();
  const klineRaws = prefetched.raws.filter((r) => r.tool === "stock_kline_summary");
  // 风险点 3 的闸：只有个股研判场景有「决策结果」可言，纯行情查询走不到这条路。
  const wantDecision = shouldBuildDecisionContract(intent.scene) && !!intent.symbol && !opts.isCancelled?.();
  const skipped = [...prefetched.skipped];
  if (shouldBuildDecisionContract(intent.scene) && !intent.symbol) {
    skipped.push("未构建结论契约：本轮研判没有落到具体标的，没有可锁死的决策结果");
  }
  // 结论卡（慢路）与交易日历（快路）并行发起：两份取数互不依赖，不该让用户排两次队。
  const decisionPromise = wantDecision && intent.symbol ? buildDecisionWithTimeout(intent.symbol) : null;

  // 交易日历与行情页交易日选择器同源（000001.SH 日K 真实日期，见 /api/quant/screener/trade-dates）。
  // 拿不到日历不装作查过：能核对的读数会全部落 unknown，并如实上屏（风险点 1：unknown ≠ 新鲜）。
  let calendarDates: string[] = [];
  if (klineRaws.length || decisionPromise) {
    try {
      const r = await fetchBarsHybridTracked(["000001.SH"], today, CALENDAR_LOOKBACK);
      calendarDates = (r.bars.get("000001.SH") ?? []).map((b) => b.date).filter(Boolean);
    } catch {
      calendarDates = [];
    }
  }
  const expected = latestNotAfter(calendarDates, today);

  const items: BarFreshness[] = [];
  const gaps: { label: string; missing: string[] }[] = [];
  for (const r of klineRaws) {
    const dates = klineLastDatesFromResult(r.out);
    // 该步本来就 missing / 形状不认：时间线上已有「缺数据」留痕，不再叠一条「无法判定新鲜度」——
    // 那会把取数失败错报成新鲜度问题。这里只核对「取到了但可能不新」的读数。
    if (!dates.length) continue;
    const label = `${String(r.args.symbol ?? "?")} 日K`;
    const last = dates.reduce((a, b) => (b > a ? b : a));
    items.push(judgeBarFreshness({ label, last_date: last, expected_date: expected }));
    const missing = gapTradingDays(dates, calendarDates);
    if (missing?.length) gaps.push({ label, missing });
  }

  const outcome = decisionPromise ? await decisionPromise : null;
  if (outcome?.view) {
    items.push(judgeBarFreshness({
      label: `结论卡技术日K（${outcome.view.subject}）`,
      last_date: outcome.view.wiring.technical_bar_date,
      expected_date: expected,
    }));
  }
  const freshness = items.length || gaps.length ? buildFreshnessReport(items, gaps) : null;

  // 追加步骤：新鲜度核对与结论卡构建都进时间线，序号接着预取往后编，两条传输（step 事件 / steps 数组）同源。
  const extraSteps: StepInfo[] = [];
  let stepNo = prefetched.nextStep;
  const addStep = (s: StepInfo) => {
    extraSteps.push(s);
    opts.emit?.({ type: "step", data: s });
  };
  if (freshness) {
    addStep({
      step: ++stepNo,
      label: "比对真实交易日历（000001.SH）核对日K新鲜度",
      status: freshness.has_issues ? "stale" : "ok",
      source: "prefetch",
      reason: "P8-①：取数后、回答前先核对新鲜度，不拿过期行情当今日结论",
      detail: freshness.has_issues
        ? freshness.lines.join(" ")
        : `${items.length} 份读数与基准交易日 ${expected} 一致`,
    });
  }
  let contract: DecisionContract | null = null;
  let blockAppend = "";
  if (decisionPromise) {
    const view = outcome?.view ?? null;
    addStep(view
      ? {
          step: ++stepNo,
          label: `现场用 v3 引擎算结论卡（${view.subject}）`,
          status: "ok",
          source: "prefetch",
          reason: "P8-②：个股研判要以本地引擎结论为准，模型引用的数字由契约锁死",
          detail: `综合得分 ${view.decision.final_score}（${view.decision.grade}），参考日 ${view.trade_date}`,
        }
      : {
          step: ++stepNo,
          label: "现场用 v3 引擎算结论卡",
          status: "missing",
          source: "prefetch",
          reason: "P8-②：算不出就不注入，模型按已取到的数据回答，但没有本地结论可引用",
          detail: outcome?.error ?? "结论卡构建失败",
        });
    if (view) {
      contract = buildDecisionContract(view);
      blockAppend = [
        "",
        "",
        `[本地决策结论卡 · v3 引擎实算 · ${view.subject}]`,
        view.text,
        "",
        `契约 JSON（数字锁死，逐字引用）：${renderDecisionContract(view)}`,
        CONTRACT_QUOTE_RULE,
      ].join("\n");
    }
  }
  if (outcome?.error) skipped.push(`结论卡未构建：${outcome.error}`);

  const block = prefetched.block + blockAppend;
  return {
    intent,
    badge: intentBadgeOf(intent, { skipped, prefetchChars: block.length }),
    prompt: freshness?.has_issues ? `${prompt}\n\n${freshnessPromptRule(freshness.lines)}` : prompt,
    block,
    steps: [...prefetched.steps, ...extraSteps],
    trace: prefetched.trace,
    skipped,
    nextStep: stepNo,
    freshness,
    contract,
  };
}
