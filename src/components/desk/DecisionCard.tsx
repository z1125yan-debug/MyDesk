"use client";
// P7-④ 结论卡：把 buildDecision 的四维结果原样摊开给使用者看。
//
// 这张卡片的渲染纪律（和内核一样重要，改样式前先读完）：
// 1) **points=null 与 points=0 必须长得不一样**。「算不出」显示成「—／算不出」并保留原因，
//    「0 分」显示成 0 并写明是按表归入 0 分档。把它们混在一起就等于把「没读到消息」说成「消息面中性」。
// 2) **综合得分不显示百分号**。得分是规则加权的结果，写成 72% 会被读成「明天有 72% 的概率」，
//    而概率要看得懂口径（引擎/期限/样本/区间）才有意义 —— 需要时看概率面那一维的原始读数。
// 3) **每一路来源单独标状态与所属日**。取数失败的那一路显示「本次未取到」，不渲染成 0，也不留空白。
// 4) **缺维度就说缺**：被剔除的维度、重归一后的实际权重、接线层的口径声明都要出现在卡面上，
//    所以同一个字面结论在「四维齐全」与「只有技术面」时看起来明显不同，这是刻意的。
// 5) **字面分 ≠ 加权分**（v3）：维度卡上显示的是折算分，旁边必须跟着「字面 xx」与本维极值，
//    否则读者拿页面上的 +63 去对任何一张打分表都对不上。`role="basis"` 的旧表分项虚线框显示、
//    标「依据」并写明它在自己那张表里的字面分，视觉上就不与计分项混在一起。
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { SourceBadge } from "./SourceBadge";
import { fetchDecisionView } from "@/lib/desk/quant-api";
import { DIMENSION_LABEL, decisionSections, type Decision, type DimensionResult, type ScoreItem } from "@/lib/quant/screener/decision-core";
import { DATA_STATUS_TEXT } from "@/lib/quant/screener/datastatus-core";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
import { plainify, statusShortZh, verTail, verZh } from "@/lib/desk/plain-core";
import type { DecisionView } from "@/lib/quant/screener/decision-wiring-core";

/**
 * 六档趋势等级的着色（P7-⑦ 任务书的档位名）：红涨绿跌，中性档不抢眼。
 * 档位名以内核产出的字符串为键 —— 内核改了档位名，这里立刻缺键变灰，而不是一直显示旧配色。
 */
const GRADE_TONE: Record<string, string> = {
  强势看多: "text-red-500", 偏强看多: "text-red-400", 震荡偏强: "text-orange-400",
  中性震荡: "text-foreground/80", 偏弱: "text-emerald-400", 弱势看空: "text-emerald-500",
};

const fmtSigned = (x: number) => `${x > 0 ? "+" : ""}${Math.round(x * 10) / 10}`;
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** 得分的着色沿用红涨绿跌：正分偏红、负分偏绿、0 与算不出不抢眼 */
const scoreTone = (p: number | null) => (p === null ? "text-muted-foreground" : p > 0 ? "text-red-500" : p < 0 ? "text-emerald-500" : "text-muted-foreground");

export default function DecisionCard({ symbol }: { symbol: string }) {
  const [view, setView] = useState<DecisionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      setView(await fetchDecisionView(symbol));
    } catch (e) {
      setError(String((e as Error).message || e));
      setView(null);
    } finally {
      setBusy(false);
    }
  }, [symbol]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold">🧭 四维决策结论（技术 / 概率 / 市场 / 事件）</div>
        <span className="text-[10px] text-muted-foreground">只读取数，不写库、不触发扫描、不调模型</span>
        <div className="ml-auto flex items-center gap-2">
          {view && (
            <SourceBadge
              status={view.decision.excluded.length > 0 ? "DEGRADED 部分维度未计入" : "DERIVED"}
              source={`结论口径 ${verTail(view.decision.protocol_version)}`}
              time={view.as_of.slice(11, 19)}
            />
          )}
          <button onClick={() => void load()} disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 重新取数
          </button>
        </div>
      </div>

      {busy && !view && (
        <div className="px-1 py-6 text-center text-[11.5px] text-muted-foreground">
          正在取日K / 全A快照 / 板块主线 / 事件解读四路数据（一次结论同源只取一遍，通常需要几秒到几十秒）…
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11.5px] text-amber-300">
          本次未取到决策结论：{error}
          <div className="mt-0.5 text-[10.5px] text-muted-foreground">这一块不留假数据也不给默认结论；重取或换一只股票再试。</div>
        </div>
      )}
      {view && <CardBody view={view} />}
    </div>
  );
}

function CardBody({ view }: { view: DecisionView }) {
  const d = view.decision;
  const w = view.wiring;
  const sec = decisionSections(d);
  return (
    <div className="space-y-3">
      {/* 结论行 */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        {d.final_score === null ? (
          <div className="text-lg font-bold text-muted-foreground">本次不给综合分</div>
        ) : (
          <div className="flex items-end gap-2">
            <span className={`text-3xl font-bold leading-none ${scoreTone(d.final_score)}`}>{fmtSigned(d.final_score)}</span>
            <span className="text-[11px] text-muted-foreground">综合评分（−100~+100 折算刻度，不是百分率）</span>
          </div>
        )}
        {d.grade && <span className={`text-xl font-bold ${GRADE_TONE[d.grade] ?? ""}`}>{d.grade}</span>}
        {d.final_score !== null && (
          <span className="text-[10.5px] text-muted-foreground">
            本次生效权重下的可达区间 {d.attainable.min} ~ {d.attainable.max}
            {d.attainable.unreachable_grades.length > 0 && <span className="text-amber-400">（打不出：{d.attainable.unreachable_grades.join("、")}）</span>}
          </span>
        )}
      </div>
      <div className="text-[12.5px] leading-relaxed">{d.statement}</div>

      {/* 三段式的后两段：主要判断依据 / 核心风险点（与 AI 上下文共用同一份 decisionSections） */}
      <div className="grid gap-2 lg:grid-cols-2">
        <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2">
          <div className="text-[11px] font-medium text-muted-foreground">② 主要判断依据（参与加权的分项与折算记账）</div>
          <ul className="mt-1 space-y-0.5 text-[11.5px]">
            {sec.basis.map((b, i) => <li key={i}>· {plainify(b)}</li>)}
          </ul>
        </div>
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
          <div className="text-[11px] font-medium text-amber-300/90">③ 核心风险点（反向分项、缺口与未计入的维度）</div>
          <ul className="mt-1 space-y-0.5 text-[11.5px]">
            {sec.risk.map((r, i) => <li key={i}>· {plainify(r)}</li>)}
          </ul>
        </div>
      </div>

      {/* 四维 */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {d.dimensions.map((dim) => <DimHeader key={dim.key} dim={dim} />)}
      </div>

      {d.conflict && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11.5px] text-amber-200">
          <b>多维分歧</b>：{d.conflict.statement}
        </div>
      )}

      {d.excluded.length > 0 && (
        <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2">
          <div className="text-[11px] font-medium text-muted-foreground">没有计入加权的部分（缺的那一维权重已从分母拿掉，不是按 0 分平均）</div>
          <ul className="mt-1 space-y-0.5 text-[11px]">
            {d.excluded.map((e) => <li key={e.key}>· <b>{DIMENSION_LABEL[e.key]}</b>：{plainify(e.reason)}</li>)}
          </ul>
        </div>
      )}

      {/* 分项明细 */}
      <div className="space-y-2">
        {d.dimensions.map((dim) => <DimDetail key={dim.key} dim={dim} />)}
      </div>

      {/* 接线口径与逐路来源 */}
      <div className="rounded-lg border border-border/70 px-3 py-2">
        <div className="text-[11px] font-medium text-muted-foreground">取数来源与口径（每一路单独标是否取到）</div>
        <ul className="mt-1 space-y-1">
          {view.sources.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
              <SourceBadge status={s.used ? "REAL 已取到" : "MISSING 本次未取到"} source={s.label} time={s.as_of ?? undefined} />
              <span className="text-muted-foreground/80">{plainify(s.detail)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-1.5 grid gap-0.5 text-[10.5px] text-muted-foreground/80 sm:grid-cols-2">
          <span title={`接线版本 ${w.wiring_version}`}>接线口径 {verTail(w.wiring_version)}｜基准指数 {w.base_index.label}（{w.base_index.symbol}）</span>
          <span>技术面日K {w.technical_bars} 根，最后一根 {w.technical_bar_date ?? "无"}｜RSI 周期 {w.rsi_period}</span>
          <span>概率面打分周期 {w.probability_horizon ?? "未声明"} 日｜成交额基线 {w.turnover_baseline_days ?? 0} 个可信用留档日</span>
          <span>技术面窗口：均量 {w.volume_window ?? "无有效读数"} 根／压力位 {w.prior_high_window ?? "无有效读数"} 根</span>
          <span>事件窗口 {w.event_window.start} → {w.event_window.end}（{w.event_window.stale_after_days} 天内），取到 {w.event_window.rows} 行{w.event_window.payload_broken ? `，${w.event_window.payload_broken} 行不可解析` : ""}</span>
          <span>决策参考日 {view.trade_date}（取数时刻 {view.as_of}）</span>
        </div>
        {w.probability_scope && <div className="mt-1 text-[10.5px] text-amber-300/90">口径：{plainify(w.probability_scope)}</div>}
      </div>

      {w.notes.length > 0 && (
        <DeskCollapse
          className="mt-2"
          title={`接线层登记（${w.notes.length} 条：口径声明、把补出来的 0 还原成缺失、降级与滞后说明）`}
          contentClassName="text-[11px] text-muted-foreground"
        >
          <ul className="space-y-0.5">
            {w.notes.map((n, i) => <li key={i}>· {n}</li>)}
          </ul>
        </DeskCollapse>
      )}

      <DeskCollapse
        className="mt-2"
        title="这份结论的完整文字口径（与 AI 上下文共用同一份）"
        contentClassName="text-[11px] text-muted-foreground"
      >
        <pre className="whitespace-pre-wrap break-words leading-relaxed">{plainify(view.text)}</pre>
      </DeskCollapse>

      <div className="text-[10.5px] leading-relaxed text-muted-foreground/80">
        免责声明：综合得分是上面四张打分表在本次生效权重下的加权结果，用于把「哪些读数在支持、哪些在反对」写成同一量纲，
        不是明日涨跌的概率，不构成投资建议。分层口径：{d.layers.map((l) => DATA_STATUS_TEXT[l as keyof typeof DATA_STATUS_TEXT] ?? l).join("、")}。
        {d.layers.includes("AI_INTERPRETATION") && " 其中事件面来自 AI 对已落库消息的解释，是解释而非事实本身。"}
        {d.weights.renormalized && " 本次有权重被重新归一（有维度未计入），得分不能与四维齐全时直接比较。"}
      </div>
    </div>
  );
}

function DimHeader({ dim }: { dim: DimensionResult }) {
  // v3 起「计没计分」看的是 norm_score：字面分可以算出来却没有本维极值可折算，那种情况一律没进加权。
  const counted = dim.norm_score !== null;
  const tone = scoreTone(counted ? dim.norm_score : null);
  const scoredItems = dim.items.filter((i) => i.role !== "basis");
  return (
    <div className={`rounded-lg border px-3 py-2 ${counted ? "border-border bg-accent/20" : "border-amber-500/25 bg-amber-500/5"}`}>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{DIMENSION_LABEL[dim.key]}</span>
        <span className="font-mono text-[10px] text-muted-foreground">权重 {pct(dim.weight_applied)}</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className={`text-lg font-bold ${tone}`}>{counted ? fmtSigned(dim.norm_score as number) : "未计入"}</span>
        <span className="text-[10px] text-muted-foreground">
          {counted ? `折算分（字面 ${dim.raw_score === null ? "算不出" : fmtSigned(dim.raw_score)}）` : dim.raw_score === null ? "没有读数" : `字面 ${fmtSigned(dim.raw_score)} 未折算`}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground/80" title={dim.rule_version ?? "无规则读数"}>
        {scoredItems.filter((i) => i.points !== null).length}/{scoredItems.length} 项有分（另有 {dim.items.length - scoredItems.length} 项只作依据）｜{dim.rule_version ? verZh(dim.rule_version) : "本次没有规则读数"}
      </div>
    </div>
  );
}

function DimDetail({ dim }: { dim: DimensionResult }) {
  if (!dim.items.length && !dim.missing.length) return null;
  const open = dim.norm_score !== null;
  return (
    <DeskCollapse
      defaultOpen={open}
      className="text-[11.5px]"
      triggerClassName="text-[11.5px] font-normal"
      contentClassName="text-[11px] text-muted-foreground"
      title={
        <>
          <span className="font-medium">{DIMENSION_LABEL[dim.key]}分项</span>
          <span className="ml-2 text-[10.5px] text-muted-foreground">
            {dim.norm_score === null
              ? (dim.raw_score === null ? "本次不计分" : `字面 ${fmtSigned(dim.raw_score)}，但${dim.excluded_reason ? "未参与加权" : "无法折算"}`)
              : `字面 ${dim.raw_score === null ? "—" : fmtSigned(dim.raw_score)} → 折算 ${fmtSigned(dim.norm_score)}（生效权重 ${pct(dim.weight_applied)}）`}
            ｜本维极值 {dim.bounds ? `${dim.bounds.min}~${dim.bounds.max}` : "未声明"}｜{statusShortZh(dim.status ?? "")}
          </span>
        </>
      }
    >
      <ul className="space-y-1.5">
        {dim.items.map((it, i) => <ItemRow key={`${it.rule}-${i}`} it={it} dimVersion={dim.rule_version} />)}
        {dim.missing.map((m, i) => (
          <li key={`m-${i}`} className="text-[11px] text-amber-300/90">⚠ {plainify(m)}</li>
        ))}
      </ul>
    </DeskCollapse>
  );
}

function ItemRow({ it, dimVersion }: { it: ScoreItem; dimVersion: string | null }) {
  const nullish = it.points === null;
  const basis = it.role === "basis";
  return (
    <li className={`rounded-md px-2.5 py-1.5 ${basis ? "border border-dashed border-border/70 bg-background/40" : "bg-accent/20"}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={`text-[12px] font-medium ${basis ? "text-muted-foreground" : scoreTone(it.points)}`}>
          {basis ? "依据" : nullish ? "算不出" : `${fmtSigned(it.points as number)} 分`}
        </span>
        <span className="text-[12px]" title={it.rule}>{it.label}</span>
        <span className="text-[10px] text-muted-foreground/70">{statusShortZh(it.status)}</span>
        <span className="text-[10px] text-muted-foreground/60" title={it.rule_version ?? dimVersion ?? ""}>{it.rule_version ? verZh(it.rule_version) : dimVersion ? verZh(dimVersion) : "无版本登记"}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{plainify(it.raw)}</div>
      {basis && (
        <div className="mt-0.5 text-[10.5px] text-muted-foreground/80">
          这条是判定依据，不进本维求和（新表已有同一指标，重复计权等于把同一个读数算两遍）
          {it.points !== null && `；它在自己那张表里的字面分是 ${fmtSigned(it.points)}`}
        </div>
      )}
      {it.note && (
        <div className={`mt-0.5 text-[10.5px] ${nullish && !basis ? "text-amber-300/80" : "text-muted-foreground/80"}`}>
          {nullish && !basis && <b>【缺读数，不是 0 分】</b>}{plainify(it.note)}
        </div>
      )}
    </li>
  );
}
