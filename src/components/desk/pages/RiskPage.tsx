"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { SourceBadge, PctText } from "../SourceBadge";
import { SnapshotBar } from "../SnapshotBar";
import { fetchRisk, type RiskClient } from "@/lib/desk/quant-api";
// R20：主力净额该显示哪个数（全A快照 vs 通达信自算子集）的取舍规则在一处
import { mainNetDisplay } from "@/lib/desk/main-net-core";
import { useDesk } from "@/lib/desk/store";

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

export default function RiskPage() {
  const go = useDesk((s) => s.go);
  const [data, setData] = useState<RiskClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { setData(await fetchRisk()); }
    catch (e) { setError(String((e as Error).message || e)); setData(null); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
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
  const promoNote = !pb ? ""
    : `名单最早只回溯到 ${pb.earliest ?? "—"}：再早的日子东财涨停池不给数，那是「读不到」，不是「那些天没涨停」。`
      + "今日表现按本地不复权收盘价前后两天相除，除权除息那天会偏。"
      + (pb.adjacent === false ? "两份名单中间还缺了一个交易日的沉淀。" : "");

  return (
    <div className="w-full space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><ShieldAlert size={18} className="text-sky-400" /> 风险监控</div>
          <div className="text-[12px] text-muted-foreground">真实情绪指标 + 上证相似环境统计 · 不编造缺失项 · 不构成投资建议</div>
        </div>
        <div className="flex items-center gap-2">
          {data && <SourceBadge status={data.live ? "LIVE" : "HISTORICAL"} source={data.source.provider.split("（")[0]} time={data.as_of.slice(11, 19)} />}
          <button onClick={load} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        </div>
      </div>
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      <SnapshotBar kind="risk" label="风险监控"
        sideEffect="留档这一下会在服务端真的重算一次（全A快照 + 指数行情 + 相似历史日统计），不是读本页缓存、也不是把上面的数字上传存起来。" />
      {data && (
        <>
          <div className={`rounded-xl border px-5 py-4 ${levelClass(data.risk.level)}`}>
            <div className="text-[12px] opacity-80">市场风险等级</div>
            <div className="text-2xl font-bold">{data.risk.level}</div>
            <div className="mt-1 text-xs opacity-90">炸板率 {data.break_rate === null ? "—" : `${data.break_rate.toFixed(0)}%`} · 涨跌比 {(data.decliners > 0 ? data.advancers / data.decliners : 99).toFixed(2)} · 主力净额 {mn ? <span title={mn.hint}>{mn.value.toFixed(0)} 亿{mn.selfComputed ? "（自算）" : ""}</span> : "—"}{mn && <span className="ml-1 opacity-70">{mn.label}</span>}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">接力与梯队（昨日涨停名单 → 今天）</div>
              {pb && <div className="text-[11.5px] text-muted-foreground">名单已攒 {pb.roster_days} 个交易日 · 取数 {pb.as_of.slice(11, 19)}</div>}
            </div>
            {!pb && (
              <div className="text-xs text-amber-400">读不到本地涨停名单：{data.promotion_error || "无数据"}——不是「今天没人涨停」，是名单还没攒出来</div>
            )}
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
                <div className="mt-2 text-[11.5px] text-muted-foreground">{pb.line}</div>
                <div className="mt-1 text-[11.5px] text-muted-foreground/80">{promoNote}</div>
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
            <div className="mb-2 text-sm font-semibold">建议关注</div>
            <div className="flex flex-wrap gap-2">
              {data.suggestions.map((s) => (
                <span key={s} className="rounded-md border border-border bg-accent/40 px-2 py-1 text-xs">{s}</span>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">历史参考（上证相似涨跌幅环境）</div>
              <button onClick={() => go("problab")} className="text-xs text-sky-400 hover:underline">条件概率页 →</button>
            </div>
            <div className="text-[12px] text-muted-foreground">{data.history_ref_note}</div>
            {data.history_ref && (
              <div className="mt-3 grid grid-cols-3 gap-3">
                {data.history_ref.horizons.map((h) => (
                  <div key={h.h} className="rounded-lg border border-border px-3 py-2 text-xs">
                    <div className="text-muted-foreground">{h.h} 日</div>
                    <div className="text-base font-semibold">{h.win_rate == null ? "—" : `${h.win_rate.toFixed(0)}%`}</div>
                    <div className="text-[11.5px] text-muted-foreground">样本 {h.sample_size} · 均值 {h.avg_return == null ? "—" : `${h.avg_return.toFixed(2)}%`}</div>
                  </div>
                ))}
              </div>
            )}
            {data.history_ref && !data.history_ref.sample_ok && (
              <div className="mt-2 text-[12px] text-amber-400">样本不足，仅供参考</div>
            )}
          </div>
          {!!data.missing.length && (
            <div className="text-[11.5px] leading-4 text-muted-foreground/80">暂缺：{data.missing.join("；")}</div>
          )}
        </>
      )}
    </div>
  );
}
