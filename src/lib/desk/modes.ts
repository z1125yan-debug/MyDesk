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

/**
 * 回答风格的服务端口径句（进系统提示词的那一句）。与 CHAT_MODES 同址存放的原因一样：
 * 工具端点（/api/ai/chat，systemPrompt 内嵌）与纯对话端点（/api/ai/proxy，独立 system 件）
 * 现在都要消费 mode——抄两份必然漂（改了一边、另一边界面照样显示选中，回答口径却没变）。
 * 键型钉死为 ChatMode：加模式漏登记，两条链路都在编译期报错。
 */
export const MODE_NOTES: Record<ChatMode, string> = {
  decision: "决策模式：面向操作前的快速研判，结论前置、证据充分。",
  judge: "研判模式：侧重技术结构与资金结构的客观描述，减少主观倾向。",
  deep: "深度思考模式：先梳理数据，再做逻辑推演，最后给风险清单。",
  search: "实时搜索模式：优先引用 market_news 返回的真实快讯，注明时间；无数据则明说。",
};

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
