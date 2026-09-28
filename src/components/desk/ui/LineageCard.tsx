"use client";
// P15-R3b 页面血缘卡制·统一组件（《UI-观感审计》L3 项落地）。
//
// 口径来源：稳智回答卡的结构（analysis-layout → analysis-heading + analysis-section*）——
// 一件事一张卡，卡内按血缘分小节，小节间渐变细线，小节标题带 tone 色点（判断=蓝/正面=绿/警示=橙/风险=红）。
// 这里抽的是「结构同款」，不是像素复刻：对方 18px 大标题是给阅读流回答页的，我们页面卡尺度小一档。
//
// 纪律：
// - 全仓库卡片只认这一份实现——页面里再 local 定义同名组件 = 从这一刻起会漂（测试钉住）；
// - 「一卡一焦点数字」的 StatCard 是 L1 观感轮口牌的组件化：label 小、数字大、口径进 title，
//   缺数照旧走「暂无数据/—」，这里不发明兜底值。
import { useState } from "react";

export type SectionTone = "info" | "success" | "warning" | "danger";

const TONE_DOT: Record<SectionTone, string> = {
  info: "bg-sky-400/70",
  success: "bg-emerald-400/70",
  warning: "bg-amber-400/70",
  danger: "bg-red-400/70",
};

/** 一张血缘卡：顶部标题行（可带动作区），下方按顺序摆 LineageSection / 任意内容 */
export function LineageCard(props: {
  title: React.ReactNode;
  /** 标题下的小字口径行（出身/统计窗这种），长注释请进 title 属性不要占版面 */
  note?: React.ReactNode;
  /** 右侧动作区（刷新、Tab、日期这种），有它标题行才是「控制面板」 */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={"apple-card apple-fade-in overflow-hidden " + (props.className ?? "p-5")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[16px] font-semibold tracking-tight">{props.title}</div>
          {props.note && <div className="mt-1 text-[12.5px] leading-5 text-muted-foreground">{props.note}</div>}
        </div>
        {props.actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div>}
      </div>
      {props.children}
    </div>
  );
}

/** 卡内小节：tone 色点 + 标题 + 可折叠；小节之间渐变细线（对方 section 分隔线的同款结构） */
export function LineageSection(props: {
  title: React.ReactNode;
  tone?: SectionTone;
  /** 小节标题右侧的轻说明（如「全A快照」） */
  hint?: React.ReactNode;
  /** 标题行右侧动作（刷新按钮等） */
  actions?: React.ReactNode;
  /** 给折叠按钮（默认展开；不传就一直展开） */
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
  /** 首节不需要分隔线时传 false */
  divided?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  const tone = props.tone ?? "info";
  return (
    <section className={props.divided === false ? "pt-4" : "mt-4"} aria-label={typeof props.title === "string" ? props.title : undefined}>
      <div className={props.divided === false ? "" : "mb-3 h-px bg-gradient-to-r from-transparent via-border to-transparent"} />
      <div className="flex flex-wrap items-center gap-2">
        <span className={"h-2 w-2 shrink-0 rounded-full " + TONE_DOT[tone]} aria-hidden />
        <h3 className="text-[14.5px] font-semibold">{props.title}</h3>
        {props.hint && <span className="text-[12px] text-muted-foreground">{props.hint}</span>}
        {props.collapsible && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="ml-auto rounded-md px-2 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-overlay-strong hover:text-foreground"
            aria-expanded={open}
          >
            {open ? "收起" : "展开"}
          </button>
        )}
        {!props.collapsible && props.actions && <span className="ml-auto flex items-center gap-2">{props.actions}</span>}
      </div>
      {(!props.collapsible || open) && <div className="mt-2.5">{props.children}</div>}
    </section>
  );
}

/** 一焦点数字小卡（L1 口径的组件化）：label 小、数字大、口径进 title */
export function StatCard(props: {
  label: React.ReactNode;
  value: React.ReactNode;
  /** 数字着色类（text-red-400 这种）；缺数态请传 text-muted-foreground */
  toneClass?: string;
  /** 口径/出身说明进 tooltip，不占版面（L2 说明收声） */
  title?: string;
  foot?: React.ReactNode;
}) {
  return (
    <div className="apple-card px-3.5 py-3" title={props.title}>
      <div className="text-[12px] text-muted-foreground">{props.label}</div>
      <div className={"mt-1 font-mono text-lg font-semibold " + (props.toneClass ?? "")}>{props.value}</div>
      {props.foot && <div className="mt-1 text-[11.5px] text-muted-foreground/80">{props.foot}</div>}
    </div>
  );
}
