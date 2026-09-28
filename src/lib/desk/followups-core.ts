// 追问推荐（稳智 follow_up_suggestions 的本地等价实现）——纯文本切分，不碰 IO。
//
// 稳智那边是服务端字段：answer_finished 事件带 `follow_up_suggestions:{group_id, suggestions:[3]}`，
// 前端把它画成正下方三颗可点芯片（逆向见 D:\qoder-exports\稳智AI_试试这样问8卡与输出格式规格_2026-09-27.md §5/§6）。
// 本地没有那一份「答完再生成推荐」的服务端调用（多打一次模型 = 多一份延迟与费用，而且没余额可试），
// 所以换一个杠杆：让模型在回答末尾自己带上那一句，前端切开、剥掉、画成芯片。
//
// 为什么不新增 ChatMessage.followUps 字段：
//  1) 正文才是唯一事实来源。存两份（正文一份、字段一份）就会漂——done 全文回放、断点续传、
//     非流式兜底三条路都得记得同步那个字段，漏一条芯片就凭空消失或重复。
//  2) 存档零迁移。老会话里没有这个字段的回答照样能渲染；标记本来就在 content 里，刷新后还在。
//  3) 送回首轮上下文时用它就地剥掉（chat-core.buildPromptMessages），不用清档。
//
// 渲染纪律：流式过程中「半个标记」也不能露出来。
// 标记是 5 个字符的【追问推荐】，模型是一个字一个字吐的：如果只认全文，
// 用户会先看见「…一句话总结：先观察。【追问】」这种半截脏行，下一帧才消失。
// 所以「整行只到标记前缀为止」时也先藏起来（判据是行首要一路走完【追问推荐】的前缀才成立，
// 「【风险提示】……」这种正文段落匹配不上，不会被误吞）。

/** 标记原文。给提示词用的是这个常量，给正则用的是下面两条按同一形状写的行正则；
 *  p59 测试把「提示词里说的那一句」原样喂给解析器，两边一漂就红，靠测试钉住而不是靠人记。 */
export const FOLLOWUP_MARKER = "【追问推荐】";

/** 进系统提示词的那一句口径（与 MODE_NOTES 同层，但它是「跨模式的收尾纪律」，所以单独一条、四档共用一份） */
export const FOLLOWUP_NOTE = [
  `收尾纪律：回答的最末尾另起一行，以${FOLLOWUP_MARKER}开头，后面给 3 个「用户下一步最可能问」的追问，用竖线 | 分隔，每个不超过 20 字、不带标点符号、不写成列表。`,
  `例：${FOLLOWUP_MARKER}688256 的回踩支撑位在哪|今天板块资金流向如何|按我的成本该怎么分批。这一行只写给系统画推荐按钮用，不要解释它。`,
].join("\n");


/** 一颗推荐：文案 + 点击时真正发出去的那句（两者现在同文，留结构体以便日后加「带标的前缀」这类加工） */
export interface FollowUp {
  text: string;
  send: string;
}

export interface AnswerSplit {
  /** 剥掉推荐行之后的正文（拿去画 Markdown、拿去进下一轮上下文） */
  body: string;
  /** 最多 3 颗；没解析出来就是空数组，界面一颗都不画 */
  suggestions: FollowUp[];
  /** 正文里是否出现过标记（含半截）：用于「标记被截断但还没成行」时也别把半截画出去 */
  markerSeen: boolean;
}

/** 稳智一次给 3 颗，本地也按 3 颗封顶（多出来的一律丢弃，不摊大芯片行） */
export const MAX_FOLLOW_UPS = 3;
/** 单颗太长就不是「一句话提问」而是模型在凑段落，丢掉 */
const MAX_SUGGESTION_CHARS = 40;
/** 至少 2 颗才画：只剩一颗多半是模型把标记写在半截上，不如不画 */
const MIN_SUGGESTION_CHARS = 2;

/** 整行标记：允许被 markdown 加粗/列表符号包一层（模型常这么干），只认这一种锚。
 *  收口的「】**」这类必须容得下，但「】」本身是硬要求——漏了它会把「】」当推荐第一项交给界面。 */
const MARKER_LINE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?[ \t]*【[ \t]*追问推荐[ \t]*】[ \t]*(?:\*\*|__)?[ \t]*[:：]?[ \t]*(.*)$/gm;

/** 流式未收口时的半个标记：行首出现前 3 字就整行当它是标记行 */
const PARTIAL_MARKER_LINE = /^[ \t]*(?:\*\*|__)?[ \t]*【[ \t]*(?:追[ \t]*(?:问[ \t]*(?:推[ \t]*(?:荐[ \t]*(?:】[^\n]*)?)?)?)?)?[ \t]*$/gm;

/** 取最后一处命中：模型偶尔会把标记写两遍，切在最后一处能少丢正文 */
function lastHit(re: RegExp, text: string): RegExpExecArray | null {
  re.lastIndex = 0; // 带 g 的正则共享 lastIndex，不复位就会从上次扫到的地方接着走
  let hit: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) hit = m;
  return hit;
}

/** 分隔符：稳智用竖线；宽竖线/全角逗号/分号/换行都当它想分句，一并收 */
const SEPARATORS = /[|｜、，,;；]/;

function toSuggestions(raw: string): FollowUp[] {
  const seen = new Set<string>();
  const out: FollowUp[] = [];
  for (const piece of raw.split(SEPARATORS)) {
    // 去掉模型顺手加的项目符号、引号与尾部句号：芯片是一句话，不是 markdown 列表项
    const text = piece.replace(/^[\s"'“”『]+|[\s"'“”』。；;、|｜]+$/g, "").replace(/^\d+[.、]\s*/, "").trim();
    if (text.length < MIN_SUGGESTION_CHARS || text.length > MAX_SUGGESTION_CHARS) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, send: text });
    if (out.length >= MAX_FOLLOW_UPS) break;
  }
  return out;
}

/**
 * 把一条助手回答切成「正文 + 追问推荐」。
 * 全程只读字符串，不认流事件、不认消息结构，所以降级路（非流式一次性返回）与流式路共用它。
 */
export function splitFollowUps(content: string): AnswerSplit {
  const text = String(content ?? "");
  const hit = lastHit(MARKER_LINE, text);
  if (hit) {
    const head = text.slice(0, hit.index).replace(/\s+$/, "");
    return { body: head, suggestions: toSuggestions(hit[1] ?? ""), markerSeen: true };
  }
  const partial = lastHit(PARTIAL_MARKER_LINE, text);
  if (partial) {
    // 半截标记：整行藏起来，等下一帧长成完整标记再按完整规则切
    return { body: text.slice(0, partial.index).replace(/\s+$/, ""), suggestions: [], markerSeen: true };
  }
  return { body: text, suggestions: [], markerSeen: false };
}

/** 只要正文（进上下文、给结论守卫、给步骤时间线判定用） */
export function followUpBody(content: string): string {
  return splitFollowUps(content).body;
}

/** 只要推荐（界面画芯片用） */
export function followUpsOf(content: string): FollowUp[] {
  return splitFollowUps(content).suggestions;
}
