// P52 输出边界护栏：模型复述内部脚手架的**确定性**清理（不依赖模型自觉）
//
// 为什么要有这一层：
//   实测上游（AMD 网关 DeepSeek-V4-Flash-Vision-Exp）会稳定把注入的「决策信号块」字段
//   和它自己对指令的理解抄进给用户的正文开头，而且**形态每次都变**，实测抓到三种：
//     v1 一行：用户问的是上证指数现在多少点，一句话回答。这是简单行情查询，不需要展开深度分析框架。直接引用真实数据回答即可。
//     v2 一行：交易周期：短线；风险偏好：中；当前市场状态：震荡偏弱
//     v3 多行：/短线/波段/中线
//             风险偏好：低/中/高
//             【决策信号块】（由 LLM 分类器判定，仅作参考口径，不是模型最终结论）
//             - 交易周期：短线
//             - 风险偏好：中
//             - 当前市场状态：震荡偏弱
//   两个提示词落点（客户端 assistantSystemPrompt / 服务端 /api/ai/chat systemPrompt）都加了
//   【禁止复述】段，注入块自己也标了「内部参考·禁止抄写」，实测该模型仍复述（指令遵循偏弱）。
//
//   所以分成两层，各司其职：
//     提示词层（ai.ts / route.ts / intent-llm-core.ts）= 请求模型别那么干；
//     本文件（纯核 + route.ts 接线）              = 保证干不了 —— 在输出边界上清掉。
//
// 判据为什么是「整块」而不是「整行」：
//   逐行判「这行像不像脚手架」会在 v3 那种多行块上直接漏掉（块里第一行是选项列表，不带 label）。
//   改成：从开头开始，**只要当前这一块（到第一个空行为止）里每一行都是脚手架味，就整块吃掉**，
//   吃完接着看下一块，直到遇上第一个真内容块为止。这样整块的错杀面比逐行小，命中率反而高。
//
// 纪律：
//   - 只清洗**开头**。中间和结尾的正文一个字不动（不替模型改写、不删观点）。
//   - 命中即留痕：调用方拿到 stripped 必须如实告知（route.ts 发 warning），不静默丢内容。
//   - 剥完不许把正文剥空；空了说明判错，原样返回（宁可留脏也不给空答案）。
//   - 单行块从严（要 ≥2 个字段段才认），多行块才吃全 —— 「交易周期：中线」这种正常回答不许误伤。
//
// 零 IO 纯函数：不 import、不读 env、不碰时钟，node 直跑可测。

export interface GuardResult {
  /** 清洗后的正文 */
  text: string;
  /** 被剥掉的开头原文（空串 = 没剥）。留痕用，不静默丢。 */
  stripped: string;
}

/**
 * 决策信号块 / 分类器会产出的字段名（模型抄出来的就是这些 label 开头的行）。
 * 注意这里**不是**禁用词表：判据看的是整行形状 + 整块比例，不问用户问了什么。
 */
const SIGNAL_LABELS = [
  "结论倾向", "交易周期", "风险偏好", "当前市场状态", "市场状态", "信号类型",
  "置信度", "情绪温度", "建议仓位", "建议立场", "风险等级", "关键价位", "止盈止损",
  "失效条件", "风险提示",
] as const;

/** 交易周期选项的裸列表（v3 的块首行「/短线/波段/中线」） */
const HORIZON_TOKENS = ["超短", "短线", "短中", "中线", "长线", "波段", "日内"] as const;

/** 行首是「<已知 label>：」——允许前置 markdown 项目符号（v3 的「- 交易周期：短线」） */
const LABEL_HEAD_RE = new RegExp(
  `^\\s*(?:[-*·]\\s*)?(?:${SIGNAL_LABELS.join("|")})\\s*[:：]`,
);

/** 整行只是交易周期选项的堆叠：「/短线/波段/中线」「短线、中线」 */
const HORIZON_ONLY_RE = new RegExp(
  `^[/、\\s|]*(?:${HORIZON_TOKENS.join("|")})(?:[/、\\s|]*(?:${HORIZON_TOKENS.join("|")}))*[/、\\s|]*$`,
);

/**
 * 只有水平线的一行（`---` / `***` / `___`）。它本身不含任何内容，
 * 只是模型在脚手架与正文之间画的隔断（实测 q2/q3 都有），所以算「透明行」：
 * 遇到它继续往下扫，而不是在这里停下 —— 否则后面那些该剥的头块会被它挡在门外。
 */
const HORIZONTAL_RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** 模型自述 / 解释指令的句式（整句都是这类，才判脚手架） */
const NARRATION_PATTERNS = [
  /^用户(问|说的是)/,
  /^这是(一个)?简单(的)?(行情)?(查询|问题)/,
  /^不需要展开深度分析/,
  /^直接引用真实数据(回答|作答)/,
  /^结合(上下|上述)上下文/,
  /^（?由\s*LLM\s*分类器判定/,
  // q11 实测：模型自报完字段后用「理由：…」开头写论证段——答案正文不会以它起段
  /^理由[:：]/,
  // q13 实测（截图第三轮）：模型把注入的指令栈整段抄回正文——
  // 「请用七维框架全面分析寒武纪（688256.SH），并给出可执行的入场计划。」
  // 「需要调用工具获取真实数据，不要凭印象。」「注意：用户持仓偏好为超短（1天以内）…」
  // 答案正文不会以「请用/请按…」的祈使句起段，更不会指挥自己「需要调用工具」
  /^请(用|按|以)[^。]{0,24}(框架|口径|分析|回答)/,
  /^需要(?:调用|获取)/,
  /^注意[:：]\s*(?:用户|持仓|周期|口径)/,
  // q14 实测：「系统已自动解析为 688256.SH，请按此代码分析。」——分类器注记的回述句
  /^系统已(自动)?解析/,
  // q20 实测：「信号块摘要：趋势强度偏弱，……建议观望。」——决策信号块的摘要行抄回正文
  /^信号块摘要[:：]/,
  // q20 实测：「中期 1-3 周｜置信度：中」——周期+置信度压缩字段行（答案正文不会用这个形状起段）
  /^[短中长]期[^。：]{0,14}[|｜]\s*置信度[:：]/,
] as const;

// q13 实测：「｜信号：观望」——字段行被掐头后的全角竖线残段（与 PIPE_PROV_RE 的「行中管道」不同形态）
const PIPE_FIELD_HEAD_RE = /^\s*[|｜]\s*(?:信号|方向|建议|结论|评级|置信度|情绪|周期|仓位|风险)\s*[:：]/;

/**
 * 思维链 / 内心独白行的**行首**线索（P53）。
 *
 * 事故：上游把 500+ 帧内心独白当 delta 流过正文（`q1.txt` 实测 875 帧里前 364 帧是独白，
 * 第 365 帧才是 `</think>`，真答案在标签之后）。收尾标签能一刀切开（见 findThinkClose），
 * 但**开场标签被上游吃掉**、或模型干脆不写标签时，只剩这些句式可认。
 *
 * 这一层比 SIGNAL_LABELS 松、但**只在开头整块命中时才动手**（见 isReasoningLine / isScaffoldBlock），
 * 正文中段引用一句「用户问…」不受影响（stripScaffoldEcho 只剥开头）。
 */
const REASONING_LINE_RE = new RegExp(
  "^\\s*(?:#{1,6}\\s*)?(?:" + [
    "用户(问|说的是|想要|提到|希望)",
    // q10 实测：模型把注入的周期口径/关注标的字段化自报（「用户持仓周期：超短（1 天以内…）」
    // 「用户持仓偏好：日内分批…」「用户当前关注标的：688256.SH」）——给用户的答案不会以这些字段行开头
    "用户(的)?(持仓|偏好|关注|当前)", "数据块", "信号块", "决策信号", "背景(信息|数据)",
    // 分类器件的自报字段：模型的「分类器判定：… 分类器置信度：… 分类器提示：…」是它把注入块改写了一遍
    "分类器(判定|置信度|提示|结果|结论|类型|认为)",
    "我的分析", "推理过程", "思考过程", "分析过程", "我的思考", "论证过程",
    "让我", "我先", "我需要", "我应该", "我可以", "我准备", "我需",
    // q11 实测：上游把英文内心独白也直接写进 content（「Let me analyze this. The user wants…」）
    "Let me", "Let's", "I'll", "I will", "I need to", "I should", "I'm going to", "The user wants",
    "实际上", "不过", "另外", "为了(更|交叉|完整|准确)", "按(指令|要求)|根据指令",
    "先(看看|确认|核对|判断)", "接下来我", "综上(所述)?我",
  ].join("|") + ")",
);

/**
 * 注入块被模型当标题抄回来时的**块名**（`### 市场情绪块` 这种）。
 * 用户答案里不会出现这些标题 —— 它们是系统注入的数据块/信号块的内部命名。
 * 名字后面允许接东西（实测「### 指数快照（东财口径）」也是同一类回显），
 * 但要卡一个边界字符，免把「数据块的说明」这种正常说法误读成块名。
 */
const INJECTED_BLOCK_HEAD_RE = new RegExp(
  "^#{1,6}\\s*(?:市场情绪块|市场情绪|数据块|信号块|决策信号块|稳智决策信号块|指数快照|行情快照|行情上下文|本地插件数据|工具(返回|结果)|检索结果)(?:\\s|[（(【「:：·—\\-]|$)",
);

// P55-B（截图第二轮）：模型回显注入件时的两种伪装形态。
// ① 管道来源标注行：「寒武纪（**688256.SH**）报价 | REAL | 真实数据：…」——
//    「| REAL | / | DERIVED |」这套管道格式只出现在注入快照行里，正常答案写不出这种形状；
//    模型还常给整行加粗，所以必须在 isScaffoldishLine 的 ** 放行之前判。
// ② 方头括号注入头：「【用户持仓周期偏好】超短…」「【系统注入_实时行情快照】行情快照·…」——
//    模型把服务端注入的口径句/快照改写个壳又抄回来；正常答案不会用「【用户持仓」当行首。
const PIPE_PROV_RE = /[|｜]\s*(?:REAL|DERIVED(?:_ON_DEMO)?|DEMO|MISSING)\s*[|｜]/;
const INJECTION_BRACKET_HEAD_RE = /^【(?:系统注入|用户持仓|用户偏好|行情上下文|行情快照|数据块|信号块|本地插件数据|市场环境|市场情绪|产业逻辑|基本面|个股|资金|技术|消息面|新闻面|综合判断|综合评估|候选池|最新(?:短线|财经)?快讯)/;

/** 「确定性注入头」的严格子集：这些词不可能作为用户答案里某个段落的 legitimate 起头。
 *  q24 实测：模型编造注入块（【系统注入·个股快照】+ 行情字段段）并重复 4 次——块里混着的
 *  行情字段行不是脚手架，旧判据整块保下。只要块里出现这类头，其余行按宽松口径收进块。 */
const STRICT_INJECTION_HEAD_RE = /^【(?:系统注入|本地插件数据|行情上下文|行情快照|个股快照|个股资金流|个股技术状态|个股技术面|市场快照|数据快照|最新(?:短线|财经)?快讯)/;

/** 注入快讯的 bullet 行（`- 07:30 系统谋划…` / `• 07:30 …`，允许 ** 加粗壳）：时间戳开头是快讯清单的形状。
 *  误伤闸：句末带 。！？ 的不算——「- **10:00 首次回踩。**」这种时间轴交易计划 bullet 是正文，不许碰。 */
const NEWS_BULLET_RE = /^[-•*]?\s*\*{0,2}\s*\d{1,2}:\d{2}\s+\S/;

function isNewsBullet(t: string): boolean {
  if (!NEWS_BULLET_RE.test(t)) return false;
  const bare = t.replace(/\*+\s*$/, "").trim();
  return !/[。！？]$/.test(bare);
}

/** 归一化用于「回显比对」：去掉所有空白与常见标点，只留实义字符 */
function normalizeEcho(s: string): string {
  return s.replace(/[\s\u3000]+/g, "").replace(/[，。！？、；：""''（）【】《》·—～\-.,!?;:()[\]{}<>"'`|]/g, "");
}

export interface GuardOpts {
  /**
   * 用户本轮原话：开头整块只是把提问抄一遍时也剥掉（实测模型先复读问题再作答）。
   * 比对走 normalizeEcho（去空白与标点），所以「上证指数现在多少点？」和「上证指数现在多少点」等价。
   */
  echoes?: string[];
}

/** 行内「强线索」句子：这些句式在用户答案里几乎不可能作为首句出现（允许 `### ` 标题前缀） */
const STRONG_REASONING_RE = /^(?:#{1,6}\s*)?(?:用户(问|说的是)|用户(的)?(持仓|偏好|关注|当前)|数据块|信号块|分类器|让我|我的分析|推理过程|思考过程|论证过程|Let me|Let's|I'll|I need to|I should|The user wants)/;

/**
 * 思维链控制标签。开场标签实测会被上游吃掉（只剩 `</think>` 收尾），所以**两边都要认**：
 *   - 有收尾标签 → 标签之前的统统是推理（最硬、可整段切）；
 *   - 只有开场标签没有收尾 → 到此刻为止全是推理（流式下「继续等正文」）。
 */
const CONTROL_TAG_RE = /^\s*(?:<\/?(?:think|thinking|analysis|reasoning|scratchpad|inner_monologue)>\s*)+/i;
const THINK_CLOSE_RE = /<\/(?:think|thinking|analysis|reasoning|scratchpad|inner_monologue)\s*>/gi;
const THINK_OPEN_RE = /^\s*<(?:think|thinking|analysis|reasoning|scratchpad|inner_monologue)\s*>/i;

/** 文本里第一个思维链收尾标签的**结束**下标（没有返回 -1） */
function findThinkClose(text: string): number {
  THINK_CLOSE_RE.lastIndex = 0;
  const m = THINK_CLOSE_RE.exec(text);
  return m ? m.index + m[0].length : -1;
}

/** 注入块自带的标题标记：模型整行抄下来就是最硬的自证（v3 的【决策信号块】） */
const MARKER_PATTERNS = [/决策信号块/, /【稳智决策信号块/, /【禁止复述/] as const;

/**
 * 系统提示词的小节标题。实测上游会整段回吐 system prompt（v4：把【回答风格】【数据纪律】
 * …连同规则编号一起抄出来），所以这些标题也算硬自证 —— 用户答案里不可能出现它们。
 */
const PROMPT_SECTION_MARKERS = [
  "【回答风格】", "【数据纪律", "【输出格式", "【行情上下文】", "【回答规则】", "【禁止复述】",
] as const;

/**
 * P55 回显行判据：这一行是不是「注入上下文被抄回来」的一行。
 *
 * 事故形态（2026-09-27 实测截图 + q1..q9 抓包）：上游把注入的快讯行
 * （`- 02:33 以军袭击加沙多地…`）、周期口径句、行情快照行
 * （`- 寒武纪（688256.SH）报价｜REAL｜…`）整段抄进正文开头——这些行
 * 不带任何脚手架标记，此前的判据一行都抓不住，整段回显被当成正文放行。
 *
 * 比对语料 = 调用方给的 opts.echoes（本轮用户原话 + 注入件后缀，归一化后拼一起）：
 *   - 整行照抄（归一化后 ≥12 字且在语料里）→ 算；
 *   - 行内连续 24 字语料段覆盖过半 → 也算（模型会自己加个头再抄正文，整行相等判不住，
 *     实测「【用户持仓周期回注】回应（1天以内…）…口径答。」就是这种）。
 * 24 字窗口是误伤闸：正常的「复述问题再作答」（问题通常 <16 字）凑不满一个窗口；
 * 「你的偏好是超短（1 天以内，日内或隔夜）。这个尺度下…」与口径句的最长公共段也只有 ~11 字。
 * 带 ** 加粗的行是模型自己写的正文，调用方负责放行（本函数不重复判）。
 * 零 IO 纯函数。
 */
const ECHO_MIN_LINE = 12;
const ECHO_WINDOW = 24;

export function isEchoLine(line: string, corpus: string): boolean {
  const c = normalizeEcho(corpus);
  if (!c) return false;
  const t = line.trim();
  if (!t || t.includes("**")) return false;
  const n = normalizeEcho(t);
  if (n.length < ECHO_MIN_LINE) return false;
  if (c.includes(n)) return true;
  if (n.length < ECHO_WINDOW) return false;
  let covered = 0;
  let streak = 0;
  let i = 0;
  while (i + ECHO_WINDOW <= n.length) {
    if (c.includes(n.slice(i, i + ECHO_WINDOW))) {
      covered += ECHO_WINDOW;
      i += ECHO_WINDOW;
      // P55-B：连续两窗命中（≥24 字语料逐字照抄且首尾相接 ≥48 字）直接认——
      // 模型改几个字（「隔夜」→「隔周」）会让局部错位，但长段照抄躲不掉
      streak++;
      if (streak >= 2) return true;
    } else {
      i++;
      streak = 0;
    }
  }
  return covered * 2 >= n.length;
}

/** 把 opts.echoes 拼成比对语料（空数组 → 空串，判据自动关闭） */
function echoCorpusOf(opts?: GuardOpts): string {
  const echoes = opts?.echoes ?? [];
  return echoes.length ? normalizeEcho(echoes.join("\n")) : "";
}

/** 单行是不是「脚手架味」（多行块的成员判据） */
export function isScaffoldishLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (MARKER_PATTERNS.some((r) => r.test(t))) return true;
  if (PROMPT_SECTION_MARKERS.some((m) => t.includes(m))) return true;
  if (INJECTED_BLOCK_HEAD_RE.test(t)) return true;
  if (HORIZONTAL_RULE_RE.test(t)) return true;
  // P55-B：这两个判据必须在 ** 放行之前 —— 加粗回显行（「寒武纪（**688256.SH**）报价 | REAL |…」）正是靠 ** 混过旧判据的
  if (PIPE_PROV_RE.test(t)) return true;
  if (INJECTION_BRACKET_HEAD_RE.test(t)) return true;
  if (PIPE_FIELD_HEAD_RE.test(t)) return true;
  // P57：注入快讯的 bullet（`- 07:30 标题`）——整块由这种行构成时 = 模型把快讯清单抄回来了。
  // 放在 ** 放行之前：模型会给 bullet 加粗（`- **07:30 系统谋划…**`），不能让 ** 条款把它救走。
  if (isNewsBullet(t)) return true;
  // 带**加粗标签**的行是模型写的正文（`- 📌 **仓位：** 5 成` 这类），不是脚手架
  if (t.includes("**")) return false;
  if (NARRATION_PATTERNS.some((r) => r.test(t))) return true;
  if (REASONING_LINE_RE.test(t)) return true;
  if (LABEL_HEAD_RE.test(t)) return true;
  if (HORIZON_ONLY_RE.test(t)) return true;
  // 短项目符号项（`- 交易周期：短线` 这类，前面已过 label 判据；这里兜「- 低/中/高」）
  if (/^[-*·]\s+\S/.test(t) && t.length <= 40 && /[/、:：]/.test(t)) return true;
  return false;
}

function isLabeledSegment(seg: string): boolean {
  return SIGNAL_LABELS.some((l) => seg.startsWith(`${l}：`) || seg.startsWith(`${l}:`));
}

/**
 * 单行「字段行」：「交易周期：短线；风险偏好：中；当前市场状态：震荡偏弱」。
 * 从严：≥2 段、每段都以已知 label + 冒号开头、全长不过 120 字。
 * 单个 label（「交易周期：中线」）不算 —— 那可能是用户在问周期、模型正常回答。
 */
function isFieldLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 120) return false;
  const segs = t.split(/[；;｜|]/).map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return false;
  return segs.every(isLabeledSegment);
}

/** 整块都是自述句（拆句后每句都属于自述句式） */
function isNarration(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  const sentences = t.split(/[。！!？?]/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return false;
  return sentences.every((s) => NARRATION_PATTERNS.some((r) => r.test(s)));
}

/**
 * 单行是不是**内心独白**（P53 新增，专治「上游把思维链写进正文」）。
 *
 * 从严三档，全在**单行块**上才用，多行块由 isScaffoldishLine 逐行判：
 *   1. 拆句后 ≥2 句命中推理线索 → 认（「用户问上证指数点位。数据块里有…」）；
 *   2. 首句就是强线索（`用户问` / `数据块` / `信号块` / `让我` / `我的分析` / `推理过程`）→ 认；
 *   3. 但第 2 档加一道闸：整行含 `**` 加粗标签的一律放行 —— 真答案的第一行就是加粗结论，
 *      自述句不会带加粗标签（实测 q2 的残留就是「用户问的是…请用自然语言散文体输出，不要用列表。」
 *      这种没加粗、又长到 3 句的自述，光靠句数阈值抓不住）。
 */
function isReasoningLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (!REASONING_LINE_RE.test(t)) return false;
  const sentences = t.split(/[。！!？?；;]/).map((s) => s.trim()).filter(Boolean);
  const hits = sentences.filter((s) => REASONING_LINE_RE.test(s)).length;
  if (hits >= 2) return true;
  if (!STRONG_REASONING_RE.test(sentences[0] ?? "")) return false;
  if (t.includes("**")) return false;
  return true;
}

/**
 * 一个「块」（到空行为止的连续行）是不是脚手架块。
 *   - 块里有注入块标题标记 → 是（最硬的自证，单行块也算）；
 *   - 块是用户原话的回显（opts.echoes）→ 是（模型先复读问题再作答，实测形态）；
 *   - 单行块：得是「多字段行」/「整段自述」/「内心独白」才认（从严，护住「交易周期：中线」这类正常回答）；
 *   - 多行块（≥2 个非空行）：每一行都脚手架味就整块认。
 */
export function isScaffoldBlock(lines: string[], opts?: GuardOpts): boolean {
  const nonEmpty = lines.filter((l) => l.trim());
  if (!nonEmpty.length) return false;
  if (nonEmpty.some((l) => MARKER_PATTERNS.some((r) => r.test(l)))) return true;
  if (nonEmpty.some((l) => PROMPT_SECTION_MARKERS.some((m) => l.includes(m)))) return true;
  if (nonEmpty.some((l) => INJECTED_BLOCK_HEAD_RE.test(l.trim()))) return true;
  // 整块只有水平线：不含内容的隔断，算脚手架（单行块也要认）
  if (nonEmpty.every((l) => HORIZONTAL_RULE_RE.test(l.trim()))) return true;
  // P57：块里出现确定性注入头（【系统注入·个股快照】/【最新财经快讯】…）→ 整块按注入件回述收。
  // 其余行宽松判：不带 ** 加粗标签、不以？！收口就算数（编造的行情字段段「寒武纪（…）最新行情：收盘…」就是这么认的）。
  if (nonEmpty.some((l) => STRICT_INJECTION_HEAD_RE.test(l.trim()))) {
    return nonEmpty
      .filter((l) => !STRICT_INJECTION_HEAD_RE.test(l.trim()))
      .every((l) => {
        const t = l.trim();
        return t.length > 0 && !t.includes("**") && !/[？！]$/.test(t);
      });
  }
  // 整块（拼起来）就是用户原话的回显
  const echoes = opts?.echoes ?? [];
  if (echoes.length) {
    const whole = normalizeEcho(nonEmpty.join(""));
    if (whole && echoes.some((e) => { const n = normalizeEcho(e); return n.length > 0 && n === whole; })) return true;
  }
  if (nonEmpty.length === 1) {
    const l = nonEmpty[0];
    if (isFieldLine(l) || isNarration(l) || isReasoningLine(l)) return true;
    // P55-B：单行的管道来源标注行 / 方头括号注入头 / 竖线字段残段也是决定性形态（与 isScaffoldishLine 同判据）
    const lt = l.trim();
    if (PIPE_PROV_RE.test(lt) || INJECTION_BRACKET_HEAD_RE.test(lt) || PIPE_FIELD_HEAD_RE.test(lt)) return true;
    // P57：单行注入快讯 bullet（`- 06:30 伊麻亨利：…`）——模型抄清单时可能多编/漏抄一条，
    // 那条不在语料里 isEchoLine 抓不住，靠快讯形状认（isNewsBullet 已带句末标点误伤闸）
    if (isNewsBullet(lt)) return true;
    // q11 实测：单字段裸数字自报（「置信度：0.62」「情绪温度：42.2」）——值是纯数字的
    // 已知 label 行是字段自报，不是给用户的答案（「交易周期：中线」这种文字值仍放行）
    const fm = l.match(/^\s*(?:[-*·]\s*)?([^：:]{2,8})[:：]\s*([^：:]+)$/);
    if (fm && (SIGNAL_LABELS as readonly string[]).includes(fm[1]) && /^[\d.]+%?$/.test(fm[2].trim())) return true;
    // P55：单行块也可以是「注入上下文整行抄回来」（快讯行/快照行/口径句），从严走 isEchoLine
    return isEchoLine(l, echoCorpusOf(opts));
  }
  // P55：整块都是注入上下文的回显行（快讯列表、行情快照行、被改头抄写的口径句）——
  // 每一行都要中判据才动手（整块口径，误伤面比逐行小）；带 ** 的正文行 isEchoLine 自己放行。
  const corpus = echoCorpusOf(opts);
  if (corpus && nonEmpty.every((l) => isEchoLine(l, corpus))) return true;
  return nonEmpty.every((l) => isScaffoldishLine(l));
}

/** 整篇都是脚手架时的兜底话术（调用方在 text 为空且 stripped 非空时使用） */
export const SCAFFOLD_ONLY_NOTICE =
  "模型这一轮没有写成正文（只回吐了内部提示词），本轮没有可用结论，请重试一次。";

/**
 * 清掉正文**开头**的脚手架，返回清洗后的正文与剥掉的开头。
 *
 * 逐块扫，一遇到第一块不是脚手架的就停 —— 只能删开头，删不到中间/结尾，
 * 也不可能把「正文里引用了一句『用户问的是…』」这种正常内容误伤（它不在开头）。
 */
export function stripScaffoldEcho(text: string, opts?: GuardOpts): GuardResult {
  if (!text || !text.trim()) return { text, stripped: "" };

  // 0) 先摘掉文本最前面的思维链控制标签（</think> 这类）。
  //    必须在分块判定之前做：标签粘在行首会让「字段行」判据失配（实测就是这么漏的）。
  const tagMatch = text.match(CONTROL_TAG_RE);
  const tag = tagMatch ? tagMatch[0] : "";
  let body = tag ? text.slice(tag.length) : text;
  const dropTails: string[] = [];

  // 0.5) P53 思维链收尾标签切割（本仓最硬的一类泄漏，实测 875 帧里前 364 帧都栽在这）：
  //      上游把整段内心独白写进 `content`，末尾用 `</think>` 收口，真答案在标签之后。
  //      凡出现收尾标签 → 标签之前的一切都不是给用户看的（脚手架自述、CoT 全在里面），一刀切开。
  //      只有开场标签、还没收尾 → 到此刻为止全是推理：返回空正文但带上 stripped，
  //      流式头护栏据此「继续等正文」，而不是把半截独白当答案放出去。
  const closeAt = findThinkClose(body);
  if (closeAt >= 0) {
    dropTails.push(body.slice(0, closeAt));
    body = body.slice(closeAt);
  } else if (THINK_OPEN_RE.test(body)) {
    return { text: "", stripped: body.trim() };
  }

  // 1) 反复吃掉「整块都是脚手架」的头块
  const droppedChunks: string[] = [];
  for (;;) {
    body = body.replace(/^[\s\u3000]+/, "");
    body = body.replace(CONTROL_TAG_RE, "");   // 收尾标签可能贴在有内容的那一段行首，一起摘掉
    if (!body) break;
    const lines = body.split("\n");
    const blankAt = lines.findIndex((l) => !l.trim());
    const blockLines = blankAt === -1 ? lines : lines.slice(0, blankAt);
    if (!isScaffoldBlock(blockLines, opts)) break;
    droppedChunks.push(blockLines.join("\n"));
    body = blankAt === -1 ? "" : lines.slice(blankAt).join("\n");
    if (!body.trim()) break;
  }
  // 2) 中段：整段都是脚手架的块也清掉（保留空行结构）。
  //    头部扫描会被真正的正文挡住，可模型仍可能在正文中间插一段自述 ——
  //    实测 q7：「让我调一下实时数据。」单独成段，夹在两条答案之间。
  //    纪律不变：按「整段」判（isScaffoldBlock），且只有水平线/带加粗标签的段一律不动。
  {
    const all = body.split("\n");
    const keep: string[] = [];
    let i = 0;
    while (i < all.length) {
      while (i < all.length && !all[i].trim()) { keep.push(all[i]); i++; }
      const start = i;
      while (i < all.length && all[i].trim()) i++;
      const blk = all.slice(start, i);
      if (!blk.length) continue;
      if (blk.every((l) => HORIZONTAL_RULE_RE.test(l.trim()))) { keep.push(...blk); continue; }
      if (isScaffoldBlock(blk, opts)) { droppedChunks.push(blk.join("\n")); continue; }
      keep.push(...blk);
    }
    body = keep.join("\n");
  }
  body = body.replace(/^[\s\u3000]+/, "");

  const stripped = [tag.trim(), ...dropTails.map((s) => s.trim()), ...droppedChunks.map((s) => s.trim())]
    .filter(Boolean)
    .join("\n\n");

  // 什么都没剥（只可能剥了空行）→ 原样返回
  if (!stripped) return { text, stripped: "" };
  // 整篇都是脚手架（实测 v4：模型把整份 system prompt 回吐出来，正文一个字没写）：
  // 返回**空正文** + 剥掉的内容，由调用方换成一句如实的话术 —— 绝不把 system prompt 放给用户看。
  if (!body.trim()) return { text: "", stripped };

  return { text: body, stripped };
}
