"use client";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// 聊天气泡内的 Markdown 渲染（P7-⑤③ 升级为「结构化渲染」）。
//
// 升级点只有一件事：模型按开发文档 §2.4 用带图标的二级/三级标题分块时（🎯 结论 / 📊 基本面 /
// ⚠️ 风险 / 🧭 操作参考 / 💰 资金 / 📈 技术 / 📰 事件 / 🔥 市场 / 📌 备注），
// 界面把它渲染成对应的分区卡片，而不是让它落回普通标题。
// 不引新依赖，也不在这里判定内容真假：卡片只管「这一块是什么」，数据真伪仍由上下文来源分层负责。
type ModuleKey = "decision" | "fundamental" | "risk" | "action" | "capital" | "technical" | "event" | "market" | "note";

const MODULES: Record<ModuleKey, { emoji: string; words: string[]; ring: string; bg: string; text: string }> = {
  decision:     { emoji: "🎯", words: ["结论", "决策", "综合判断", "评分"], ring: "border-sky-500/40",     bg: "bg-sky-500/10",     text: "text-sky-200" },
  fundamental:  { emoji: "📊", words: ["基本面", "财务", "估值"],           ring: "border-indigo-500/40",  bg: "bg-indigo-500/10",  text: "text-indigo-200" },
  risk:         { emoji: "⚠️", words: ["风险", "提示"],                     ring: "border-rose-500/40",    bg: "bg-rose-500/10",    text: "text-rose-200" },
  action:       { emoji: "🧭", words: ["操作参考", "应对", "计划", "风控清单"], ring: "border-teal-500/40",  bg: "bg-teal-500/10",  text: "text-teal-200" },
  capital:      { emoji: "💰", words: ["资金", "主力", "筹码"],             ring: "border-amber-500/40",   bg: "bg-amber-500/10",   text: "text-amber-200" },
  technical:    { emoji: "📈", words: ["技术", "结构", "关键位", "支撑", "阻力"], ring: "border-emerald-500/40", bg: "bg-emerald-500/10", text: "text-emerald-200" },
  event:        { emoji: "📰", words: ["事件", "消息", "快讯", "新闻"],     ring: "border-violet-500/40",  bg: "bg-violet-500/10",  text: "text-violet-200" },
  market:       { emoji: "🔥", words: ["市场", "大盘", "情绪", "板块"],     ring: "border-orange-500/40",  bg: "bg-orange-500/10",  text: "text-orange-200" },
  note:         { emoji: "📌", words: ["备注", "说明", "口径", "数据来源"], ring: "border-slate-500/40",   bg: "bg-slate-500/10",   text: "text-slate-200" },
};

/** 标题文本 → 模块：emoji 命中或关键词命中都算，认不出就返回 null（按普通标题渲染） */
function moduleOf(text: string): ModuleKey | null {
  const t = text.replace(/[#*`]/g, "").trim();
  if (!t) return null;
  for (const [key, m] of Object.entries(MODULES) as [ModuleKey, (typeof MODULES)[ModuleKey]][]) {
    if (t.startsWith(m.emoji)) return key;
  }
  for (const [key, m] of Object.entries(MODULES) as [ModuleKey, (typeof MODULES)[ModuleKey]][]) {
    if (t.length <= 16 && m.words.some((w) => t.includes(w))) return key;
  }
  return null;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function ModuleHeading({ level, children }: { level: 2 | 3; children: ReactNode }) {
  const label = textOf(children);
  const key = moduleOf(label);
  const size = level === 2 ? "text-[14px]" : "text-[13px]";
  if (!key) {
    const Tag = level === 2 ? "h2" : "h3";
    return <Tag className={`${size} font-bold ${level === 3 ? "text-sky-300" : ""}`}>{children}</Tag>;
  }
  const m = MODULES[key];
  return (
    <div className={`mt-1 flex items-center gap-1.5 rounded-t-md border ${m.ring} ${m.bg} px-2 py-1`}>
      <span aria-hidden className="text-[12px] leading-none">{m.emoji}</span>
      <span className={`${size} font-semibold ${m.text}`}>{label.replace(m.emoji, "").trim() || m.words[0]}</span>
      <span className="ml-auto font-mono text-[9.5px] uppercase opacity-60">{key}</span>
    </div>
  );
}

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="text-[15px] font-bold">{children}</h1>,
  h2: ({ children }) => <ModuleHeading level={2}>{children}</ModuleHeading>,
  h3: ({ children }) => <ModuleHeading level={3}>{children}</ModuleHeading>,
  // 表格在窄气泡里最容易撑破布局：包一层横向滚动，不裁数据
  table: ({ children }) => (
    <div className="desk-scroll -mx-1 overflow-x-auto py-0.5">
      <table className="w-full min-w-[420px] border-collapse text-[12px]">{children}</table>
    </div>
  ),
  // 引用块常被模型用来放「系统提示 / 口径说明」，按提示条处理
  blockquote: ({ children }) => (
    <blockquote className="my-1 rounded border-l-2 border-sky-500/50 bg-sky-500/5 px-2 py-1 text-[12.5px] text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-border" />,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-sky-300 underline">{children}</a>
  ),
};

export default function Markdown({ content }: { content: string }) {
  return (
    <div
      className="space-y-2 [&_code]:rounded [&_code]:bg-accent [&_code]:px-1 [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-accent/60 [&_pre]:p-2 [&_strong]:font-semibold [&_strong]:text-foreground [&_tbody_tr]:border-b [&_tbody_tr]:border-border/50 [&_td]:px-1.5 [&_td]:py-1 [&_th]:border-b [&_th]:border-border [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-4"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{content}</ReactMarkdown>
    </div>
  );
}
