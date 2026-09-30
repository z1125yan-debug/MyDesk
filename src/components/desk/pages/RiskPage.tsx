"use client";
// 极简版风险监控（2026-09-29 定稿）：一眼结论 = 情绪词 + 3 核心数 + 一句建议。
// 留档区只留「留档今天」按钮和日期；点日期用同一套一眼版式回看当天数字，不播报 headline 长文。
import { useCallback, useEffect, useState } from "react";
import { Archive, ChevronDown, ChevronUp, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { useLivePoll } from "@/hooks/use-live-poll";
import {
  archiveSnapshotApi, fetchRisk, fetchSnapshots,
  type RiskClient, type SnapshotItemClient, type SnapshotRespClient,
} from "@/lib/desk/quant-api";
// R20：主力净额该显示哪个数（全A快照 vs 通达信自算子集）的取舍规则在一处
import { mainNetDisplay } from "@/lib/desk/main-net-core";
import { useDesk } from "@/lib/desk/store";
import type { PageKey } from "@/lib/desk/types";

/** 接力读数的人话换算：只排版，不判定（判定与分母口径都在 limit-up-roster-core） */
function rateCell(b?: { base: number; promoted: number; rate: number | null }): { value: string; sub: string; na: boolean } {
  if (!b) return { value: "—", sub: "两天名单还没凑齐", na: true };
  if (!b.base) return { value: "—", sub: "昨日这一档 0 家，没有分母", na: true };
  const r = b.rate === null ? "—" : `${Math.round(b.rate)}%`;
  return { value: `${b.promoted}/${b.base}`, sub: `晋级率 ${r}`, na: false };
}

const signed = (v: number | null): string => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

function levelClass(level: string): string {
  if (level === "事件风险") return "text-violet-300 border-violet-500/40 bg-violet-500/10";
  if (level === "高风险") return "text-red-500 border-red-500/40 bg-red-500/10";
  if (level === "偏高") return "text-orange-400 border-orange-500/40 bg-orange-500/10";
  if (level === "注意") return "text-amber-400 border-amber-500/40 bg-amber-500/10";
  return "text-emerald-400 border-emerald-500/40 bg-emerald-500/10";
}

/** 情绪词 → 一句话结论（人话翻译，不新增事实） */
function conclusionLine(d: RiskClient): string {
  const lvl = d.risk.level;
  const bk = d.break_rate === null ? null : `${d.break_rate.toFixed(0)}%`;
  const adv = d.decliners > 0 ? d.advancers / d.decliners : 99;
  if (lvl === "高风险") return `情绪转弱，炸板率 ${bk ?? "—"}、涨跌比 ${adv.toFixed(2)}，控仓回避高标接力`;
  if (lvl === "偏高") return `偏谨慎，炸板率 ${bk ?? "—"}、涨跌比 ${adv.toFixed(2)}，追高性价比在下降`;
  if (lvl === "注意") return `中性偏弱，涨跌比 ${adv.toFixed(2)}、炸板率 ${bk ?? "—"}，关注主线是否分化`;
  return `情绪正常，涨跌比 ${adv.toFixed(2)}、炸板率 ${bk ?? "—"}，按主线正常参与`;
}

export default function RiskPage() {
  const go = useDesk((s) => s.go);
  const [data, setData] = useState<RiskClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showDetail, setShowDetail] = useState(false);
  const poll = useLivePoll();

  // 留档：极简条——一个按钮 + 日期；点日期才回看当天
  const [snap, setSnap] = useState<SnapshotRespClient | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState("");
  const [snapError, setSnapError] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { setData(await fetchRisk()); }
    catch (e) { setError(String((e as Error).message || e)); setData(null); }
    finally { setBusy(false); }
  }, []);
  // tick 依赖：盘中自动轮询重取；休市时 useLivePoll 不推进 tick，effect 不重跑
  useEffect(() => { void load(); }, [load, poll.tick]);

  const loadSnap = useCallback(async (d = "") => {
    setSnapBusy(true); setSnapError("");
    try { setSnap(await fetchSnapshots("risk", d)); setPicked(d); }
    catch (e) { setSnapError(String((e as Error).message || e)); }
    finally { setSnapBusy(false); }
  }, []);
  useEffect(() => { void loadSnap(); }, [loadSnap]);

  const saveArchive = async () => {
    setSaving(true); setSnapError("");
    try {
      await archiveSnapshotApi("risk");
      await loadSnap("");
    } catch (e) {
      setSnapError(String((e as Error).message || e));
    } finally { setSaving(false); }
  };

  const dates = snap?.available_dates ?? [];
  const pickedItem: SnapshotItemClient | null =
    picked && snap?.items.length ? snap.items[0] : null;

  // 派生量：不新造事实，只决定「这一格显示哪个源的哪个数」
  const mn = mainNetDisplay(data);
  // R20：接力 / 梯队 / 昨日涨停表现——读数来自本地涨停名单表，算不出就原样说算不出
  const pb = data?.promotion ?? null;
  const promoCells = [
    { label: "首板 → 二板", ...rateCell(pb?.promotion?.oneToTwo) },
    { label: "二板 → 三板", ...rateCell(pb?.promotion?.twoToThree) },
    { label: "三板以上续住", ...rateCell(pb?.promotion?.threePlus) },
  ];
  const ladder = pb?.ladder ?? null;
  const ladderText = !ladder ? "梯队：没有名单，判不了最高板"
    : ladder.highest === null ? `梯队：${ladder.total} 只涨停里连板数一个都没读到，判不了最高板`
      : `梯队：最高 ${ladder.highest} 板 · `
        + (ladder.gaps.length ? `中间断 ${ladder.gaps.join("、")} 板（断层）` : "板数连续、没有断层")
        + (ladder.unknownBoards ? ` · ${ladder.unknownBoards} 只缺连板数（不进梯队）` : "")
        + ` · 分布 ${ladder.counts.map((c) => `${c.boards}板 ${c.n} 家`).join(" / ")}`;
  const money = pb?.money ?? null;
  const moneyText = !money ? "昨日涨停股今日表现：判不了"
    : !money.available ? `昨日涨停股今日表现：${money.reason || "算不出"}`
      : `昨日涨停股今日表现：${money.sample} 只参与 · 平均 ${signed(money.avg)} · 中位 ${signed(money.median)}`
        + ` · 上涨占比 ${money.positiveRate === null ? "—" : `${Math.round(money.positiveRate)}%`}`;

  const t = data?.as_of ?? "";
  const asOfTime = t.length >= 19 ? t.slice(11, 19) : t;
  const asOfShort = t.length >= 16 ? `${t.slice(5, 10)} ${t.slice(11, 16)}` : t;

  const advRatio = data ? (data.decliners > 0 ? data.advancers / data.decliners : 99) : 0;
  const breakRate = data?.break_rate ?? null;

  return (
    <div className="w-full space-y-4 px-6 py-4">
      {/* 顶栏：极简（时效缩成刷新左边的小圆点徽章，悬停看完整口径） */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><ShieldAlert size={18} className="text-sky-400" /> 风险监控</div>
          <div className="text-[11.5px] text-muted-foreground">不构成投资建议</div>
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <span
              title={data.live ? `盘中实时 · 行情时刻 ${data.as_of}` : `已收盘 · 快照截至 ${data.as_of}`}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${data.live ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-border bg-card text-muted-foreground"}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${data.live ? "animate-pulse bg-emerald-400" : "bg-sky-400/70"}`} />
              {data.live ? `实时 ${asOfTime}` : `快照 ${asOfShort}`}
            </span>
          )}
          <button onClick={load} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      {data && (
        <>
          {/* 一眼结论：情绪词 + 一句话 */}
          <div className={`rounded-xl border px-6 py-6 text-center ${levelClass(data.risk.level)}`}>
            <div className="text-[13px] opacity-80">今日情绪</div>
            <div className="mt-1 text-4xl font-bold tracking-wide">{data.risk.level}</div>
            <div className="mt-2 text-sm opacity-90">{conclusionLine(data)}</div>
          </div>
          {/* 3 个核心数 */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-border bg-card p-4 text-center">
              <div className="text-xs text-muted-foreground">炸板率</div>
              <div className={`mt-1 text-2xl font-bold ${breakRate !== null && breakRate > 40 ? "text-orange-400" : "text-foreground"}`}>{breakRate === null ? "—" : `${breakRate.toFixed(0)}%`}</div>
              <div className="text-[11px] text-muted-foreground">触板 {data.touched_limit} / 炸板 {data.limit_up_broken}</div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4 text-center">
              <div className="text-xs text-muted-foreground">涨跌比</div>
              <div className="mt-1 text-2xl font-bold">{advRatio.toFixed(2)}</div>
              <div className="text-[11px] text-muted-foreground">涨 {data.advancers} / 跌 {data.decliners}</div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4 text-center">
              <div className="text-xs text-muted-foreground">主力净额</div>
              <div className="mt-1 text-2xl font-bold">{mn ? `${mn.value.toFixed(0)}亿` : "—"}</div>
              <div className="text-[11px] text-muted-foreground">{mn?.label ?? "全A口径"}</div>
              <div className="mt-0.5 text-[10.5px] leading-tight text-muted-foreground/80">全市场个股口径，与「资金去向」板块榜不是同一笔数</div>
            </div>
          </div>
          {/* 一句建议 */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted-foreground">建议</div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {data.suggestions.map((s) => <span key={s} className="rounded-md border border-border bg-accent/40 px-2 py-1 text-xs">{s}</span>)}
            </div>
          </div>
          {/* 细节默认收起，不占视线 */}
          <button onClick={() => setShowDetail(!showDetail)} className="flex w-full items-center justify-center gap-1 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-accent">
            {showDetail ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {showDetail ? "收起全部指标" : "展开全部指标"}
          </button>
          {showDetail && <DetailBlock data={data} ladderText={ladderText} moneyText={moneyText} promoCells={promoCells} pb={pb} go={go} />}
        </>
      )}

      {/* 留档：一行 = 按钮 + 日期，其余全删 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/60 px-3 py-2 text-[12px]">
        <span className="inline-flex items-center gap-1 text-muted-foreground"><Archive size={12} /> 留档</span>
        <button onClick={saveArchive} disabled={saving || snapBusy}
          title="留档今天：服务端当场重算一次后存库"
          className="flex items-center gap-1 rounded-md border border-sky-500/50 bg-sky-500/15 px-2 py-1 text-sky-200 hover:bg-sky-500/25 disabled:opacity-40">
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Archive size={11} />}
          {saving ? "留档中…" : "留档今天"}
        </button>
        {snapBusy && <Loader2 size={11} className="animate-spin text-muted-foreground" />}
        {dates.slice(0, 12).map((d) => (
          <button key={d.date} onClick={() => void loadSnap(picked === d.date ? "" : d.date)} disabled={snapBusy || saving}
            title={`${d.date}（${d.count} 条）`}
            className={`rounded border px-1.5 py-0.5 text-[11.5px] ${picked === d.date ? "border-sky-500/50 bg-sky-500/15 text-sky-200" : "border-border text-muted-foreground hover:border-sky-500/40"}`}>
            {d.date.slice(5)}
          </button>
        ))}
        {dates.length > 12 && <span className="text-[11px] text-muted-foreground">…共 {dates.length} 天</span>}
        {snapError && <span className="text-[11.5px] text-red-300">{snapError}</span>}
      </div>

      {/* 选中的留档日：同一套一眼版式，两行，无长文 */}
      {pickedItem && <ArchivedMini item={pickedItem} />}
    </div>
  );
}

/** 留档回看：从存档 payload 里读出当天的情绪词 + 3 个数，同一套一眼版式；读不出就直说读不出 */
function ArchivedMini({ item }: { item: SnapshotItemClient }) {
  const p = (item.payload && typeof item.payload === "object" ? item.payload : null) as Record<string, unknown> | null;
  const risk = p ? (p.risk as { level?: unknown } | null | undefined) : undefined;
  const level = typeof risk?.level === "string" ? risk.level : "";
  const br = typeof p?.break_rate === "number" ? `${p.break_rate.toFixed(0)}%` : "—";
  const a = typeof p?.advancers === "number" ? p.advancers : null;
  const d = typeof p?.decliners === "number" ? p.decliners : null;
  const ratio = a !== null && d !== null && d > 0 ? (a / d).toFixed(2) : "—";
  const tdx = p?.main_net_tdx as { sum_yi?: unknown } | undefined;
  let mn = "—";
  if (tdx && typeof tdx.sum_yi === "number" && isFinite(tdx.sum_yi)) mn = `${tdx.sum_yi.toFixed(0)}亿`;
  else if (typeof p?.main_net_known === "number" && p.main_net_known > 0 && typeof p?.main_net_sum_yi === "number") mn = `${p.main_net_sum_yi.toFixed(0)}亿`;

  if (!level) {
    return (
      <div className="rounded-xl border border-border bg-card/60 px-3 py-2 text-[11.5px] text-muted-foreground">
        {item.trade_date} 的留档内容读不出（{item.payload_broken ? "存的原文损坏" : "缺关键字段"}）
      </div>
    );
  }
  return (
    <div className={`rounded-xl border px-4 py-3 ${levelClass(level)}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        {item.trade_date} · 留档 {item.computed_at.slice(11, 16)} · {level}
      </div>
      <div className="mt-1 text-xs opacity-90">炸板率 {br} · 涨跌比 {ratio} · 主力净额 {mn}</div>
    </div>
  );
}

/** 明细块（折叠区）：接力/梯队、触发指标、历史参考 */
function DetailBlock({
  data, ladderText, moneyText, promoCells, pb, go,
}: {
  data: RiskClient;
  ladderText: string;
  moneyText: string;
  promoCells: { label: string; value: string; sub: string; na: boolean }[];
  pb: RiskClient["promotion"];
  go: (page: PageKey) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold">接力与梯队（昨日涨停名单 → 今天）</div>
          {pb && <div className="text-[11.5px] text-muted-foreground">名单已攒 {pb.roster_days} 个交易日</div>}
        </div>
        {!pb && <div className="text-xs text-amber-400">读不到本地涨停名单：{data.promotion_error || "无数据"}——不是「今天没人涨停」，是名单还没攒出来</div>}
        {pb && (
          <>
            <div className="grid grid-cols-3 gap-3">
              {promoCells.map((c) => (
                <div key={c.label} className="rounded-lg border border-border px-3 py-2 text-xs">
                  <div className="text-muted-foreground">{c.label}</div>
                  <div className={`mt-0.5 text-base font-semibold ${c.na ? "text-muted-foreground" : ""}`}>{c.value}</div>
                  <div className="text-[11.5px] text-muted-foreground">{c.sub}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs">{ladderText}</div>
            <div className="mt-1 text-xs">{moneyText}</div>
          </>
        )}
      </div>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 text-sm font-semibold">触发指标</div>
        <ul className="space-y-1 text-xs">
          {data.risk.triggers.map((t) => <li key={t} className="text-muted-foreground">· {t}</li>)}
        </ul>
      </div>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold">历史参考（上证相似涨跌幅环境）</div>
          <button onClick={() => go("problab")} className="text-xs text-sky-400 hover:underline">条件概率页 →</button>
        </div>
        {data.history_ref && (
          <div className="grid grid-cols-3 gap-3">
            {data.history_ref.horizons.map((h) => (
              <div key={h.h} className="rounded-lg border border-border px-3 py-2 text-xs">
                <div className="text-muted-foreground">{h.h} 日</div>
                <div className="text-base font-semibold">{h.win_rate == null ? "—" : `${h.win_rate.toFixed(0)}%`}</div>
                <div className="text-[11.5px] text-muted-foreground">样本 {h.sample_size} · 均值 {h.avg_return == null ? "—" : `${h.avg_return.toFixed(2)}%`}</div>
              </div>
            ))}
          </div>
        )}
        {data.history_ref && !data.history_ref.sample_ok && <div className="mt-2 text-[12px] text-amber-400">样本不足，仅供参考</div>}
      </div>
      {!!data.missing.length && <div className="text-[11.5px] leading-4 text-muted-foreground/80">暂缺：{data.missing.join("；")}</div>}
    </div>
  );
}
