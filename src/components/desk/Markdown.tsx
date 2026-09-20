"use client";
import { createContext, useContext, type ReactNode } from "react";
import { cloneElement, isValidElement, Children } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitByLinks, type DeskLink, type LinkSegment, type SectorRef } from "@/lib/desk/link-core";

// 聊天气泡内的 Markdown 渲染（P7-⑤③ 升级为「结构化渲染」）。
//
// 升级点一（P7-⑤③）：模型按开发文档 §2.4 用带图标的二级/三级标题分块时（🎯 结论 / 📊 基本面 /
// ⚠️ 风险 / 🧭 操作参考 / 💰 资金 / 📈 技术 / 📰 事件 / 🔥 市场 / 📌 备注），
// 界面把它渲染成对应的分区卡片，而不是让它落回普通标题。
//
// 升级点二（P7-⑧②，本轮）：正文里的 6 位代码与「已知清单内的板块名」渲染成可点片段，点一下切标的/跳板块榜。
// 判定全在纯内核 link-core（有单测），这里只负责「把命中的区间换成按钮」。三条渲染约束：
//  - 不引新依赖、不改文案：切分保证拼回去逐字等于原文，链接不吞字不改字；
//  - code / pre / a 里不做二次识别：代码块里的示例代码、外链的显示文字都不是「AI 在指一只票」；
//  - 模块卡片标题里不放链接：卡片头是「这一块讲什么」，塞按钮会把标题画歪，且点标题跳走很怪。
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

// ---------- P7-⑧② 可点片段：渲染层 ----------

interface LinkCtx {
  sectors: SectorRef[];
  onLink: (link: DeskLink) => void;
}

/** 没有这个上下文（分析页正文、个股画像那些地方）时，一个链接都不生成：跳转联动只属于对话链路 */
const DeskLinkCtx = createContext<LinkCtx | null>(null);

// 这些标签内部不再做二次识别：代码块/行内代码里的示例代码、外链显示文字都不是「AI 在指一只票」。
// a / code / pre 的取值要么是这里的字符串标签名，要么是下面那两个组件函数的引用（同一轮渲染内稳定）。
const NO_LINK_TYPES = new Set<unknown>(["a", "code", "pre"]);

function ExternalLink({ children, href }: { children?: ReactNode; href?: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className="text-sky-300 underline">{children}</a>;
}

/** 行内代码：样式仍由外层 [&_code] 的选择器管，这里只是为了让遍历能按引用认出「这是 code」并停下 */
function InlineCode({ children }: { children?: ReactNode }) {
  return <code>{children}</code>;
}

NO_LINK_TYPES.add(ExternalLink);
NO_LINK_TYPES.add(InlineCode);

function linkLabel(link: DeskLink): string {
  return link.kind === "symbol" ? `切到 K 线图：${link.symbol}` : `跳到板块榜并展开：${link.name}（${link.code}）`;
}

function LinkSpan({ seg, ctx }: { seg: LinkSegment; ctx: LinkCtx }) {
  const link = seg.link as DeskLink;
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); ctx.onLink(link); }}
      title={linkLabel(link)}
      className={(link.kind === "symbol" ? "font-mono " : "") +
        "cursor-pointer rounded bg-sky-500/10 px-1 text-sky-300 underline decoration-dotted decoration-sky-500/50 underline-offset-2 hover:bg-sky-500/25 hover:text-sky-200"}>
      {seg.text}
    </button>
  );
}

/**
 * 递归把子树里的字符串换成「文字 / 可点片段」。
 * 只做替换不重排：命中的区间由 link-core 决定，这里连判定都不做，避免界面和测试各判一套。
 */
function linkifyTree(node: ReactNode, ctx: LinkCtx, path: string): ReactNode {
  return Children.map(node, (child, i) => {
    const key = `${path}.${i}`;
    if (typeof child === "string") {
      const segs = splitByLinks(child, ctx.sectors);
      if (!segs.some((s) => s.link)) return child;
      return segs.map((s, j) => (s.link
        ? <LinkSpan key={`${key}l${j}`} seg={s} ctx={ctx} />
        : <span key={`${key}t${j}`}>{s.text}</span>));
    }
    if (isValidElement(child)) {
      if (NO_LINK_TYPES.has(child.type)) return child;
      const props = child.props as { children?: ReactNode };
      if (props.children == null) return child;
      return cloneElement(child as React.ReactElement<{ children?: ReactNode }>, undefined, linkifyTree(props.children, ctx, key));
    }
    return child;
  });
}

/** 容器组件共用：有上下文就换链接，没有就原样渲染（同一段正文在两个入口的表现只由这一处决定） */
function Linked({ children }: { children?: ReactNode }) {
  const ctx = useContext(DeskLinkCtx);
  return <>{ctx ? linkifyTree(children, ctx, "r") : children}</>;
}

function MdP({ children }: { children?: ReactNode }) {
  return <p><Linked>{children}</Linked></p>;
}
function MdLi({ children }: { children?: ReactNode }) {
  return <li><Linked>{children}</Linked></li>;
}
function MdTd({ children }: { children?: ReactNode }) {
  return <td><Linked>{children}</Linked></td>;
}
function MdTh({ children }: { children?: ReactNode }) {
  return <th><Linked>{children}</Linked></th>;
}
function MdH1({ children }: { children?: ReactNode }) {
  return <h1 className="text-[15px] font-bold"><Linked>{children}</Linked></h1>;
}
function MdBlockquote({ children }: { children?: ReactNode }) {
  return (
    <blockquote className="my-1 rounded border-l-2 border-sky-500/50 bg-sky-500/5 px-2 py-1 text-[12.5px] text-muted-foreground">
      <Linked>{children}</Linked>
    </blockquote>
  );
}

function ModuleHeading({ level, children }: { level: 2 | 3; children: ReactNode }) {
  const label = textOf(children);
  const key = moduleOf(label);
  const size = level === 2 ? "text-[14px]" : "text-[13px]";
  if (!key) {
    const Tag = level === 2 ? "h2" : "h3";
    return <Tag className={`${size} font-bold ${level === 3 ? "text-sky-300" : ""}`}><Linked>{children}</Linked></Tag>;
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
  h1: MdH1,
  h2: ({ children }) => <ModuleHeading level={2}>{children}</ModuleHeading>,
  h3: ({ children }) => <ModuleHeading level={3}>{children}</ModuleHeading>,
  p: MdP,
  li: MdLi,
  // 表格里最容易整格都是代码：逐格换，不整表换（表头/结构节点不动）
  td: MdTd,
  th: MdTh,
  // 表格在窄气泡里最容易撑破布局：包一层横向滚动，不裁数据
  table: ({ children }) => (
    <div className="desk-scroll -mx-1 overflow-x-auto py-0.5">
      <table className="w-full min-w-[420px] border-collapse text-[12px]">{children}</table>
    </div>
  ),
  // 引用块常被模型用来放「系统提示 / 口径说明」，按提示条处理
  blockquote: MdBlockquote,
  hr: () => <hr className="my-2 border-border" />,
  a: ({ children, href }) => <ExternalLink href={href}>{children}</ExternalLink>,
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
};

export default function Markdown({
  content, sectors, onLink,
}: {
  content: string;
  /** 已知板块清单（/api/market/sectors 的真实榜单）；不传 = 不生成板块链接 */
  sectors?: SectorRef[];
  /** 点击可点片段的回调；不传 = 整段正文一律不可点 */
  onLink?: (link: DeskLink) => void;
}) {
  const ctx: LinkCtx | null = onLink ? { sectors: sectors ?? [], onLink } : null;
  return (
    <div
      className="space-y-2 [&_code]:rounded [&_code]:bg-accent [&_code]:px-1 [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-accent/60 [&_pre]:p-2 [&_strong]:font-semibold [&_strong]:text-foreground [&_tbody_tr]:border-b [&_tbody_tr]:border-border/50 [&_td]:px-1.5 [&_td]:py-1 [&_th]:border-b [&_th]:border-border [&_th]:px-1.5 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-4"
    >
      <DeskLinkCtx.Provider value={ctx}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{content}</ReactMarkdown>
      </DeskLinkCtx.Provider>
    </div>
  );
}
