// 回答风格（mode）的唯一定义处。
//
// 为什么单独成文件：首页的下拉和对话页的 chip 是同一个东西的两种画法，
// 各自抄一份清单就会漂（少一个模式、文案不一致、键名大小写不一致都看不出来）。
// 现在两边都从这份映射出键与文案，选择结果存在 store 的 assistantMode 上，
// 所以「首页选的模式」和「对话页真正带出去的模式」一定是同一个值。
export type ChatMode = "decision" | "judge" | "deep" | "search";

export const CHAT_MODES: { key: ChatMode; label: string; desc: string }[] = [
  { key: "decision", label: "决策模式", desc: "结论前置，工具调真实数据" },
  { key: "judge", label: "研判模式", desc: "客观描述结构，少主观" },
  { key: "deep", label: "深度思考", desc: "先数据后推演，附风险清单" },
  { key: "search", label: "实时搜索", desc: "优先引用最新快讯" },
];

/** 外部输入（存档里可能被改坏）只认这四个键，认不出就退回默认 */
export function isChatMode(value: unknown): value is ChatMode {
  return CHAT_MODES.some((m) => m.key === value);
}

/**
 * 把外部传来的 mode 收成合法值。
 * 请求体里的 mode 是浏览器给的：服务端拿它当查表键之前先过这道门，
 * 认不出的值不会带着一个不存在的模式名进提示词，而是明确按默认口径回答。
 */
export function asChatMode(value: unknown, fallback: ChatMode = "decision"): ChatMode {
  return isChatMode(value) ? value : fallback;
}

export function chatModeLabel(mode: unknown): string {
  return CHAT_MODES.find((m) => m.key === mode)?.label ?? "未选";
}
