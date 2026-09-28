"use client";
// 研究结论 widget（P18 稳智对齐）。把 AI 按 modes.ts MODE_NOTES.decision 模板吐的
// markdown 精准识别成 11 字段 + 4 证据区块的结构化卡。
//
// 为什么单独成组件：Markdown.tsx 的分区卡把每一小节当普通卡片画，10 个 11 字段各自
// 一张卡就视觉过载——稳智逆向扒到的做法是把 10 个字段合并进**一张 widget**，
// 字段用两列网格 + 字段内的小 emoji 前缀画，证据区块用一张更宽的分区卡挂在下方。
// 前端只做画，抽取规则全在 decision-widget-core（有单测钉口径）。
//
// 渲染纪律：
//  - 字段顺序严格按 DECISION_FIELDS 定义顺序（core_judgement → action）
//  - 字段缺失时不隐藏、不猜——用"暂无"占位（对齐稳智 EMPTY_PLACEHOLDER 语义）
//  - signal 缺失时不硬凑，直接把第一个 core_judgement 顶上来
import type { ParsedDecision } from "@/lib/desk/decision-widget-core";
import { DECISION_FIELDS, EVIDENCE_BLOCKS, EMPTY_PLACEHOLDER } from "@/lib/desk/decision-widget-core";

/** 单字段渲染：emoji + 中文名 + 正文。缺失时用"暂无"占位。 */
function Field({ emoji, zh, body }: { emoji: string; zh: string; body?: string }) {
  const empty = !body || body.trim() === "";
  return (
    <div className="rounded-lg border border-border/60 bg-overlay px-2.5 py-2">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span aria-hidden className="text-[13px] leading-none">{emoji}</span>
        <span className="text-[12.5px] font-medium text-foreground/90">{zh}</span>
      </div>
      {empty ? (
        <div className="text-[13px] italic text-muted-foreground/60">{EMPTY_PLACEHOLDER}</div>
      ) : (
        <div className="whitespace-pre-wrap break-words text-[13.5px] leading-5 text-foreground/95">{body}</div>
      )}
    </div>
  );
}

/** 证据区块渲染：字段更宽、正文支持多行/表格。 */
function EvidenceBlock({ emoji, zh, body }: { emoji: string; zh: string; body?: string }) {
  const empty = !body || body.trim() === "";
  if (empty) return null; // 空区块不画（比空字段更严格，避免视觉噪音）
  return (
    <div className="rounded-lg border border-border/60 bg-overlay px-2.5 py-2">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span aria-hidden className="text-[13px] leading-none">{emoji}</span>
        <span className="text-[12.5px] font-medium text-foreground/90">{zh}</span>
      </div>
      <div className="whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground/90">{body}</div>
    </div>
  );
}

/** 研究结论 widget 主体。parsed 是 decision-widget-core.extractDecision 的返回值。 */
export default function DecisionWidget({ parsed }: { parsed: ParsedDecision }) {
  const signalText = parsed.signal && parsed.signal.trim() ? parsed.signal : parsed.fields.core_judgement;
  const blockEntries = EVIDENCE_BLOCKS.filter((b) => {
    const v = parsed.blocks[b.key];
    return v && v.trim().length > 0;
  });
  return (
    <section className="rounded-xl border border-sky-500/25 bg-sky-500/[0.04] shadow-inner">
      {/* 卡头：🎯 研究结论 + 一句话 signal（稳智 a 常量第一行） */}
      <header className="flex items-center gap-2 rounded-t-xl border-b border-sky-500/20 bg-sky-500/[0.08] px-3 py-2">
        <span aria-hidden className="text-[15px] leading-none">🎯</span>
        <span className="text-[14px] font-semibold text-foreground">研究结论</span>
        {signalText && (
          <span className="ml-1 min-w-0 flex-1 truncate text-[13px] text-foreground/90" title={signalText}>
            {signalText}
          </span>
        )}
      </header>

      {/* 11 字段网格：2 列，第一列 core_judgement 单独占一行（视觉突出） */}
      <div className="p-2.5">
        <Field
          emoji={DECISION_FIELDS[0].emoji}
          zh={DECISION_FIELDS[0].zh}
          body={parsed.fields[DECISION_FIELDS[0].key]}
        />
        <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {DECISION_FIELDS.slice(1).map((d) => (
            <Field key={d.key} emoji={d.emoji} zh={d.zh} body={parsed.fields[d.key]} />
          ))}
        </div>

        {/* 证据区块：4 个横排（有的模型只填 1-2 个，缺失的不画） */}
        {blockEntries.length > 0 && (
          <>
            <div className="mt-2.5 border-t border-sky-500/15 pt-2">
              <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-sky-300/80">
                证据与数据支撑
              </div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {blockEntries.map((b) => (
                  <EvidenceBlock key={b.key} emoji={b.emoji} zh={b.zh} body={parsed.blocks[b.key]} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
