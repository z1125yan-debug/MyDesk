"use client";
// P7-⑥⑥ 场景徽章：把「这一轮系统替你判成了什么场景、为什么、取了哪些数、什么没取」摊开写。
//
// 为什么要单独做：自动调度最大的风险不是取错数，而是**看不出来它按哪个口径答的**。
// 服务端已经判好了（intent-core），徽章字段也穿过 SSE 与非流式两条出口（chat-core.IntentBadge），
// 这里只负责如实展示，不在界面上二次判定 —— 界面自己再判一次就会出现「徽章说 A、提示词是 B」。
//
// 诚实约束：
//  - 没有徽章（服务端没判：非对话请求、或场景层降级）就整块不画，绝不画一个「通用问答」占位；
//  - 命中的场景词是判定层给的，界面只列不改写；
//  - skipped（本轮没取的项与原因）必须显示，「没取」和「取到空」是两件事。
import { Sparkles } from "lucide-react";
import type { IntentBadge } from "@/lib/desk/chat-core";
import { SCENE_LABELS, symbolSourceText } from "@/lib/desk/intent-core";

function sceneName(scene: string): string {
  return (SCENE_LABELS as Record<string, string>)[scene] ?? scene;
}

/**
 * 标的来源的说法来自判定层（symbolSourceText），这里只做两件界外事：
 * 认不出的来源写「来源未标注」而不是硬套一个说法 —— 徽章是从服务端解出来的，键可能整段没有。
 */
const KNOWN_SOURCES = ["question", "session", "focus", "name", "none"] as const;

function sourceNote(source: string): string {
  return (KNOWN_SOURCES as readonly string[]).includes(source)
    ? symbolSourceText(source as (typeof KNOWN_SOURCES)[number])
    : "来源未标注";
}

export default function SceneBadge({ intent }: { intent?: IntentBadge | null }) {
  if (!intent) return null;
  const hits = intent.hits ?? [];
  const alternates = intent.alternates ?? [];
  const skipped = intent.skipped ?? [];
  const chars = intent.prefetchChars ?? 0;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] leading-4 text-muted-foreground">
      <span className="inline-flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-sky-300">
        <Sparkles size={10} />
        场景 · {intent.label || sceneName(intent.scene)}
      </span>
      {!!hits.length && <span title="判定命中的词">依据：{hits.join("、")}</span>}
      {intent.inherited && <span title="本轮没有出现新场景词，沿用了上一轮判到的场景">沿用上一轮场景</span>}
      {intent.followUp && <span title="这句是接着上文问的（省略了主语或股票）">按追问处理</span>}
      {intent.symbol && (
        <span>
          股票 <span className="font-mono text-sky-300">{intent.symbol}</span>
          <span className="text-muted-foreground/80">（{sourceNote(intent.symbolSource)}）</span>
        </span>
      )}
      {!!alternates.length && (
        <span title="这句话里还问到别的场景，系统没有预先取数，需要时由模型自己调工具">
          还问到：{alternates.map((s) => sceneName(s)).join("、")}（未预取）
        </span>
      )}
      {chars > 0
        ? <span title="系统按场景自动取到并注入模型的真实数据字数">{`自动取数 ${chars} 字`}</span>
        : <span title="本轮没有注入自动取到的真实数据（判成通用问答、或该场景本来不取数）">本轮未注入自动取数</span>}
      {!!skipped.length && (
        <span className="w-full rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-amber-200">
          未取：{skipped.join("；")}
        </span>
      )}
    </div>
  );
}
