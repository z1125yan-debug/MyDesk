"use client";
// P36-C 战绩页（2026-10-01）+ P39 / #75 两层漏斗拆分
//
// 这一页只回答一个问题：**跟着推荐走，到底赚没赚。**
// 所以页面上每一个数字都是已经走完的行情算出来的——没有一个是预测。
// 口径（与回测同一套，写在卡片上，不许只显示裸数字）：
//   第二天开盘价买入 → 第三天开盘价卖出 → 扣掉手续费印花税滑点；
//   第二天一字涨停或停牌买不进的票直接剔除，不算「收益 0」；
//   及格线是同一天全A个股的中位收益（跑不赢它 = 白干）。
//
// P39 / #75 两层：策略选股（第一层，被稀释的平均）与 AI优选（第二层，从候选里收窄的聚焦子集）
// 分别给汇总 / 净值 / 明细；AI优选当天没生成时据实说「未运行」，不拿第一层的数字冒充。
//
// 说人话纪律（任务书第 0 节）：不出现「样本外/净值曲线/截面/IC/超额」这类词；
// 「净值」这个词保留但要跟上「本金 1 块变成几块」的解释。

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Loader2, ChevronDown, ChevronRight } from "lucide-react";
import AiPickDecisionCards from "@/components/desk/AiPickDecisionCards";
import MarketScopeBadge from "@/components/desk/MarketScopeBadge";
import { parseAiPickNote } from "@/lib/quant/strategy/ai-pick-note";

interface NavPoint { tradeDate: string; nav: number; benchNav: number; hasSample: boolean }

interface RowDetail { symbol: string; net: number | null; reason: string | null }

interface TrackRow {
  tradeDate: string; regime: string; strategyName: string; source: string;
  symbols: string[]; symbolsNote: string | null; filled: boolean;
  win: number | null; up: number | null; count: number | null; skipped: number | null;
  bench: number | null; basis: string | null; detail: RowDetail[];
}

interface LayerSummary {
  rows: number; withSymbols: number; filled: number; pending: number;
  days: number; targetDays: number; enough: boolean;
  symCount: number; symUp: number; symWinPct: number | null;
  avgNet: number | null; benchAvgNet: number | null;
  navNow: number | null; benchNavNow: number | null; costPct: number; basis: string;
}

interface ShadowStat { mean: number; median: number; winRate: number; count: number; benchMean: number | null; sellDate: string }
interface ShadowRow {
  tradeDate: string; regime: string; strategyName: string;
  symbols: { symbol: string; name: string; close: number | null; ret20: number | null; devMa20: number | null }[];
  symbolsNote: string | null;
  h1: ShadowStat | null; h5: ShadowStat | null; h20: ShadowStat | null;
  detail: { symbol: string; net1: number | null; net5: number | null; net20: number | null }[];
  remainingDays: number;
}
interface ShadowLayer {
  status: string;
  summary: {
    days: number; emptyDays: number; matured: number;
    h1AvgMean: number | null; h5AvgMean: number | null; h20AvgMean: number | null;
    h20BatchWinPct: number | null; navNow: number | null; benchNavNow: number | null; basis: string;
  };
  nav: NavPoint[];
  byRegime: { regime: string; batches: number; empty: number; h1Mean: number | null; h5Mean: number | null; h20Mean: number | null }[];
  rows: ShadowRow[];
}

interface TrackData {
  ok: boolean; error?: string;
  layers?: {
    strategy: { summary: LayerSummary; nav: NavPoint[]; pending: { tradeDate: string; strategyName: string; reason: string }[]; rows: TrackRow[]; status: string };
    aiPick: { summary: LayerSummary; nav: NavPoint[]; pending: { tradeDate: string; strategyName: string; reason: string }[]; rows: TrackRow[]; status: string };
    shadow?: ShadowLayer;
  };
  aiPickStatus?: string;
}

const pct = (x: number | null, digits = 2): string =>
  x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%`;

/** 两条折线：跟单（蓝）vs 全A中位（灰）。点数少的时候也照画，不插值、不平滑 */
function NavChart({ nav }: { nav: NavPoint[] }) {
  const W = 720, H = 180, PAD = 22;
  if (nav.length < 2) {
    return (
      <div className="flex h-[180px] items-center justify-center rounded-lg border border-dashed border-border text-[12.5px] text-muted-foreground">
        至少要有两天成绩才画得出这条线（现在 {nav.length} 天）
      </div>
    );
  }
  const vals = nav.flatMap((p) => [p.nav, p.benchNav]);
  const lo = Math.min(...vals, 1), hi = Math.max(...vals, 1);
  const span = Math.max(hi - lo, 0.02);
  const xOf = (i: number) => PAD + (i * (W - PAD * 2)) / (nav.length - 1);
  const yOf = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const line = (get: (p: NavPoint) => number) =>
    nav.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(get(p)).toFixed(1)}`).join(" ");
  const y1 = yOf(1);
  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} className="min-w-full">
        <line x1={PAD} y1={y1} x2={W - PAD} y2={y1} stroke="currentColor" className="text-border" strokeDasharray="4 4" />
        <path d={line((p) => p.nav)} fill="none" stroke="#3b82f6" strokeWidth={2} />
        <path d={line((p) => p.benchNav)} fill="none" stroke="#9ca3af" strokeWidth={1.5} strokeDasharray="5 3" />
        {nav.map((p, i) => <circle key={p.tradeDate} cx={xOf(i)} cy={yOf(p.nav)} r={2} fill="#3b82f6" />)}
        <text x={PAD} y={12} className="fill-muted-foreground text-[10px]">
          本金 1 块 → 现在 {nav[nav.length - 1]?.nav.toFixed(3)} 块（灰线=随便买只票）
        </text>
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="inline-block h-[2px] w-4 bg-blue-500" />跟着推荐买</span>
        <span className="flex items-center gap-1"><span className="inline-block h-[2px] w-4 bg-gray-400" />同一天随便买只票（及格线）</span>
        <span>横轴：交易日；纵轴：本金变成几倍</span>
      </div>
    </div>
  );
}

/** 某只票的次日均净（展示用，null 一律「—」） */
function winSafely(r: TrackRow): number | null {
  return typeof r.win === "number" && Number.isFinite(r.win) ? r.win : null;
}

function sourceLabel(source: string): string {
  if (source === "ai_pick") return "AI优选";
  if (source === "regime") return "分档推荐";
  return "闸门推荐";
}

function LayerBlock({
  title, subtitle, accent, layer, open, setOpen, onGenerate, generating,
}: {
  title: string; subtitle: string; accent: string;
  layer: { summary: LayerSummary; nav: NavPoint[]; pending: { tradeDate: string; strategyName: string; reason: string }[]; rows: TrackRow[]; status: string };
  open: Record<string, boolean>;
  setOpen: Dispatch<SetStateAction<Record<string, boolean>>>;
  onGenerate?: () => void;
  generating?: boolean;
}) {
  const s = layer.summary;
  const byDate = useMemo(() => {
    const m = new Map<string, TrackRow[]>();
    for (const r of layer.rows) {
      const arr = m.get(r.tradeDate) ?? [];
      arr.push(r);
      m.set(r.tradeDate, arr);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [layer.rows]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={`text-[13px] font-semibold ${accent}`}>{title}</span>
        <span className="text-[11.5px] text-muted-foreground">{subtitle}</span>
        {onGenerate && (
          <button onClick={onGenerate} disabled={generating || layer.status === "not_configured"}
            className="ml-auto rounded-md border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[12px] text-amber-200 hover:bg-amber-400/20 disabled:opacity-50">
            {generating ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : null}
            {generating ? "生成中…" : "生成今日 AI 优选战绩池"}
          </button>
        )}
      </div>

      {layer.status === "not_configured" && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[12.5px] text-amber-200/90">
          还没配置服务端模型通道，没法自动跑 AI优选（所以这一层是空的，不是「跑输了」）。
          到「设置 → AI 接口」填好 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL_NAME 后重启，收盘后会自动从当日候选里收窄出这份战绩。
        </div>
      )}
      {layer.status === "empty" && (
        <div className="rounded-lg border border-dashed border-border/70 p-3 text-[12.5px] text-muted-foreground">
          这一天还没有 AI优选战绩（可能当日没有候选，或还没生成）。点「生成今日 AI 优选战绩池」用服务端模型从当日候选里收窄一份；
          生成后第二、第三天走完会自动回填，和策略选股同一套口径。
        </div>
      )}

      {layer.status === "ok" && (
        <>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div>
                <div className="text-[12px] text-muted-foreground">已经攒了多少天</div>
                <div className="text-[20px] font-bold">{s.days} <span className="text-[12.5px] font-normal text-muted-foreground">/ {s.targetDays} 天</span></div>
                <div className="text-[11.5px] text-muted-foreground">
                  {s.enough ? "够 20 天了，胜率才有意义" : `还差 ${s.targetDays - s.days} 天，少于 20 天数字只是参考`}
                </div>
              </div>
              <div>
                <div className="text-[12px] text-muted-foreground">跟着买，本金变成</div>
                <div className="text-[20px] font-bold text-blue-400">{s.navNow == null ? "—" : `${s.navNow.toFixed(3)} 倍`}</div>
                <div className="text-[11.5px] text-muted-foreground">随便买只票现在是 {s.benchNavNow == null ? "—" : `${s.benchNavNow.toFixed(3)} 倍`}</div>
              </div>
              <div>
                <div className="text-[12px] text-muted-foreground">推的票里赚钱的比例</div>
                <div className="text-[20px] font-bold">{s.symWinPct == null ? "—" : `${s.symWinPct.toFixed(1)}%`}</div>
                <div className="text-[11.5px] text-muted-foreground">共 {s.symCount} 笔，赚了 {s.symUp} 笔</div>
              </div>
              <div>
                <div className="text-[12px] text-muted-foreground">平均每笔（扣掉手续费后）</div>
                <div className={"text-[20px] font-bold " + ((s.avgNet ?? 0) >= 0 ? "text-rose-400" : "text-emerald-500")}>{pct(s.avgNet)}</div>
                <div className="text-[11.5px] text-muted-foreground">同期随便买一只 {pct(s.benchAvgNet)}</div>
              </div>
            </div>
            <div className="mt-3 border-t border-dashed border-border/60 pt-2 text-[11.5px] leading-relaxed text-muted-foreground">
              {s.basis}　每买卖一次来回要交约 {s.costPct}%。
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 text-[13.5px] font-semibold">跟单 vs 随便买（本金 1 块起）</div>
            <NavChart nav={layer.nav} />
          </div>

          {s.pending > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-[12.5px] text-amber-200/90">
              还有 {s.pending} 条没回填（后面两个交易日没走完，或者当时没记具体票）。走完会自动补，不能手工填。
              {!!layer.pending.length && (
                <ul className="mt-1.5 space-y-0.5 text-[11.5px] text-muted-foreground">
                  {layer.pending.slice(0, 6).map((p, i) => <li key={i}>{p.tradeDate}　{p.strategyName}：{p.reason}</li>)}
                </ul>
              )}
            </div>
          )}

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 text-[13.5px] font-semibold">逐条明细（点开看每只票）</div>
            <div className="space-y-1.5">
              {byDate.map(([date, rows]) => (
                <div key={date} className="rounded-lg border border-border/60">
                  <button onClick={() => setOpen((m) => ({ ...m, [date]: !m[date] }))}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-accent/40">
                    {open[date] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="font-medium">{date}</span>
                    <span className="text-[11.5px] text-muted-foreground">{rows[0]?.regime || "档位未知"}期 · {rows.length} 条推荐</span>
                    <span className="ml-auto text-[12px]">
                      {(() => {
                        const done = rows.filter((r) => r.filled && r.win != null);
                        if (!done.length) return <span className="text-muted-foreground">还没出成绩</span>;
                        const avg = done.reduce((a, r) => a + (r.win as number), 0) / done.length;
                        return <span className={(avg >= 0 ? "text-rose-400" : "text-emerald-500")}>平均 {pct(avg)}</span>;
                      })()}
                    </span>
                  </button>
                  {open[date] && (
                    <div className="space-y-2 border-t border-border/60 px-3 py-2">
                      {rows.map((r, i) => {
                        // AI优选行：symbolsNote 是 11 字段拼成的扁平文本，解析回分格卡片展示；
                        // 解析不出（旧格式）时 cards 为空，保留原文本展示，不冒充有卡。
                        const cards = r.source === "ai_pick" ? parseAiPickNote(r.symbolsNote) : [];
                        return (
                        <div key={i} className="text-[12.5px]">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{r.strategyName}</span>
                            <span className="text-[11px] text-muted-foreground">{sourceLabel(r.source)}</span>
                            {r.filled ? (
                              <span className="text-[11.5px]">
                                推了 {r.count} 只（{r.up} 只赚）· 平均 {pct(winSafely(r))} · 同期随便买 {pct(r.bench)}
                                {r.skipped ? `　${r.skipped} 只买不进已剔除` : ""}
                              </span>
                            ) : (
                              <span className="text-[11.5px] text-muted-foreground">
                                {cards.length ? "决策见下方 11 字段卡片" : (r.symbolsNote || "还没出成绩")}
                              </span>
                            )}
                          </div>
                          {!!r.detail.length && (
                            <div className="mt-1 flex flex-wrap gap-1.5 pl-1">
                              {r.detail.map((d, k) => (
                                <span key={k} className={"rounded px-1.5 py-0.5 text-[11px] " +
                                  (d.net == null ? "bg-muted text-muted-foreground" : d.net >= 0 ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300")}>
                                  {d.symbol} {d.net == null ? (d.reason ?? "没买到") : pct(d.net, 2)}
                                </span>
                              ))}
                            </div>
                          )}
                          {!!r.basis && <div className="mt-1 text-[11px] text-muted-foreground">{r.basis}</div>}
                          {r.source === "ai_pick" && <AiPickDecisionCards note={r.symbolsNote} />}
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
              {!byDate.length && <div className="py-6 text-center text-[12.5px] text-muted-foreground">还没有任何推荐记录。</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 影子版（第三层，2026-10-24 规格书）：纯机械规则，与正式版同表对照。
 *  口径和正式版不一样：信号日收盘买、持有 1/5/20 天三档，主考核 20 天那档；
 *  正式版是第二天开盘买、第三天开盘卖（看 1 天）。两边 T+1 那档勉强可比，页面上并排写清，不混着说。 */
function ShadowBlock({ layer, formalAvgNet }: { layer: ShadowLayer; formalAvgNet: number | null }) {
  const s = layer.summary;
  const statLine = (label: string, st: ShadowStat | null) =>
    st == null ? `${label} 还没到期` : `${label} 平均 ${pct(st.mean)}（中位 ${pct(st.median)}，${st.count} 只里 ${st.winRate.toFixed(0)}% 赚钱，同期上证 ${pct(st.benchMean)}）`;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-sky-300">影子版（机械规则）</span>
        <span className="text-[11.5px] text-muted-foreground">不看新闻、不问模型：每天收盘按固定条件筛票，和正式版同台对账</span>
      </div>
      <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-3 text-[12px] leading-relaxed text-muted-foreground">
        影子版为机械规则回测口径，历史年化不构成收益承诺。已知风险：跌深的票在大盘暴跌那几天跌得更狠（先挨打、等 20 天尺度的反弹，短期会比正式版难看）；每天开的仓位高度相关，一段行情的好坏会同时决定很多份的成绩。
      </div>
      {layer.status === "empty" ? (
        <div className="rounded-lg border border-dashed border-border/70 p-3 text-[12.5px] text-muted-foreground">
          影子版还没有落第一行。每个交易日收盘后自动按规则出票（强势挑涨势刚起的、震荡和弱势只在跌深时出手），落库后这里开始记账，20 天后出第一份主成绩。
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div>
                <div className="text-[12px] text-muted-foreground">已经记了多少天</div>
                <div className="text-[20px] font-bold">{s.days} <span className="text-[12.5px] font-normal text-muted-foreground">天</span></div>
                <div className="text-[11.5px] text-muted-foreground">其中空仓 {s.emptyDays} 天（没符合条件的票，或震荡档闸门关着）</div>
              </div>
              <div>
                <div className="text-[12px] text-muted-foreground">组合本金变成（只算已到期）</div>
                <div className="text-[20px] font-bold text-sky-300">{s.navNow == null ? "—" : `${s.navNow.toFixed(3)} 倍`}</div>
                <div className="text-[11.5px] text-muted-foreground">同样滚法买上证是 {s.benchNavNow == null ? "—" : `${s.benchNavNow.toFixed(3)} 倍`}；已到期 {s.matured} 份</div>
              </div>
              <div>
                <div className="text-[12px] text-muted-foreground">持有 20 天那档（主成绩）</div>
                <div className={"text-[20px] font-bold " + ((s.h20AvgMean ?? 0) >= 0 ? "text-rose-400" : "text-emerald-500")}>{pct(s.h20AvgMean)}</div>
                <div className="text-[11.5px] text-muted-foreground">到期批次里赚钱的占 {s.h20BatchWinPct == null ? "—" : `${s.h20BatchWinPct.toFixed(0)}%`}</div>
              </div>
              <div>
                <div className="text-[12px] text-muted-foreground">只持 1 天那档（和正式版对一眼）</div>
                <div className={"text-[20px] font-bold " + ((s.h1AvgMean ?? 0) >= 0 ? "text-rose-400" : "text-emerald-500")}>{pct(s.h1AvgMean)}</div>
                <div className="text-[11.5px] text-muted-foreground">正式版同口径平均 {pct(formalAvgNet)}（买入时点不同，只作参考）</div>
              </div>
            </div>
            <div className="mt-3 border-t border-dashed border-border/60 pt-2 text-[11.5px] leading-relaxed text-muted-foreground">{s.basis}</div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 text-[13.5px] font-semibold">按档位 × 持有期看（平均收益）</div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">大盘档位</th>
                    <th className="py-1 pr-3 font-medium">批数</th>
                    <th className="py-1 pr-3 font-medium">空仓</th>
                    <th className="py-1 pr-3 font-medium">持 1 天</th>
                    <th className="py-1 pr-3 font-medium">持 5 天</th>
                    <th className="py-1 font-medium">持 20 天</th>
                  </tr>
                </thead>
                <tbody>
                  {layer.byRegime.map((r) => (
                    <tr key={r.regime} className="border-t border-border/50">
                      <td className="py-1.5 pr-3 font-medium">{r.regime}</td>
                      <td className="py-1.5 pr-3">{r.batches}</td>
                      <td className="py-1.5 pr-3">{r.empty}</td>
                      <td className="py-1.5 pr-3">{pct(r.h1Mean)}</td>
                      <td className="py-1.5 pr-3">{pct(r.h5Mean)}</td>
                      <td className="py-1.5">{pct(r.h20Mean)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-1 text-[11.5px] text-muted-foreground">没到期的格子是「—」，不拿别的档顶替。</div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 text-[13.5px] font-semibold">影子组合 vs 上证（本金 1 块起，只算已到期份）</div>
            <NavChart nav={layer.nav} />
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 text-[13.5px] font-semibold">逐日名单</div>
            <div className="space-y-1.5">
              {layer.rows.map((r) => (
                <div key={r.tradeDate} className="rounded-lg border border-border/60 px-3 py-2 text-[12.5px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.tradeDate}</span>
                    <span className="text-[11.5px] text-muted-foreground">{r.regime}期 · {r.strategyName}</span>
                    <span className="ml-auto text-[12px]">
                      {r.h20 ? <span className={(r.h20.mean >= 0 ? "text-rose-400" : "text-emerald-500")}>20 天 {pct(r.h20.mean)}</span>
                        : r.symbols.length ? <span className="text-muted-foreground">持有中，剩余 {r.remainingDays} 日</span>
                        : <span className="text-muted-foreground">空仓</span>}
                    </span>
                  </div>
                  {!!r.symbols.length && (
                    <div className="mt-1 flex flex-wrap gap-1.5 pl-1">
                      {r.symbols.map((sm) => {
                        const d = r.detail.find((x) => x.symbol === sm.symbol);
                        const net = d?.net20 ?? d?.net5 ?? d?.net1;
                        return (
                          <span key={sm.symbol} className={"rounded px-1.5 py-0.5 text-[11px] " +
                            (net == null ? "bg-muted text-muted-foreground" : net >= 0 ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300")}>
                            {sm.name || sm.symbol} {sm.symbol.slice(0, 6)}{sm.ret20 != null ? ` 20日${sm.ret20 >= 0 ? "+" : ""}${sm.ret20.toFixed(1)}%` : ""}{net != null ? ` · ${pct(net)}` : ""}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div className="mt-1 text-[11.5px] text-muted-foreground">
                    {statLine("持1天", r.h1)}；{statLine("持5天", r.h5)}；{statLine("持20天", r.h20)}
                  </div>
                  {!!r.symbolsNote && <div className="mt-0.5 text-[11px] text-muted-foreground/80">{r.symbolsNote}</div>}
                </div>
              ))}
              {!layer.rows.length && <div className="py-6 text-center text-[12.5px] text-muted-foreground">还没有影子记录。</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function TrackRecordPage() {
  const [data, setData] = useState<TrackData | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/quant/trackrecord");
      const j = (await r.json()) as TrackData;
      if (!j?.ok) throw new Error((j as { error?: string }).error || "战绩读取失败");
      setData(j);
      setErr("");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const genAiPick = useCallback(async () => {
    setGenerating(true);
    try {
      await fetch("/api/quant/ai-pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch {
      /* 失败如实由接口 missing[] 说明，这里不阻断，刷新后看状态 */
    } finally {
      setGenerating(false);
      await load();
    }
  }, [load]);

  const strategy = data?.layers?.strategy;
  const aiPick = data?.layers?.aiPick;
  const shadow = data?.layers?.shadow;

  return (
    <div className="w-full space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">战绩</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            哪天推了哪几只票、第二天各自赚了多少，全都是已经走完的行情算出来的，不是预测。
          </p>
          <div className="mt-2"><MarketScopeBadge note="战绩仅统计 A 股选股/AI 优选，港股/美股选股不在本页统计" /></div>
        </div>
        <button onClick={() => void load()} disabled={loading}
          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-accent disabled:opacity-50">
          {loading ? <Loader2 size={13} className="animate-spin" /> : "刷新"}
        </button>
      </div>

      {err && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[13px] text-rose-300">{err}</div>}

      {strategy && (
        <LayerBlock title="策略选股（第一层）" subtitle="被稀释的「平均」：全市场候选过闸/分档后推的" accent="text-foreground"
          layer={strategy} open={open} setOpen={setOpen} />
      )}

      {aiPick && (
        <LayerBlock title="AI优选（第二层）" subtitle="从当日候选里收窄出的聚焦子集，理论上更可信" accent="text-amber-300"
          layer={aiPick} open={open} setOpen={setOpen} onGenerate={genAiPick} generating={generating} />
      )}

      {shadow && <ShadowBlock layer={shadow} formalAvgNet={aiPick?.summary.avgNet ?? null} />}

      {!data && !loading && !err && (
        <div className="py-16 text-center text-[13px] text-muted-foreground">没有战绩数据。</div>
      )}
    </div>
  );
}
