"use client";
// 大盘情绪仪表盘（需求文档 P0：涨跌家数/涨停/成交额/风险等级 + 板块资金榜）
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { SourceBadge, PctText } from "../SourceBadge";
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
      setTiers(null); // 失败显式空（REAL_DATA_ONLY：不兜底）
    } finally {
      setTiersBusy(false);
    }
  }, []);

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      setSent(await fetchSentiment());
      // 板块榜：直接调真实接口（fetchBoardRows 会回退演示数据，违反 REAL_DATA_ONLY，不用）
      const r = await fetch("/api/market/board?kind=industry&dir=in");
      const j = await r.json();
      setBoards(Array.isArray(j.rows) && j.rows.length ? (j.rows as SectorRow[]) : null);
      void loadTiers(); // 梯队需逐只拉涨停名单日K（较慢），独立加载不阻塞本页
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }, [loadTiers]);

  useEffect(() => { load(); }, [load]);

  const riskColor = (level: string): string =>
    level === "高风险" ? "text-red-500 border-red-500/40 bg-red-500/10"
      : level === "偏高" ? "text-orange-400 border-orange-500/40 bg-orange-500/10"
      : level === "注意" ? "text-amber-400 border-amber-500/40 bg-amber-500/10"
      : "text-emerald-400 border-emerald-500/40 bg-emerald-500/10";

  const total = sent ? sent.advancers + sent.decliners + sent.flat : 0;
  const advPct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-lg font-bold">大盘情绪仪表盘</div>
          <div className="text-[11px] text-muted-foreground">全A快照真实统计 · 无数据源指标显式标注暂缺 · 不构成投资建议</div>
        </div>
        <div className="flex items-center gap-2">
          {sent && <SourceBadge status={sent.live ? "LIVE" : "HISTORICAL"} source={sent.source.provider.split("（")[0]} time={sent.as_of.slice(11, 19)} />}
          <button onClick={load} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      {sent && (
        <>
          {/* 指数 */}
          <div className="grid grid-cols-3 gap-3">
            {sent.indices.map((ix) => (
              <div key={ix.symbol} className="rounded-xl border border-border bg-card px-4 py-3">
                <div className="text-[11px] text-muted-foreground">{ix.name}</div>
                <div className="mt-0.5 flex items-baseline gap-2">
                  <span className="text-xl font-bold">{ix.price.toFixed(2)}</span>
                  <PctText value={ix.changePct} className="text-sm font-medium" />
                </div>
              </div>
            ))}
          </div>

          {/* 涨跌结构 */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between text-[12px] text-muted-foreground">
              <span>涨跌家数（共 {sent.total} 只有效快照）</span>
              <span>涨停 <b className="text-red-500">{sent.limit_up}</b> · 跌停 <b className="text-emerald-500">{sent.limit_down}</b></span>
            </div>
            <div className="flex h-7 overflow-hidden rounded-lg">
              <div className="flex items-center justify-start bg-red-500/80 px-2 text-[11px] font-semibold text-white" style={{ width: `${advPct(sent.advancers)}%` }}>
                {sent.advancers}
              </div>
              <div className="flex items-center justify-center bg-accent px-1 text-[11px] text-muted-foreground">{sent.flat}</div>
              <div className="flex items-center justify-end bg-emerald-500/80 px-2 text-[11px] font-semibold text-white" style={{ width: `${advPct(sent.decliners)}%` }}>
                {sent.decliners}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Card label="全A成交额" value={`${sent.amount_total_yi.toFixed(0)} 亿`} />
              <Card label="全A主力净额" value={<span className={sent.main_net_sum_yi >= 0 ? "text-red-500" : "text-emerald-500"}>{sent.main_net_sum_yi >= 0 ? "+" : ""}{sent.main_net_sum_yi.toFixed(0)} 亿</span>} />
              <Card label="中位涨跌幅" value={<PctText value={sent.median_pct} />} />
              <Card label="涨跌比" value={(sent.decliners > 0 ? sent.advancers / sent.decliners : 99).toFixed(2)} />
              <Card
                label="涨停/炸板"
                value={
                  <span>
                    涨停 <b className="text-red-500">{sent.limit_up}</b>
                    {" · 炸板 "}<b className={sent.limit_up_broken > 0 ? "text-orange-400" : ""}>{sent.limit_up_broken}</b>
                    {" · 炸板率 "}<b>{sent.break_rate === null ? "—" : `${sent.break_rate.toFixed(0)}%`}</b>
                  </span>
                }
              />
            </div>
          </div>

          {/* 风险等级 */}
          <div className={`rounded-xl border p-4 ${riskColor(sent.risk.level)}`}>
            <div className="flex items-center gap-2 text-base font-bold">⚠ 市场风险等级：{sent.risk.level}</div>
            <div className="mt-1.5 space-y-0.5 text-[12px] opacity-90">
              {sent.risk.triggers.map((t, i) => <div key={i}>· {t}</div>)}
            </div>
            <div className="mt-1 text-[10.5px] opacity-70">风险等级是统计口径的警示（不是确定性预测）；触发指标仅限有真实数据源的项</div>
          </div>

          {/* 涨停梯队/连板池（P0补齐·任务B） */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">
                涨停梯队
                {tiers && (
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                    涨停 {tiers.limit_up_count} · 触板 {tiers.touched_count} · 炸板 {tiers.broken_count}
                    {tiers.break_rate !== null && <> · 炸板率 {tiers.break_rate.toFixed(0)}%</>} · 最高 {tiers.max_boards} 板
                  </span>
                )}
              </div>
              <button onClick={loadTiers} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-sky-300">
                {tiersBusy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} 刷新梯队
              </button>
            </div>
            {tiersBusy && !tiers && <div className="text-[11px] text-muted-foreground">正在按涨停名单逐只拉日K（eltdx/腾讯真实数据）…</div>}
            {tiers && tiers.tiers.every((t) => !t.stocks.length) && (
              <div className="text-[11px] text-amber-400/80">今日无收盘涨停股（梯队为空，属真实结果）</div>
            )}
            {tiers && (
              <div className="space-y-2">
                {tiers.tiers.filter((t) => t.stocks.length > 0 || t.label === "首板").map((tier) => (
                  <div key={tier.label} className="flex flex-wrap items-start gap-1.5">
                    <span className={`w-14 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${
                      tier.label === "最高板" ? "bg-red-500/15 text-red-400" : tier.label === "3连板+" ? "bg-orange-500/15 text-orange-400" : "bg-accent/60 text-muted-foreground"
                    }`}>{tier.label}</span>
                    <div className="flex flex-1 flex-wrap gap-1.5">
                      {tier.stocks.length === 0 && <span className="text-[11px] text-muted-foreground/60">—</span>}
                      {tier.stocks.map((s) => (
                        <button key={s.symbol} title={`${s.symbol}${s.industry ? " · " + s.industry : ""}`}
                          onClick={() => { setFocusSymbol(s.symbol); go("profile"); }}
                          className="rounded border border-border bg-accent/30 px-2 py-0.5 text-[11.5px] hover:border-sky-500/50 hover:text-sky-300">
                          {s.name}
                          <span className="ml-1 font-mono text-[10.5px] text-red-500">{s.boards}{s.capped ? "+" : ""}板</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="text-[10.5px] text-muted-foreground/70">{tiers.note}（{tiers.as_of}）</div>
              </div>
            )}
            {!tiers && !tiersBusy && (
              <div className="text-[11px] text-amber-400/80">暂无数据（梯队接口失败或数据源不可用）</div>
            )}
          </div>

          {/* 板块资金榜 */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">行业板块主力净流入榜</div>
              <button onClick={() => go("board")} className="text-xs text-sky-400 hover:underline">完整数据看板 →</button>
            </div>
            {boards ? (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {boards.map((b, i) => (
                  <div key={b.code} className="flex items-center gap-2 rounded bg-accent/30 px-3 py-1.5 text-[12px]">
                    <span className="w-5 text-muted-foreground">{i + 1}</span>
                    <span className="w-24 truncate font-medium">{b.name}</span>
                    <PctText value={b.changePct} className="w-16 text-right" />
                    <span className="ml-auto text-[11px] text-muted-foreground">主力 <span className={b.main >= 0 ? "text-red-500" : "text-emerald-500"}>{b.main.toFixed(2)}亿</span></span>
                    <span className="w-20 truncate text-right text-[10.5px] text-muted-foreground/70">{b.leader}</span>
                  </div>
                ))}
              </div>
            ) : <div className="text-[11px] text-amber-400/80">板块资金榜：暂无数据（东财接口被限流或不可用）</div>}
          </div>

          {/* 缺失指标 */}
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300/80">
            暂缺指标（无真实数据源，未参与风险判定）：{sent.missing.join("；")}
          </div>
        </>
      )}
    </div>
  );
}

function Card({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-accent/40 px-3 py-2">
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
    </div>
  );
}
