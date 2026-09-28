"use client";
import { createContext, useContext, Fragment, type ReactNode } from "react";
import { cloneElement, isValidElement, Children } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitByLinks, type DeskLink, type LinkSegment, type SectorRef } from "@/lib/desk/link-core";
import { splitBlocks, stripLeadingEmoji, SECTION_EMOJI, SECTION_DEFS, type MdBlock } from "@/lib/desk/markdown-sections-core";
import { extractDecision } from "@/lib/desk/decision-widget-core";
import DecisionWidget from "./DecisionWidget";

// 聊天气泡内的 Markdown 渲染（P7-⑤③ 结构化 → P15 对齐稳智「分区卡」→ P61 对齐稳智正文度量 → P62 正文去框）。
//
// P62（2026-09-27 用户拿稳智截图对比后定的口径：「完全照稳智：正文彻底去框」）：
//  - 稳智的正文本来就是**裸排**的：段落、列表、引用都没有框，只有表格卡、执行条、输入卡才描边。
//    P61 那版给每一段散段套一张 .wz-block、给每个小节套一张灰卡，结果三层框叠在一起，
//    看起来是「报表页」而不是「一句话 + 一段回答」。这里全部拆掉：p/ul/ol/blockquote 直接出标签、
//    小节标题只是正文流里一行加粗字（emoji + 标题），框只留在 .wz-table-card 上。
//  - 阅读宽度收成居中窄栏（.wz-col，880px），由挂类名的页面负责，不在这里画。
//  - 分类与切块规则仍在纯核 markdown-sections-core（有单测），这里只管画。
//
// P61 留下的度量口径不变（来源：稳智 ai-matrix-content-DW5S8amy.css 实测）：正文 16px/1.82 + 数字等宽、
// 标题 22/19/17 且字重 650、表格 15px/1.65 格内 11x16、段间 20px、条间 10px、代码块 14px 圆角。
// 度量本体全在 globals.css 的 .wz-md / .wz-h / .wz-table 段里（一处定义），这个文件不写任何字号。
//
// P7-⑧② 保留：正文里的 6 位代码与「已知清单内的板块名」渲染成可点片段。三条渲染约束不变：
//  - 不引新依赖、不改文案：切分保证拼回去逐字等于原文，链接不吞字不改字；
//  - code / pre / a 里不做二次识别；小节标题里不放链接（标题是「这块讲什么」，塞按钮会画歪）。

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
/** 列表：稳智的 ul/ol 就是裸列表 + 1.55em 缩进，不画框（度量在 globals.css 的 .wz-md ul/ol） */
function MdUl({ children }: { children?: ReactNode }) {
  return <ul>{children}</ul>;
}
function MdOl({ children }: { children?: ReactNode }) {
  return <ol>{children}</ol>;
}
function MdTd({ children }: { children?: ReactNode }) {
  return <td><Linked>{children}</Linked></td>;
}
function MdTh({ children }: { children?: ReactNode }) {
  return <th><Linked>{children}</Linked></th>;
}
function MdH1({ children }: { children?: ReactNode }) {
  return <h1 className="wz-h wz-h1"><Linked>{children}</Linked></h1>;
}
function MdBlockquote({ children }: { children?: ReactNode }) {
  return <blockquote><Linked>{children}</Linked></blockquote>;
}

/**
 * 没被切成段的 ##/### 标题（分类认不出的）：与卡头走同一行画法（wz-h），只是字号小一档。
 * P15 起 ModuleHeading 退役；P62 起「卡」这个概念也退役了——标题就是正文里的一行加粗字。
 */
function PlainHeading({ level, children }: { level: 2 | 3; children: ReactNode }) {
  const Tag = level === 2 ? "h2" : "h3";
  return <Tag className={"wz-h " + (level === 2 ? "wz-h2" : "wz-h3")}><Linked>{children}</Linked></Tag>;
}

const COMPONENTS: Components = {
  h1: MdH1,
  h2: ({ children }) => <PlainHeading level={2}>{children}</PlainHeading>,
  h3: ({ children }) => <PlainHeading level={3}>{children}</PlainHeading>,
  p: MdP,
  li: MdLi,
  ul: MdUl,
  ol: MdOl,
  // 表格里最容易整格都是代码：逐格换，不整表换（表头/结构节点不动）
  td: MdTd,
  th: MdTh,
  // 表格是稳智少数「该有框」的地方：外面一张圆角卡（.wz-table-card），卡内再包一层横向滚动，不裁数据
  table: ({ children }) => (
    <div className="wz-table-card desk-scroll -mx-1 overflow-x-auto">
      <table className="wz-table">{children}</table>
    </div>
  ),
  // 引用块常被模型用来放「系统提示 / 口径说明」，按提示条处理（左竖条 + 弱色，不画框）
  blockquote: MdBlockquote,
  hr: () => <hr />,
  a: ({ children, href }) => <ExternalLink href={href}>{children}</ExternalLink>,
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
};

/** 一段 markdown 走同一套组件渲染（intro/plain 块/卡体共用，保证两处画法不漂） */
function MdTree({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{text}</ReactMarkdown>;
}

/**
 * 分区小节（P62：正文彻底去框）。
 * 之前这里是「同款灰卡 + 卡头色带」，卡头那一横条把标题和正文隔成了两层，读起来像报表页。
 * 稳智的画法没有这层壳：小节标题就是正文流里一行加粗字（emoji + 标题），下面直接跟裸正文。
 * 所以这里只输出一个 h2 + 正文本身，两者都是 .wz-md 的直接子节点，块间距由 globals.css 一处决定。
 * 分类仍然只决定两件事：挂哪个 emoji、这一节要不要抬成标题（认不出的按普通标题渲染，不硬凑）。
 */
function SectionCard({ block }: { block: Extract<MdBlock, { kind: "card" }> }) {
  const emoji = SECTION_EMOJI[block.section];
  const fallback = SECTION_DEFS.find((d) => d.kind === block.section)?.words[0] ?? "";
  // 标题里的 emoji 剥掉再画：前面已经统一挂了一个，不重复
  const title = stripLeadingEmoji(block.head) || fallback;
  return (
    <>
      <h2 className="wz-h wz-h2">
        {emoji && <span aria-hidden>{emoji} </span>}
        {title}
      </h2>
      {block.body && <MdTree text={block.body} />}
    </>
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
  // P18 稳智对齐：先尝试抽取 11 字段决策结构，命中就**只**走 DecisionWidget 渲染——
  // widget 已经把 10 个字段合并成一张结构化卡 + 4 证据区块，视觉密度比"每小节一张卡"高得多。
  // 命中决策后不再走 splitBlocks 分区卡路径（否则 10 个 11 字段会各画一张卡，视觉过载）。
  // 没命中（研判/深度/搜索模式，或模型没照模板吐）就走原来的分区卡路径。
  const decision = extractDecision(content);
  const { intro, blocks } = decision ? { intro: "", blocks: [] as MdBlock[] } : splitBlocks(content);
  return (
    <div className="wz-md">
      <DeskLinkCtx.Provider value={ctx}>
        {decision && <DecisionWidget parsed={decision} />}
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
