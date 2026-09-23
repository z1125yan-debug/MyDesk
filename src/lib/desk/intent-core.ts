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
// P8-③：自动调度的「谁进哪个场景、怎么给参、必读与否」搬进 skills-core 的可注册表；
// 本层保留计划解释与全部文案（reason/skipped 的措辞单一出处），两边都还是纯函数。
import {
  SKILLS, DISPATCH_MAX_SYMBOLS, DISPATCH_ANALYSIS_MAX,
  type SkillArgs, type SkillPlanEntry, type SkillReason, type SkillRegistry,
} from "./skills-core.ts";
// P10 择优轮：选股场景候选池的条件抽取纯核（同为零 IO 纯函数，node --test 直跑不受影响）
import { extractPickConds, PICK_DISCIPLINE } from "../quant/screener/pick-pool-core.ts";
export { DISPATCH_MAX_SYMBOLS, DISPATCH_ANALYSIS_MAX };

export type Scene =
  | "sentiment"      // 大盘情绪
  | "sector"         // 行业 / 概念板块
  | "screener"       // 量化选股
  | "quote"          // 行情查询（个股实时快照）
  | "watchlist"      // 自选股总览
  | "stock_analysis" // LLM 个股深度分析
  | "qimen"          // 奇门遁甲（排盘在「奇门解盘」面板本地实算；对话场景只引导切换，不起局）
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
// 同口径 P9-观感轮再补「对比 / 交易计划」：对话页空状态的七张建议卡里，
// 「帮我对比几只股票谁更强」「帮我做一个股票交易计划」两句原本也不命中任何词——
// 前者正是多代码对比取数的入口（调度层本来就支持逐只取），后者离了现价/技术面就是空谈。
const SCENE_RULES: { scene: Scene; words: string[] }[] = [
  { scene: "watchlist", words: ["自选", "我的股票", "我的持仓", "持仓", "关注列表", "关注股"] },
  { scene: "screener", words: ["选股", "筛选", "筛出", "选出", "符合条件的股票", "全a", "全部a股", "有什么股票", "哪些股票", "推荐几只", "排个序", "因子"] },
  { scene: "sector", words: ["板块", "行业", "概念", "题材", "赛道", "资金榜", "领涨", "龙头"] },
  { scene: "sentiment", words: ["大盘", "情绪", "涨停", "跌停", "炸板", "赚钱效应", "风险等级", "市场", "指数", "成交额", "北向", "今天行情"] },
  { scene: "qimen", words: ["奇门", "遁甲", "九宫", "排盘", "占卜", "卦", "吉时", "方位", "风水", "命理"] },
  // 「怎么样」是 R10 扩容补的：3014 实测「中国电影卖的怎么样」一个词都不命中、判成通用问答不取数——
  // 用户嘴里的研判就是这么说的。抢不走前排场景：「我的自选怎么样」仍归自选、「大盘怎么样」仍归情绪（优先级在前）。
  { scene: "stock_analysis", words: ["怎么看", "怎么样", "分析", "研报", "值不值", "能不能买", "该不该卖", "买点", "卖点", "目标价", "仓位", "止损", "止盈", "技术面", "基本面", "估值", "趋势", "支撑", "阻力", "压力", "破位", "关键位", "进场", "风控", "回测", "对比", "交易计划"] },
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

/**
 * R10 扩容：从提问里露出「可能是公司名」的候选片段（纯函数：只提议，不断言）。
 * 用户说票说的是名字（「中国电影卖的怎么样」），代码形状识别拿不到标的——
 * 这里把疑问词/功能词/场景词剔掉，剩下的 2~6 字连续中文段就是候选，交给服务层
 * 拿东财搜索验证；只有命中的才算标的，并且出处如实标成「按公司名匹配」（见 nameHits）。
 * 候选表不自己认定任何名字：纯层猜名字仍是把猜测当事实，这层连「像名字」都不算数。
 */
const NAME_STOPWORDS =
  "请问|帮我|给我|我想|我要|有没有|是不是|能不能|可不可以|值不值|值不值得|行不行|怎么样|怎样|怎么|咋样|如何|为什么|为何|什么|现在|今天|昨天|明天|最近|近期|短期|后市|整体|这|那|它|他|她|们|的|了|吗|呢|吧|啊|呀|和|与|跟|或|是|就|都|还|也|再|把|被|给|在|个|只|买|卖|加仓|减仓|建仓|清仓|补仓|持有|持仓|自选|关注|走势|行情|表现|情况|消息|新闻|公告|政策|基本面|技术面|分析|研究|看看|介绍|对比|评价|预测|目标|仓位|止损|止盈|买点|卖点|一下|股|票|大盘|指数|板块|行业|概念|题材|龙头|资金|涨停|跌停|放量|缩量|突破|支撑|压力|破位|反弹|回调|进场|出场|风控|操作";

export function nameCandidates(question: string): string[] {
  const cut = (question ?? "").replace(new RegExp(NAME_STOPWORDS, "g"), " ");
  const out: string[] = [];
  for (const m of cut.matchAll(/[\u4e00-\u9fa5]{2,6}/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out.slice(0, 5);
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
  /**
   * R10 扩容：调用方拿公司名候选（nameCandidates）经东财搜索验证后的命中结果。
   * 纯层不做 IO 也不猜名字——名字只有在这里（被外部查证过）才能升格为标的；
   * 带代码提问时代码优先，nameHits 不参与（用户直接写的代码比名字搜索更可信）。
   * matchKind 如实记录命中方式（R10c）：exact=全等，prefix=简称唯一命中全称，suffix=砍组织形式词尾缀后唯一命中。
   */
  nameHits?: { name: string; symbol: string; matchKind?: "exact" | "prefix" | "suffix" }[];
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
  symbolSource: "question" | "session" | "focus" | "name" | "none";
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
  name: "按提问里的公司名经东财搜索匹配（全等或简称唯一命中全称，不是用户直接给的代码）",
  none: "未识别到标的",
};

/** 标的来源的一句话说明（提示词与界面共用，两边措辞不会各自漂移） */
export function symbolSourceText(source: Intent["symbolSource"]): string {
  return SYMBOL_SOURCE_TEXT[source];
}

/**
 * 任意输入的来源取词（R10b）：认得的原始键给人话，认不出的原样透传。
 * 给 Debug 意图行这类「值可能来自历史留底」的场合——旧档里这一格存的本来就是人话（如「提问内代码」），
 * 不许改写成「来源未标注」，也不许把 question/name 这种原始键漏给用户看。
 */
export function symbolSourceLabel(source: string): string {
  return (SYMBOL_SOURCE_TEXT as Record<string, string | undefined>)[source] ?? source;
}

/**
 * 判场景。
 * 规则：抽代码 -> 命中的场景按优先级取第一个 -> 判不出来才是 general。
 * 追问（「那这个股明天怎么看」）本轮没有场景词时沿用上一轮场景与标的；
 * 但只要说了新代码，就算换了标的，重新取数。否则「那 600519 呢」会被答成上一只票。
 */
export function classifyIntent(input: IntentInput): Intent {
  const question = input.question ?? "";
  const codeSyms = extractSymbols(question);
  // R10 扩容：带代码时代码优先（用户写的比搜出来的可信）；没代码才用服务层查证过的 nameHits，
  // 且出处标成 name 而不是 question——徽章与提示词都要能看出「这个代码是系统按名字搜到的，不是你报的」。
  const nameSyms = (input.nameHits ?? []).map((h) => h.symbol).filter((s) => !codeSyms.includes(s));
  const symbols = codeSyms.length ? codeSyms : nameSyms;
  const fromName = !codeSyms.length && nameSyms.length > 0;
  const followUp = isFollowUp(question);
  const matched = sceneHits(question);
  // P10 择优轮：条件句式选股（「帮我找成交额大于5亿、站上20日线的股票」这类）词表没覆盖到，
  // 但纯核能抽出 ≥2 条量化条件、句子里有股/票、又没给具体代码——按 screener 处理，
  // hits 直接摆抽到的条件原话（徽章看得见「为什么判成选股」）。2 条起判是防误伤：
  // 单一条「站上20日线」更可能是在问某只票的技术面，不该抢成整池筛选；自选/奇门在场不抢。
  let own = matched[0];
  {
    const ex = extractPickConds(question);
    const noClaim = !matched.some((m) => m.scene === "watchlist" || m.scene === "screener" || m.scene === "qimen");
    const overwritable = !own || own.scene === "sentiment" || own.scene === "sector" || own.scene === "quote" || own.scene === "stock_analysis" || own.scene === "general";
    if (ex.conds.length >= 2 && /股票|个股|票/.test(question) && !symbols.length && noClaim && overwritable) {
      own = { scene: "screener", hits: ex.matched };
    }
  }
  // alternates：正常路径与旧口径逐字一致（第 2~3 个命中场景）；只有「条件句式抢判」发生时，
  // 原第一命中（如成交额→情绪）降级为 alternates，不丢。
  const grabbed = own?.scene === "screener" && matched[0]?.scene !== "screener";
  const alternates = (grabbed ? matched.slice(0, 2) : matched.slice(1, 3)).map((m) => m.scene);
  // 「那 600519 呢」这类：一个场景词都没有，只换了代码 + 带着指代/语气词 —— 场景该沿用上一轮，标的必须换。
  // chat-core.isFollowUp 看到 6 位代码就判「不是追问」（它的用途是决定要不要重新认标的），所以这里要自己再判一次。
  const trimmed = question.trim();
  const codeSwapFollowUp = !matched.length && symbols.length > 0 && (/^(那|它|这|该|同样|对比|再看|还有|继续|换)/.test(trimmed) || /[呢吧]$/.test(trimmed));

  const build = (scene: Scene, inherited: boolean): Intent => {
    let symbol: string | null = null;
    let symbolSource: Intent["symbolSource"] = "none";
    if (needsSymbol(scene)) {
      if (symbols.length) { symbol = symbols[0]; symbolSource = fromName ? "name" : "question"; }
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
      ? "本轮没有可用的标的：先问清是哪只，不要自己挑一个来答。" +
        "用户点了公司名而系统没解析出代码时，只说「没能匹配到可交易的代码」；" +
        "禁止反过来断言「该公司未上市/没有上市代码」这类市场事实——没搜到不等于不存在（查得到才算事实，查不到只是没查到）。"
      : "";
  const lines: string[] = [head];
  switch (scene) {
    case "sentiment":
      lines.push(
        "回答大盘/市场整体状态：先给风险等级结论，再给涨跌家数、成交额、涨停/跌停与主力资金事实。",
        // P11：情绪块自带「情绪温度 0-100」综合分——它是给用户看的说人话入口，报它是允许的，但分量口径要说清
        "数据块里有「情绪温度」时可以引用它开场（如「市场温度 62/100，偏热」），并说明它是宽度/动量/投机/资金流按当前行情类型的加权分；温度标了缩权/缺读时照实转述，不许把它当成精确事实。",
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
      // P10 择优轮（用户裁定改口径，参考 aiwuchuan 的「候选池→择优」链路）：旧三条里
      // 「条件含糊时先问清一句再跑」把「帮我选股」这类请求拦死在原地——改为系统先给真池，
      // 模型在池内择优；「条件必须结构化、按真实命中数答、不得凭印象报票」三条原样保住。
      lines.push(
        "本轮候选池已按你的提问（或系统默认活跃池）用 factor_screener 现跑，注入块里的就是真实命中清单。",
        ...PICK_DISCIPLINE,
        "想换条件就带着新 conditions 再调一次 factor_screener（field 只能取自因子目录）；命中 0 只就说 0 只，不要为了显得有结论而放宽条件。",
        "不得凭印象报「哪些票强势」，那不是池子里算出来的。",
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
        // R10 扩容（用户口径「除了技术还要结合新闻回答我」）：消息面从「可选论据」升为「事实段必读」——
        // 系统已把这只票自己的新闻/公告随预取送到，引用它是回答义务，不是加分项。
        "个股分析：先取数（快照 + 日 K 技术状态 + 资金流 + 这只票自己的新闻/公告），再按「事实 -> 推断 -> 建议」三段回答。",
        "事实段必须至少挂一条该票自身的消息面（注入块 stock_news 里带时间的新闻/公告原文）；宏观快讯不能替代个股消息面；",
        "stock_news 为空或 missing 时明写「该股时间窗内没有可引报道，本轮是纯行情数据判断」，不把数据推断包装成有消息面佐证。",
        "推断必须挂在取到的数上，取不到的维度直接说没取到；建议要给失效条件（什么价位或信号说明判断错了）。",
        "不得把 AI 推测写成市场事实，不得给「必涨」「稳赚」这类结论。",
      );
      break;
    case "qimen":
      lines.push(
        "奇门遁甲：排盘由「奇门解盘」面板用本地开源引擎实算（时家起局），对话链路本轮不直接起局、也不复述盘面。",
        "请引导用户切换到智能助手页顶部的「奇门解盘」模式去起局与解盘；可以说明它属于传统术数推演、不是市场数据。",
        "不得虚构盘局、宫位、干支、吉凶；如果用户其实想要行情或判断，直接改用行情与量化口径回答并说明这一点。",
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
 * 场景到优先工具（不排他：模型仍可调注册表里的任何一个）。
 * P8-③ 起这份表住在 skills-core（SCENE_PREFERS）：预取计划与优先清单同源于注册表，
 * 不会再出现「改了一边忘另一边」的两张表。
 */
export function toolsForScene(scene: Scene, registry: SkillRegistry = SKILLS): string[] {
  return registry.prefersForScene(scene);
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

/**
 * R12 网关大脑：提问里点到的冻结池号（形如 2026-09-22-全A-101 / 2026-09-11-all_a-901）。
 * 形状照 /api/pool/freeze 的 poolId 生成口径（日期-universe-三位序号）；
 * 只认完整池号——光提日期（「2026-09-22 复盘」）不算，宁可不读也不猜池（与 P13「不带池号不猜池」同源）。
 */
const POOL_ID_RE = /\d{4}-\d{2}-\d{2}-[0-9A-Za-z_\u4e00-\u9fa5]+-\d{3}/g;

export function extractPoolIds(question: string): string[] {
  const found = String(question ?? "").match(POOL_ID_RE) ?? [];
  return [...new Set(found)].slice(0, 2); // 一轮最多两个池：更多就是刷屏不是提问
}

/** 两个标的上限常量住在 skills-core（注册表与上限同源），文件头已按原名 re-export，旧 import 路径不变。 */

/**
 * 取数计划（P8-③ 起表驱动）：读 skills-core 注册表里该场景的参与项，
 * per_symbol 项逐标的成组展开、once 项殿后，并处理 gate / 快照抵扣 / 场景静态留痕。
 *  - 快照里已经带了同一只票就不重复取，并把原因写进 skipped（界面要能说清）；
 *  - 选股场景不预取：条件得由模型从自然语言抽成结构化 conditions，替它猜条件等于替用户做决定；
 *  - 奇门 / 通用不取数；
 *  - 自选清单为空就不取，免得画出一个注定失败的步骤。
 * 行为与搬表前的 switch 逐字一致（p7-intent 的 25 条调度断言就是这条「一致」的验收闸）。
 */
export function planDispatch(ctx: DispatchContext, registry: SkillRegistry = SKILLS): { calls: DispatchCall[]; skipped: string[] } {
  const { intent } = ctx;
  const calls: DispatchCall[] = [];
  const skipped: string[] = [];
  const covered = new Set((ctx.snapshotSymbols ?? []).map((s) => s.toUpperCase()));
  const wantNews = ctx.news ?? wantsNews(intent.question);
  const symbols = intent.symbols.length ? intent.symbols : intent.symbol ? [intent.symbol] : [];
  const capped = symbols.slice(0, DISPATCH_MAX_SYMBOLS);
  if (symbols.length > capped.length) skipped.push(`提问涉及 ${symbols.length} 个代码，本轮只取前 ${DISPATCH_MAX_SYMBOLS} 个`);

  const cfg = registry.configForScene(intent.scene);
  const sceneMax = Math.min(cfg.symbol_max ?? DISPATCH_MAX_SYMBOLS, DISPATCH_MAX_SYMBOLS);
  const cappedScene = capped.slice(0, sceneMax);
  if (cfg.cap === "analysis" && capped.length > cappedScene.length) {
    skipped.push(`个股分析一次最多看 ${DISPATCH_ANALYSIS_MAX} 只，其余请分开问`);
  }

  // 文案的单一出处：注册表只声明「谁在哪个场景、怎么展开、给什么参」，说辞仍旧归判定层。
  // news 的两个变体（消息面/原因、消息面/为什么）是旧 switch 里就有的逐字差异，原样保住不擅自统一。
  const reasonOf = (r: SkillReason): string => {
    switch (r) {
      case "scene": return `问题按「${SCENE_LABELS[intent.scene]}」处理`;
      case "scene_snapshot": return `按「${SCENE_LABELS[intent.scene]}」取实时快照`;
      case "kline": return "取日 K 并算技术状态（均线/MACD/KDJ/RSI）";
      case "fund_flow": return "取近 14 日主力资金";
      case "news": return "同时问了消息面/原因";
      case "news_why": return "同时问了消息面/为什么";
      case "watchlist": return `按「${SCENE_LABELS.watchlist}」取全部自选的实时行情`;
      case "screener_pool": return "按「量化选股」现跑候选池（条件从提问抽取，抽不到按系统默认活跃池并如实标注）";
      case "stock_news": return "取这只票自己的新闻/公告（结论须结合消息面）";
    }
  };
  const argsOf = (a: SkillArgs, symbol: string): Record<string, unknown> => {
    switch (a) {
      case "symbol": return { symbol };
      case "news8": return { limit: 8 };
      case "sector_kind": return { kind: intent.question.includes("概念") ? "concept" : "industry", size: 15 };
      // P10 择优轮：选股场景的候选池。条件由纯核从提问里确定性抽取（抽不到给空数组，
      // 工具层按默认活跃池跑并如实标注 origin）——「把猜的条件当用户要求」仍是事故，
      // 所以 matched 原话片段随参数一起走，注入块里要摆给用户看。
      case "screener_pool": {
        const ex = extractPickConds(intent.question);
        return {
          conditions: ex.conds,
          limit: 15,
          pool_origin: ex.conds.length ? "extracted" : "default",
          pool_matched: ex.matched,
        };
      }
      case "empty":
      default: return {};
    }
  };
  // gate 不满足：news 静默不出 call（旧 switch 就没有这条留痕）；watchlist 空清单必须留话
  const gateOk = (e: SkillPlanEntry): boolean => {
    if (e.gate === "news") return wantNews;
    if (e.gate === "watchlist_nonempty") {
      if ((ctx.watchlistCount ?? 0) === 0) {
        skipped.push("本机自选清单为空，未调自选总览（空清单不是取数失败）");
        return false;
      }
      return true;
    }
    return true;
  };

  const entries = registry.entriesForScene(intent.scene);
  // per_symbol 按「标的外层、技能内层」展开：个股分析三件套逐只成组，技能在外层会把两只票的
  // 读数在时间线上交错开，用户看不出哪三条属于哪只。
  // 去重只对快照有效（dedupe_snapshot 只挂在快照项上）：客户端带回来的是「当前图表的实时行情」，
  // K 线技术状态与资金流它并没有算过，拿快照去抵掉后两个工具，等于让模型少两组数据继续下结论。
  for (const s of cappedScene) {
    for (const { tool, entry } of entries) {
      if (entry.spread !== "per_symbol") continue;
      if (!gateOk(entry)) continue;
      if (entry.dedupe_snapshot && covered.has(s.toUpperCase())) {
        skipped.push(`${tool} · ${s}：客户端快照已带该品种实时数据，未重复取数`);
        continue;
      }
      calls.push({ tool, args: argsOf(entry.args, s), reason: reasonOf(entry.reason) });
    }
  }
  for (const { tool, entry } of entries) {
    if (entry.spread !== "once") continue;
    if (!gateOk(entry)) continue;
    calls.push({ tool, args: argsOf(entry.args, ""), reason: reasonOf(entry.reason) });
  }

  // R12 网关大脑：提问里点了完整池号 → 系统直接读那个冻结池。
  // 为什么走预取而不是等模型自取：网关通道（doubao2API）根本没有 function call，
  // candidate_pool 那类「模型自己要调」的工具在豆包网关这条路上永远不会发生——
  // 想让它真有池数据，就得在供数侧把池送到它面前（稳智同款做法：数据由系统装好）。
  // 奇门场景不掺：那条 skip 口径是「本轮不取任何行情数」，为一个池号破例等于自己拆自己的纪律。
  if (cfg.skip !== "qimen") {
    for (const pid of extractPoolIds(intent.question)) {
      calls.push({
        tool: "candidate_pool", args: { pool_id: pid },
        reason: "提问里点了池号，系统直接读这个冻结池（条件与名单随数据块给全）",
      });
    }
  }

  // P10：screener 的「未预取」留痕随候选池上线一起退场（旧文案钉在 p10 测试的口径迁移注释里）
  if (cfg.skip === "qimen") skipped.push("奇门排盘在「奇门解盘」面板本地实算，对话链路本轮不起局、不取行情数（取行情只会让它看起来像在算盘）");
  if (cfg.skip === "general") skipped.push("按通用问答处理，未取数");
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
