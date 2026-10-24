"use client";
// 日报页：按板块分类整理——顶部类别筛选 chips，下方按分类分组的板块卡片墙。
// 点卡片展开详情（plain 全文 + 流入/流出/公司家数/领涨股涨跌幅 + 美股段落置顶）。
// 缺数据就说“没取到”，不编：加载态 / 失败态 / 空态都有。
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, Newspaper, RefreshCw } from "lucide-react";
import {
  CATEGORY_FILTERS,
  type SectorCategoryFilter,
  type SectorCategoryGroup,
  type SectorDailyCard,
} from "@/lib/desk/daily-report-by-sector-core";
import type { FedPredictionSection, FeedRelatedSection, SectorFlowSection, UsMarketSection } from "@/lib/desk/daily-report-sections-core";
import MarketScopeBadge from "@/components/desk/MarketScopeBadge";

interface DailyReportSectorsResp {
  ok: boolean;
  category: string;
  categories: string[];
  cards: SectorDailyCard[];
  groups: SectorCategoryGroup[];
  usMarket: UsMarketSection | null;
  sectorFlow: SectorFlowSection | null;
  fed: FedPredictionSection | null;
  feedRelated: FeedRelatedSection | null;
  plain: string;
  hasData: boolean;
  error?: string;
}

const fmtYi = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)} 亿`;
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

export default function DailyReportPage() {
  const [category, setCategory] = useState<SectorCategoryFilter>("全部");
  const [data, setData] = useState<DailyReportSectorsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (cat: SectorCategoryFilter) => {
    setLoading(true);
    setError("");
    setExpanded(null);
    try {
      const res = await fetch(`/api/daily-report/sectors?category=${encodeURIComponent(cat)}`);
      const j = (await res.json()) as DailyReportSectorsResp;
      if (!res.ok || !j.ok) throw new Error(j.error || "日报按板块获取失败");
      setData(j);
    } catch (e) {
      setError(String((e as Error).message || e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(category); }, [category, load]);

  const switchCategory = (c: SectorCategoryFilter) => {
    if (c !== category) setCategory(c);
  };

  const usPlain = data?.usMarket?.plain ?? "美股：昨晚收盘没取到，算不出对 A 股的影响。";
  const flowPlain = data?.sectorFlow?.plain ?? "今日板块资金：没取到，算不出钱去了哪。";
  const fedPlain = data?.fed?.plain ?? "美联储 / 预测市场：Kalshi 和 Polymarket 都没取到，算不出加息概率。";
  const feedRelated = data?.feedRelated ?? null;
  const feedPlain = feedRelated?.plain ?? "动态相关（股票）：动态没取到，算不出动态里有没有股票相关的内容。";
  const groups = data?.groups ?? [];
  const totalCards = data?.cards.length ?? 0;

  return (
    <div className="w-full space-y-4 px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Newspaper size={18} className="text-sky-400" />日报 · 按板块分类
        </h1>
        <div className="mt-1"><MarketScopeBadge note="日报板块为 A 股板块；美股/美联储段落是外部环境参考，不是港股/美股日报" /></div>
        <button
          onClick={() => void load(category)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
        </button>
      </div>
      <p className="text-[12.5px] leading-5 text-muted-foreground">
        每天的日报按板块类型分好类放一块：点分类只看那一类，点板块卡片展开看详情。缺数据就说“没取到”，不编。
      </p>

      {/* 类别筛选 chips：全部 + 7 个分类，点哪个只看哪个分类的板块 */}
      <div className="flex flex-wrap gap-2">
        {CATEGORY_FILTERS.map((c) => {
          const on = c === category;
          const count = c === "全部"
            ? totalCards
            : groups.find((g) => g.category === c)?.cards.length ?? data?.cards.filter((card) => card.category === c).length ?? 0;
          return (
            <button
              key={c}
              onClick={() => switchCategory(c)}
              aria-pressed={on}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] transition-all active:scale-95 ${on
                ? "border-sky-400/60 bg-sky-400/15 font-medium text-sky-200"
                : "border-border/60 bg-card text-muted-foreground hover:border-sky-400/40 hover:text-foreground"}`}
            >
              {c}
              {!loading && data && <span className="ml-1 tabular-nums text-[11.5px] opacity-70">({count})</span>}
            </button>
          );
        })}
      </div>

      {/* 美股 + 板块资金 + 美联储/预测市场 + 动态相关段落置顶 */}
      <div className="space-y-2">
        <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5 text-[13px] leading-6">
          <span className="mr-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[11.5px] font-medium text-sky-300">美股置顶</span>
          {loading ? "美股读数中…" : usPlain}
        </div>
        <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5 text-[13px] leading-6">
          <span className="mr-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11.5px] font-medium text-amber-300">板块资金</span>
          {loading ? "板块资金读数中…" : flowPlain}
        </div>
        <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5 text-[13px] leading-6">
          <span className="mr-2 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11.5px] font-medium text-violet-300">美联储 / 预测市场</span>
          {loading ? "预测市场读数中…" : fedPlain}
        </div>
        <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5 text-[13px] leading-6">
          <span className="mr-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11.5px] font-medium text-emerald-300">动态相关 · 股票</span>
          {loading ? "动态读数中…" : feedPlain}
          {!loading && feedRelated && feedRelated.items.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {feedRelated.items.map((it) => (
                <li key={it.title} className="text-[12.5px] leading-5">
                  《{it.title}》{it.published ? `（${it.published}）` : ""} · 来源：动态
                  {it.sourceUrl && (
                    <a href={it.sourceUrl} target="_blank" rel="noreferrer" className="ml-1 text-sky-300 underline underline-offset-2">原文</a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 加载态 */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" /> 日报按板块加载中…
        </div>
      )}

      {/* 失败态：如实说没取到 */}
      {!loading && error && (
        <div className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-6 text-center">
          <p className="text-sm text-red-300">日报按板块：没取到（{error}）</p>
          <button
            onClick={() => void load(category)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs hover:border-sky-500/40 hover:text-sky-300"
          >
            重新拉取
          </button>
        </div>
      )}

      {/* 空态 */}
      {!loading && !error && data && !data.hasData && (
        <div className="py-16 text-center text-sm text-muted-foreground">
          日报按板块：没取到，算不出今天各板块的情况。
        </div>
      )}

      {/* 板块卡片墙：按分类分组 */}
      {!loading && !error && data && data.hasData && groups.length > 0 && (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.category}>
              <h2 className="mb-2 flex items-baseline gap-2 text-[15px] font-semibold">
                {group.category}
                <span className="text-[12px] font-normal text-muted-foreground">{group.cards.length} 个板块</span>
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {group.cards.map((card) => {
                  const open = expanded === card.name;
                  const up = card.changePct >= 0;
                  return (
                    <article
                      key={card.name}
                      className={`overflow-hidden rounded-xl border bg-card transition-colors ${open ? "border-sky-400/50" : "border-border/60 hover:border-sky-400/30"}`}
                    >
                      <button
                        onClick={() => setExpanded(open ? null : card.name)}
                        aria-expanded={open}
                        className="w-full px-4 py-3 text-left"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[15px] font-semibold">{card.name}</span>
                          <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[11.5px] text-muted-foreground">
                            {card.category}
                          </span>
                        </div>
                        <div className="mt-2 flex items-baseline gap-3">
                          <span className={`text-xl font-semibold tabular-nums ${up ? "text-red-400" : "text-emerald-400"}`}>
                            {fmtPct(card.changePct)}
                          </span>
                          <span className="text-[12.5px] text-muted-foreground">
                            净{card.netYi >= 0 ? "流入" : "流出"} {fmtYi(card.netYi)}
                          </span>
                          <ChevronDown
                            size={15}
                            className={`ml-auto shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                          />
                        </div>
                        <div className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
                          流入 {Math.abs(card.inflowYi).toFixed(2)} 亿 · 流出 {Math.abs(card.outflowYi).toFixed(2)} 亿
                          {card.leader ? ` · 领涨股 ${card.leader}` : " · 领涨股没取到"}
                        </div>
                        {card.divergence && (
                          <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[12.5px] leading-5 text-amber-300/90">
                            ⚠️ {card.divergence.kind}：{card.divergence.plain}
                          </div>
                        )}
                      </button>
                      {/* 展开详情：美股段落置顶 + plain 全文 + 明细 */}
                      {open && (
                        <div className="border-t border-border/60 px-4 py-3">
                          <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-[13px] leading-6">
                            <span className="mr-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[11.5px] font-medium text-sky-300">美股置顶</span>
                            {usPlain}
                          </div>
                          <p className="mt-2.5 text-[13.5px] leading-6">{card.plain}</p>
                          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
                            <div className="flex justify-between"><dt className="text-muted-foreground">流入</dt><dd className="tabular-nums">{Math.abs(card.inflowYi).toFixed(2)} 亿</dd></div>
                            <div className="flex justify-between"><dt className="text-muted-foreground">流出</dt><dd className="tabular-nums">{Math.abs(card.outflowYi).toFixed(2)} 亿</dd></div>
                            <div className="flex justify-between"><dt className="text-muted-foreground">净流入</dt><dd className="tabular-nums">{fmtYi(card.netYi)}</dd></div>
                            <div className="flex justify-between"><dt className="text-muted-foreground">公司家数</dt><dd className="tabular-nums">{card.count > 0 ? `${card.count} 家` : "没取到"}</dd></div>
                            <div className="flex justify-between"><dt className="text-muted-foreground">领涨股</dt><dd>{card.leader || "没取到"}</dd></div>
                            <div className="flex justify-between"><dt className="text-muted-foreground">领涨股涨跌幅</dt><dd className="tabular-nums">{card.leader ? fmtPct(card.leaderPct) : "没取到"}</dd></div>
                          </dl>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* 有数据但当前分类下无卡（如该分类今天没有板块） */}
      {!loading && !error && data && data.hasData && groups.length === 0 && (
        <div className="py-16 text-center text-sm text-muted-foreground">
          「{category}」分类下今天没有板块。
        </div>
      )}
    </div>
  );
}
