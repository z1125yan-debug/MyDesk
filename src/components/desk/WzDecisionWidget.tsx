"use client";
// P19 稳智对齐 · 决策信号 widget
//
// 把 LLM 意图识别器判出的 11 字段 WzDecisionPayload 渲染成稳智风格的决策卡。
// 组件纪律：
//   - 字段为 null/空数组的一律不画（不写"未提供"这种废话）；
//   - 数值一律带单位（/100、%、元）；
//   - stance 用固定色：偏多=emerald / 偏空=red / 观望=amber / 无观点=muted；
//   - 只吃这一份数据契约，不与 intent 徽章共用字段——场景是"回答走哪条路"、决策信号是"结论"。
//
// 组件只画不判：stance/horizon/signalType 的中文标签在这里做（前端展示层），
// 服务端的白名单与 clamp 已在 chat-stream-core.asWzDecision 走完；
// 这里再算一次标签只是本地映射，不做二次判定。
import type { WzDecisionPayload } from "@/lib/desk/chat-core";

// ---------- 前端本地标签表（与 intent-llm-core 保持字面一致，避免二次判定漂移） ----------
const STANCE_META: Record<WzDecisionPayload["stance"], { label: string; tone: string; emoji: string }> = {
  long: { label: "偏多", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", emoji: "📈" },
  short: { label: "偏空", tone: "border-red-500/30 bg-red-500/10 text-red-300", emoji: "📉" },
  wait: { label: "观望", tone: "border-amber-500/30 bg-amber-500/10 text-amber-300", emoji: "⏸" },
  neutral: { label: "无观点", tone: "border-border/60 bg-overlay text-muted-foreground", emoji: "·" },
};

const HORIZON_LABELS: Record<NonNullable<WzDecisionPayload["horizon"]>, string> = {
  ultra_short: "超短",
  short: "短线",
  short_mid: "短中线",
  mid: "中线",
  long: "长线",
};

const SIGNAL_LABELS: Record<NonNullable<WzDecisionPayload["signalType"]>, string> = {
  trend_breakout: "趋势突破",
  pullback_rebound: "回调反抽",
  range_bound: "区间震荡",
  volume_surge: "放量异动",
  divergence_risk: "背离风险",
  stop_loss_hit: "止损触发",
  stop_profit_hit: "止盈触发",
  capital_inflow: "资金流入",
  capital_outflow: "资金流出",
  event_driven: "事件驱动",
  sector_rotation: "板块轮动",
  no_signal: "无明确信号",
};

// ---------- 小数格式：价格是保留 2 位，0/100 类整数直接原样 ----------
const fmt = (n: number, digits = 2): string => {
  const s = Number.isFinite(n) ? n.toFixed(digits) : "—";
  // 去掉尾随的 .00（"12.00" → "12"），保留 12.34 不变
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
};

export default function WzDecisionWidget({ signal }: { signal: WzDecisionPayload }) {
  const stance = STANCE_META[signal.stance] ?? STANCE_META.neutral;

  // 有内容才画整卡：stance 为 neutral 且其余字段全空 → 组件返回 null（等价于服务端 hasAnything=false）
  const keyLevelsPresent = (signal.keyLevels.support?.length ?? 0) > 0 || (signal.keyLevels.resistance?.length ?? 0) > 0;
  const stopPlanPresent = signal.stopPlan.stopLoss != null || signal.stopPlan.takeProfit != null;
  const hasRichContent =
    signal.stance !== "neutral" || signal.horizon != null || signal.signalType != null ||
    signal.confidence != null || signal.sentimentTemp != null || signal.positionPct != null ||
    signal.invalidation != null || signal.riskNotes.length > 0 || signal.dataGaps.length > 0 ||
    keyLevelsPresent || stopPlanPresent;
  if (!hasRichContent) return null;

  // 顶部标签行：主结论 + 交易周期 + 信号类型（有则画）
  const tags: { label: string; tone: string; emoji?: string }[] = [];
  tags.push({ label: stance.label, tone: stance.tone, emoji: stance.emoji });
  if (signal.horizon) tags.push({ label: HORIZON_LABELS[signal.horizon], tone: "border-sky-500/30 bg-sky-500/10 text-sky-300" });
  if (signal.signalType) tags.push({ label: SIGNAL_LABELS[signal.signalType], tone: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300" });

  // 数值指标行：置信度 / 情绪温度 / 建议仓位
  const metrics: { label: string; value: string; hint?: string }[] = [];
  if (signal.confidence != null) metrics.push({ label: "置信度", value: `${signal.confidence}/100` });
  if (signal.sentimentTemp != null) metrics.push({ label: "情绪温度", value: `${signal.sentimentTemp}/100` });
  if (signal.positionPct != null) metrics.push({ label: "建议仓位", value: `${signal.positionPct}%` });

  return (
    <div className="mt-2 rounded-xl border border-border/60 bg-overlay/40 p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-muted-foreground/70">决策信号</span>
        <span className="text-[11px] text-muted-foreground/60">（规则单独抽取，可能与上方 AI 正文结论不一致，仅供参考）</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t, i) => (
            <span key={i} className={"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12px] font-medium " + t.tone}>
              {t.emoji ? <span>{t.emoji}</span> : null}
              {t.label}
            </span>
          ))}
        </div>
      </div>

      {/* 数值指标行：等宽卡片，缺字段直接不占位 */}
      {metrics.length > 0 && (
        <div className="mb-1.5 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}>
          {metrics.map((m, i) => (
            <div key={i} className="rounded-md border border-border/50 bg-card/50 px-2 py-1">
              <div className="text-[10.5px] text-muted-foreground/70">{m.label}</div>
              <div className="font-mono text-[14px] font-semibold text-foreground">{m.value}</div>
              {m.hint ? <div className="text-[10.5px] text-muted-foreground/60">{m.hint}</div> : null}
            </div>
          ))}
        </div>
      )}

      {/* 关键价位 & 止盈止损 */}
      {(keyLevelsPresent || stopPlanPresent) && (
        <div className="mb-1.5 flex flex-wrap gap-2 text-[12px]">
          {signal.keyLevels.support && signal.keyLevels.support.length > 0 && (
            <span className="text-muted-foreground">
              <span className="text-emerald-300">支撑</span>{" "}
              <span className="font-mono">{signal.keyLevels.support.map((n) => fmt(n)).join(" / ")}</span>
            </span>
          )}
          {signal.keyLevels.resistance && signal.keyLevels.resistance.length > 0 && (
            <span className="text-muted-foreground">
              <span className="text-red-300">压力</span>{" "}
              <span className="font-mono">{signal.keyLevels.resistance.map((n) => fmt(n)).join(" / ")}</span>
            </span>
          )}
          {signal.stopPlan.stopLoss != null && (
            <span className="text-muted-foreground">
              <span className="text-red-300">止损</span>{" "}
              <span className="font-mono">{fmt(signal.stopPlan.stopLoss)}</span>
            </span>
          )}
          {signal.stopPlan.takeProfit != null && (
            <span className="text-muted-foreground">
              <span className="text-emerald-300">止盈</span>{" "}
              <span className="font-mono">{fmt(signal.stopPlan.takeProfit)}</span>
            </span>
          )}
        </div>
      )}

      {/* 失效条件：一段自然语言，用引号样式突出 */}
      {signal.invalidation && (
        <div className="mb-1.5 rounded-md border border-amber-500/25 bg-amber-500/5 px-2 py-1 text-[12px] leading-4 text-amber-200">
          <span className="mr-1 text-[11px] text-amber-300/80">⚠ 失效条件</span>
          {signal.invalidation}
        </div>
      )}

      {/* 风险提示列表 */}
      {signal.riskNotes.length > 0 && (
        <div className="mb-1.5 text-[12px] leading-4">
          <div className="mb-0.5 text-[11px] text-muted-foreground/80">⚠ 风险提示</div>
          <ul className="space-y-0.5 pl-1">
            {signal.riskNotes.map((r, i) => (
              <li key={i} className="text-muted-foreground/90">· {r}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 数据缺口 */}
      {signal.dataGaps.length > 0 && (
        <div className="text-[12px] leading-4">
          <div className="mb-0.5 text-[11px] text-muted-foreground/80">⌗ 数据缺口</div>
          <ul className="space-y-0.5 pl-1">
            {signal.dataGaps.map((g, i) => (
              <li key={i} className="text-muted-foreground/80">· {g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
