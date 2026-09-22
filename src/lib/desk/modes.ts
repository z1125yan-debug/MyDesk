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

/* ---------------- 持仓周期（horizon）：与回答风格同一套「一处定义、两端消费」纪律 ---------------- */
// 参考稳智AI 的研究指令口径：「交易周期按所选周期执行」——周期直接改变入场条件/仓位节奏/失效条件的时间尺度，
// 是决策质量参数而不是界面装饰。默认「未选」：没选就一个字都不注入，不替用户假设他是短线客。

export type ChatHorizon = "short" | "mid" | "long";

export const CHAT_HORIZONS: { key: ChatHorizon; label: string; desc: string }[] = [
  { key: "short", label: "短线", desc: "数日至一两周" },
  { key: "mid", label: "中线", desc: "数周至数月" },
  { key: "long", label: "长线", desc: "数月至一年以上" },
];

/** 周期的服务端口径句（进系统提示词）。与 MODE_NOTES 同址同纪律：工具环与纯对话端点查同一张表 */
export const HORIZON_NOTES: Record<ChatHorizon, string> = {
  short: "用户的持仓周期偏好：短线（数日至一两周）。入场条件、仓位节奏、失效条件、止盈止损都要按短周期给（如 5/10 日线、2~3 成仓分批、跌破 5 日线即失效），不要给长线持有口径。",
  mid: "用户的持仓周期偏好：中线（数周至数月）。入场条件看 20/60 日线级别的企稳与回踩、仓位以周为单位分批推进、失效条件写在周线级别，不要按日内/数日的短线口径答。",
  long: "用户的持仓周期偏好：长线（数月至一年以上）。论据侧重基本面与行业景气位置、仓位强调分批建仓与回撤承受、失效条件是逻辑破坏（业绩/行业反转），不是几日的技术位跌破。",
};

/** 外部输入白名单（与 asChatMode 同一套路）：认不出/未选一律 null——不猜周期、也不注入任何周期口径 */
export function asHorizon(value: unknown): ChatHorizon | null {
  return CHAT_HORIZONS.some((h) => h.key === value) ? (value as ChatHorizon) : null;
}

export function chatHorizonLabel(horizon: unknown): string {
  return CHAT_HORIZONS.find((h) => h.key === horizon)?.label ?? "未选";
}
