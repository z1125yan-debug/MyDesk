"use client";
// 个股资金画像（需求文档 P0：输入代码 → 全量数据 → 结构化报告；每块带数据源/状态）
import { useCallback, useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import Markdown from "../Markdown";
import DecisionCard from "../DecisionCard";
import { SourceBadge, PctText, NumText } from "../SourceBadge";
import { useDesk } from "@/lib/desk/store";
import { searchSymbols, normalizeTradingViewSymbol } from "@/lib/desk/market";
import { fetchStockProfile, aiChatTools, type ProfileResp } from "@/lib/desk/quant-api";
import { aiConfigured } from "@/lib/desk/ai";

const TECH_LABELS: Record<string, string> = {
  above_ma_5: "站上MA5", above_ma_10: "站上MA10", above_ma_20: "站上MA20", above_ma_60: "站上MA60", above_ma_144: "站上MA144",
  ma_struct: "均线多头", macd: "MACD柱", macd_cross: "MACD金叉", kdj_cross: "KDJ金叉", kdj_j: "KDJ-J",
  rsi_14: "RSI14", rsi_24: "RSI24", atr_ratio_14: "相对波动%", vwap20_filter: "站上VWAP20", vwap_pos: "VWAP偏离%",
  rps_50: "RPS50(子集)", rps_120: "RPS120(子集)", is_limit_up: "今日涨停", amount_yi: "成交额(亿)",
};

export default function ProfilePage() {
  const focusSymbol = useDesk((s) => s.focusSymbol);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const addWatch = useDesk((s) => s.addWatch);
  const ai = useDesk((s) => s.ai);
  const [input, setInput] = useState(focusSymbol);
  const [symbol, setSymbol] = useState(focusSymbol);
  const [data, setData] = useState<ProfileResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [suggest, setSuggest] = useState<{ symbol: string; name: string }[]>([]);
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const load = useCallback(async (sym: string) => {
    setBusy(true); setError(""); setAiText(""); setData(null);
    setFocusSymbol(sym);
    try {
      setData(await fetchStockProfile(sym));
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }, [setFocusSymbol]);

  useEffect(() => { if (symbol) load(symbol); }, [symbol, load]);

  // 搜索联想（真实搜索接口）
  useEffect(() => {
    const q = input.trim();
    if (!q || /^(\d{6})(\.(SH|SZ|BJ))?$/i.test(q)) { setSuggest([]); return; }
    const t = setTimeout(() => {
      searchSymbols(q).then((rows) => setSuggest(rows.slice(0, 6))).catch(() => setSuggest([]));
    }, 250);
    return () => clearTimeout(t);
  }, [input]);

  const submit = () => {
    const q = input.trim().toUpperCase();
    const m = /^(\d{6})$/.exec(q);
    // 补后缀不再在本页抄一份号段：全工程只有 intent-core.suffixOf 一处判交易所（经 normalizeTradingViewSymbol 转出）
    const sym = m ? normalizeTradingViewSymbol(m[1]) : q;
    if (/^\d{6}\.(SH|SZ|BJ)$/.test(sym)) setSymbol(sym);
    else setError("代码格式：688256 或 688256.SH");
  };

  const aiExplain = async () => {
    if (!data) return;
    setAiBusy(true); setAiText("");
    try {
      const b = data.blocks;
      const ctx = JSON.stringify({
        基本信息: { 代码: data.symbol, 名称: data.name, 行业: data.industry, 现价: b.quote?.data.price, 涨跌幅: b.quote?.data.changePct },
        盘口: b.depth?.data, 逐笔资金: b.trades?.data, 主力资金流: b.fundflow?.data?.days?.slice(-5),
        技术状态: b.tech?.data, 板块: b.sector?.data, 历史条件概率: b.probability?.data, 市场风险: b.risk?.data,
        数据缺失: data.missing,
      });
      const { content } = await aiChatTools(
        { provider: ai.provider, baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, proxy: ai.proxy },
        [{ role: "user", content: `以下是个股 ${data.symbol} ${data.name ?? ""} 的真实画像数据（JSON）。请输出：为什么处于当前状态（多空力量对照）、明日观察点、逻辑失效条件。严格区分【事实/模型推断/风险】，数据缺失项直接说「暂无数据」，不给买卖建议。\n${ctx}` }],
        { mode: "deep", focusSymbol: data.symbol },
      );
      setAiText(content);
    } catch (e) {
      setAiText(`AI 解读失败：${(e as Error).message}`);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      {/* 搜索条 */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submit(); }}
            placeholder="输入股票代码：688256 / 000001.SZ"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-sky-500/50"
          />
          {suggest.length > 0 && (
            <div className="absolute left-0 top-11 z-20 w-72 rounded-lg border border-border bg-popover p-1 shadow-lg">
              {suggest.map((s) => (
                <button key={s.symbol} onClick={() => { setInput(s.symbol); setSuggest([]); setSymbol(s.symbol); }}
                  className="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-xs hover:bg-accent">
                  <span>{s.name}</span><span className="font-mono text-muted-foreground">{s.symbol}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={submit} className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-400">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} 生成画像
        </button>
        {data && (
          <button onClick={() => addWatch({ symbol: data.symbol, name: data.name ?? data.symbol, kind: "watch" })}
            className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:border-sky-500/40 hover:text-sky-300">
            + 自选
          </button>
        )}
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      {data && (
        <>
          {/* 头部 */}
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-xl font-bold">{data.symbol}</div>
            <div className="text-lg">{data.name ?? "—"}{data.industry ? <span className="ml-2 text-xs text-muted-foreground">{data.industry}</span> : null}</div>
            {data.blocks.quote && (
              <>
                <div className="text-2xl font-bold"><NumText value={data.blocks.quote.data.price} /></div>
                <PctText value={data.blocks.quote.data.changePct} className="text-lg font-semibold" />
              </>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <SourceBadge status={data.blocks.quote ? data.blocks.quote.status : "OFFLINE"} source={data.blocks.quote?.source} time={data.as_of.slice(11, 19)} />
              <span className="text-[10.5px] text-muted-foreground">{data.session.label}</span>
            </div>
          </div>

          {data.missing.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
              以下数据块暂缺（不参与结论，不冒充实数）：{data.missing.join("；")}
            </div>
          )}

          {/* 四维决策结论（P7-④）：独立取数，慢不阻塞下面的画像区块 */}
          <DecisionCard symbol={data.symbol} />

          {/* 资金状态 */}
          <Section title="📊 资金状态" badge={data.blocks.trades?.source ?? data.blocks.fundflow?.source}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {data.blocks.trades ? (
                <>
                  <Cell label="主动买入(逐笔)" value={`+${data.blocks.trades.data.buyAmountYi.toFixed(2)} 亿`} cls="text-red-500" />
                  <Cell label="主动卖出(逐笔)" value={`-${data.blocks.trades.data.sellAmountYi.toFixed(2)} 亿`} cls="text-emerald-500" />
                  <Cell label="主动净额" value={`${data.blocks.trades.data.netYi >= 0 ? "+" : ""}${data.blocks.trades.data.netYi.toFixed(2)} 亿`} cls={data.blocks.trades.data.netYi >= 0 ? "text-red-500" : "text-emerald-500"} />
                  <Cell label="外盘 / 内盘" value={`${(data.blocks.trades.data.outerHand / 10000).toFixed(1)}万 / ${(data.blocks.trades.data.insideHand / 10000).toFixed(1)}万手`} />
                </>
              ) : <Empty span={4} text="逐笔主动买卖：暂无数据（eltdx 网关未运行）" />}
            </div>
            {data.blocks.trades?.note && <div className="mt-1.5 text-[10px] text-muted-foreground/70">口径说明：{data.blocks.trades.note}</div>}
            {data.blocks.fundflow ? (
              <div className="mt-3">
                {(() => {
                  const days = data.blocks.fundflow!.data.days;
                  const today = data.blocks.fundflow!.data.todayYi;
                  if (days.length < 2) {
                    // 数据源被限流时只有 1 日数据：不做图表（避免无信息色带），直接给数值+说明
                    return (
                      <div className="rounded-lg bg-accent/40 px-3 py-2 text-[11.5px]">
                        <span className="text-muted-foreground">近14日主力净额序列仅获取到 {days.length} 日（东财接口被限流，恢复后自动补齐）。</span>{" "}
                        <span>今日主力净额：</span>
                        <span className={(today ?? 0) >= 0 ? "font-semibold text-red-500" : "font-semibold text-emerald-500"}>{(today ?? 0).toFixed(2)} 亿</span>
                      </div>
                    );
                  }
                  const maxAbs = Math.max(...days.map((d) => Math.abs(d.value)), 0.01);
                  return (
                    <>
                      <div className="mb-1 text-[11px] text-muted-foreground">
                        近14日主力净额（东财，今日 <span className={(today ?? 0) >= 0 ? "text-red-500" : "text-emerald-500"}>{(today ?? 0).toFixed(2)} 亿</span>）
                      </div>
                      <div className="relative h-20 overflow-x-auto desk-scroll">
                        <div className="flex h-full min-w-full items-center gap-[3px]">
                          {days.map((d) => {
                            const h = Math.max(3, (Math.abs(d.value) / maxAbs) * 38);
                            return (
                              <div key={d.date} className="relative flex h-full flex-1 min-w-[14px] flex-col justify-center" title={`${d.date}: ${d.value.toFixed(2)} 亿`}>
                                <div className="absolute left-0 right-0 top-1/2 h-px bg-border/60" />
                                {d.value >= 0 ? (
                                  <div className="relative rounded-sm bg-red-500/70" style={{ height: `${h}px`, transform: "translateY(calc(-50% - 0.5px))" }} />
                                ) : (
                                  <div className="relative rounded-sm bg-emerald-500/70" style={{ height: `${h}px`, transform: "translateY(calc(50% + 0.5px))" }} />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div className="mt-0.5 flex justify-between text-[9.5px] text-muted-foreground/60">
                        <span>{days[0]?.date}</span><span>{days.at(-1)?.date}</span>
                      </div>
                    </>
                  );
                })()}
              </div>
            ) : <Empty text="主力资金流：暂无数据" />}
            {data.blocks.depth ? (
              <div className="mt-3 grid grid-cols-2 gap-4 text-[11.5px]">
                <div>
                  <div className="mb-1 text-muted-foreground">买五档（委买 {data.blocks.depth.data.bidTotalHand} 手）</div>
                  {data.blocks.depth.data.bids.map((l, i) => (
                    <div key={i} className="flex justify-between font-mono"><span className="text-red-500">买{i + 1}</span><span>{l.price.toFixed(2)}</span><span className="text-muted-foreground">{l.volume}</span></div>
                  ))}
                </div>
                <div>
                  <div className="mb-1 text-muted-foreground">卖五档（委卖 {data.blocks.depth.data.askTotalHand} 手）</div>
                  {data.blocks.depth.data.asks.map((l, i) => (
                    <div key={i} className="flex justify-between font-mono"><span className="text-emerald-500">卖{i + 1}</span><span>{l.price.toFixed(2)}</span><span className="text-muted-foreground">{l.volume}</span></div>
                  ))}
                </div>
                <div className="col-span-2 text-[10px] text-muted-foreground/70">
                  内盘 {data.blocks.depth.data.insideHand} 手 · 外盘 {data.blocks.depth.data.outerHand} 手 · 现手 {data.blocks.depth.data.activeHand} 手（eltdx · quotes.get_depth）
                </div>
              </div>
            ) : <Empty text="五档盘口：暂无数据（eltdx 网关未运行）" />}
          </Section>

          {/* 技术面 */}
          <Section title="📈 技术面" badge={data.blocks.tech?.source}>
            {data.blocks.tech ? (
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.blocks.tech.data).filter(([, v]) => v !== null).map(([k, v]) => (
                  <span key={k} className="rounded-md bg-accent/40 px-2.5 py-1 text-[11.5px]">
                    <span className="text-muted-foreground">{TECH_LABELS[k] ?? k}</span>{" "}
                    <span className={typeof v === "number" && v >= 1 ? "text-red-500 font-medium" : typeof v === "number" && v <= 0 ? "text-emerald-500" : "text-foreground"}>
                      {typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 1 ? (v === 1 ? "是" : "否") : (v as number).toFixed(2)}
                    </span>
                  </span>
                ))}
              </div>
            ) : <Empty text="技术指标：日K历史不足" />}
          </Section>

          {/* 板块&主线 */}
          <Section title="🏭 板块强度" badge={data.blocks.sector?.source}>
            {data.blocks.sector ? (
              <div className="flex flex-wrap items-center gap-4 text-[12.5px]">
                <span>行业：<b>{data.blocks.sector.data.name}</b></span>
                <span>今日板块涨幅：<PctText value={data.blocks.sector.data.changePct} /></span>
                <span>主力净流入排名：<b className="text-sky-300">第 {data.blocks.sector.data.rank} / {data.blocks.sector.data.count}</b></span>
                <span>板块主力净额：{data.blocks.sector.data.mainYi.toFixed(1)} 亿</span>
                <span className="text-[10.5px] text-muted-foreground">板块RPS/主线判定属 P2 主线发现</span>
              </div>
            ) : <Empty text="板块强度：行业未匹配到榜单" />}
          </Section>

          {/* 新闻&事件 */}
          <Section title="📰 新闻&事件" badge={data.blocks.news?.source}>
            {data.blocks.news ? (
              <ul className="space-y-1 text-[12px]">
                {data.blocks.news.data.map((n, i) => (
                  <li key={i} className="flex gap-2"><span className="shrink-0 font-mono text-muted-foreground">{n.time}</span><span>{n.title}</span></li>
                ))}
                <li className="text-[10.5px] text-muted-foreground/70">个股级新闻：暂无数据源（P2 全球事件雷达接入后补齐）</li>
              </ul>
            ) : <Empty text="宏观快讯：暂无数据" />}
          </Section>

          {/* 历史条件概率 */}
          <Section title="🎯 历史条件概率" badge={data.blocks.probability?.source} note={data.blocks.probability?.note}>
            {data.blocks.probability ? (
              <>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-3">
                  {data.blocks.probability.data.horizons.map((h) => (
                    <div key={h.h} className="rounded-lg bg-accent/40 px-3 py-2">
                      <div className="text-[10.5px] text-muted-foreground">{h.h}日上涨概率</div>
                      <div className={`text-lg font-bold ${h.win_rate !== null && h.win_rate >= 55 ? "text-red-500" : h.win_rate !== null && h.win_rate < 50 ? "text-emerald-500" : ""}`}>
                        {h.win_rate === null ? "—" : `${h.win_rate.toFixed(0)}%`}
                      </div>
                      <div className="text-[10px] text-muted-foreground">样本 {h.sample_size} · 均 {h.avg_return?.toFixed(2)}% · 最差 {h.worst_return?.toFixed(2)}%</div>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 text-[10.5px] text-muted-foreground">
                  统计区间：{data.blocks.probability.data.period ? `${data.blocks.probability.data.period.start} ~ ${data.blocks.probability.data.period.end}` : "—"}（实际数据覆盖，非固定区间）
                  {data.blocks.probability.data.sample_ok === false && <span className="ml-2 text-amber-400">样本不足，仅供参考</span>}
                </div>
                {data.blocks.probability.data.warnings.map((w, i) => (
                  <div key={i} className="mt-1 text-[10px] text-amber-300/80">⚠ {w}</div>
                ))}
              </>
            ) : <Empty text="历史条件概率：日K历史不足或条件无法匹配" />}
          </Section>

          {/* 风险提示 */}
          {data.blocks.risk && (
            <Section title="⚠️ 市场风险" badge={data.blocks.risk.source}>
              <div className="text-sm">当前市场风险等级：<b className="text-amber-400">{data.blocks.risk.data.level}</b></div>
              <ul className="mt-1 space-y-0.5 text-[11.5px] text-muted-foreground">
                {data.blocks.risk.data.triggers.map((t, i) => <li key={i}>· {t}</li>)}
              </ul>
            </Section>
          )}

          {/* AI 条件式解读 */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-semibold text-foreground/80">AI 条件式解读（事实/推断/风险分层，非预测）</div>
              <button onClick={aiExplain} disabled={aiBusy || !aiConfigured(ai)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-40">
                {aiBusy ? "解读中…" : "生成 AI 解读"}
              </button>
            </div>
            {aiText && <div className="mt-2 text-sm"><Markdown content={aiText} /></div>}
            {!aiConfigured(ai) && <div className="mt-1 text-[10.5px] text-muted-foreground">未配置 AI 接口（设置 → AI 接口）</div>}
          </div>
        </>
      )}

      {!data && !busy && !error && (
        <div className="rounded-xl border border-dashed border-border px-4 py-14 text-center text-xs text-muted-foreground">
          输入代码生成画像：实时报价 → 五档盘口 → 逐笔资金 → 主力资金流 → 技术状态 → 板块强度 → 历史条件概率 → 市场风险
        </div>
      )}
    </div>
  );
}

function Section({ title, badge, note, children }: { title: string; badge?: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold">{title}</div>
        {badge && <span className="text-[10px] text-muted-foreground">{badge}</span>}
        {note && <span className="text-[10px] text-muted-foreground/70">{note}</span>}
      </div>
      {children}
    </div>
  );
}

function Cell({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-accent/40 px-3 py-2">
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold ${cls ?? ""}`}>{value}</div>
    </div>
  );
}
function Empty({ text, span }: { text: string; span?: number }) {
  return <div className={span ? `col-span-${span}` : ""} ><span className="text-[11px] text-amber-400/80">{text}</span></div>;
}
