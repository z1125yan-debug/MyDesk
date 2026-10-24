// AI优选决策卡 · 11 字段分格卡片（docs/参考平台能力清单.md §七.2）
//
// 每只 AI优选的票一张卡，11 个字段各一格；数据来自 symbolsNote 解析回的
// AiPickNoteCard（parseAiPickNote），缺的字段显示「未取到」，不编。
// 解析不出卡（旧格式 note）时返回 null，调用方保留原文本展示。

import { AI_PICK_CARD_FIELDS, AI_PICK_MISSING_LABEL, parseAiPickNote } from "@/lib/quant/strategy/ai-pick-note";

export default function AiPickDecisionCards({ note }: { note: string | null }) {
  const cards = parseAiPickNote(note);
  if (!cards.length) return null;
  return (
    <div className="mt-2 space-y-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[12.5px] font-semibold">AI 优选决策卡（11 字段）</span>
        <span className="text-[11px] text-muted-foreground">缺的字段显示「{AI_PICK_MISSING_LABEL}」，不编</span>
      </div>
      {cards.map((c) => (
        <div key={c.symbol} className="rounded-lg border border-border/70 bg-card p-3">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-[13.5px] font-semibold">{c.symbol}</span>
            {c.name && <span className="text-[13px] font-medium">{c.name}</span>}
          </div>
          {c.reason && (
            <div className="mb-1 text-[12.5px] leading-relaxed">
              <span className="text-muted-foreground">入选理由：</span>{c.reason}
            </div>
          )}
          {c.entryCondition && (
            <div className="mb-1 text-[12.5px] leading-relaxed">
              <span className="text-muted-foreground">入场条件：</span>{c.entryCondition}
            </div>
          )}
          {c.mainRisk && (
            <div className="mb-2 text-[12.5px] leading-relaxed">
              <span className="text-muted-foreground">主要风险：</span>{c.mainRisk}
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {AI_PICK_CARD_FIELDS.map((f) => {
              const v = c[f.key];
              return (
                <div key={f.key} className="rounded-md border border-border/50 bg-muted/30 p-2">
                  <div className="mb-0.5 text-[11.5px] font-medium text-muted-foreground">
                    {f.icon} {f.label}
                  </div>
                  <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed">
                    {v ?? <span className="text-muted-foreground">{AI_PICK_MISSING_LABEL}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
