// 对话回答的「小节分类」纯内核（P15 对齐稳智表达轮）。零 IO，客户端直接 import，node 可直测。
//
// 为什么单独成文件：分类规则同时被两处消费——Markdown.tsx 的渲染层（哪段包成卡、挂什么 emoji）
// 和钉测（口径不许悄悄漂）。写进 tsx 就只能字符串钉，行为测不到。
//
// 规则来源：对 aiwuchuan.com 前端 bundle（AiMatrixHome-*.js）实测拆出的小节分类器逐条对齐——
// 它按标题关键词把回答分成 risk/action/capital/technical/fundamental/market/event/decision/note，
// 再给标题自动挂 emoji（模型没写也挂），命中的小节整段包卡。这就是「不像死人机」的那层渲染。
// 顺序即优先级（与它一致）：一个标题同时含多类词时，取先命中的类。
export type SectionKind =
  | "risk" | "action" | "capital" | "technical" | "fundamental"
  | "market" | "event" | "decision" | "note"
  // P21 结论契约：LLM 用固定前缀输出这四类块，前端强识别
  | "conclusion" | "watchlist" | "invalidation" | "plan";

/** 分类优先级由数组顺序定义；emoji 一份定义（渲染层不再各抄一份）。
 *  fundamental 不收裸词「数据」：它会抢在 note 的「数据口径/数据来源」前面命中，把口径说明画成财报卡。
 *
 * P21 结论契约：四类固定前缀（🎯 核心判断 / 🔍 关注清单 / 🛑 失效条件 / 🧭 执行计划）
 * 是 decision 模式注入到 LLM 提示词的强约束，LLM 按这套前缀输出，前端按硬前缀命中——
 * 排在最前面，抢在通用 risk/action 等关键词前命中，避免"核心判断"被归成"决策"、
 * "失效条件"被归成"风险"。 */
export const SECTION_DEFS: { kind: SectionKind; emoji: string; words: string[] }[] = [
  { kind: "conclusion",   emoji: "🎯", words: ["核心判断", "核心结论", "核心观点", "🎯 核心判断", "🎯 核心结论"] },
  { kind: "watchlist",    emoji: "🔍", words: ["关注清单", "观察清单", "观察标的", "🔍 关注清单", "🔍 观察清单"] },
  { kind: "invalidation", emoji: "🛑", words: ["失效条件", "失效信号", "失效场景", "🛑 失效条件"] },
  { kind: "plan",         emoji: "🧭", words: ["执行计划", "操作计划", "入场计划", "执行清单", "🧭 执行计划", "🧭 操作计划"] },
  { kind: "risk",         emoji: "⚠️", words: ["风险", "止损", "防守", "警惕", "注意"] },
  { kind: "action",       emoji: "📊", words: ["仓位", "减仓", "加仓", "买点", "卖点", "策略", "应对", "风控清单"] },
  { kind: "capital",      emoji: "💰", words: ["资金", "主力", "量能", "成交", "筹码"] },
  { kind: "technical",    emoji: "📈", words: ["技术", "趋势", "均线", "支撑", "压力", "回踩", "形态", "指标", "关键位", "阻力"] },
  { kind: "fundamental",  emoji: "📉", words: ["财报", "业绩", "基本面", "估值", "盈利", "公司", "产业", "行业逻辑", "证据"] },
  { kind: "market",       emoji: "🔥", words: ["市场", "大盘", "板块", "轮动", "情绪", "环境"] },
  { kind: "event",        emoji: "📰", words: ["新闻", "消息", "公告", "催化", "事件", "快讯"] },
  { kind: "decision",     emoji: "🎯", words: ["结论", "判断", "总结", "定性", "一句话", "决策", "评分", "综合"] },
  { kind: "note",         emoji: "📌", words: ["备注", "说明", "口径", "数据来源", "免责声明", "仅供参考", "数据基准", "边界"] },
];

export const SECTION_EMOJI: Record<SectionKind, string> = Object.fromEntries(
  SECTION_DEFS.map((d) => [d.kind, d.emoji]),
) as Record<SectionKind, string>;

/** 剥掉标题开头的 emoji/变体选择符/空白（模型自己挂了 emoji 的，剥掉再分类，卡头不重复画两个） */
export function stripLeadingEmoji(text: string): string {
  return String(text).replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u20E3\s]+/u, "").trim();
}

/** 标题文本 → 小节类型；认不出返回 null（按普通标题渲染，不硬凑一张卡） */
export function classifyHeading(text: string): SectionKind | null {
  const t = stripLeadingEmoji(String(text).replace(/[*`#>]/g, "")).trim();
  if (!t || t.length > 40) return null;
  for (const d of SECTION_DEFS) {
    if (d.words.some((w) => t.includes(w))) return d.kind;
  }
  return null;
}

export type MdBlock =
  | { kind: "plain"; text: string }
  | { kind: "card"; section: SectionKind; head: string; body: string };

/**
 * 按「分类命中的 ##/### 标题」把整段 markdown 切成块：命中的成为卡（标题+后续正文），
 * 其余（含没命中的标题）保持原样进 plain 块。代码围栏（``` / ~~~）内的伪标题不算标题——
 * 模型常在代码块里示例 markdown，切进去会把一张卡腰斩。
 */
export function splitBlocks(md: string): { intro: string; blocks: MdBlock[] } {
  const lines = String(md).split(/\r?\n/);
  const blocks: MdBlock[] = [];
  let plain: string[] = [];
  let cur: { section: SectionKind; head: string; body: string[] } | null = null;
  let inFence = false;
  const flushPlain = () => {
    const t = plain.join("\n").trim();
    if (t) blocks.push({ kind: "plain", text: t });
    plain = [];
  };
  const flushCard = () => {
    if (cur) blocks.push({ kind: "card", section: cur.section, head: cur.head, body: cur.body.join("\n").trim() });
    cur = null;
  };
  for (const line of lines) {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    const m = inFence ? null : /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      const kind = classifyHeading(m[2]);
      if (kind) {
        flushPlain(); flushCard();
        cur = { section: kind, head: m[2].trim(), body: [] };
        continue;
      }
      // 同级标题但没命中分类：当前卡收口。标题是同级的兄弟，不是上一张卡的正文；
      // 这一行连同后续未命中内容进 plain（四级标题不受影响，仍可留在卡内做小节）。
      flushCard();
    }
    if (cur) cur.body.push(line); else plain.push(line);
  }
  flushCard(); flushPlain();
  let intro = "";
  if (blocks.length > 0 && blocks[0].kind === "plain") intro = (blocks.shift() as { kind: "plain"; text: string }).text;
  return { intro, blocks };
}
