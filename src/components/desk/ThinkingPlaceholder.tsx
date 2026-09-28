"use client";
// 稳智同款「思考中」占位（对话页 / 右下角随问小窗共用一份）。
//
// 源码实证 aiwuchuan /ai-matrix：
//   · 文案取自 AiMatrixHome C()：深度模式 →「🧠 深度思考中」，其余 →「⚡ 快速分析中」；
//   · 画法取自 .stream-placeholder（14px/1.6 灰字）+ .flow-pulse（1.1s 翻转）+ .flow-wait（opacity .4）。
//
// 本仓语义：assistant 草稿消息一挂上就是「空正文 + streaming」，过去只能看到一个空气泡配一根闪烁光标，
// 看不出模型是在思考还是在取数。这里把「还没有正文」的那一段明确画出来——正文一到就换成真正的
// Markdown + 光标，占位不残留（调用方按 m.streaming && !m.content 决定挂不挂）。
import { useDesk } from "@/lib/desk/store";

export default function ThinkingPlaceholder({ className = "" }: { className?: string }) {
  // 与 composer 的「回答风格」同一份设置：deep → 深度思考中，其余（决策/研判/实时搜索）→ 快速分析中。
  const mode = useDesk((s) => s.assistantMode);
  const deep = mode === "deep";
  return (
    <div className={"stream-placeholder typing " + className} role="status" aria-live="polite" data-thinking-placeholder>
      <span className="flow-pulse" aria-hidden>{deep ? "🧠" : "⚡"}</span>
      {" "}
      {deep ? "深度思考中" : "快速分析中"}
      <span className="flow-wait">…</span>
    </div>
  );
}
