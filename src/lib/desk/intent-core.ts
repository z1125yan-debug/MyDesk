// P7-⑥② 场景意图识别（纯内核：给一句话 + 会话上下文，判它属于哪个场景、该注入哪段提示词、该自动调哪些工具）。
//
// 为什么单独一层：意图判定是「猜」，猜的规则必须能被测试钉住。
// 写在路由里就没法测，写在页面里就会出现三个入口各判一套，这两条都是 P7-⑤ 之前犯过的错。
//
// 三条口径（本轮不放松）：
//  1) 这是关键词 + 代码形状的**规则判定**，不是模型判定。每个 Intent 都带命中的关键词（hits）与并列场景
//     （alternates），界面和测试都能看出「为什么判成这个场景」。判不出来就是 general，不硬凑。
//  2) 场景只决定两件事：注入哪段场景提示词、先替模型取哪些数。它不关闭模型的工具调用能力，
//     自动调度是预取不是限制，模型仍可再调别的工具补数。
//  3) 取不到的东西不能靠场景词编出来：自选清单为空、没识别到代码、回测尚未接入，都写进提示词让它如实说。
// 带 .ts 后缀是 node --test 直跑纯内核的前提（与 quant/screener 下的 *-core.ts 同一套写法）。
import { isFollowUp } from "./chat-core.ts";

export type Scene =
  | "sentiment"      // 大盘情绪
  | "sector"         // 行业 / 概念板块
  | "screener"       // 量化选股
  | "quote"          // 行情查询（个股实时快照）
  | "watchlist"      // 自选股总览
  | "stock_analysis" // LLM 个股深度分析
  | "qimen"          // 奇门遁甲（本轮仅入口 + 提示词占位，排盘算法在 P7-⑨）
  | "general";       // 通用对话

export const SCENES: Scene[] = ["sentiment", "sector", "screener", "quote", "watchlist", "stock_analysis", "qimen", "general"];

/**
 * 外部传来的场景字符串归一（客户端回传的上一轮场景、请求体里的字段都算外部）。
 * 不认的就是没有：宁可当「上一轮没判过」，也不能让一个拼错的名字把提示词带到别的场景去。
 */
export function asScene(v: unknown): Scene | null {
  return typeof v === "string" && (SCENES as string[]).includes(v) ? (v as Scene) : null;
}

/** 场景中文名：徽章、提示词、步骤说明都用这一份，写两处迟早对不上 */
export const SCENE_LABELS: Record<Scene, string> = {
  sentiment: "大盘情绪",
  sector: "行业板块",
  screener: "量化选股",
  quote: "行情查询",
  watchlist: "自选股",
  stock_analysis: "个股分析",
  qimen: "奇门遁甲",
  general: "通用问答",
};

// ---------- 关键词表 ----------
// 数组顺序即优先级：一句话同时命中多个场景时取靠前的那个，其余记进 alternates。
// 为什么不做加权评分：评分要归一化、要调权重，最后变成一个没人能解释、也没法写断言的黑箱；
// 「优先级 + 命中词」判错了能一眼看出该改哪一行。
//
// watchlist 必须排在 screener 前面：纯子串匹配下「自**选股**」里含着「选股」，
// 于是「我的自选股现在整体怎么样」会被判成全市场选股（生产实测 curl 抓到的第一条误判：
// 徽章显示「量化选股」、自选总览的预取直接不做）。两条路的工具都还开着（模型照样能自己调
// factor_screener），差别只在先给用户看哪个场景、先替他取哪份真实数据 ——
// 用户问自己名下的清单时先取他的清单，比先给他一个选股口径更贴近那句话的意思。
// 反过来的说法（"从自选股里筛出放量上涨的"）会判成自选股，同时把「量化选股」记进 alternates，
// 提示词里点名，由模型决定是否补调筛选工具，不会因此丢掉选股能力。
//
// 「阻力 / 关键位 / 进场 / 风控」这四个词是浏览器实测（3014 + 假上游）补进来的：
// 小窗和助手页自己摆的快捷问里，「关键位在哪」「现在适合进场吗」「给我一个风控清单」三条
// 一个词都没命中，点一下徽章就是「通用问答」、skipped 写「按通用问答处理，未取数」——
// 界面递到用户嘴边的话，不该点了就退化成不取数的闲聊。
const SCENE_RULES: { scene: Scene; words: string[] }[] = [
  { scene: "watchlist", words: ["自选", "我的股票", "我的持仓", "持仓", "关注列表", "关注股"] },
  { scene: "screener", words: ["选股", "筛选", "筛出", "选出", "符合条件的股票", "全a", "全部a股", "有什么股票", "哪些股票", "推荐几只", "排个序", "因子"] },
  { scene: "sector", words: ["板块", "行业", "概念", "题材", "赛道", "资金榜", "领涨", "龙头"] },
  { scene: "sentiment", words: ["大盘", "情绪", "涨停", "跌停", "炸板", "赚钱效应", "风险等级", "市场", "指数", "成交额", "北向", "今天行情"] },
  { scene: "qimen", words: ["奇门", "遁甲", "九宫", "排盘", "占卜", "卦", "吉时", "方位", "风水", "命理"] },
  { scene: "stock_analysis", words: ["怎么看", "分析", "研报", "值不值", "能不能买", "该不该卖", "买点", "卖点", "目标价", "仓位", "止损", "止盈", "技术面", "基本面", "估值", "趋势", "支撑", "阻力", "压力", "破位", "关键位", "进场", "风控", "回测"] },
  { scene: "quote", words: ["现价", "报价", "最新价", "多少钱", "什么价", "价格", "股价", "行情", "买一", "卖一", "盘口"] },
];

// ---------- 代码识别 ----------

/**
 * 无后缀代码按交易所号段补后缀（全工程只有这一份号段口径：
 * chat-tools.normalizeSymbol、market.normalizeTradingViewSymbol、ProfilePage 的搜索框都已改为委托这里）。
 *
 * BJ 必须在 SH 之前判：SH 那条里有单独的 `9`，而北交所新代码段是 92xxxx，
 * 先判 SH 会把 920819 这类真实的北交所标的算成 920819.SH（沪市），
 * 于是取数取不到、跳转跳去一只不存在的标的——三个副本都曾这么错过。
 * 90xxxx（沪市 B 股）仍归 SH：BJ 只认 43/83/87/92 四个前缀。
 */
export function suffixOf(six: string): "SH" | "SZ" | "BJ" {
  if (/^(43|83|87|92)/.test(six)) return "BJ";
  if (/^(60|68|9|5)/.test(six)) return "SH";
  return "SZ";
}

/**
 * 代码形状正则的**唯一出处**。为什么给工厂而不是导出了一个常量：带 /g 的正则是有状态的
 * （exec 会推进 lastIndex），跨模块共享一个实例迟早出现「同一句正文两次调用抽出不同结果」这种查不动的错位。
 * 前后都不能再贴数字：否则日期 20260919 的前六位会被当成一个股票代码，把整轮问答带去看一只不存在的票。
 */
export function codeRe(): RegExp {
  return /(?<!\d)\d{6}(?:\.(?:SH|SZ|BJ))?(?!\d)/gi;
}

/** 正文里的一处代码出现：raw 是原样那串（可能不带后缀），symbol 是补全后的完整代码，start/end 是它在正文里的位置 */
export interface SymbolMatch {
  raw: string;
  symbol: string;
  start: number;
  end: number;
}

/**
 * 逐个出现地报（不去重）：链接层要知道「第几处」才能就地换成可点片段。
 * extractSymbols 只要「有哪些」，两者共用这一份匹配，避免出现两套代码形状口径。
 */
export function findSymbolMatches(text: string): SymbolMatch[] {
  const out: SymbolMatch[] = [];
  const re = codeRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? ""))) {
    out.push({
      raw: m[0],
      symbol: m[0].includes(".") ? m[0].toUpperCase() : `${m[0].slice(0, 6)}.${suffixOf(m[0].slice(0, 6))}`,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * 从自然语言里抽 6 位代码（可带 .SH/.SZ/.BJ）。
 * 只认代码形状，不做「名称到代码」的反查：那要查标的字典，属于取数层，纯层猜名字就是把猜测当事实。
 * 名称怎么变成标的由调用方处理（分析页当前品种 / 会话已关联标的），并如实标注来源。
 */
export function extractSymbols(text: string): string[] {
  const out: string[] = [];
  for (const mt of findSymbolMatches(text)) {
    if (!out.includes(mt.symbol)) out.push(mt.symbol);
  }
  return out;
}

// ---------- 判定 ----------

export interface IntentInput {
  /** 本轮用户提问原文 */
  question: string;
  /** 分析页当前品种：说「这只股」时用来兜底，会如实说明是沿用而非识别出来的 */
  focusSymbol?: string | null;
  /** 会话已关联的标的（上一轮问的是谁） */
  sessionSymbol?: string | null;
  /** 上一轮判到的场景（追问时沿用） */
  prevScene?: Scene | null;
}

export interface Intent {
  scene: Scene;
  label: string;
  /** 命中的关键词；general 时为空数组，界面据此显示「按通用问答处理」 */
  hits: string[];
  /** 除主场景外还命中了谁（一句话问两件事很常见）：提示词点名，由模型决定是否补取 */
  alternates: Scene[];
  /** 本轮实际使用的标的；null 表示这个场景不需要标的（大盘 / 板块 / 选股） */
  symbol: string | null;
  /** 标的从哪来：必须在提示词里如实说明，不能让用户以为系统认出了股票名字 */
  symbolSource: "question" | "session" | "focus" | "none";
  /** 是否沿用上一轮场景（追问） */
  inherited: boolean;
  /** 是否按追问处理（省略主语的短句） */
  followUp: boolean;
  /** 问题里出现的全部代码（多股对比时调度层逐个取数） */
  symbols: string[];
  /** 提问原文：场景提示词与调度计划都从这一个来源读，不再各处传第二份 */
  question: string;
}

/** 命中的场景（按优先级排好；general 不出现在这里） */
export function sceneHits(question: string): { scene: Scene; hits: string[] }[] {
  const q = (question ?? "").toLowerCase();
  return SCENE_RULES
    .map((r) => ({ scene: r.scene, hits: r.words.filter((w) => q.includes(w.toLowerCase())) }))
    .filter((x) => x.hits.length > 0);
}

/** 这个场景需不需要一个具体标的 */
function needsSymbol(scene: Scene): boolean {
  return scene === "quote" || scene === "stock_analysis" || scene === "qimen";
}

const SYMBOL_SOURCE_TEXT: Record<Intent["symbolSource"], string> = {
  question: "从你的提问里识别出的代码",
  session: "沿用本会话前面问的那只",
  focus: "分析页当前品种",
  none: "未识别到标的",
};

/** 标的来源的一句话说明（提示词与界面共用，两边措辞不会各自漂移） */
export function symbolSourceText(source: Intent["symbolSource"]): string {
  return SYMBOL_SOURCE_TEXT[source];
}

/**
 * 判场景。
 * 规则：抽代码 -> 命中的场景按优先级取第一个 -> 判不出来才是 general。
 * 追问（「那这个股明天怎么看」）本轮没有场景词时沿用上一轮场景与标的；
 * 但只要说了新代码，就算换了标的，重新取数。否则「那 600519 呢」会被答成上一只票。
 */
export function classifyIntent(input: IntentInput): Intent {
  const question = input.question ?? "";
  const symbols = extractSymbols(question);
  const followUp = isFollowUp(question);
  const matched = sceneHits(question);
  const own = matched[0];
  const alternates = matched.slice(1, 3).map((m) => m.scene);
  // 「那 600519 呢」这类：一个场景词都没有，只换了代码 + 带着指代/语气词 —— 场景该沿用上一轮，标的必须换。
  // chat-core.isFollowUp 看到 6 位代码就判「不是追问」（它的用途是决定要不要重新认标的），所以这里要自己再判一次。
  const trimmed = question.trim();
  const codeSwapFollowUp = !matched.length && symbols.length > 0 && (/^(那|它|这|该|同样|对比|再看|还有|继续|换)/.test(trimmed) || /[呢吧]$/.test(trimmed));

  const build = (scene: Scene, inherited: boolean): Intent => {
    let symbol: string | null = null;
    let symbolSource: Intent["symbolSource"] = "none";
    if (needsSymbol(scene)) {
      if (symbols.length) { symbol = symbols[0]; symbolSource = "question"; }
      else if (input.sessionSymbol) { symbol = input.sessionSymbol; symbolSource = "session"; }
      else if (input.focusSymbol) { symbol = input.focusSymbol; symbolSource = "focus"; }
    }
    return {
      scene,
      label: SCENE_LABELS[scene],
      hits: inherited ? [] : own?.hits ?? [],
      alternates,
      symbol,
      symbolSource,
      inherited,
      followUp: followUp || (inherited && codeSwapFollowUp),
      symbols,
      question,
    };
  };

  // 这轮没出现新场景词、又确实是接着上一轮问的：沿用上一轮场景（「那它明天怎么看」不该被当成新开一轮）
  const prevUsable = !!input.prevScene && input.prevScene !== "general";
  if (!own && prevUsable && (followUp || codeSwapFollowUp)) return build(input.prevScene as Scene, true);
  return build(own?.scene ?? "general", false);
}

// ---------- 场景提示词 ----------

export interface ScenePromptCtx {
  intent: Intent;
  /** 服务端日期（shanghaiDate()）：跨时区机器上不能靠 new Date() 现算「今天」 */
  today?: string;
  /** 本机自选条数（0 时要明确禁止拿热门股冒充自选） */
  watchlistCount?: number | null;
  /** 回测是否真的接进了对话链路（P7-⑥ 没有，默认按未接入处理） */
  backtestReady?: boolean;
  /**
   * P7-⑧④：可回测因子白名单那一行（由服务层现查数据库后经 backtest-core 渲染成串）。
   * 为什么这里只收一条已经渲染好的字符串：名单是库里的读数，写法归 backtest-core（测试也在那边钉），
   * 场景提示词只负责「放不放、放在哪」。反过来在这里拼一遍就会出现两份白名单文案。
   */
  backtestPromptLine?: string | null;
}

/**
 * 场景提示词的注入内容。
 * 只写「这类问题该怎么答、缺数据时怎么说」，不复述任何行情数字。
 * 数字来自取数块，提示词里复述一份迟早和取到的对不上。
 */
export function scenePrompt(scene: Scene, ctx: ScenePromptCtx): string {
  const { intent } = ctx;
  const head = `【场景：${SCENE_LABELS[scene]}${ctx.today ? `｜今日 ${ctx.today}` : ""}】`;
  const symbolNote = intent.symbol
    ? `本轮标的：${intent.symbol}（${symbolSourceText(intent.symbolSource)}）。`
    : needsSymbol(scene)
      ? "本轮没有可用的标的：先问清是哪只，不要自己挑一个来答。"
      : "";
  const lines: string[] = [head];
  switch (scene) {
    case "sentiment":
      lines.push(
        "回答大盘/市场整体状态：先给风险等级结论，再给涨跌家数、成交额、涨停/跌停与主力资金事实。",
        "不要只看单一指数就下「整体转弱」这种结论；指数与全 A 家数是两套口径，要分开说。",
        "没有情绪数据块时明确说「未取到当日情绪」，不要用印象补。",
      );
      break;
    case "sector":
      lines.push(
        "回答行业/概念板块：给资金净流入排名与涨跌幅，并说明是行业还是概念口径。",
        "板块内部个股分化时要点出来，不能把板块结论直接套到每只票上。",
      );
      break;
    case "screener":
      lines.push(
        "选股类问题：条件必须写成结构化 conditions（field 只能取自因子目录），并用 factor_screener 现跑，按真实命中数回答。",
        "命中 0 只就说 0 只，不要为了显得有结论而放宽条件；条件含糊时先问清一句再跑。",
        "不得凭印象报「哪些票强势」，那不是算出来的。",
      );
      break;
    case "quote":
      lines.push(
        "行情查询：只报实时快照里的数（价格、涨跌幅、成交额、主力净额），并写明取数时刻。",
        "缺哪个字段就说缺，不要用昨收或记忆里的价顶替现价。",
      );
      break;
    case "watchlist":
      lines.push(
        ctx.watchlistCount === 0
          ? "本机自选清单是空的：直接说明「你的自选清单为空」，不要拿热门股或示例代码冒充自选。"
          : "自选股问题一律基于本机自选清单现取行情：先逐只给涨跌幅与资金，再给整体强弱分布。",
        "清单来自用户浏览器存档（随请求带上），不是你推荐的持仓，也不要替用户加自选。",
      );
      break;
    case "stock_analysis":
      lines.push(
        "个股分析：先取数（快照 + 日 K 技术状态 + 资金流），再按「事实 -> 推断 -> 建议」三段回答。",
        "推断必须挂在取到的数上，取不到的维度直接说没取到；建议要给失效条件（什么价位或信号说明判断错了）。",
        "不得把 AI 推测写成市场事实，不得给「必涨」「稳赚」这类结论。",
      );
      break;
    case "qimen":
      lines.push(
        "奇门遁甲：本轮只提供入口，排盘算法尚未接入（P7-⑨ 单独实现）。",
        "可以说明它属于传统术数推演、不是市场数据，但不得虚构盘局、宫位、吉凶。",
        "如果用户其实想要行情或判断，直接改用行情与量化口径回答并说明这一点。",
      );
      break;
    case "general":
    default:
      lines.push(
        "通用问答：与行情无关的问题照常回答。",
        "涉及行情/选股/个股判断时说明本轮没有按交易场景取数，需要真实数据请换个更具体的问法。",
      );
      break;
  }
  if (intent.alternates.length) {
    lines.push(`这轮还问到「${intent.alternates.map((s) => SCENE_LABELS[s]).join("、")}」：需要该场景的数据就自己调用对应工具，不要凭印象答。`);
  }
  if (ctx.backtestReady === false && /回测/.test(intent.question)) {
    // P7-⑧④ 之后这句不再写「P7-⑦ 之后才做」：回测工具已经在了，走到这条分支的真实原因是
    // 「这一路没有工具调用环」（/api/ai/proxy 的 Anthropic/Gemini 原生协议），说成「还没做」是假话。
    lines.push("本轮没有可用的回测工具：不得声称已回测，也不得给出回测收益数字。");
  }
  if (ctx.backtestReady === true && ctx.backtestPromptLine) {
    lines.push(
      ctx.backtestPromptLine,
      "回测结论只能引用 run_backtest 本轮返回的数字：没调用、被白名单挡下、或者超时，就如实说没有结果，绝不给「大概年化多少」这种推测出来的回测数字。",
    );
  }
  if (symbolNote) lines.push(symbolNote);
  return lines.join("\n");
}

// ---------- 该场景下建议模型优先使用的工具 ----------

/**
 * 场景到优先工具（不排他：模型仍可调 TOOLS 里的任何一个）。
 * 自动调度也按这份顺序预取，两边共用一张表，否则会出现「界面说在取、模型却没拿到」。
 */
export function toolsForScene(scene: Scene): string[] {
  switch (scene) {
    case "sentiment": return ["market_sentiment", "market_news"];
    case "sector": return ["sector_rank", "market_sentiment"];
    case "screener": return ["factor_screener", "historical_probability"];
    case "quote": return ["stock_snapshot"];
    case "watchlist": return ["watchlist_overview", "market_sentiment"];
    case "stock_analysis": return ["stock_snapshot", "stock_kline_summary", "stock_fund_flow", "market_news"];
    // 奇门本轮不取数：没有真实盘局可取，取行情只会让它看起来像算了盘
    case "qimen": return [];
    case "general":
    default: return [];
  }
}

// ---------- 自动调度计划（取什么数、用什么参数、为什么） ----------

export interface DispatchCall {
  tool: string;
  args: Record<string, unknown>;
  /** 为什么要取它：这行会进步骤说明，用户能看到「因为判成个股分析所以取快照」 */
  reason: string;
}

export interface DispatchContext {
  intent: Intent;
  /**
   * 客户端随问题带回来的实时快照里已含的品种。
   * 只用于抵掉 stock_snapshot：K 线技术状态、资金流、快讯这些快照里没有，抵掉就是少给模型两组数据。
   */
  snapshotSymbols?: string[];
  /** 本机自选条数（0 时不必再调自选总览） */
  watchlistCount?: number;
  /** 提问是否显式要消息面；省略则由 wantsNews(提问原文) 判 */
  news?: boolean;
}

const NEWS_WORDS = ["为什么", "怎么回事", "消息", "利好", "利空", "公告", "新闻", "政策"];

/** 提问里是否显式要消息面 */
export function wantsNews(question: string): boolean {
  const q = question ?? "";
  return NEWS_WORDS.some((w) => q.includes(w));
}

/** 一次对话最多预取几只票：再多会把一轮问答拖成长查询，而用户多半只是列举 */
export const DISPATCH_MAX_SYMBOLS = 5;
/** 个股分析最多预取几只（每只 3 个工具，再深就慢得没法用） */
export const DISPATCH_ANALYSIS_MAX = 3;

/**
 * 取数计划：场景 + 标的 -> 一串要提前执行的工具调用，以及「为什么没取」的清单。
 *  - 快照里已经带了同一只票就不重复取，并把原因写进 skipped（界面要能说清）；
 *  - 选股场景不预取：条件得由模型从自然语言抽成结构化 conditions，替它猜条件等于替用户做决定；
 *  - 奇门 / 通用不取数；
 *  - 自选清单为空就不取，免得画出一个注定失败的步骤。
 */
export function planDispatch(ctx: DispatchContext): { calls: DispatchCall[]; skipped: string[] } {
  const { intent } = ctx;
  const calls: DispatchCall[] = [];
  const skipped: string[] = [];
  const covered = new Set((ctx.snapshotSymbols ?? []).map((s) => s.toUpperCase()));
  const wantNews = ctx.news ?? wantsNews(intent.question);
  const symbols = intent.symbols.length ? intent.symbols : intent.symbol ? [intent.symbol] : [];
  const capped = symbols.slice(0, DISPATCH_MAX_SYMBOLS);
  if (symbols.length > capped.length) skipped.push(`提问涉及 ${symbols.length} 个代码，本轮只取前 ${DISPATCH_MAX_SYMBOLS} 个`);

  const push = (tool: string, args: Record<string, unknown>, reason: string, dedupeKey?: string) => {
    if (dedupeKey && covered.has(dedupeKey.toUpperCase())) {
      skipped.push(`${tool} · ${dedupeKey}：客户端快照已带该品种实时数据，未重复取数`);
      return;
    }
    calls.push({ tool, args, reason });
  };

  switch (intent.scene) {
    case "sentiment":
      calls.push({ tool: "market_sentiment", args: {}, reason: `问题按「${SCENE_LABELS.sentiment}」处理` });
      if (wantNews) calls.push({ tool: "market_news", args: { limit: 8 }, reason: "同时问了消息面/原因" });
      break;
    case "sector":
      calls.push({
        tool: "sector_rank",
        args: { kind: intent.question.includes("概念") ? "concept" : "industry", size: 15 },
        reason: `问题按「${SCENE_LABELS.sector}」处理`,
      });
      break;
    case "quote":
      for (const s of capped) push("stock_snapshot", { symbol: s }, `按「${SCENE_LABELS.quote}」取实时快照`, s);
      break;
    case "stock_analysis":
      for (const s of capped.slice(0, DISPATCH_ANALYSIS_MAX)) {
        // 去重只对快照有效：客户端带回来的是「当前图表的实时行情」，K 线技术状态与资金流它并没有算过，
        // 拿快照去抵掉后两个工具，等于让模型在少了两组数据的情况下继续下结论。
        push("stock_snapshot", { symbol: s }, `按「${SCENE_LABELS.stock_analysis}」取实时快照`, s);
        push("stock_kline_summary", { symbol: s }, "取日 K 并算技术状态（均线/MACD/KDJ/RSI）");
        push("stock_fund_flow", { symbol: s }, "取近 14 日主力资金");
      }
      if (capped.length > DISPATCH_ANALYSIS_MAX) skipped.push(`个股分析一次最多看 ${DISPATCH_ANALYSIS_MAX} 只，其余请分开问`);
      if (wantNews) calls.push({ tool: "market_news", args: { limit: 8 }, reason: "同时问了消息面/为什么" });
      break;
    case "watchlist":
      if ((ctx.watchlistCount ?? 0) === 0) skipped.push("本机自选清单为空，未调自选总览（空清单不是取数失败）");
      else calls.push({ tool: "watchlist_overview", args: {}, reason: `按「${SCENE_LABELS.watchlist}」取全部自选的实时行情` });
      break;
    case "screener":
      skipped.push("选股条件需由模型从提问里抽取，未预取（把猜出来的条件当成用户要求是事故）");
      break;
    case "qimen":
      skipped.push("奇门遁甲本轮只做入口：排盘算法未接入，不取数");
      break;
    case "general":
    default:
      skipped.push("按通用问答处理，未取数");
      break;
  }
  return { calls, skipped };
}

/**
 * 把预取结果并成注入模型的一段上下文。
 * 抬头必须写明「系统按场景自动取的真实数据」：模型要知道这些数既不是它算的，也不是用户给的。
 *
 * 取到的一律按工具分块给出；没取到的（抛错 / 接口给了 missing）只在尾部列名字和原因，不给数据正文——
 * 这一步不能省：模型不知道哪块是空的，就会拿印象里的数字补上，那正是 REAL_DATA_ONLY 要拦的事。
 * 一条都没取到时返回空串：没有真实数据可注入，宁可让模型按提示词回「暂无数据」。
 */
export function renderDispatchBlock(
  rows: { tool: string; ok: boolean; text: string }[],
  missing?: { tool: string; why: string }[],
): string {
  const ok = (rows ?? []).filter((r) => r.ok && r.text.trim());
  const gaps = (missing ?? []).filter((m) => m?.tool);
  if (!ok.length) return "";
  return [
    "[系统按场景自动取数]",
    "以下是本轮提问前系统替你取的真实数据（来源见每块内的标注），不是用户提供的，也不是你算出来的：",
    ...ok.map((r) => `### ${r.tool}\n${r.text}`),
    "字段缺失以块内写的「缺失」为准，不要当成 0。",
    ...(gaps.length
      ? [`[本轮未取到的数据]\n${gaps.map((m) => `- ${m.tool}：${m.why}`).join("\n")}\n这些维度本轮没有数据：回答里直接写「暂无数据」，不得凭印象或记忆补数。`]
      : []),
  ].join("\n\n");
}
