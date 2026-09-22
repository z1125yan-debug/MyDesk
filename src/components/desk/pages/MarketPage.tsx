"use client";
// 大盘情绪：用户友好版。
// 保留全部取数逻辑；去掉工程口径脚注与高频状态徽章，视觉走纯黑苹果风。
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { PctText } from "../SourceBadge";
import { fetchSentiment, fetchLimitUp, fetchTrend, fetchBreadth, type SentimentClient, type LimitUpClient, type TrendClient, type TrendDayPoint, type BreadthClient } from "@/lib/desk/quant-api";
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
  // P15-R2a 复盘统计：两市成交额趋势/指数累计涨跌来自 /api/market/trend（东财指数日 K 实数）。
  // 日期范围是本机视图参数（默认近 90 天），点「加载复盘数据统计」才按新范围重取——与稳智同纪律。
  const [trend, setTrend] = useState<TrendClient | null>(null);
  const [trendBusy, setTrendBusy] = useState(false);
  const [trendFrom, setTrendFrom] = useState("");
  const [trendTo, setTrendTo] = useState("");
  const [trendError, setTrendError] = useState("");
  // P15-R2b 逐日宽度（站上5日线占比/创5日·3日新低）：来自 stock_daily_close 的收盘后沉淀。
  // 攒不够天数不是错误——chips 与图各按「攒中 N/x」如实显示进度，取数失败也只是没数。
  const [breadth, setBreadth] = useState<BreadthClient | null>(null);

  const loadBreadth = useCallback(async () => {
    try {
      setBreadth(await fetchBreadth(90));
    } catch {
      setBreadth(null); // 宽度失败不打掉情绪主体：chips 走「暂无数据」分支，tooltip 说清原因
    }
  }, []);

  const loadTrend = useCallback(async (from = "", to = "") => {
    setTrendBusy(true); setTrendError("");
    try {
      setTrend(await fetchTrend(from, to));
    } catch (e) {
      setTrend(null);
      setTrendError(String((e as Error).message || e));
    } finally {
      setTrendBusy(false);
    }
  }, []);

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
      void loadTrend(); // 顶部成交额监控卡第一屏就要有数，不等用户点按钮
      void loadBreadth(); // P15-R2b 逐日宽度：与趋势一样首屏自动带，攒够没攒够页面自会显示
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }, [loadTiers, loadTrend, loadBreadth]);

  useEffect(() => { load(); }, [load]);

  const riskColor = (level: string): string =>
    level === "高风险" ? "border-red-400/25 bg-red-400/[0.07]"
      : level === "偏高" ? "border-orange-400/25 bg-orange-400/[0.07]"
      : level === "注意" ? "border-amber-400/25 bg-amber-400/[0.07]"
      : "border-emerald-400/25 bg-emerald-400/[0.07]";

  const total = sent ? sent.advancers + sent.decliners + sent.flat : 0;
  const advPct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  // —— 顶部监控卡的派生量（全部由已回传字段推得，不产生新事实）——
  const temp = sent ? computeTemperature({
    advancers: sent.advancers, decliners: sent.decliners, median_pct: sent.median_pct,
    limit_up: sent.limit_up, limit_down: sent.limit_down, break_rate: sent.break_rate,
    main_net_sum_yi: sent.main_net_sum_yi, main_net_known: sent.main_net_known,
  }, regime) : null;
  // 三/四/五板+ 分档：从「3连板+」名单实数推（capped 20+ 计入五板+），监控卡与梯队卡共用这一份
  const p3 = tiers?.tiers.find((t) => t.label === "3连板+")?.stocks ?? [];
  const n3 = p3.filter((s) => s.boards === 3).length;
  const n4 = p3.filter((s) => s.boards === 4).length;
  const n5 = p3.filter((s) => s.boards >= 5).length;
  // 成交额卡：取最近一个「两市齐有读数」的日子；缺就是缺，不拿单边合计
  const tLatest = trend ? [...trend.days].reverse().find((d) => d.totalYi !== null) ?? null : null;
  const fmtYi = (yi: number) => (yi >= 10000 ? `${(yi / 1e4).toFixed(2)} 万亿` : `${yi.toFixed(0)} 亿`);
  // P15-R2b 宽度派生量：只有攒满根数的日子才有点（above_ma5_pct 非 null）；进度按库里真实天数说
  const bLatest = breadth?.latest ?? null;
  const bStored = breadth?.stored_trading_days ?? 0;
  const bPoints = (breadth?.series ?? []).filter((s) => s.above_ma5_pct !== null);

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

          {/* P15-R2a 顶部监控四卡（稳智「市场情绪分析」同款布局）：温度 / 成交额 / 连板高度 / 涨跌比。
              下面的原详细卡一个不删——监控卡管「3 秒看懂」，详细卡管「点开看口径」。 */}
          <div className="apple-stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {/* ① 情绪温度：小表盘 + 分数 + 行情三态（与下方详卡同一份 temp/regime，切哪边都同步） */}
            <div className="apple-card px-4 py-3.5">
              <div className="text-[12px] text-muted-foreground">情绪温度</div>
              <div className="mt-1 flex items-center gap-2.5">
                <TempGauge value={temp?.temperature ?? null} label={temp?.label ?? ""} compact />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1">
                    <span className="text-[26px] font-semibold tracking-tight">{temp?.temperature ?? "—"}</span>
                    <span className="text-[11px] text-muted-foreground">{temp?.label ?? "无读数"}</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1">
                    {REGIMES.map((rg) => (
                      <button key={rg.key} onClick={() => setRegime(rg.key)}
                        title={`${rg.label}：分量权重不同，温度是同一批读数的另一种看法`}
                        className={
                          "rounded-full px-2 py-0.5 text-[11px] transition-colors " +
                          (regime === rg.key ? "bg-sky-400/15 font-medium text-sky-200" : "text-muted-foreground hover:text-foreground")
                        }>{rg.label}</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            {/* ② 成交额（两市指数口径，与下方「全A快照合计」是两个口径各说各话——tooltip 写明出身） */}
            <div className="apple-card px-4 py-3.5">
              <div className="text-[12px] text-muted-foreground">成交额</div>
              <div className="mt-1 text-[26px] font-semibold tracking-tight"
                title={`沪深两市指数日成交额合计（东财 kline，含当天截至刷新时刻的累计）· ${trend?.range.from ?? ""} 至 ${trend?.range.to ?? ""} 窗口内最近一个两市齐有读数的日子。全A快照口径的成交额在下方「涨跌结构」卡，两者口径不同不互训`}>
                {trendBusy && !tLatest ? <span className="text-[13px] font-normal text-muted-foreground">取数中…</span>
                  : tLatest ? fmtYi(tLatest.totalYi as number)
                  : <span className="text-[13px] font-normal text-muted-foreground" title={trend?.missing.join("；") || "趋势数据未取到（点「加载复盘数据统计」重试）"}>暂无数据</span>}
              </div>
              <div className="mt-1 text-[11.5px] text-muted-foreground">
                {tLatest && trend?.delta.yi != null ? (
                  <span className={trend.delta.yi >= 0 ? "text-red-400" : "text-emerald-400"}>
                    {trend.delta.yi >= 0 ? "↑" : "↓"} {Math.abs(trend.delta.yi).toFixed(0)} 亿 <span className="text-muted-foreground">vs {trend.delta.prev_date} 两市合计</span>
                  </span>
                ) : tLatest ? <span>vs 昨日：上一配对日缺读数，不硬凑</span> : <span>—</span>}
              </div>
            </div>
            {/* ③ 连板高度：max_boards + 五档 chips（与下方梯队卡同一份推导） */}
            <div className="apple-card px-4 py-3.5">
              <div className="text-[12px] text-muted-foreground">连板高度</div>
              <div className="mt-1 text-[26px] font-semibold tracking-tight"
                title={tiers ? `最高连板 ${tiers.max_boards} 板（涨停梯队实数）· 触板 ${tiers.touched_count}` : "涨停梯队还没取到读数"}>
                {tiers ? <>{tiers.max_boards}<span className="text-[14px] font-normal text-muted-foreground">板</span></>
                  : <span className="text-[13px] font-normal text-muted-foreground">{tiersBusy ? "取数中…" : "暂无数据"}</span>}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1 text-[10.5px] text-muted-foreground">
                <span className="rounded bg-white/[0.05] px-1.5 py-0.5">涨停 <b className="text-red-400">{sent.limit_up}</b></span>
                <span className="rounded bg-white/[0.05] px-1.5 py-0.5">跌停 <b className="text-emerald-400">{sent.limit_down}</b></span>
                {tiers && <><span className="rounded bg-white/[0.05] px-1.5 py-0.5">三板 {n3}</span>
                  <span className="rounded bg-white/[0.05] px-1.5 py-0.5">四板 {n4}</span>
                  <span className="rounded bg-orange-400/10 px-1.5 py-0.5 text-orange-300">五板+ {n5}</span></>}
              </div>
            </div>
            {/* ④ 涨跌比：涨/跌家数即时推；低5日/低3日要逐日历史沉淀，管线未建就明说没有 */}
            <div className="apple-card px-4 py-3.5">
              <div className="text-[12px] text-muted-foreground">涨跌比</div>
              <div className="mt-1 text-[26px] font-semibold tracking-tight"
                title={`涨 ${sent.advancers} / 跌 ${sent.decliners}（全A快照）；无跌幅票时按 99 封顶显示`}>
                <span className={sent.advancers >= sent.decliners ? "text-red-400" : "text-emerald-400"}>
                  {(sent.decliners > 0 ? sent.advancers / sent.decliners : 99).toFixed(2)}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1 text-[10.5px] text-muted-foreground">
                <span className="rounded bg-white/[0.05] px-1.5 py-0.5">涨 <b className="text-red-400">{sent.advancers}</b></span>
                <span className="rounded bg-white/[0.05] px-1.5 py-0.5">跌 <b className="text-emerald-400">{sent.decliners}</b></span>
                {bLatest && bLatest.ma5_eligible > 0 ? (
                  <span className="rounded bg-white/[0.05] px-1.5 py-0.5"
                    title={`创5日新低 ${bLatest.new_low_5} 家（${bLatest.date} 收盘沉淀·分母是满 5 根的 ${bLatest.ma5_eligible} 只）· ${breadth?.caliber ?? ""}`}>低5日 <b className="text-orange-300">{bLatest.new_low_5}</b></span>
                ) : (
                  <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-muted-foreground/70"
                    title={bStored > 0
                      ? `创5日新低家数：逐日沉淀管线已在跑（本库已攒 ${bStored}/5 个交易日），满 5 天才出数——不拿 4 天凑 5 天的口径`
                      : "创5日新低家数：要逐日收盘价沉淀才有的读数。收盘后调度器（breadth 任务）从部署日起攒，还没跑出第一批——不做「拿今天快照猜新低」这种假数"}>
                    {bStored > 0 ? `低5日 攒中 ${bStored}/5` : "低5日 暂无数据"}</span>
                )}
                {bLatest && bLatest.ma3_eligible > 0 ? (
                  <span className="rounded bg-white/[0.05] px-1.5 py-0.5"
                    title={`创3日新低 ${bLatest.new_low_3} 家（${bLatest.date} 收盘沉淀·分母是满 3 根的 ${bLatest.ma3_eligible} 只；并列最低算新低）`}>低3日 <b className="text-orange-300">{bLatest.new_low_3}</b></span>
                ) : (
                  <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-muted-foreground/70"
                    title={bStored > 0
                      ? `创3日新低家数：已攒 ${bStored}/3 个交易日，满 3 天出数（比 5 日口径早两个交易日）`
                      : "创3日新低家数：同上，逐日收盘价沉淀未跑过第一批，缺就明说"}>
                    {bStored > 0 ? `低3日 攒中 ${bStored}/3` : "低3日 暂无数据"}</span>
                )}
              </div>
            </div>
          </div>

          {/* P15-R2a 复盘统计：日期范围 + 加载按钮 + 三张图（成交额趋势/情绪5日线占比趋势/指数累计涨跌）。
              R2b 后 5日线占比那条吃 stock_daily_close 的逐日沉淀：攒够 2 个真实统计日才画线，攒不够如实报进度。 */}
          <div className="apple-card apple-fade-in p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[14px] font-medium">大盘复盘统计</div>
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <input type="date" value={trendFrom} max={trendTo || undefined} onChange={(e) => setTrendFrom(e.target.value)}
                  className="rounded-md border border-border/70 bg-white/[0.03] px-2 py-1 text-[12px] text-foreground [color-scheme:dark]" title="开始日期（不设=近 90 天）" />
                <span className="text-muted-foreground">至</span>
                <input type="date" value={trendTo} min={trendFrom || undefined} onChange={(e) => setTrendTo(e.target.value)}
                  className="rounded-md border border-border/70 bg-white/[0.03] px-2 py-1 text-[12px] text-foreground [color-scheme:dark]" title="结束日期（不设=至今）" />
                <button onClick={() => void loadTrend(trendFrom, trendTo)} disabled={trendBusy}
                  className="flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1.5 text-[12px] text-sky-200 transition-colors hover:bg-sky-400/15 disabled:opacity-50">
                  {trendBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 加载复盘数据统计
                </button>
              </div>
            </div>
            {trendError && <div className="mb-2 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-[12.5px] text-red-300">{trendError}</div>}
            {trend && !!trend.missing.length && (
              <div className="mb-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-200/90">
                {trend.missing.map((m, i) => <div key={i}>· {m}</div>)}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div className="rounded-xl border border-border/60 bg-white/[0.02] p-3">
                <div className="mb-1.5 text-[12.5px] font-medium">大盘成交额趋势</div>
                <TurnoverBars days={trend?.days ?? []} />
                <div className="mt-1 text-[10.5px] text-muted-foreground/70" title={trend?.source ?? ""}>
                  {trend ? `沪+深指数日成交额合计 · ${trend.range.from} ~ ${trend.range.to}（${trend.days.length} 个交易日）` : "未取数"}
                </div>
                {trend?.notes.map((n, i) => <div key={i} className="text-[10.5px] text-amber-200/70">· {n}</div>)}
              </div>
              <div className="rounded-xl border border-border/60 bg-white/[0.02] p-3">
                <div className="mb-1.5 text-[12.5px] font-medium">大盘情绪（5日线占比）趋势</div>
                {bPoints.length >= 2 ? (
                  <>
                    <BreadthPctLine points={bPoints} />
                    <div className="mt-1 text-[10.5px] text-muted-foreground/70" title={breadth?.caliber ?? ""}>
                      站上5日线占比 · {bPoints.length} 个真实统计日（自 {bPoints[0].date} 起逐日沉淀·无回填）
                    </div>
                  </>
                ) : bPoints.length === 1 ? (
                  <div className="flex h-[150px] flex-col items-center justify-center gap-1 text-center text-[11.5px] text-muted-foreground">
                    <span>首日读数 {bPoints[0].above_ma5_pct?.toFixed(1)}%（{bPoints[0].date}）</span>
                    <span className="max-w-[220px] text-[10.5px] leading-4">趋势要两个点以上才成立：现在只攒出 1 个真实统计日，不画「一条横线冒充趋势」。</span>
                  </div>
                ) : (
                  <div className="flex h-[150px] flex-col items-center justify-center gap-1 text-center text-[11.5px] text-muted-foreground">
                    <span>暂无数据{bStored > 0 ? `（已攒 ${bStored}/5 个交易日）` : ""}</span>
                    <span className="max-w-[220px] text-[10.5px] leading-4">
                      「高于5日线占比」要逐日沉淀全A收盘对 5 日线的关系（收盘后调度器 breadth 任务，自部署日起攒、不回填）：图画出来那天起才是真数，不拿别的东西冒充趋势。
                    </span>
                  </div>
                )}
              </div>
              <div className="rounded-xl border border-border/60 bg-white/[0.02] p-3">
                <div className="mb-1.5 text-[12.5px] font-medium">指数区间累计涨跌</div>
                <IndexCumLines cum={trend?.cum ?? null} />
                <div className="mt-1 text-[10.5px] text-muted-foreground/70">{trend ? `按区间首日收盘归一（首日=0%）· ${trend.range.from} ~ ${trend.range.to}` : "未取数"}</div>
              </div>
            </div>
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
              <Card label="成交额" value={
                sent.amount_known === 0 ? (
                  <span className="text-[13px] font-normal text-muted-foreground" title="快照里没有任何一只票带成交额读数——合计 0 是「没抓到」不是「成交 0 亿」">暂无数据</span>
                ) : (
                  // P14 对齐稳智格式：≥万亿显 X.XX 万亿。vs昨日不硬凑——数据源不提供昨日全市场成交额字段，缺就是缺
                  <span title={`全A快照合计口径（${sent.amount_known} 只有成交额读数）；数据源无「昨日全市场成交额」字段，不做 vs 昨日对比`}>
                    {sent.amount_total_yi >= 10000 ? `${(sent.amount_total_yi / 1e4).toFixed(2)} 万亿` : `${sent.amount_total_yi.toFixed(0)} 亿`}
                  </span>
                )
              } />
              <Card label="主力净额" value={<span className={sent.main_net_sum_yi >= 0 ? "text-red-400" : "text-emerald-400"}>{sent.main_net_sum_yi >= 0 ? "+" : ""}{sent.main_net_sum_yi.toFixed(0)} 亿</span>} />
              <Card label="中位涨跌" value={<PctText value={sent.median_pct} />} />
              <Card label="涨跌比" value={(sent.decliners > 0 ? sent.advancers / sent.decliners : 99).toFixed(2)} />
              <Card label="炸板率" value={<>{sent.break_rate === null ? "—" : `${sent.break_rate.toFixed(0)}%`}<span className="ml-1.5 text-[11px] font-normal text-muted-foreground">炸 {sent.limit_up_broken}</span></>} />
            </div>
          </div>

          {/* 情绪温度详情（P11）：四分量加权与监控卡同一份 temp/regime——上面切三态，这里分量权重同步变 */}
          {temp && (
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
          )}

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
              {/* P14 对齐稳智连板分档：三/四/五板+ 计数从「3连板+」名单实数推（capped 20+ 计入五板+），不是新读数；
                  P15-R2a 起分档推导上移到组件顶部，监控卡与这里同一份 */}
              {tiers && tiers.tiers.some((t) => t.stocks.length > 0) && (
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground"
                  title={`涨停 ${tiers.limit_up_count}（触板 ${tiers.touched_count}）· 跌停 ${sent.limit_down} · 三板 ${n3} · 四板 ${n4} · 五板+ ${n5}——分档按连板数实数归档（20+ 计入五板+）`}>
                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5">涨停 <b className="text-red-400">{tiers.limit_up_count}</b></span>
                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5">跌停 <b className="text-emerald-400">{sent.limit_down}</b></span>
                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5">三板 <b>{n3}</b></span>
                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5">四板 <b>{n4}</b></span>
                    <span className="rounded-full bg-orange-400/10 px-2 py-0.5 text-orange-300">五板+ <b>{n5}</b></span>
                </div>
              )}
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
// compact=true 是监控卡里的迷你版（P15-R2a 用户口径：同款灰卡+顶部四卡，表盘要缩得进窄卡）。
function TempGauge({ value, label, compact = false }: { value: number | null; label: string; compact?: boolean }) {
  const w = compact ? 96 : 200;
  const h = compact ? 60 : 118;
  // 完整版几何与 P11 一字不动（cy=96 给下方数字行留位）；compact 是等比缩到 96×60
  const cx = w / 2, cy = compact ? 56 : 96, r = compact ? 38 : 74;
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
    <div className="relative shrink-0" style={{ width: w }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`情绪温度 ${value ?? "无读数"}`}>
        {bands.map((b) => (
          <path key={b.from} d={arc(b.from + 0.8, b.to - 0.8)} stroke={b.color}
            strokeOpacity={value === null ? 0.2 : b.color === active ? 0.95 : 0.3}
            strokeWidth={compact ? 6 : 10} fill="none" strokeLinecap="round" />
        ))}
        {needle && <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke={active} strokeWidth={compact ? 2.5 : 3} strokeLinecap="round" />}
        {needle && <circle cx={cx} cy={cy} r={compact ? 3 : 4.5} fill={active} />}
      </svg>
      {!compact && (
        <div className="absolute inset-x-0 bottom-0 text-center">
          <span className="text-[30px] font-semibold tracking-tight" style={{ color: value === null ? undefined : active }}>
            {value === null ? "—" : value}
          </span>
          <span className="ml-1 text-[12px] text-muted-foreground">{value === null ? "无读数" : `/ 100 · ${label}`}</span>
        </div>
      )}
    </div>
  );
}

// ---------- P15-R2a 图表：手绘 SVG（不引图表库，项目零新依赖口径） ----------
// 画法对齐稳智那两张图的意思，但守本页纪律：缺读数的日子留缝不画柱（不拉平到 0），
// 每根柱子 hover 出「日期 · 沪/深/合计」三个数，图注自报窗口与来源。

const CHART_W = 600, CHART_H = 150, CHART_PAD = 6;

/** 大盘成交额趋势：柱=两市合计（亿），线=合计的 5 日均线（稳智同款「柱+线」语汇） */
function TurnoverBars({ days }: { days: TrendDayPoint[] }) {
  const pts = days.filter((d) => d.totalYi !== null);
  if (!pts.length) {
    return <div className="flex h-[150px] items-center justify-center text-[11.5px] text-muted-foreground" title="趋势数据未取到或两市没配齐过一天">暂无数据</div>;
  }
  const max = Math.max(...pts.map((d) => d.totalYi as number)) * 1.08;
  const band = (CHART_W - CHART_PAD * 2) / days.length;
  const idxOf = new Map(days.map((d, i) => [d.date, i]));
  // 5 日均线只在窗口内能凑满 5 个配对日的点上画——窗口头部少于 5 根不硬画半截线
  const ma = pts.map((d, i) => {
    const win = pts.slice(Math.max(0, i - 4), i + 1);
    return { date: d.date, v: win.reduce((s, p) => s + (p.totalYi as number), 0) / win.length, ok: i >= 4 };
  }).filter((p) => p.ok);
  const x = (date: string) => CHART_PAD + (idxOf.get(date) ?? 0) * band + band / 2;
  const y = (v: number) => CHART_H - 18 - (v / max) * (CHART_H - 30);
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" role="img" aria-label="大盘成交额趋势">
      <line x1={CHART_PAD} y1={CHART_H - 18} x2={CHART_W - CHART_PAD} y2={CHART_H - 18} stroke="currentColor" strokeOpacity={0.2} />
      {days.map((d) => (d.totalYi === null ? null : (
        <rect key={d.date} x={x(d.date) - Math.max(1.5, band * 0.32)} y={y(d.totalYi)}
          width={Math.max(3, band * 0.64)} height={CHART_H - 18 - y(d.totalYi)} rx={1.5}
          className="fill-sky-400/70">
          <title>{`${d.date} 合计 ${(d.totalYi / 1e4).toFixed(2)} 万亿（沪 ${d.shYi === null ? "缺" : (d.shYi / 1e4).toFixed(2)} / 深 ${d.szYi === null ? "缺" : (d.szYi / 1e4).toFixed(2)} 万亿）`}</title>
        </rect>
      )))}
      {ma.length > 1 && (
        <polyline fill="none" stroke="#fb923c" strokeOpacity={0.9} strokeWidth={1.6}
          points={ma.map((p) => `${x(p.date).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} />
      )}
      <text x={CHART_PAD} y={11} className="fill-current text-[9px]" fill="#fb923c" opacity={0.85}>— 5 日均线</text>
      <text x={CHART_PAD} y={CHART_H - 5} className="fill-current" fontSize={9} opacity={0.55}>{pts[0].date}</text>
      <text x={CHART_W - CHART_PAD} y={CHART_H - 5} textAnchor="end" fontSize={9} opacity={0.55}>{pts[pts.length - 1].date}</text>
    </svg>
  );
}

/** 指数区间累计涨跌：三条线按区间首日归一（首日=0%），图例带区间末实数 */
function IndexCumLines({ cum }: { cum: TrendClient["cum"] | null }) {
  const series = cum ? [
    { name: "上证", color: "#f87171", pts: cum.sh },
    { name: "深成", color: "#38bdf8", pts: cum.sz },
    { name: "创业板", color: "#fbbf24", pts: cum.cyb },
  ].filter((s) => s.pts.length > 1) : [];
  if (!series.length) {
    return <div className="flex h-[150px] items-center justify-center text-[11.5px] text-muted-foreground" title="至少一条指数的区间读数都没取到时画空图没有意义">暂无数据</div>;
  }
  const dates = [...new Set(series.flatMap((s) => s.pts.map((p) => p.date)))].sort();
  const vals = series.flatMap((s) => s.pts.map((p) => p.pct));
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (d: string) => CHART_PAD + (dates.indexOf(d) / Math.max(1, dates.length - 1)) * (CHART_W - CHART_PAD * 2);
  const y = (v: number) => 14 + (1 - (v - lo) / span) * (CHART_H - 34);
  return (
    <div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" role="img" aria-label="指数区间累计涨跌">
        <line x1={CHART_PAD} y1={y(0)} x2={CHART_W - CHART_PAD} y2={y(0)} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" />
        {series.map((s) => (
          <polyline key={s.name} fill="none" stroke={s.color} strokeWidth={1.6} strokeOpacity={0.95}
            points={s.pts.map((p) => `${x(p.date).toFixed(1)},${y(p.pct).toFixed(1)}`).join(" ")} />
        ))}
        <text x={CHART_PAD} y={CHART_H - 5} fontSize={9} opacity={0.55}>{dates[0]}</text>
        <text x={CHART_W - CHART_PAD} y={CHART_H - 5} textAnchor="end" fontSize={9} opacity={0.55}>{dates[dates.length - 1]}</text>
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-[10.5px] text-muted-foreground">
        {series.map((s) => (
          <span key={s.name}><i className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: s.color }} />
            {s.name} <b style={{ color: s.color }}>{s.pts[s.pts.length - 1].pct >= 0 ? "+" : ""}{s.pts[s.pts.length - 1].pct.toFixed(2)}%</b></span>
        ))}
      </div>
    </div>
  );
}

// P15-R2b：站上5日线占比折线。点集只收 pct 非 null 的真实统计日（攒不满 5 根的日子不进图，
// 也不会被 0 补上——线断在第一天是事实，不是画漏了）。y 轴固定 0-100%：占比就这个量纲，不自动缩放夸大波动。
function BreadthPctLine({ points }: { points: { date: string; above_ma5_pct: number | null }[] }) {
  const pts = points.filter((p): p is { date: string; above_ma5_pct: number } => p.above_ma5_pct !== null);
  if (pts.length < 2) return null;
  const x = (i: number) => CHART_PAD + (i / (pts.length - 1)) * (CHART_W - CHART_PAD * 2);
  const y = (v: number) => 14 + (1 - v / 100) * (CHART_H - 34);
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" role="img" aria-label="大盘情绪（5日线占比）趋势">
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={CHART_PAD} y1={y(g)} x2={CHART_W - CHART_PAD} y2={y(g)} stroke="currentColor" strokeOpacity={g === 50 ? 0.25 : 0.1} strokeDasharray={g === 50 ? "3 3" : undefined} />
          <text x={CHART_PAD} y={y(g) - 2} fontSize={8} opacity={0.45}>{g}%</text>
        </g>
      ))}
      <polyline fill="none" stroke="#34d399" strokeWidth={1.8} points={pts.map((p, i) => `${x(i).toFixed(1)},${y(p.above_ma5_pct).toFixed(1)}`).join(" ")} />
      {pts.map((p, i) => (
        <circle key={p.date} cx={x(i)} cy={y(p.above_ma5_pct)} r={2.2} fill="#34d399">
          <title>{`${p.date} 站上5日线 ${p.above_ma5_pct.toFixed(1)}%`}</title>
        </circle>
      ))}
      <text x={CHART_PAD} y={CHART_H - 5} fontSize={9} opacity={0.55}>{pts[0].date}</text>
      <text x={CHART_W - CHART_PAD} y={CHART_H - 5} textAnchor="end" fontSize={9} opacity={0.55}>{last.date}</text>
      <text x={CHART_W - CHART_PAD - 4} y={y(last.above_ma5_pct) - 6} textAnchor="end" fontSize={10} fill="#34d399">{last.above_ma5_pct.toFixed(1)}%</text>
    </svg>
  );
}
