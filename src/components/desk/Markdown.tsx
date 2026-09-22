"use client";
import { createContext, useContext, Fragment, type ReactNode } from "react";
import { cloneElement, isValidElement, Children } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitByLinks, type DeskLink, type LinkSegment, type SectorRef } from "@/lib/desk/link-core";
import { splitBlocks, stripLeadingEmoji, SECTION_EMOJI, SECTION_DEFS, type MdBlock } from "@/lib/desk/markdown-sections-core";

// 聊天气泡内的 Markdown 渲染（P7-⑤③ 结构化 → P15 对齐稳智「分区卡」）。
//
// P15 的关键改动（对齐从 aiwuchuan.com 前端 bundle 实测拆出的表达层）：
//  - 不再只画一条标题色带、正文散落外面——「小节标题 + 它下面的正文」一起包进一张圆角分区卡。
//    卡是同款灰卡：1px 浅描边 + 14px 圆角 + 浅灰底，卡头不再按九类分色（分类只决定 emoji 与成不成卡）。
//    一屏下来一块一块的，这才是「不像死人机」的那层观感。
//    分类与切块规则全在纯核 markdown-sections-core（有单测），这里只管画。
//  - 标题 emoji 由纯核按关键词自动挂（模型没写也挂）；认不出的小节不硬凑卡、按普通标题渲染。
//
// P7-⑧② 保留：正文里的 6 位代码与「已知清单内的板块名」渲染成可点片段。三条渲染约束不变：
//  - 不引新依赖、不改文案：切分保证拼回去逐字等于原文，链接不吞字不改字；
//  - code / pre / a 里不做二次识别；卡片标题里不放链接（标题是「这块讲什么」，塞按钮会画歪）。

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

/**
 * 没被切成卡的 ##/### 标题（分类认不出的）：按普通标题渲染。
 * P15 起 ModuleHeading 退役——命中的标题已经被 splitBlocks 拿去当卡头，走到这里的都是不该成卡的。
 */
function PlainHeading({ level, children }: { level: 2 | 3; children: ReactNode }) {
  const Tag = level === 2 ? "h2" : "h3";
  const size = level === 2 ? "text-[14px]" : "text-[13px]";
  return <Tag className={`${size} font-bold ${level === 3 ? "text-sky-300" : ""}`}><Linked>{children}</Linked></Tag>;
}

const COMPONENTS: Components = {
  h1: MdH1,
  h2: ({ children }) => <PlainHeading level={2}>{children}</PlainHeading>,
  h3: ({ children }) => <PlainHeading level={3}>{children}</PlainHeading>,
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

/** 一段 markdown 走同一套组件渲染（intro/plain 块/卡体共用，保证两处画法不漂） */
function MdTree({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{text}</ReactMarkdown>;
}

/**
 * 分区卡：同款灰卡——1px 浅描边 + 圆角 + 浅灰底，九类不再各配一色（用户口径：想收成同款灰卡）。
 * 分类只决定两件事：成不成卡、卡头挂哪个 emoji；配色统一由界面基调出，深浅色主题都成立。
 */
function SectionCard({ block }: { block: Extract<MdBlock, { kind: "card" }> }) {
  const emoji = SECTION_EMOJI[block.section];
  const fallback = SECTION_DEFS.find((d) => d.kind === block.section)?.words[0] ?? "";
  // 标题里的 emoji 剥掉再画：卡头左边已经挂了统一的一个，不重复
  const title = stripLeadingEmoji(block.head) || fallback;
  return (
    <section className="rounded-xl border border-border/80 bg-card">
      <header className="flex items-center gap-1.5 rounded-t-xl border-b border-border/60 bg-accent/40 px-2.5 py-1.5">
        <span aria-hidden className="text-[13px] leading-none">{emoji}</span>
        <span className="text-[13px] font-semibold text-foreground">{title}</span>
      </header>
      {block.body && (
        <div className="px-3 py-2"><MdTree text={block.body} /></div>
      )}
    </section>
  );
}

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
  const { intro, blocks } = splitBlocks(content);
  return (
    <div
      className="space-y-2 [&_code]:rounded [&_code]:bg-accent [&_code]:px-1 [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-accent/60 [&_pre]:p-2 [&_strong]:font-semibold [&_strong]:text-foreground [&_tbody_tr]:border-b [&_tbody_tr]:border-border/50 [&_td]:px-1.5 [&_td]:py-1 [&_th]:border-b [&_th]:border-border [&_th]:px-1.5 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-4"
    >
      <DeskLinkCtx.Provider value={ctx}>
        {intro && <MdTree text={intro} />}
        {blocks.map((b, i) => (
          b.kind === "card"
            ? <Fragment key={i}><SectionCard block={b} /></Fragment>
            : <MdTree key={i} text={b.text} />
        ))}
      </DeskLinkCtx.Provider>
    </div>
  );
}
