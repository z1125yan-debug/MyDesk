// 研究结论 widget 纯内核（P18 对齐稳智结构化决策卡）。
//
// 为什么单独成文件：解析规则同时被渲染层（DecisionWidget.tsx）和钉测消费——
// 写进 tsx 就只能字符串钉，解析行为测不到；抽出来才能像 markdown-sections-core 那样钉死。
//
// 数据来源：AI 在决策模式下按 modes.ts 的 MODE_NOTES.decision 模板吐 markdown。
// 稳智逆向扒出的 11 字段（decision_signal / core_judgement / data_basis / signals /
// capital_flow / falsification / trigger / invalidation / position_plan / risk / action）
// + 4 证据区块（Agent Loop / 已核验来源 / 结构化结果 / 数据提示）——字段名与 emoji 都对齐。
//
// 解析纪律：
//  - 严格按"emoji + 中文名："的锚点切分；emoji 剥掉只留正文，不重复展示。
//  - 字段缺失、正文为空都照实标"暂无"，不补不猜。
//  - 未命中"研究结论"块时 extract 返回 null，交给 Markdown 的普通分区卡渲染——
//    模型没按模板吐，前端就退回到普通卡片，不硬凑一张空 widget。
import { stripLeadingEmoji } from "./markdown-sections-core.ts";

export type DecisionFieldKey =
  | "core_judgement" | "data_basis" | "signals" | "capital_flow"
  | "falsification" | "trigger" | "invalidation" | "position_plan"
  | "risk" | "action";

export type EvidenceBlockKey = "agent_loop" | "sources" | "structured" | "data_note";

/** 字段的中文名 + emoji。顺序即渲染顺序（稳智 a 常量数组的顺序）。 */
export const DECISION_FIELDS: { key: DecisionFieldKey; emoji: string; zh: string }[] = [
  { key: "core_judgement", emoji: "📌", zh: "核心结论" },
  { key: "data_basis",     emoji: "📌", zh: "依据" },
  { key: "signals",        emoji: "📈", zh: "关键信号" },
  { key: "capital_flow",   emoji: "📊", zh: "强弱/量价" },
  { key: "falsification",  emoji: "🧪", zh: "反证状态" },
  { key: "trigger",        emoji: "🗓️", zh: "触发条件" },
  { key: "invalidation",   emoji: "🛑", zh: "失效条件" },
  { key: "position_plan",  emoji: "📦", zh: "仓位节奏" },
  { key: "risk",           emoji: "⚠️", zh: "风险提示" },
  { key: "action",         emoji: "🧭", zh: "操作参考" },
];

export const EVIDENCE_BLOCKS: { key: EvidenceBlockKey; emoji: string; zh: string }[] = [
  { key: "agent_loop",  emoji: "🔬", zh: "Agent Loop 摘要" },
  { key: "sources",     emoji: "🔎", zh: "已核验的信息来源" },
  { key: "structured",  emoji: "📊", zh: "结构化结果" },
  { key: "data_note",   emoji: "⚠️", zh: "数据提示" },
];

export type ParsedDecision = {
  /** 顶层标题（"研究结论"）后面的那一句摘要，通常就是模型写的一句话结论 */
  signal: string | null;
  /** 11 字段中的 10 个（不含 signal 本身） */
  fields: Partial<Record<DecisionFieldKey, string>>;
  /** 4 个证据区块 */
  blocks: Partial<Record<EvidenceBlockKey, string>>;
  /** 命中的原始锚点顺序（供测试断言解析顺序稳定） */
  order: string[];
  /** 模型按模板吐了至少 3 个 11 字段之一，或至少 1 个证据区块，才算命中 */
  hit: boolean;
};

const FIELD_PATTERNS: { key: DecisionFieldKey; re: RegExp }[] = [
  { key: "core_judgement", re: /^[-*]?\s*📌\s*核心结论\s*[:：]\s*(.*)$/ },
  { key: "data_basis",     re: /^[-*]?\s*📌\s*依据\s*[:：]\s*(.*)$/ },
  { key: "signals",        re: /^[-*]?\s*📈\s*关键信号\s*[:：]\s*(.*)$/ },
  { key: "capital_flow",   re: /^[-*]?\s*📊\s*强弱\/量价\s*[:：]\s*(.*)$/ },
  { key: "falsification",  re: /^[-*]?\s*🧪\s*反证状态\s*[:：]\s*(.*)$/ },
  { key: "trigger",        re: /^[-*]?\s*🗓️?\s*触发条件\s*[:：]\s*(.*)$/ },
  { key: "invalidation",   re: /^[-*]?\s*🛑\s*失效条件\s*[:：]\s*(.*)$/ },
  { key: "position_plan",  re: /^[-*]?\s*📦\s*仓位节奏\s*[:：]\s*(.*)$/ },
  { key: "risk",           re: /^[-*]?\s*⚠️?\s*风险提示\s*[:：]\s*(.*)$/ },
  { key: "action",         re: /^[-*]?\s*🧭\s*操作参考\s*[:：]\s*(.*)$/ },
];

const BLOCK_PATTERNS: { key: EvidenceBlockKey; re: RegExp }[] = [
  { key: "agent_loop",  re: /^🔬\s*Agent\s*Loop\s*摘要\s*[:：]\s*(.*)$/i },
  { key: "sources",     re: /^🔎\s*已核验(?:的)?的信息来源\s*[:：]\s*(.*)$/ },
  { key: "structured",  re: /^📊\s*结构化结果\s*[:：]\s*(.*)$/ },
  { key: "data_note",   re: /^⚠️?\s*数据提示\s*[:：]\s*(.*)$/ },
];

/** 识别"研究结论"顶层标题：允许 emoji 前缀、允许 markdown 标题级别。返回标题后的第一句正文。 */
function extractSignal(lines: string[]): { signal: string | null; bodyFrom: number } {
  const re = /^(?:#{1,3}\s*)?🎯?\s*研究结论\s*[:：]?\s*(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i].trim());
    if (!m) continue;
    const inline = (m[1] ?? "").trim();
    // 标题行本身带了摘要就直接用；否则看下一非空行是不是能作为 signal
    if (inline && !inline.startsWith("```") && !inline.startsWith("-")) return { signal: inline, bodyFrom: i + 1 };
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const next = lines[j].trim();
      if (!next) continue;
      // 遇到下一个 emoji 锚点、markdown 标题、或 markdown 列表项，signal 停止
      if (/^[#📌📈📊🧪🗓🛑📦⚠🧭🔬🔎]/.test(next)) break;
      if (/^[-*]\s*📌\s*(核心结论|依据)/.test(next)) break;
      // 直接就是列表项（- 开头）——说明标题下没有独立总结句，字段列表直接跟上
      if (/^[-*]\s+/.test(next)) break;
      // 遇到空行 + 列表项——同上，signal 停在空行前
      return { signal: next, bodyFrom: j + 1 };
    }
    return { signal: null, bodyFrom: i + 1 };
  }
  return { signal: null, bodyFrom: 0 };
}

/** 逐行匹配字段/区块，遇到下一个锚点为止收集"跨行正文"。空锚点不写。 */
function collectField(lines: string[], start: number): string {
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    // 遇到任何字段/区块锚点就停
    if (FIELD_PATTERNS.some((p) => p.re.test(trimmed))) break;
    if (BLOCK_PATTERNS.some((p) => p.re.test(trimmed))) break;
    // 遇到 markdown 标题（##/###）也停——通常是下一张分区卡的开头
    if (/^#{2,3}\s+/.test(trimmed)) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

/**
 * 从整段 markdown 抽取稳智 11 字段结构。
 *
 * 命中条件：至少命中 1 个 11 字段 OR 1 个证据区块——这样模型即便漏填一半，
 * 前端也能画半张卡，而不是硬凑或退回普通渲染。
 */
export function extractDecision(markdown: string): ParsedDecision | null {
  const md = String(markdown ?? "");
  const lines = md.split(/\r?\n/);
  const { signal, bodyFrom } = extractSignal(lines);
  const fields: Partial<Record<DecisionFieldKey, string>> = {};
  const blocks: Partial<Record<EvidenceBlockKey, string>> = {};
  const order: string[] = [];

  for (let i = bodyFrom; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // 字段锚点
    let matched = false;
    for (const p of FIELD_PATTERNS) {
      const m = p.re.exec(trimmed);
      if (!m) continue;
      const inline = (m[1] ?? "").trim();
      // 后续跨行正文合并（collectField 会停在下一个锚点/markdown 标题处）
      const rest = collectField(lines, i + 1);
      const body = [inline, rest].filter(Boolean).join("\n").trim();
      fields[p.key] = body;
      order.push(p.key);
      // 消费完 rest 里的所有行，直接跳到 rest 末尾之后（空 rest 不跳）
      if (rest) i += rest.split("\n").length;
      matched = true;
      break;
    }
    if (matched) continue;
    // 区块锚点
    for (const p of BLOCK_PATTERNS) {
      const m = p.re.exec(trimmed);
      if (!m) continue;
      const inline = (m[1] ?? "").trim();
      const rest = collectField(lines, i + 1);
      const body = [inline, rest].filter(Boolean).join("\n").trim();
      blocks[p.key] = body;
      order.push(p.key);
      if (rest) i += rest.split("\n").length;
      break;
    }
  }

  const fieldCount = Object.keys(fields).length;
  const blockCount = Object.keys(blocks).length;
  const hit = fieldCount >= 1 || blockCount >= 1;
  if (!hit) return null;
  return { signal, fields, blocks, order, hit };
}

/** 兜底文案：字段缺失时前端渲染用的字面文案（不猜、不编） */
export const EMPTY_PLACEHOLDER = "暂无";
