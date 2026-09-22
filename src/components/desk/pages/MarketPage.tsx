"use client";
// 大盘情绪：用户友好版。
// 保留全部取数逻辑；去掉工程口径脚注与高频状态徽章，视觉走纯黑苹果风。
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { PctText } from "../SourceBadge";
import { fetchSentiment, fetchLimitUp, type SentimentClient, type LimitUpClient } from "@/lib/desk/quant-api";
// P11 情绪温度：仪表盘与对话工具吃同一份纯核（零 IO，浏览器端直接 import），
// 三态切换只换权重、不重取数——分量各算一次，牛/熊/震荡是同一批读数的三种加权。
import { computeTemperature, REGIMES, type MarketRegime } from "@/lib/quant/screener/sentiment-temperature-core";
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
  // 行情类型（牛/熊/震荡）只影响温度权重，是本机视图状态、不进 store 也不发请求
  const [regime, setRegime] = useState<MarketRegime>("range");

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

          {/* 情绪温度（P11 对齐稳智表达层）：四分量加权成一个 0-100 的分 + 半环仪表，权重随行情类型切 */}
          {(() => {
            const temp = computeTemperature({
              advancers: sent.advancers, decliners: sent.decliners, median_pct: sent.median_pct,
              limit_up: sent.limit_up, limit_down: sent.limit_down, break_rate: sent.break_rate,
              main_net_sum_yi: sent.main_net_sum_yi, main_net_known: sent.main_net_known,
            }, regime);
            return (
              <div className="apple-card apple-fade-in p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[14px] font-medium">情绪温度</div>
                  <div className="flex items-center gap-1">
                    {REGIMES.map((rg) => (
                      <button key={rg.key} onClick={() => setRegime(rg.key)}
                        className={
                          "rounded-full px-3 py-1 text-[12px] transition-colors " +
                          (regime === rg.key ? "bg-sky-400/15 font-medium text-sky-200" : "text-muted-foreground hover:text-foreground")
                        }
                      >{rg.label}</button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-6">
                  <TempGauge value={temp.temperature} label={temp.label} />
                  <div className="min-w-[240px] flex-1 space-y-2">
                    {temp.components.map((c) => (
                      <div key={c.key} className="flex items-baseline gap-2 text-[12.5px]">
                        <span className="w-14 shrink-0 text-muted-foreground">{c.label}</span>
                        <span className="w-11 shrink-0 font-medium">{c.score === null ? "缺" : c.score}</span>
                        <span className="w-10 shrink-0 text-muted-foreground/70">{c.score === null ? "—" : `${c.weight}%`}</span>
                        <span className="truncate text-muted-foreground/80" title={c.score === null ? c.missing_note : c.raw}>
                          {c.score === null ? c.missing_note : c.raw}
                        </span>
                      </div>
                    ))}
                    {temp.temperature === null && (
                      <div className="text-[12px] text-amber-300/80">全部分量没有真实读数：温度按「无读数」显示，不硬造一个数。</div>
                    )}
                    {temp.temperature !== null && temp.missing.length > 0 && (
                      <div className="text-[11.5px] text-amber-300/70">{temp.missing[0]}</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

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

// 半环温度计表盘：0-100 五段色带（冰点/偏冷/中性/偏热/过热），指针指当前分。
// 色带分段与 sentiment-temperature-core 的 temperatureLabel 档位同线（25/45/60/80）；
// 没有真实读数时画灰盘 + 「—」，不画一根指向编造位置的针。
function TempGauge({ value, label }: { value: number | null; label: string }) {
  const cx = 100, cy = 96, r = 74;
  const pt = (pct: number) => {
    const a = Math.PI * (1 - Math.min(100, Math.max(0, pct)) / 100);
    return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
  };
  const arc = (from: number, to: number) => {
    const p1 = pt(from), p2 = pt(to);
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${r} ${r} 0 0 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  };
  const bands = [
    { from: 0, to: 25, color: "#38bdf8" },
    { from: 25, to: 45, color: "#34d399" },
    { from: 45, to: 60, color: "#94a3b8" },
    { from: 60, to: 80, color: "#fb923c" },
    { from: 80, to: 100, color: "#f87171" },
  ];
  const active = bands.find((b) => (value ?? -1) >= b.from && (value ?? -1) < b.to)?.color ?? "#94a3b8";
  const needle = value === null ? null : pt(value);
  return (
    <div className="relative shrink-0" style={{ width: 200 }}>
      <svg width="200" height="118" viewBox="0 0 200 118" role="img" aria-label={`情绪温度 ${value ?? "无读数"}`}>
        {bands.map((b) => (
          <path key={b.from} d={arc(b.from + 0.8, b.to - 0.8)} stroke={b.color}
            strokeOpacity={value === null ? 0.2 : b.color === active ? 0.95 : 0.3}
            strokeWidth="10" fill="none" strokeLinecap="round" />
        ))}
        {needle && <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke={active} strokeWidth="3" strokeLinecap="round" />}
        {needle && <circle cx={cx} cy={cy} r="4.5" fill={active} />}
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <span className="text-[30px] font-semibold tracking-tight" style={{ color: value === null ? undefined : active }}>
          {value === null ? "—" : value}
        </span>
        <span className="ml-1 text-[12px] text-muted-foreground">{value === null ? "无读数" : `/ 100 · ${label}`}</span>
      </div>
    </div>
  );
}
