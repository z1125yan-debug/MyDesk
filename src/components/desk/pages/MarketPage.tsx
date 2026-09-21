"use client";
// 大盘情绪：用户友好版。
// 保留全部取数逻辑；去掉工程口径脚注与高频状态徽章，视觉走纯黑苹果风。
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { PctText } from "../SourceBadge";
import { fetchSentiment, fetchLimitUp, type SentimentClient, type LimitUpClient } from "@/lib/desk/quant-api";
import type { SectorRow } from "@/lib/desk/types";
import { useDesk } from "@/lib/desk/store";

export default function MarketPage() {
  const go = useDesk((s) => s.go);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const [sent, setSent] = useState<SentimentClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [boards, setBoards] = useState<SectorRow[] | null>(null);
  const [tiers, setTiers] = useState<LimitUpClient | null>(null);
  const [tiersBusy, setTiersBusy] = useState(false);

  const loadTiers = useCallback(async () => {
    setTiersBusy(true);
    try {
      setTiers(await fetchLimitUp());
    } catch {
      setTiers(null);
    } finally {
      setTiersBusy(false);
    }
  }, []);

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      setSent(await fetchSentiment());
      const r = await fetch("/api/market/board?kind=industry&dir=in");
      const j = await r.json();
      setBoards(Array.isArray(j.rows) && j.rows.length ? (j.rows as SectorRow[]) : null);
      void loadTiers();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }, [loadTiers]);

  useEffect(() => { load(); }, [load]);

  const riskColor = (level: string): string =>
    level === "高风险" ? "border-red-400/25 bg-red-400/[0.07]"
      : level === "偏高" ? "border-orange-400/25 bg-orange-400/[0.07]"
      : level === "注意" ? "border-amber-400/25 bg-amber-400/[0.07]"
      : "border-emerald-400/25 bg-emerald-400/[0.07]";

  const total = sent ? sent.advancers + sent.decliners + sent.flat : 0;
  const advPct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-6 py-6">
      <div className="apple-slide-up flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">大盘情绪</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">一眼看清今天市场的温度。</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 rounded-full border border-border/70 bg-white/[0.03] px-3.5 py-2 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} 刷新
        </button>
      </div>

      {error && <div className="apple-card border-red-400/25 px-4 py-3 text-[13px] text-red-300">{error}</div>}

      {sent && (
        <>
          {/* 指数：大数字 */}
          <div className="apple-stagger grid grid-cols-3 gap-3">
            {sent.indices.map((ix) => (
              <div key={ix.symbol} className="apple-card px-5 py-4">
                <div className="text-[12px] text-muted-foreground">{ix.name}</div>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <span className="text-[24px] font-semibold tracking-tight">{ix.price.toFixed(2)}</span>
                  <PctText value={ix.changePct} className="text-[13px] font-medium" />
                </div>
              </div>
            ))}
          </div>

          {/* 涨跌结构 */}
          <div className="apple-card apple-fade-in p-5">
            <div className="mb-3 flex items-center justify-between text-[12.5px] text-muted-foreground">
              <span>涨跌家数（共 {sent.total} 只）</span>
              <span>涨停 <b className="text-red-400">{sent.limit_up}</b> · 跌停 <b className="text-emerald-400">{sent.limit_down}</b></span>
            </div>
            <div className="flex h-3 overflow-hidden rounded-full">
              <div className="bg-red-400/80" style={{ width: `${advPct(sent.advancers)}%` }} />
              <div className="bg-white/10" style={{ width: `${advPct(sent.flat)}%` }} />
              <div className="bg-emerald-400/80" style={{ width: `${advPct(sent.decliners)}%` }} />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Card label="成交额" value={`${sent.amount_total_yi.toFixed(0)} 亿`} />
              <Card label="主力净额" value={<span className={sent.main_net_sum_yi >= 0 ? "text-red-400" : "text-emerald-400"}>{sent.main_net_sum_yi >= 0 ? "+" : ""}{sent.main_net_sum_yi.toFixed(0)} 亿</span>} />
              <Card label="中位涨跌" value={<PctText value={sent.median_pct} />} />
              <Card label="涨跌比" value={(sent.decliners > 0 ? sent.advancers / sent.decliners : 99).toFixed(2)} />
              <Card label="炸板率" value={<>{sent.break_rate === null ? "—" : `${sent.break_rate.toFixed(0)}%`}<span className="ml-1.5 text-[11px] font-normal text-muted-foreground">炸 {sent.limit_up_broken}</span></>} />
            </div>
          </div>

          {/* 风险等级 */}
          <div className={`apple-card apple-fade-in border p-5 ${riskColor(sent.risk.level)}`}>
            <div className="flex items-center gap-2 text-[16px] font-semibold">市场风险：{sent.risk.level}</div>
            <div className="mt-2 space-y-1 text-[13px] text-foreground/80">
              {sent.risk.triggers.map((t, i) => <div key={i}>· {t}</div>)}
            </div>
          </div>

          {/* 涨停梯队 */}
          <div className="apple-card apple-fade-in p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[14px] font-medium">涨停梯队{tiers && <span className="ml-2 text-[12px] font-normal text-muted-foreground">最高 {tiers.max_boards} 板</span>}</div>
              <button onClick={loadTiers} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-sky-200">
                {tiersBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
              </button>
            </div>
            {tiersBusy && !tiers && <div className="text-[12.5px] text-muted-foreground">正在整理涨停名单…</div>}
            {tiers && tiers.tiers.every((t) => !t.stocks.length) && (
              <div className="text-[12.5px] text-muted-foreground/80">今天没有收盘涨停的股票。</div>
            )}
            {tiers && (
              <div className="space-y-2.5">
                {tiers.tiers.filter((t) => t.stocks.length > 0 || t.label === "首板").map((tier) => (
                  <div key={tier.label} className="flex flex-wrap items-start gap-2">
                    <span className={`w-14 shrink-0 rounded-full px-2 py-0.5 text-center text-[11.5px] font-medium ${
                      tier.label === "最高板" ? "bg-red-400/15 text-red-300" : tier.label === "3连板+" ? "bg-orange-400/15 text-orange-300" : "bg-white/[0.05] text-muted-foreground"
                    }`}>{tier.label}</span>
                    <div className="flex flex-1 flex-wrap gap-1.5">
                      {tier.stocks.length === 0 && <span className="text-[12px] text-muted-foreground/50">—</span>}
                      {tier.stocks.map((s) => (
                        <button key={s.symbol}
                          onClick={() => { setFocusSymbol(s.symbol); go("profile"); }}
                          className="rounded-full border border-border/60 bg-white/[0.02] px-2.5 py-1 text-[12.5px] transition-colors hover:border-sky-400/40 hover:text-sky-200">
                          {s.name}
                          <span className="ml-1 text-red-400">{s.boards}{s.capped ? "+" : ""}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 板块资金榜 */}
          <div className="apple-card apple-fade-in p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[14px] font-medium">行业资金流入榜</div>
              <button onClick={() => go("board")} className="text-[12.5px] text-sky-300 hover:underline">更多 →</button>
            </div>
            {boards ? (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {boards.map((b, i) => (
                  <button key={b.code} onClick={() => go("sectors")} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition-colors hover:bg-white/[0.04]">
                    <span className="w-5 text-muted-foreground/60">{i + 1}</span>
                    <span className="truncate font-medium">{b.name}</span>
                    <PctText value={b.changePct} className="w-14 text-right" />
                    <span className="ml-auto text-[12px] text-muted-foreground">主力 <span className={b.main >= 0 ? "text-red-400" : "text-emerald-400"}>{b.main.toFixed(2)}亿</span></span>
                  </button>
                ))}
              </div>
            ) : <div className="text-[12.5px] text-muted-foreground/80">资金榜数据稍后再看。</div>}
          </div>
        </>
      )}
    </div>
  );
}

function Card({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="apple-inset px-3.5 py-3">
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-[15px] font-semibold">{value}</div>
    </div>
  );
}
