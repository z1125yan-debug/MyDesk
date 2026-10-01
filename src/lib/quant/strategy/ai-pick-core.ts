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
}

export interface AiPickChoice {
  symbol: string;
  /** 一句话入选理由（说人话，页面直接展示） */
  reason?: string;
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
 */
export function buildAiPickPrompt(cands: readonly AiPickCandidate[], date: string, topN: number): string {
  const list = cands
    .map((c, i) => `${i + 1}. ${c.symbol}${c.name ? `（${c.name}）` : ""}${typeof c.close === "number" && Number.isFinite(c.close) ? ` 收盘 ${c.close.toFixed(2)}` : ""}`)
    .join("\n");
  return [
    "你是 A 股量化工作台的「AI优选」环节。下面是一份已经过第一层筛选的候选股清单（某交易日的候选池）。",
    "你的任务：从这清单里挑出你最有信心、次日最值得关注的若干只，做成一份收窄后的「AI优选」清单。",
    "",
    "硬纪律：",
    "1) 只能从下面清单里选，绝对不能发明清单之外的代码（清单外 = 脱离可复核的候选集，一律无效）；",
    "2) 最多选 " + topN + " 只；如果清单本身质量不高，可以少于 " + topN + " 只，甚至一只都不选；",
    "3) 每只给一句中文理由（为什么选它、看什么、风险点是什么），说人话，不堆术语；",
    "4) 只做「收窄与排序」，不要给买卖价、不要预测涨跌、不要编造数字。",
    "",
    "只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，形状严格如下：",
    '{ "picks": [ { "symbol": "600519.SH", "reason": "一句话理由" } ] }',
    "",
    "交易日：" + date,
    "候选清单（共 " + cands.length + " 只）：",
    list || "（空）",
  ].join("\n");
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
  for (const p of picks) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const sym = typeof o.symbol === "string" ? o.symbol : "";
    if (!normSym(sym)) continue;
    out.push({
      symbol: sym.trim().toUpperCase(),
      reason: typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : undefined,
    });
  }
  return out.length ? out : null;
}

/** 把模型选择收敛到候选集内、限量、去重（双重保险：指令里的 topN + 解析后的上限） */
export function narrowChoices(choices: AiPickChoice[] | null, cands: readonly AiPickCandidate[], topN: number): AiPickCandidate[] {
  if (!choices) return [];
  const seen = new Set<string>();
  const out: AiPickCandidate[] = [];
  for (const ch of choices) {
    const c = candidateOf(cands, ch.symbol);
    if (!c) continue; // 清单外一律丢弃
    const key = normSym(c.symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol: c.symbol, name: c.name, close: c.close ?? null, reason: ch.reason });
    if (out.length >= topN) break;
  }
  return out;
}
