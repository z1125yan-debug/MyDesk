"use client";
// P6-B 事件理解层的前端呈现：一条已落库解释 = 一个可回溯链。
//
// 页面在这里不重新判断任何事：字段归属（哪些是事实、哪些是 AI 解释、哪些是服务端派生）来自内核的
// FACT_FIELDS / AI_FIELDS / DERIVED_FIELDS，回溯文本来自 renderInterpretationTrace。
// 之所以把解释按「事件」挂起来显示，是 §十 的要求：看的人必须能一眼回到「原始事件 → AI 提取 → AI 解释」。
import {
  AI_EXTRA_FIELDS, AI_FIELDS, DERIVED_FIELDS, FACT_FIELDS, STATUS_TEXT,
  renderInterpretationTrace, type EventInterpretation,
} from "@/lib/quant/screener/event-interpret-core";
import type { InterpretationViewClient } from "@/lib/desk/quant-api";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
// P15-R15：提示词版本号是显示读法，原文常量不动（p6-b-* 钉在字段值上，不是页面文本）。
import { promptVerZh } from "@/lib/desk/plain-core";

const TONE: Record<string, string> = {
  利好: "border-red-500/40 text-red-300",
  利空: "border-emerald-500/40 text-emerald-300",
  双向: "border-amber-500/40 text-amber-300",
  中性: "border-border text-muted-foreground",
  未知: "border-border text-muted-foreground",
};

const chip = "rounded border px-1.5 py-0.5 text-[10px]";

/** 置信度只按「AI 对自己这套解释的把握」来读，永远不写成上涨概率（§九 原文口径） */
export function confidenceText(c: number | null): string {
  if (c === null) return "置信度：未给出（模型没填，服务端不替它补）";
  const pct = Math.round(c * 100);
  const band = c >= 0.7 ? "较高" : c >= 0.4 ? "中等" : "偏低";
  return `解释置信度 ${pct}%（${band}）——这是 AI 对自己这套解释的把握度，不是股票上涨概率`;
}

function Kv({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return <div className="mt-1 text-[11px]"><b className="text-muted-foreground">{label}：</b>{value}</div>;
}

export function InterpretationCard({ itp }: { itp: EventInterpretation & Partial<InterpretationViewClient> }) {
  const trace = renderInterpretationTrace(itp as EventInterpretation);
  const dropped = itp.dropped;
  const nDropped = (dropped?.evidence?.length ?? 0) + (dropped?.symbols?.length ?? 0)
    + (dropped?.probability_claims?.length ?? 0) + (dropped?.fields?.length ?? 0);
  return (
    <div className="mt-2 rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/[0.04] px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${chip} border-fuchsia-500/40 text-fuchsia-300`}>AI 理解 · {STATUS_TEXT[itp.interpretation_status]}</span>
        <span className={`${chip} ${TONE[itp.impact_direction] ?? TONE.未知}`}>{itp.impact_direction}</span>
        <span className={`${chip} border-border text-muted-foreground`}>范围 {itp.impact_scope}</span>
        <span className={`${chip} border-border text-muted-foreground`}>重要性 {itp.importance}</span>
        {itp.stale && <span className={`${chip} border-amber-500/40 text-amber-300`}>事件已更新：解释过时</span>}
        {itp.orphan && <span className={`${chip} border-amber-500/40 text-amber-300`}>原事件行已不在当天库中：只剩解释快照</span>}
        <span className="ml-auto text-[10px] text-muted-foreground">{itp.model || "模型未记录"} · {promptVerZh(itp.prompt_version)}</span>
      </div>

      <div className="mt-1.5 text-[11.5px] leading-relaxed">{itp.summary || "（模型未给出摘要，本条已被判为无摘要）"}</div>
      <div className="mt-1 text-[10.5px] text-muted-foreground">{confidenceText(itp.confidence)}</div>

      <Kv label="AI 实体" value={itp.entities.join("、")} />
      <Kv label="AI 行业/主题" value={[...itp.industries, ...itp.themes].join("、")} />
      <Kv label="AI 认为相关（标题或既有映射里有出处）" value={itp.affected_symbols.join("、")} />
      {!!itp.hypothesized_symbols?.length && (
        <div className="mt-1 text-[11px] text-amber-300/90">
          <b>AI 假设标的（无出处，未验证）：</b>{itp.hypothesized_symbols.join("、")}
          <span className="text-muted-foreground"> —— 这是 AI 猜的（假设层），不是「已确认相关」</span>
        </div>
      )}
      <Kv label="仍需验证" value={itp.unknowns.join("；")} />
      <Kv label="下一步该查" value={itp.follow_up_queries.join("；")} />
      {!!(itp.violations?.length || nDropped) && (
        <div className="mt-1 text-[10.5px] text-amber-300/90">
          校验留痕：违规 {itp.violations?.length ?? 0} 条 · 被降级/剔除 {nDropped} 处（原文在下方回溯里，未静默删除）
        </div>
      )}

      <DeskCollapse
        className="mt-1.5"
        title="展开完整回溯链（原始事件 → AI 提取 → AI 解释 → 状态分层）"
        triggerClassName="text-[10.5px] text-muted-foreground hover:text-foreground"
        contentClassName="text-[10.5px] text-muted-foreground"
      >
        <pre className="whitespace-pre-wrap break-words rounded border border-border/60 bg-background/60 p-2 text-[10.5px] leading-relaxed">{trace}</pre>
        <div className="mt-1 text-[10px] text-muted-foreground/80">
          字段归属（内核唯一出处，页面不自己判）：事实 {FACT_FIELDS.join("/")} ｜
          AI 解释 {AI_FIELDS.join("/")}
          {AI_EXTRA_FIELDS.length ? ` + ${AI_EXTRA_FIELDS.join("/")}` : ""} ｜
          服务端派生 {DERIVED_FIELDS.join("/")}
        </div>
      </DeskCollapse>
    </div>
  );
}

/** 事件行与解释的对应：优先用服务端给的当前行 id（row_id），行已重扫时退回「标题+时间」原文匹配 */
export function interpretKey(itp: InterpretationViewClient): string {
  return itp.row_id || `${itp.title}|${itp.published_at}`;
}
