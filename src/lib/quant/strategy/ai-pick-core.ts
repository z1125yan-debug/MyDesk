// P39 / #75 AI优选战绩层 · 纯核（无 IO / 无 fetch / 无时钟，可被 node --test 直跑）
//
// 为什么复用 StrategyPick 而不是新开一张表：
//   战绩页的回填（pickfill）、净值（navSeriesOf）、逐条明细、按天聚合全围着这张表转。
//   AI优选只要带 source="ai_pick" + 已经填好的 symbols，就能原样走通整条战绩链——
//   不必把同一套「T+1 买 / T+2 卖 / 扣费」重写一遍（重写必分叉、必互相打架）。
//
// 这一层要同时解决两件事：
//   ① AI优选结果进战绩页（聚焦子集的战绩，理论上比被稀释的 layer1 平均更可信，是收费点的证据）；
//   ② 用户不手动用 AI优选时，服务端用「已配置的服务端模型通道」自动从当日候选里收窄出 ≤N 只，
//      于是战绩页始终有这一层，不会「不用就不触发」。

/** 与策略选股层（gate / regime）区分的来源标记 */
export const AI_PICK_SOURCE = "ai_pick";

/**
 * 借用 StrategyPick.strategyId 当自然键的一部分：AI优选不是社区策略，
 * 用一个永不可能是真实策略 id 的哨兵值（策略 id 都是正整数，-1 不会撞）。
 * 唯一键 = (tradeDate, strategyId=-1, source="ai_pick") ⇒ 一天最多一条 AI优选战绩。
 */
export const AI_PICK_STRATEGY_ID = -1;

/** 服务端一次收窄最多保留几只：票越少方差越大，太多就失去「优选」意义 */
export const AI_PICK_MAX = 10;

export interface AiPickCandidate {
  symbol: string;
  name?: string;
  /** T 日收盘价（qfq）；回填要用它判 T+1 是否一字涨停。缺就用仓库补 */
  close?: number | null;
  /** 入选理由（从模型选择里带下来；手动候选可空） */
  reason?: string;
  /** 富化数据（参考模板：喂给模型做证据，不编）：2026-10-16 补 */
  changePct?: number | null;
  amountYi?: number | null;
  pe?: number | null;
  pb?: number | null;
  mktCapYi?: number | null;
  fundNetYi?: number | null;
  /** 第 5 种分歧用（THS 三边；仅决策日 == 最新交易日时取，历史日为 null，不冒充） */
  superNetYi?: number | null;
  midNetYi?: number | null;
  smallNetYi?: number | null;
  /** 第一级板块名（如“煤炭”；用于第 5 种分歧的板块对比） */
  sectorName?: string | null;
  /** 同板块中位涨跌幅 %（tradeDate 当日；缺为 null） */
  sectorMedianChangePct?: number | null;
  sector?: string | null;
  strategy?: string | null;
  /** 当日换手率 % = 当日成交量(股)/流通股本(股)×100（DB 量 + 估值流通股本算出；算不出为 null，不编 0） */
  turnoverPct?: number | null;
  /**
   * 当日新闻（财联社电报分页拉回 tradeDate 当天、按个股名/板块关键词匹配的原标题）。
   * null = 没拉到（断源/失败，不编）；"" = 拉到了但当日无相关新闻（真的没有，不编）。
   */
  news?: string | null;
  /**
   * 当日巨潮公告（CNINFO 按 tradeDate 当天拉回、按代码过滤的原标题 + 类型）。
   * null = 没拉到（断源/失败，不编）；"" = 拉到了但当日无相关公告（真的没有，不编）。
   * 格式：每条一行 "类型：标题"，多条用 "；" 连接，供 AI 优选引用如“XX 发布回购公告”。
   */
  announcements?: string | null;
  /**
   * 当日减持风险（巨潮公告 type=减持 的标题口径解析，cninfo.ts 的 reductionRiskOf）。
   * null = 没拉到公告（不编）；"" = 拉到了但当日无减持公告（真的没有）。
   * 非空时为小白一句话，如“大股东（持股5%以上）要减持（还没卖），具体减持多少股看公告正文”。
   * 模型看到非空减持风险时：不要选减持大的票，或必须在主要风险里标出减持风险。
   */
  reductionRisk?: string | null;
}

export interface AiPickChoice {
  symbol: string;
  /** 一句话入选理由（说人话，页面直接展示） */
  reason?: string;
  /** 看好程度排序：1 = 最看好，依次递增；必须与 picks 输出顺序一致（第 1 只 rank=1，第 2 只 rank=2……） */
  rank?: number;
  /** 排序理由/信心依据（一句，说明为什么排在这个位置，如“资金+题材共振最强”/“估值低但题材弱，排后”） */
  rankReason?: string;
  /** 参考模板 5 字段（docs/参考平台能力清单.md §三）：入选理由 / 入场条件 / 仓位节奏 / 失效条件 / 主要风险 */
  entryCondition?: string;
  positionRhythm?: string;
  invalidCondition?: string;
  mainRisk?: string;
  /** 参考模板 11 字段研究卡（同文档 §七.2）：研究结论 / 核心结论 / 依据 / 关键信号 / 强弱量价 / 反证状态 / 触发条件 / 失效条件 / 仓位节奏 / 风险提示 / 操作参考 */
  researchConclusion?: string;
  coreConclusion?: string;
  evidence?: string;
  keySignals?: string;
  priceVolume?: string;
  falsification?: string;
  trigger?: string;
  riskHint?: string;
  actionRef?: string;
}

/** 候选代码归一：去掉 .SH/.SZ/.BJ 后缀再比，容忍模型只回 6 位代码 */
function normSym(s: string): string {
  return String(s || "").trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, "");
}

export function candidateMap(cands: readonly AiPickCandidate[]): Map<string, AiPickCandidate> {
  const m = new Map<string, AiPickCandidate>();
  for (const c of cands) {
    const key = normSym(c.symbol);
    if (!key) continue;
    if (!m.has(key)) m.set(key, c);
  }
  return m;
}

export function candidateOf(cands: readonly AiPickCandidate[], symbol: string): AiPickCandidate | undefined {
  return candidateMap(cands).get(normSym(symbol));
}

/**
 * 候选池 → 喂给模型的中文清单。
 * 给的是「代码 / 名称 / 收盘价」这种事实，不给投资建议；模型只负责从里面收窄，
 * 不许发明候选名单之外的票（那样就脱离可复核的候选集了）。
 * topN 上限写进指令，但解析侧仍再卡一道，双保险。
 *
 * 2026-10-16 按 docs/参考平台能力清单.md 升级为参考模板：
 *   原因（没触发完整模板的根因，三处都在旧代码里）：
 *   ① prompt 只要求“一句话 reason”，没要求入场/仓位/失效/风险/反证；
 *   ② 解析只取 symbol/reason，其余字段即使模型给了也被丢掉；
 *   ③ max_tokens 1500 装不下 5 只 × 完整决策卡（会被截断）。
 *   修复：prompt 按 5 字段 + 11 字段 + 七维框架要求输出；解析全字段提取；
 *   调用侧 max_tokens 放到 6000；候选行带富化数据（PE/PB/市值/主力/板块/策略/情绪）当证据。
 *   入场条件只用触发条件表述（“放量站上…”），不给具体买卖价；仓位只给节奏（“轻/分批/观望”），不给具体仓位数字。
 */
export function buildAiPickPrompt(
  cands: readonly AiPickCandidate[],
  date: string,
  topN: number,
  marketCtx?: string,
): string {
  const fmt = (v: number | null | undefined, digits = 2): string =>
    typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
  const list = cands
    .map((c, i) => {
      const bits = [
        `${i + 1}. ${c.symbol}${c.name ? `（${c.name}）` : ""}`,
        typeof c.close === "number" && Number.isFinite(c.close) ? `收盘 ${c.close.toFixed(2)}` : "",
        c.changePct != null ? `涨跌 ${fmt(c.changePct)}%` : "",
        c.amountYi != null ? `成交额 ${fmt(c.amountYi, 2)}亿` : "",
        c.pe != null ? `PE(TTM) ${fmt(c.pe)}` : "",
        c.pb != null ? `PB ${fmt(c.pb)}` : "",
        c.mktCapYi != null ? `市值 ${fmt(c.mktCapYi, 1)}亿` : "",
        c.fundNetYi != null ? `主力净额 ${c.fundNetYi >= 0 ? "+" : ""}${fmt(c.fundNetYi)}亿` : "主力净额 —（未取到，不编）",
        c.turnoverPct != null ? `换手 ${fmt(c.turnoverPct)}%` : "换手 —（未取到，不编）",
        c.sector ? `板块 ${c.sector}` : "",
        c.strategy ? `入选策略 ${c.strategy}` : "",
        c.news != null ? `新闻 ${c.news === "" ? "当日无相关新闻" : c.news}` : "新闻 —（未取到，不编）",
        c.announcements != null ? `巨潮公告 ${c.announcements === "" ? "当日无相关公告" : c.announcements}` : "巨潮公告 —（未取到，不编）",
        c.reductionRisk != null ? `减持风险 ${c.reductionRisk === "" ? "当日无减持公告" : c.reductionRisk}` : "减持风险 —（未取到，不编）",
      ].filter(Boolean).join(" | ");
      return bits;
    })
    .join("\n");
  return [
    "你是 A 股量化工作台的「AI优选」环节。下面是一份已经过第一层筛选的候选股清单（某交易日的候选池）。",
    "你的任务：从这清单里挑出你最有信心、次日最值得关注的若干只，按看好程度从高到低排序，做成一份收窄后的「AI优选」清单。",
    "",
    marketCtx ? `当日大盘情绪（事实，不用再猜）：${marketCtx}` : "",
    "",
    "分析框架（七维，权重供参考，不必逐项打分，但结论要有依据）：",
    "市场环境 15% · 产业逻辑 20% · 基本面 20% · 资金行为 20% · 技术面 20% · 综合判断 5%；末维必须给出可执行的关注计划。",
    "分析步骤（Agent Loop）：理解问题 → 选择分析方法 → 获取行情与市场数据（上面已给，不要再编） → 核查新闻与公开信息（新闻已按当日财联社电报匹配给在每只后面：写“当日无相关新闻”就是真的没有匹配到；写“未取到”就是没拉到，都不编；巨潮公告已按当日巨潮公告匹配给在每只后面：写“当日无相关公告”就是真的没有，写“未取到”就是没拉到，如“XX 发布回购公告 / 业绩预告”可作为选股理由的证据） → 综合分析 → 生成结论。",
    "",
    "硬纪律：",
    "1) 只能从下面清单里选，绝对不能发明清单之外的代码（清单外 = 脱离可复核的候选集，一律无效）；",
    "2) 最多选 " + topN + " 只；如果清单本身质量不高，可以少于 " + topN + " 只，甚至一只都不选；",
    "3) 只做「收窄与排序」，不要给具体买卖价、不要预测涨跌、不要编造数字。没有给的数据（主力/新闻等）就写“未取到”，不编；",
    "4) 入场条件只用触发条件表述（如“放量站上近端均线再关注”），不给具体价格；仓位只给节奏（如“轻仓/分批/观望”），不给具体仓位数字；",
    "5) 每只必须有反证状态：一句话写“什么情况说明我错了”。",
    "6) 减持风险：某只后面写了“减持风险”且不是“当日无减持公告”的，说明该股当天有股东减持公告——大股东（控股股东/持股5%以上）减持是高风险，不要选减持大的票；实在要选，必须在主要风险里标出“大股东减持，小心”。减持风险写“未取到”就是没拉到，不要编；",
    "7) 派发嫌疑：换手 >10% 但涨幅 <3% = 高换手小涨幅，疑似主力派发，不要选；如果某只换手 >10% 且涨幅 <3%，即使选了也必须在主要风险里标出“高换手小涨幅，疑似派发”；",
    "8) 背离：主力净额为负（主力净流出）且当日价涨 = 价涨资金离场，背离，不要选；",
    "9) 必须解释为什么弃掉每只候选票：输出里除 picks 外，再给一个 rejected 数组，每只没选的候选票都要有一条，写清弃选原因（如“高换手小涨幅疑似派发”/“主力净流出背离”/“涨停追高风险”等），不能只说选了哪些；",
    "10) 排序：picks 必须按你看好的程度从高到低排序（最看好的放最前，不要按代码顺序、不要随机排）；每只必须带 rank（1 = 最看好，依次递增 1、2、3……）和 rankReason（一句排序理由/信心依据，说明为什么排在这个位置，如“资金+题材共振最强”/“估值低但题材弱，排后”）。rank 必须与输出顺序一致（第 1 只 rank=1，第 2 只 rank=2……）；",
    "",
    "只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，形状严格如下：",
    '{ "picks": [ { "symbol": "600519.SH", "rank": 1, "rankReason": "为什么排在这个位置，一句信心依据", "reason": "一句话入选理由", "entryCondition": "触发条件（不给具体价）", "positionRhythm": "仓位节奏（轻/分批/观望）", "invalidCondition": "失效条件", "mainRisk": "主要风险", "researchConclusion": "研究结论一句话", "coreConclusion": "核心结论一句话", "evidence": "依据（引用上面给的真实数字，如 PE/主力/涨跌）", "keySignals": "关键信号", "priceVolume": "强弱量价（价/量/换手，基于上面给的数字）", "falsification": "反证状态：什么情况说明我错了", "trigger": "触发条件", "riskHint": "风险提示", "actionRef": "操作参考（只给关注/观望/回避方向，不给买卖价）" } ], "rejected": [ { "symbol": "000001.SZ", "reason": "弃选原因一句话" } ] }',
    "",
    "交易日：" + date,
    "候选清单（共 " + cands.length + " 只，数字均为当日事实）：",
    list || "（空）",
  ].filter((l) => l !== "").join("\n");
}

/**
 * 把模型的自由文本答复收成结构化选择。
 * 收不回来（不是 JSON / 没有 picks 数组 / 一只都解析不出合法代码）一律返回 null，
 * 调用方据实说「模型没返回可解析的优选清单」——绝不拿默认值冒充成绩。
 */
export function parseAiPickResponse(text: string): AiPickChoice[] | null {
  if (!text || typeof text !== "string") return null;
  // 容忍 ```json ... ``` 包裹与前后闲话：取第一个 { 到最后一个 } 之间的内容
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
  const picks = (obj as { picks?: unknown })?.picks;
  if (!Array.isArray(picks)) return null;
  const out: AiPickChoice[] = [];
  const str = (o: Record<string, unknown>, k: string): string | undefined => {
    const v = o[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  for (const p of picks) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const sym = typeof o.symbol === "string" ? o.symbol : "";
    if (!normSym(sym)) continue;
    out.push({
      symbol: sym.trim().toUpperCase(),
      reason: str(o, "reason"),
      rank: typeof o.rank === "number" && Number.isFinite(o.rank) ? o.rank : undefined,
      rankReason: str(o, "rankReason"),
      entryCondition: str(o, "entryCondition"),
      positionRhythm: str(o, "positionRhythm"),
      invalidCondition: str(o, "invalidCondition"),
      mainRisk: str(o, "mainRisk"),
      researchConclusion: str(o, "researchConclusion"),
      coreConclusion: str(o, "coreConclusion"),
      evidence: str(o, "evidence"),
      keySignals: str(o, "keySignals"),
      priceVolume: str(o, "priceVolume"),
      falsification: str(o, "falsification"),
      trigger: str(o, "trigger"),
      riskHint: str(o, "riskHint"),
      actionRef: str(o, "actionRef"),
    });
  }
  return out.length ? out : null;
}

/** 逐只评估的单只裁决（2026-10-23 用户拍板改逐只调用） */
export interface AiPickVerdict {
  symbol: string;
  /** 模型判定是否入选（代码侧再卡 score>=60，双保险） */
  selected: boolean;
  /** 0–100 综合分（按提示词统一标尺直出；只用于入选者之间的排序） */
  score?: number;
  /** 入选时的完整决策卡（字段同 AiPickChoice） */
  choice?: AiPickChoice;
  /** 未入选原因（一句；评估失败时为失败原因） */
  rejectReason?: string;
  /** 评估本身失败（超时/通道异常/没解析出）：与「模型判不入选」严格区分 */
  evalError?: string;
}

/** 单只候选 → 喂给模型的证据行（与 buildAiPickPrompt 的候选行同口径，数字均为当日事实） */
function candidateLine(c: AiPickCandidate): string {
  const fmt = (v: number | null | undefined, digits = 2): string =>
    typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
  return [
    `${c.symbol}${c.name ? `（${c.name}）` : ""}`,
    typeof c.close === "number" && Number.isFinite(c.close) ? `收盘 ${c.close.toFixed(2)}` : "",
    c.changePct != null ? `涨跌 ${fmt(c.changePct)}%` : "",
    c.amountYi != null ? `成交额 ${fmt(c.amountYi, 2)}亿` : "",
    c.pe != null ? `PE(TTM) ${fmt(c.pe)}` : "",
    c.pb != null ? `PB ${fmt(c.pb)}` : "",
    c.mktCapYi != null ? `市值 ${fmt(c.mktCapYi, 1)}亿` : "",
    c.fundNetYi != null ? `主力净额 ${c.fundNetYi >= 0 ? "+" : ""}${fmt(c.fundNetYi)}亿` : "主力净额 —（未取到，不编）",
    c.turnoverPct != null ? `换手 ${fmt(c.turnoverPct)}%` : "换手 —（未取到，不编）",
    c.sector ? `板块 ${c.sector}` : "",
    c.strategy ? `入选策略 ${c.strategy}` : "",
    c.news != null ? `新闻 ${c.news === "" ? "当日无相关新闻" : c.news}` : "新闻 —（未取到，不编）",
    c.announcements != null ? `巨潮公告 ${c.announcements === "" ? "当日无相关公告" : c.announcements}` : "巨潮公告 —（未取到，不编）",
    c.reductionRisk != null ? `减持风险 ${c.reductionRisk === "" ? "当日无减持公告" : c.reductionRisk}` : "减持风险 —（未取到，不编）",
  ].filter(Boolean).join(" | ");
}

/**
 * 逐只评估 prompt（2026-10-23）：整池一次喂的 prompt 太长，flash 经网关生成必撞调用侧
 * 120s 硬超时（10-23 批三连败的根因）。改为一只一调：prompt 只装一只的证据，输出只装
 * 一张决策卡，每调都短。代价：模型看不到其他候选，没法横向比较——用统一打分标尺
 * （锚点写死在下面）+ 代码按分排序收窄来补；标尺与 DSA 的 sentiment_score 同思路。
 * 入选门槛：selected=true 且 score>=60（代码侧再卡一道）。
 */
export function buildAiPickSinglePrompt(
  c: AiPickCandidate,
  date: string,
  marketCtx?: string,
): string {
  return [
    "你是 A 股量化工作台的「AI优选」环节。下面是某交易日候选池里的【一只】候选股及其当日全部证据。",
    "你的任务：只评估这一只——它值不值得进入次日最值得关注的「AI优选」清单，给出判定、分数和完整的决策卡。",
    "",
    marketCtx ? `当日大盘情绪（事实，不用再猜）：${marketCtx}` : "",
    "",
    "分析框架（七维，权重供参考）：市场环境 15% · 产业逻辑 20% · 基本面 20% · 资金行为 20% · 技术面 20% · 综合判断 5%。",
    "新闻已按当日财联社电报匹配给在证据里：写“当日无相关新闻”就是真的没有匹配到；写“未取到”就是没拉到，都不编。巨潮公告同理。",
    "",
    "打分标尺（0–100，全候选池统一一把尺，不许手松手紧）：",
    "80–100：资金/题材/量价多维共振，证据互相印证，无明显反证——强入选；",
    "60–79：有明确亮点（如主力净流入+板块共振、业绩/事件催化、量价健康），反证可控——入选；",
    "40–59：亮点与风险参半，或只有单一维度支撑——不入选；",
    "20–39：偏弱（资金流出、量价背离、无催化、估值与题材不匹配等占主导）——不入选；",
    "0–19：明显差（派发/背离/重大风险）——不入选。",
    "selected 必须与分数一致：score>=60 才能 selected=true，score<60 必须 selected=false 并在 rejectReason 写清最主要的一条不入选原因。",
    "",
    "硬纪律：",
    "1) 只评估给你的这一只，不要提其他股票，不要编造数字。没有给的数据（主力/新闻等）就写“未取到”，不编；",
    "2) 只做评估，不要给具体买卖价、不要预测涨跌；入场条件只用触发条件表述（如“放量站上近端均线再关注”），仓位只给节奏（如“轻仓/分批/观望”），不给具体仓位数字；",
    "3) 必须有反证状态：一句话写“什么情况说明我错了”；",
    "4) 减持风险：证据里写了“减持风险”且不是“当日无减持公告”的，说明该股当天有股东减持公告——大股东（控股股东/持股5%以上）减持是高风险，原则上不入选；实在入选必须在主要风险里标出“大股东减持，小心”；",
    "5) 派发嫌疑：换手 >10% 但涨幅 <3% = 高换手小涨幅，疑似主力派发，不入选；",
    "6) 背离：主力净额为负（主力净流出）且当日价涨 = 价涨资金离场，背离，不入选；",
    "",
    "只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，形状严格如下：",
    '{ "symbol": "600519.SH", "selected": true, "score": 75, "reason": "一句话入选理由", "entryCondition": "触发条件（不给具体价）", "positionRhythm": "仓位节奏（轻/分批/观望）", "invalidCondition": "失效条件", "mainRisk": "主要风险", "researchConclusion": "研究结论一句话", "coreConclusion": "核心结论一句话", "evidence": "依据（引用上面给的真实数字，如 PE/主力/涨跌）", "keySignals": "关键信号", "priceVolume": "强弱量价（价/量/换手，基于上面给的数字）", "falsification": "反证状态：什么情况说明我错了", "trigger": "触发条件", "riskHint": "风险提示", "actionRef": "操作参考（只给关注/观望/回避方向，不给买卖价）", "rejectReason": "不入选时写最主要原因一句；入选时留空字符串" }',
    "",
    "交易日：" + date,
    "候选（就这一只，数字均为当日事实）：",
    candidateLine(c),
  ].filter((l) => l !== "").join("\n");
}

/** 解析逐只评估的单只裁决；解析不出返回 null（调用方记 evalError，绝不拿默认值冒充评估）。 */
export function parseAiPickVerdict(text: string): Omit<AiPickVerdict, "symbol"> | null {
  if (!text || typeof text !== "string") return null;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
  const o = obj as Record<string, unknown>;
  if (!o || typeof o !== "object") return null;
  const str = (k: string): string | undefined => {
    const v = o[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const score = typeof o.score === "number" && Number.isFinite(o.score)
    ? Math.max(0, Math.min(100, o.score))
    : undefined;
  const selected = o.selected === true && (score == null || score >= 60);
  const choice: AiPickChoice = {
    symbol: typeof o.symbol === "string" ? o.symbol.trim().toUpperCase() : "",
    reason: str("reason"),
    entryCondition: str("entryCondition"),
    positionRhythm: str("positionRhythm"),
    invalidCondition: str("invalidCondition"),
    mainRisk: str("mainRisk"),
    researchConclusion: str("researchConclusion"),
    coreConclusion: str("coreConclusion"),
    evidence: str("evidence"),
    keySignals: str("keySignals"),
    priceVolume: str("priceVolume"),
    falsification: str("falsification"),
    trigger: str("trigger"),
    riskHint: str("riskHint"),
    actionRef: str("actionRef"),
  };
  return {
    selected,
    score,
    choice: selected ? choice : undefined,
    rejectReason: selected ? undefined : (str("rejectReason") ?? (score != null ? `评分 ${score} 未达入选线 60` : "模型判不入选（未给原因）")),
  };
}

/** 确定性硬过滤（代码层，2026-10-16：只改提示词不够——模型会“承认风险但照样选”，
 * 如协和电子换手 14.45% + 涨幅 2.46%，模型在风险里承认了高换手还是选了。
 * 这两条是硬规则，不依赖模型自觉遵守；数据缺失（null）时不触发，缺就是缺，不拿 null 当 0 判）。
 * 返回弃选原因字符串；null = 通过。 */
export function hardFilterReason(c: AiPickCandidate): string | null {
  // 规则 7：高换手 + 小涨幅 = 派发嫌疑（换手与涨跌都取到时才判）
  if (
    c.turnoverPct != null && c.turnoverPct > 10 &&
    c.changePct != null && c.changePct < 3
  ) {
    return `高换手小涨幅，疑似派发（换手 ${c.turnoverPct.toFixed(2)}% > 10%，涨幅 ${c.changePct.toFixed(2)}% < 3%）`;
  }
  // 规则 8：主力净流出 + 价涨 = 背离（主力与涨跌都取到时才判；
  // 历史日 THS 不取，主力为 null，不触发，不拿今天的主力冒充历史日）
  if (
    c.fundNetYi != null && c.fundNetYi < 0 &&
    c.changePct != null && c.changePct > 0
  ) {
    return `主力净流出且价涨，背离（主力 ${c.fundNetYi.toFixed(2)}亿，涨幅 ${c.changePct.toFixed(2)}%）`;
  }
  return null;
}

export interface HardFilterResult {
  kept: AiPickCandidate[];
  rejected: { symbol: string; name?: string; reason: string }[];
}

/** 候选池硬过滤：拦掉的进 rejected（带原因，前端/日志能看到为什么弃），不进模型。 */
export function applyHardFilter(cands: readonly AiPickCandidate[]): HardFilterResult {
  const kept: AiPickCandidate[] = [];
  const rejected: HardFilterResult["rejected"] = [];
  for (const c of cands) {
    const reason = hardFilterReason(c);
    if (reason) rejected.push({ symbol: c.symbol, name: c.name, reason });
    else kept.push(c);
  }
  return { kept, rejected };
}

/** 把模型选择收敛到候选集内、限量、去重（双重保险：指令里的 topN + 解析后的上限）。
 * 第二道硬过滤：模型输出的票再过一次 hardFilterReason（防模型无视提示词硬选，
 * 如协和电子）；被拦的直接丢弃，不进战绩。 */
export function narrowChoices(choices: AiPickChoice[] | null, cands: readonly AiPickCandidate[], topN: number): AiPickCandidate[] {
  if (!choices) return [];
  const seen = new Set<string>();
  const out: AiPickCandidate[] = [];
  for (const ch of choices) {
    const c = candidateOf(cands, ch.symbol);
    if (!c) continue; // 清单外一律丢弃
    if (hardFilterReason(c)) continue; // 硬规则拦掉（不依赖模型自觉遵守）
    const key = normSym(c.symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    // 模型给的 5 字段 + 11 字段拼进 reason（落库时进 symbolsNote；symbols JSON 形状不动，不影响 pickfill）
    const cardParts = [
      ch.reason ? `入选理由：${ch.reason}` : "",
      ch.entryCondition ? `入场条件：${ch.entryCondition}` : "",
      ch.positionRhythm ? `仓位节奏：${ch.positionRhythm}` : "",
      ch.invalidCondition ? `失效条件：${ch.invalidCondition}` : "",
      ch.mainRisk ? `主要风险：${ch.mainRisk}` : "",
      ch.researchConclusion ? `研究结论：${ch.researchConclusion}` : "",
      ch.coreConclusion ? `核心结论：${ch.coreConclusion}` : "",
      ch.evidence ? `依据：${ch.evidence}` : "",
      ch.keySignals ? `关键信号：${ch.keySignals}` : "",
      ch.priceVolume ? `强弱量价：${ch.priceVolume}` : "",
      ch.falsification ? `反证状态：${ch.falsification}` : "",
      ch.trigger ? `触发条件：${ch.trigger}` : "",
      ch.riskHint ? `风险提示：${ch.riskHint}` : "",
      ch.actionRef ? `操作参考：${ch.actionRef}` : "",
    ].filter(Boolean).join("；");
    out.push({
      ...c,
      reason: cardParts || ch.reason,
    });
    if (out.length >= topN) break;
  }
  return out;
}
