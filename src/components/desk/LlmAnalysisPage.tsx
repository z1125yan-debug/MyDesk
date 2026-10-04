"use client";
// LLM 分析（S10 稳智 /settings 五Tab复刻 v2）：主题热点 / 研究池 / 板块全景看板 / 个股评估矩阵 / 产业链研报分析。
// 数据全部本地真实接口：主题=/api/market/themes、市场环境=/api/market/review-stats(稳智同源种子)、
// 板块全景=/api/market/sectors、个股矩阵=/api/quant/factor-matrix(全A条件预计算)+/api/market/allstocks。
// 产业链研报=豆包2 基于当日真实数据生成（AI 生成·已标注），历史留档本地。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { decodeStreamEvent } from "@/lib/desk/chat-stream-core";
import { pumpEventStream } from "@/lib/desk/chat-stream-client";
import { reportDayCaliber } from "@/lib/desk/report-date-core";
import { mendBoldSeams, mendReportSkeleton, mendTypos, reportTitleOf, screenReportShape } from "@/lib/desk/report-text-core";
// P64：喂给模型的数据块（中文口径 + 指数真实趋势 + 本地量化判读）全部在纯核里拼
import {
  METRIC_DEFS_ZH,
  indexTrendFromCandles,
  indexTrendZh,
  localVerdictZh,
  reviewRowsZh,
  themeFlowsZh,
} from "@/lib/desk/report-input-core";
import {
  groupNewsByTheme,
  groupedNewsZh,
  newsPoolLabelZh,
  newsQuoteZh,
  unmatchedThemesZh,
  type NewsPoolRow,
} from "@/lib/desk/report-news-core";
// P66：研报「受益标的」的 A 股合规校验（抽名字 / 对名册 / 说人话全在纯核里，这里只接线）
import {
  checkBeneficiaryNames,
  extractBeneficiaryNames,
  summarizeTickerCheck,
  tickerCheckLinesZh,
  type TickerCheckResult,
} from "@/lib/desk/report-tickers-core";
import { fetchEventsHistory } from "@/lib/desk/quant-api";
import { useTradeDate } from "@/lib/desk/use-trade-date";
// R21 主题理由 / 新闻证据：判定与匹配都在零依赖纯核里（node --test 直跑），这里只接线不写规则
import {
  THEME_REASON_EMPTY, THEME_REASON_PERIOD_NOTE, themeReasonLines, type ThemeReasonLine,
} from "@/lib/quant/review/theme-reason-core";
import {
  newsWindowLabel as newsWindowLabelOf, themeNewsEmptyNote, themeNewsHits, type ThemeNewsItem,
} from "@/lib/quant/review/theme-news-core";

type ThemeRow = { name: string; heat?: number; pct?: number; flow?: number | null; role?: string };
type ReviewRow = {
  date: string; limitUp: number; limitDown: number; t3: number; t4: number; t5: number; maxBoards: number;
  decliners: number; belowMa5: number; belowMa3: number; aboveMa5Pct: number | null;
  microPct: number | null; midPct: number | null; largePct: number | null;
};

type ThemeHeatSeed = {
  as_of_news_date: string;
  market_env: { as_of_trade_date: string; label: string };
  inference: { as_of_date: string; confidence: number; market_bucket: string; market_phase: string; reason: string };
  industries: { n: string; h: number; t: string; f: number }[];
  concepts: { n: string; h: number; t: string; f: number }[];
};

/** 研报的「市场阶段」要用真实点位/近一月均价，所以取日线**不复权**（前复权会把历史点位改小，跟交易所公布值不一致） */
const klineUrl = (symbol: string) => `/api/market/kline?symbol=${symbol}&tf=${encodeURIComponent("日线")}&fq=none`;

/** 快讯池：按指定交易日取全量窗口（服务端按 realSort 游标翻页；实测单日 300~840 条、池子只留最近约 14 天） */
const newsPoolUrl = (dates: string[]) => `/api/market/news?dates=${dates.join(",")}`;

type NewsPoolResp = {
  ok?: boolean;
  error?: string;
  news?: { date?: string; time?: string; title?: string }[];
  total?: number;
  dates?: string[];
  /** 服务端翻页预算用尽、没翻到区间最早一天 → 窗口不完整，要在 prompt 里如实标出来 */
  capped?: boolean;
  source?: { provider?: string };
};

const shDay = (offset: number) => {
  const d = new Date(Date.now() - offset * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function getJson<T = Record<string, unknown>>(url: string): Promise<T> {
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(j.error || `${url} 获取失败`);
  return j as T;
}

/**
 * 研报流式生成：POST /api/ai/proxy 读 SSE，逐帧把已累计的正文交给 onDelta，返回全文。
 *
 * 为什么研报必须走流式（与非流式路径的两条实质差别）：
 *   ① **体感**：非流式要等 4000~6000 字全部生成完才一次性返回，期间界面一个字符都不显示；
 *      流式边生成边显示，首字到达即可读。
 *   ② **超时**：`/api/ai/proxy` 里非流式路径 `callOpenAI` 用 `upstream` 的默认超时 **45s**，
 *      而流式路径 `callOpenAIStream` 显式用 **120s**。长研报在非流式路径上很容易撞 45s 上限。
 *
 * 请求体与改动前**逐字一致**，只有 `stream` 由 false 改 true；也**不带 scene**——
 * 研报是一次一问的取数请求，不该被塞交易场景提示词（proxy 路由 `prepare()` 第一行就是
 * `if (!body?.scene) return null`）。凭据口径同样不变：不发任何 x-ai-* 头，路由回落 `.env` 服务端通道。
 *
 * 上游整体返回（非 SSE，例如 Anthropic/Gemini 原生协议）时如实降级：把 JSON 里的 content 当全文，
 * 不假装逐字流（`streamed:false` 由调用方决定要不要说明）。
 */
async function streamReport(
  prompt: string,
  onDelta: (full: string) => void,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<{ text: string; streamed: boolean }> {
  // 实测（2026-09-25，DeepSeek-V4-Flash）：~6000 字研报要 **230s+**，远超 `/api/ai/proxy`
  // 流式路径原本写死的 120s 上游超时。这里显式抬高上游超时（路由侧钳在 [10s, 600s]），
  // 外层兜底再多 60s —— 让路由先报它自己的错（比 fetch 被中断更有信息量）。
  const upstreamMs = Math.min(Math.max(opts.timeoutMs ?? 300_000, 10_000), 600_000);
  const res = await fetch("/api/ai/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      stream: true,
      max_tokens: opts.maxTokens ?? 6000,
      timeout_ms: upstreamMs,
    }),
    signal: AbortSignal.timeout(upstreamMs + 60_000),
  });

  if (!/text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
    const j = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
    if (!res.ok || j.error) throw new Error(j.error || `研报生成失败（${res.status}）`);
    const text = j.content ?? "";
    if (text) onDelta(text);
    return { text, streamed: false };
  }
  if (!res.ok || !res.body) throw new Error(`流式响应不可用（${res.status}）`);

  let full = "";
  let streamError: string | null = null;
  // 帧切分复用 chat-stream-client.pumpEventStream（与智能助手同一条路，协议口径只留一份实现）
  await pumpEventStream(res.body, (raw) => {
    const ev = decodeStreamEvent(raw);
    if (!ev) return; // 形状不对的帧直接丢，不让半截帧污染正文
    if (ev.type === "delta") {
      full += ev.data.content;
      onDelta(full);
    } else if (ev.type === "done" && ev.data.fullText) {
      full = ev.data.fullText; // done 的全文是权威值，覆盖累计结果
      onDelta(full);
    } else if (ev.type === "error") {
      streamError = ev.data.message;
    }
  });
  if (streamError) throw new Error(streamError);
  return { text: full, streamed: true };
}

/* ---------------- Tab1 主题热点 ---------------- */
type HeatItem = { n: string; h: number; t: string; f: number };

function ThemeHotView() {
  const [heat, setHeat] = useState<ThemeHeatSeed | null>(null);
  // 市场环境推理与热度榜解耦：热度榜为空的日期（休市/历史无快照），市场环境读数照样能显示
  const [envInfo, setEnvInfo] = useState<{ inference?: ThemeHeatSeed["inference"]; market_env?: ThemeHeatSeed["market_env"] } | null>(null);
  const [heatNote, setHeatNote] = useState("");
  // 新闻池：优先「近 3 个交易日」全量窗口（服务端按游标翻页，每条带日期），退化才是最新一屏 + 事件归档
  const [newsPool, setNewsPool] = useState<ThemeNewsItem[]>([]);
  const [newsWin, setNewsWin] = useState<{ dates: string[]; label: string; total: number } | null>(null);
  // 热度数字的出身：种子里的 f 是「3 日资金」，实时算出来的 f 是「当日主力净额」——理由里必须分开口径说
  const [heatKind, setHeatKind] = useState<"seed" | "live" | "none">("none");
  const [themes, setThemes] = useState<ThemeRow[]>([]);
  const [boardRows, setBoardRows] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState(true);
  const [active, setActive] = useState<string>("");
  const [listKind, setListKind] = useState<"industries" | "concepts">("industries");
  // 默认跟着「最近交易日」走，不写死某一天、也不拿系统时钟顶替：
  // 休市日（周末/节假日）系统日期当天没有行情，写死日期或 new Date() 都会摆出一个没开过盘的日子。
  // 用派生值而不是 effect 同步：拿到真交易日之前 heatDate 为空（不查），拿到后自动重查一次。
  const { tradeDate } = useTradeDate();
  const [heatDatePick, setHeatDatePick] = useState(""); // 用户手动选的日期；空=跟随最近交易日
  const heatDate = heatDatePick || tradeDate;
  const [heatSource, setHeatSource] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (date: string) => {
    setBusy(true); setError("");
    try {
      const [hv, sj, nj, evh] = await Promise.all([
        getJson<{ source?: string; note?: string; date?: string; industries?: { n: string; h: number }[]; concepts?: { n: string; h: number }[]; market_env?: ThemeHeatSeed["market_env"]; inference?: ThemeHeatSeed["inference"]; empty?: boolean; news_window?: { dates?: string[]; label?: string } }>("/api/market/theme-heat?date=" + date),
        getJson<Record<string, unknown>>("/api/market/sectors?kind=industry").catch(() => ({ list: [] })),
        getJson<{ news?: { time?: string; title?: string }[] }>("/api/market/news").catch(() => ({ news: [] })),
        // 新闻池补齐：7x24 快讯只有最新一屏，历史日期按关键词会漏——并入事件雷达最近归档日的事件标题
        fetchEventsHistory().catch(() => null),
      ]);
      setHeat(hv.empty ? null : ({ as_of_news_date: hv.date ?? date, market_env: hv.market_env, inference: hv.inference, industries: hv.industries ?? [], concepts: hv.concepts ?? [] } as ThemeHeatSeed));
      setEnvInfo(hv.inference ? { inference: hv.inference, market_env: hv.market_env } : null);
      setHeatNote(hv.empty ? hv.note ?? "" : "");
      setHeatSource(hv.source ?? (hv.empty && !hv.inference ? hv.note ?? "" : ""));
      setBoardRows((sj.list ?? []) as Record<string, unknown>[]);
      // 热度出身：种子日 = 3 日资金口径；本地实时 = 当日主力净额口径。理由里分开口径说，不混。
      const isSeed = !hv.empty && (hv.source ?? "").includes("离线快照种子");
      setHeatKind(hv.empty ? "none" : isSeed ? "seed" : "live");
      // 新闻池：服务端给了「近 3 个交易日」窗口就按窗口取全量（每条自带日期）；没给才退化到最新一屏+事件归档
      const nw = hv.news_window ?? null;
      const winDates = (nw?.dates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)));
      if (winDates.length) {
        const wj = await getJson<{ news?: { time?: string; title?: string; date?: string }[]; total?: number }>(newsPoolUrl(winDates)).catch<{ news: { time?: string; title?: string; date?: string }[]; total: number }>(() => ({ news: [], total: 0 }));
        const pool = (wj.news ?? []).map((x) => ({ time: String(x.time ?? ""), title: String(x.title ?? ""), date: String(x.date ?? "") })).filter((x) => x.title);
        setNewsPool(pool);
        setNewsWin({ dates: winDates, label: nw?.label || newsWindowLabelOf(winDates), total: typeof wj.total === "number" ? wj.total : pool.length });
      } else {
        const flash = (nj.news ?? []).map((x) => ({ time: String(x.time ?? ""), title: String(x.title ?? ""), date: "" }));
        const evItems = (evh?.items ?? []).map((it) => ({ time: String(it.time ?? ""), title: String(it.title ?? ""), date: "" }));
        const seen = new Set<string>();
        setNewsPool([...flash, ...evItems].filter((x) => x.title && !seen.has(x.title) && (seen.add(x.title), true)));
        setNewsWin(null);
      }
      setActive((a) => a || hv.industries?.[0]?.n || "");
    } catch (e) { setError(String((e as Error).message || e)); } finally { setBusy(false); }
  }, []);
  // 换日期要真的重查（旧实现 load 闭包不含 heatDate，改日期只是改了输入框的数字）
  // 拿到真交易日之前不查：空日期查下去就是拿系统当天冒充数据日
  useEffect(() => { if (heatDate) void load(heatDate); }, [load, heatDate]);

  const heatList: HeatItem[] = useMemo(() => {
    if (!heat) return [];
    return listKind === "industries" ? heat.industries : heat.concepts;
  }, [heat, listKind]);
  const activeItem = heatList.find((x) => x.n === active) ?? heatList[0] ?? null;
  const boardOf = boardRows.find((b) => String(b.name ?? "") === activeItem?.n) ?? null;
  const env = envInfo?.inference ?? heat?.inference ?? null;
  const envLabel = envInfo?.market_env?.label ?? heat?.market_env?.label ?? null;
  const activeTheme = themes.length ? themes[0] : null;
  // 新闻证据：主题关键词在「近 3 个交易日」全量快讯池里命中（纯核里拆词/去重/限量）
  const newsHits = useMemo(() => themeNewsHits(newsPool, active ?? "", 8), [newsPool, active]);
  // 理由：读数 → 说明什么。资金口径看热度出身（种子=3 日 / 实时=当日），不混着说
  const reasonLines: ThemeReasonLine[] = useMemo(() => {
    const b = boardOf ?? {};
    const numOf = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
    const f = activeItem ? numOf(activeItem.f) : null;
    return themeReasonLines({
      name: active ?? "",
      heat: activeItem ? numOf(activeItem.h) : null,
      trend: activeItem?.t ?? null,
      fund3Yi: heatKind === "seed" ? f : null,
      mainTodayYi: heatKind === "seed" ? numOf(b.main) : heatKind === "live" ? f : null,
      changePct: numOf(b.changePct),
      upCount: numOf(b.up_count),
      downCount: numOf(b.down_count),
      limitUpCount: numOf(b.limit_up_count),
      leader: typeof b.leader === "string" && b.leader ? b.leader : null,
      rps: numOf(b.rps),
      marketPhase: env?.market_phase ?? null,
      marketBucket: env?.market_bucket ?? null,
    });
  }, [activeItem, boardOf, env, active, heatKind]);
  const tier = (activeItem?.h ?? 0) >= 50 ? "core" : (activeItem?.h ?? 0) >= 30 ? "watch" : "avoid";
  const decision = (activeItem?.f ?? 0) > 0 && (activeItem?.h ?? 0) >= 50 ? "buy" : (activeItem?.h ?? 0) < 30 ? "avoid" : "watch";
  // P65 口径诚实：种子里的 f 是稳智同款「3 日资金」，实时/快照里的 f 是「当日主力净额」；UI 标签跟着 heatKind 走，不混着说。
  const fundLabel = heatKind === "seed" ? "3日资金" : "当日主力净额";
  const basisText = activeItem
    ? "主题得分=" + (activeItem.h) + "，" + fundLabel + "=" + (activeItem.f != null ? activeItem.f.toFixed(2) + "亿" : "—") + "，市场阶段=" + (env?.market_phase ?? "—") + "，置信度=" + (env?.confidence ?? "—") + "。"
    : "";
  const invalidations = [
    (activeItem?.f ?? 0) < 0 ? `${fundLabel}净流出(亿元)为负，短期资金流出压力` : null,
    (activeItem?.h ?? 100) < 30 ? "热度低于30，题材接力难度上升" : null,
  ].filter(Boolean) as string[];

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      {/* 左：主题热度榜 */}
      <div className="rounded-xl border border-border/60 bg-overlay p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[14px] font-semibold">主题热度榜</div>
          <button onClick={() => void load(heatDate)} className="text-muted-foreground hover:text-foreground"><RefreshCw size={12} /></button>
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12px]">
          <input type="date" value={heatDate} onChange={(e) => setHeatDatePick(e.target.value)} title={heatDatePick ? `已手动指定 ${heatDatePick}（清空则回到最近交易日）` : `跟随最近交易日 ${tradeDate || "（读取中…）"}`} className="rounded-md border border-border/70 bg-card px-2 py-1 text-foreground [color-scheme:dark]" />
          <button onClick={() => setListKind("industries")} className={`rounded-full border px-2.5 py-1 ${listKind === "industries" ? "border-sky-400/60 bg-sky-400/15 text-sky-200" : "border-border/60 text-muted-foreground"}`}>行业</button>
          <button onClick={() => setListKind("concepts")} className={`rounded-full border px-2.5 py-1 ${listKind === "concepts" ? "border-sky-400/60 bg-sky-400/15 text-sky-200" : "border-border/60 text-muted-foreground"}`}>概念</button>
        </div>
        {error && <div className="text-[13px] text-red-300">{error}</div>}
        {busy && !heat ? (
          <div className="py-6 text-center text-[13px] text-muted-foreground"><Loader2 size={13} className="mr-1 inline animate-spin" />加载中...</div>
        ) : (
          <div className="space-y-1.5">
            {heatList.map((x) => (
              <button key={x.n} onClick={() => setActive(x.n)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${x.n === active ? "border-sky-400/60 bg-sky-400/10" : "border-border/50 hover:border-border"}`}>
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium">{x.n}</span>
                  <span className="rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[11.5px] text-amber-300">热度 {x.h}</span>
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">{fundLabel} {x.f != null ? `${x.f.toFixed(2)}亿` : "—"}{x.t ? ` · ${x.t}` : ""}</div>
              </button>
            ))}
            {!heatList.length && (
              <div className="rounded-lg border border-border/50 px-3 py-3 text-[12.5px] text-muted-foreground">
                {heatNote || "该日期无主题热度数据"}
              </div>
            )}
          </div>
        )}
      </div>
      {/* 右：市场环境 + 选中主题详情 */}
      <div className="lg:col-span-2 space-y-3">
        {env ? (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold">市场环境</span>
              <span className="rounded border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11.5px] text-amber-300">{env.market_phase}</span>
          {heatSource && <span className="rounded border border-border/60 px-2 py-0.5 text-[11.5px] text-muted-foreground" title={heatSource}>{heatSource}</span>}
              <span className="rounded border border-border/60 px-2 py-0.5 text-[11.5px] text-muted-foreground">{env.market_bucket}</span>
              <span className="rounded border border-border/60 px-2 py-0.5 text-[11.5px] text-muted-foreground">置信度 {env.confidence}</span>
              <span className="rounded border border-border/60 px-2 py-0.5 text-[11.5px] text-muted-foreground">as_of {env.as_of_date}</span>
            </div>
            <p className="mt-2 text-[13.5px] leading-5">{env.reason}</p>
          </div>
        ) : busy ? (
          <div className="rounded-xl border border-border/60 bg-overlay p-4 text-[13.5px] text-muted-foreground"><Loader2 size={13} className="mr-1 inline animate-spin" />载入市场环境...</div>
        ) : (
          <div className="rounded-xl border border-border/60 bg-overlay p-4 text-[13px] text-muted-foreground">
            市场环境：该日期无复盘读数（本地复盘种子覆盖 2026-04-20 ~ 2026-09-24，覆盖外的日期不编造市场环境）。
          </div>
        )}
        <div className="rounded-xl border border-border/60 bg-overlay p-4">
          <div className="flex items-center gap-2">
            <span className="text-[17px] font-semibold">{activeItem?.n ?? "—"}</span>
            {activeItem?.h != null && <span className="rounded border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[12px] text-amber-300">热度 {activeItem.h}</span>}
            {activeItem?.t != null && <span className="rounded border border-border/60 px-2 py-0.5 text-[11.5px] text-muted-foreground">{activeItem.t}</span>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3">
            <MiniCard label={fundLabel} value={activeItem?.f != null ? `${activeItem.f.toFixed(2)} 亿` : "—"} />
            <MiniCard label="当日涨跌" value={boardOf ? `${num(boardOf.changePct).toFixed(2)}%` : "—"} tone={boardOf ? (num(boardOf.changePct) >= 0 ? "up" : "down") : undefined} />
            <MiniCard label="领涨股" value={boardOf ? String(boardOf.leader ?? "—") : "—"} />
          </div>
          <div className="mt-3 rounded-lg border border-border/50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium text-muted-foreground">理由（规则生成 · 每条都是真实读数）</div>
              <span className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground" title={THEME_REASON_PERIOD_NOTE}>
                {heatKind === "seed" ? "资金口径：近 3 个交易日 + 当日" : heatKind === "live" ? "资金口径：当日（实时热度不带 3 日合计）" : "资金口径：—"}
              </span>
            </div>
            {reasonLines.length ? (
              <ul className="mt-1.5 space-y-1.5">
                {reasonLines.map((r, i) => (
                  <li key={`${r.key}-${i}`} className="flex gap-2 text-[13.5px] leading-snug">
                    <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">{r.label}</span>
                    <span className="min-w-0 flex-1">{r.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-1.5 text-[13px] text-muted-foreground">{THEME_REASON_EMPTY}</div>
            )}
          </div>
        </div>
        <div className="rounded-xl border border-border/60 bg-overlay p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[13px] font-medium text-muted-foreground">新闻证据</div>
            {newsWin && (
              <span className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {newsWin.label} · 池 {newsWin.total} 条 · 命中 {newsHits.length} 条
              </span>
            )}
          </div>
          <div className="mt-1.5 space-y-1.5">
            {newsHits.length ? newsHits.map((n, i) => (
              <div key={`${n.date}-${n.time}-${i}`} className="rounded border border-border/60 bg-card px-2.5 py-1.5 text-[12.5px] leading-snug">
                <span className="font-mono text-muted-foreground">{n.date ? `${n.date.slice(5)} ` : ""}{n.time}</span>
                <span className="ml-1.5">{n.title}</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground">（命中「{n.kw}」）</span>
              </div>
            )) : (
              <div className="text-[12.5px] text-muted-foreground">
                {themeNewsEmptyNote(active || "该主题", newsPool.length, newsWin?.label ?? "")}
                {!newsWin && "（本次没拿到按日快讯窗口，只扫了最新一屏快讯与事件归档。）"}
              </div>
            )}
          </div>
        </div>
        <div className="rounded-xl border border-sky-400/30 bg-sky-400/5 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold">主题分层与策略结论</span>
            <span className="rounded border border-border/60 px-2 py-0.5 text-[11.5px] text-muted-foreground">本地模板 + 规则引擎评分</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="rounded border border-border/60 px-2 py-0.5">分层 {tier}</span>
            <span className="rounded border border-border/60 px-2 py-0.5">决策 {decision}</span>
            <span className="rounded border border-border/60 px-2 py-0.5">评分 {activeItem?.h ?? "—"}</span>
          </div>
          <p className="mt-2 text-[13.5px] leading-5">{basisText}</p>
          <div className="mt-2 space-y-1.5 text-[13px]">
            <div className="text-emerald-300">✓ 次日开盘后验证：观察板块承接、量能、资金是否延续，重点看主力净额是否修复</div>
            {invalidations.map((x, i) => <div key={i} className="text-red-300">✗ {x}</div>)}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["主题", "theme_type", "热度", "趋势", "主题得分", "梯队", "阶段", "1日资金净流入(亿元)", "3日资金净流入(亿元)", "market_regime_label", "market_regime_phase"].map((f) => (
              <span key={f} className="rounded border border-border/50 px-2 py-0.5 text-[11.5px] text-muted-foreground">{f}</span>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-border/60 bg-overlay p-4">
          <div className="text-[14px] font-semibold mb-2">标准化映射明细</div>
          <table className="w-full text-[13px]">
            <thead className="text-muted-foreground">
              <tr><th className="px-3 py-1.5 text-left">原始主题</th><th className="px-3 py-1.5 text-left">标准主题</th><th className="px-3 py-1.5 text-left">方法</th><th className="px-3 py-1.5 text-left">匹配</th><th className="px-3 py-1.5 text-left">最终类型</th></tr>
            </thead>
            <tbody>
              <tr className="border-t border-border/40">
                <td className="px-3 py-2">{activeItem?.n ?? "—"}</td>
                <td className="px-3 py-2">{activeItem?.n ?? "—"}</td>
                <td className="px-3 py-2">local_board</td>
                <td className="px-3 py-2">是</td>
                <td className="px-3 py-2">{listKind === "industries" ? "industry" : "concept"}</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-3 text-[12.5px] text-muted-foreground">该主题个股（汇总）：板块成员数据源接入后展示（当前快照源不含行业成员关系，S7 补齐）。</div>
        </div>
      </div>
    </div>
  );
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v) || 0;
}

function MiniCard({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-lg border border-border/50 px-3 py-2">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className={`mt-1 text-[17px] font-semibold ${tone === "up" ? "text-red-400" : tone === "down" ? "text-emerald-400" : ""}`}>{value}</div>
    </div>
  );
}

/* ---------------- Tab3 板块全景看板 ----------------
   数据源：`/api/desk/sector-insights` 读稳智三卡缓存（scrape-aiwuchuan/cache/sector_insights_latest.json），
   算法 1:1 复刻 aiwuchuan.com Settings-Ctoklwun.js:66054 的 `Da` computed：
     - 轮动上行：flow_3d_sum_yi + pct_chg_3d + top100_ratio + ma20_ratio
     - 低吸观察：-pct_chg_5d + ma20_ratio + flow_1d_sum_yi - pop_concentration
     - 高位风险：pct_chg_7d + pop_concentration + top100_ratio
   每个卡 desc 与展示字段严格对齐稳智（Settings.js:116074-116893 的 hardcoded 文案）。 */
function SectorPanoramaView() {
  const [data, setData] = useState<{
    ok: boolean;
    cards?: { rotation: InsightItem[]; dip: InsightItem[]; high: InsightItem[] };
    trade_date?: string;
    updated_at?: string;
    filter?: string;
    top_n?: number;
    all_count?: number;
    age_sec?: number | null;
    source?: string;
    day_scope?: "1d" | "3d";
    error?: string;
  } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  type InsightItem = {
    key: string | number;
    name: string;
    score: number;
    display?: { flow3d?: string; pct3d?: string; pct5d?: string; flow1d?: string; ma20?: string; pct7d?: string; pop?: string; top100?: string };
    flow3d?: number; pct3d?: number; pct5d?: number; flow1d?: number; ma20?: number; pop?: number; top100?: number; pct7d?: number;
  };

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const j = await getJson<{
        ok: boolean;
        cards?: { rotation: InsightItem[]; dip: InsightItem[]; high: InsightItem[] };
        trade_date?: string; updated_at?: string; filter?: string;
        top_n?: number; all_count?: number; age_sec?: number | null; error?: string;
      }>("/api/desk/sector-insights?refresh=1");
      setData(j);
    } catch (e) { setError(String((e as Error).message || e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const cards = data?.cards;
  const fmtAge = (sec?: number | null): string => {
    if (sec == null) return "";
    if (sec < 60) return `${sec}s 前`;
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
    return `${Math.floor(sec / 86400)} 天前`;
  };

  // 三卡定义（desc 与展示字段全部对齐稳智 Settings.js:116074-116893 hardcoded 文案）
  // P33b：本地快照兜底（day_scope=1d）只有当日两个字段——标签如实切「当日」，不冒充 3日/MA20。
  const oneDay = data?.day_scope === "1d";
  type CardDef = {
    title: string;
    desc: string;
    tone: "amber" | "emerald" | "red";
    list: InsightItem[] | undefined;
    fields: { key: string; label: string }[];
  };
  const cardDefs: CardDef[] = [
    {
      title: "轮动上行",
      desc: oneDay ? "当日资金流入 + 当日上涨" : "资金流入 + 强度共振",
      tone: "amber",
      list: cards?.rotation,
      fields: oneDay
        ? [{ key: "flow3d", label: "当日资金" }, { key: "pct3d", label: "当日涨跌" }]
        : [
            { key: "flow3d", label: "3日资金" },
            { key: "pct3d", label: "3日涨跌" },
            { key: "ma20", label: "站上一月均价的比例" },
          ],
    },
    {
      title: "低吸观察",
      desc: oneDay ? "其余板块（按当日资金净流入排序）" : "回撤但结构未破",
      tone: "emerald",
      list: cards?.dip,
      fields: oneDay
        ? [{ key: "flow3d", label: "当日资金" }, { key: "pct3d", label: "当日涨跌" }]
        : [
            { key: "pct5d", label: "5日涨跌" },
            { key: "flow1d", label: "当日资金" },
            { key: "ma20", label: "站上一月均价的比例" },
          ],
    },
    {
      title: "高位风险",
      desc: oneDay ? "当日涨幅高（拥挤）" : "涨幅高 + 拥挤度高",
      tone: "red",
      list: cards?.high,
      fields: oneDay
        ? [{ key: "pct3d", label: "当日涨跌" }, { key: "flow3d", label: "当日资金" }]
        : [
            { key: "pct7d", label: "7日涨跌" },
            { key: "pop", label: "集中度" },
            { key: "top100", label: "Top100" },
          ],
    },
  ];
  const toneCls: Record<CardDef["tone"], string> = {
    amber: "border-amber-400/40",
    emerald: "border-emerald-400/40",
    red: "border-red-400/40",
  };
  // pma3d / ma20 之类比率字段的色标：MA20 站上比例 >50% 给中性正向，pop / top100 越大越拥挤（高位风险卡里）
  const cellTone = (cardTitle: string, key: string, v: number | undefined): string => {
    if (v == null) return "";
    if (key === "pct3d" || key === "pct5d" || key === "pct7d") return v >= 0 ? "text-red-300" : "text-emerald-300";
    if (key === "flow3d" || key === "flow1d") return v >= 0 ? "text-red-300" : "text-emerald-300";
    if (key === "ma20") return v >= 0.5 ? "text-emerald-300" : "text-amber-300";
    if (key === "pop" || key === "top100") return cardTitle === "高位风险" && v >= 0.3 ? "text-red-300" : "";
    return "";
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground">
        <span>
          板块全量看板（共 {data?.all_count ?? "—"} 个板块 · 口径 {data?.filter ?? "—"} · Top {data?.top_n ?? "—"}）
          {data?.trade_date ? ` · ${data.trade_date}` : ""}
          {data?.updated_at ? ` · 更新 ${fmtAge(data.age_sec)} (${data.updated_at})` : ""}
        </span>
        <button onClick={load} className="flex items-center gap-1 rounded-md border border-border/70 px-2.5 py-1.5 hover:text-foreground"><RefreshCw size={12} /> 刷新</button>
      </div>
      {error && <div className="rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-[13.5px] text-red-300">{error}</div>}
      {!cards && !error && (
        <div className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[13.5px] text-amber-300">
          三卡缓存未到位。请先执行：<code className="rounded bg-black/30 px-1.5 py-0.5">python scrape-aiwuchuan/scripts/sector_board_insights.py --no-cache</code>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {cardDefs.map((g) => (
          <div key={g.title} className={`rounded-xl border bg-overlay p-4 ${toneCls[g.tone]}`}>
            <div className="text-[15px] font-semibold">{g.title}</div>
            <div className="mb-2 text-[12.5px] text-muted-foreground">{g.desc}</div>
            <div className="max-h-[420px] space-y-1.5 overflow-auto">
              {(g.list ?? []).slice(0, 30).map((it, i) => (
                <div key={String(it.key ?? i)} className="rounded-lg border border-border/50 px-3 py-2 text-[13px]">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{it.name}</span>
                    <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11.5px] text-muted-foreground">分 {it.score?.toFixed(2)}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]">
                    {g.fields.map((f) => {
                      const v = (it.display?.[f.key]) ?? "—";
                      const raw = (it as unknown as Record<string, number | undefined>)[f.key];
                      return (
                        <span key={f.key} className={cellTone(g.title, f.key, raw)}>
                          {f.label} <span className="font-mono">{v}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
              {!g.list?.length && <div className="py-4 text-center text-[12.5px] text-muted-foreground">暂无</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="text-[11.5px] text-muted-foreground">
        {oneDay ? (
          <>
            本地口径（快照天数不足，暂以当日字段计）：轮动 = 当日涨跌×10 + 当日主力净额/10 · 高位 = 当日涨跌≥3% · 低吸 = 其余按当日净额排序。
            数据源：<code>data/sector-snapshots.json（15:20 定时任务留档）</code>——3日/5日/7日/近一月均价 列随快照天数积累后自动恢复稳智口径。
          </>
        ) : (
          <>
            三卡分数公式（同源公开算法复刻）：
            轮动 = flow_3d_sum_yi + pct_chg_3d + top100_ratio + ma20_ratio ·
            低吸 = -pct_chg_5d + ma20_ratio + flow_1d_sum_yi - pop_concentration ·
            高位 = pct_chg_7d + pop_concentration + top100_ratio ·
            数据源：<code>aiwuchuan.com /api/sector-panorama</code>（公开、免登录）· 缓存：<code>scrape-aiwuchuan/cache/sector_insights_*.json</code>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- Tab4 个股评估矩阵 ---------------- */
function StockMatrixView() {
  const [rows, setRows] = useState<(Record<string, unknown> & { symbol?: string })[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const [mr, ar] = await Promise.all([
        getJson<{ rows: Record<string, unknown>[] }>("/api/quant/factor-matrix"),
        getJson<{ list?: Record<string, unknown>[] }>("/api/market/allstocks?page=1&page_size=6000&order_by=amount_yi&dir=desc").catch(() => ({ list: [] })),
      ]);
      const vals = new Map<string, Record<string, unknown>>();
      for (const r of mr.rows ?? []) vals.set(String(r.symbol), r);
      const list = (ar.list ?? []).map((s) => {
        const sym = String(s.symbol ?? "");
        const v = vals.get(sym) ?? {};
        const fv = (v.values ?? {}) as Record<string, unknown>;
        return {
          symbol: sym, name: String(s.name ?? ""), close: s.price ?? null, change_pct: s.change_pct ?? null,
          floatcap_yi: s.floatcap_yi ?? null, industry: s.industry ?? v.industry ?? null,
          volume_signal: fv.volume_signal ?? null, macd: fv.macd ?? null,
          rps_50: fv.rps_50 ?? null, rps_120: fv.rps_120 ?? null,
          zsb_dealer: fv.zsb_dealer ?? null, vwap_score: fv.vwap_score ?? null,
          kline_pattern: v.kline_pattern ?? null, trend_pressure_60: v.trend_pressure_60 ?? null,
        };
      });
      setRows(list);
    } catch (e) { setError(String((e as Error).message || e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const shown = useMemo(() => {
    const kw = q.trim();
    return kw ? rows.filter((r) => String(r.symbol ?? "").includes(kw) || String(r.name ?? "").includes(kw)) : rows;
  }, [rows, q]);
  const cols: { key: string; zh: string }[] = [
    { key: "symbol", zh: "代码" }, { key: "name", zh: "名称" }, { key: "close", zh: "最新价" }, { key: "change_pct", zh: "涨跌幅" },
    { key: "volume_signal", zh: "量能信号" }, { key: "macd", zh: "MACD柱" }, { key: "floatcap_yi", zh: "流通市值" },
    { key: "rps_50", zh: "RPS50" }, { key: "rps_120", zh: "RPS120" }, { key: "zsb_dealer", zh: "庄家线" },
    { key: "kline_pattern", zh: "K线形态" }, { key: "trend_pressure_60", zh: "趋势压力线_60" },
  ];
  return (
    <div className="rounded-xl border border-border/60 bg-overlay p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[14px] font-semibold">个股评估矩阵（全A {rows.length} 只 · 当日预计算）</div>
        <div className="flex items-center gap-2 text-[13px]">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选：代码/名称" className="w-44 rounded-md border border-border/70 bg-card px-2 py-1.5 text-foreground [color-scheme:dark]" />
          <button onClick={load} className="flex items-center gap-1 rounded-md border border-border/70 px-2.5 py-1.5 text-muted-foreground hover:text-foreground"><RefreshCw size={12} /> 刷新</button>
        </div>
      </div>
      {error && <div className="text-[13px] text-red-300">{error}</div>}
      {busy && !rows.length ? <div className="py-10 text-center text-[13px] text-muted-foreground"><Loader2 className="mr-1 inline animate-spin" size={13} />载入全A条件矩阵...</div> : (
        <div className="max-h-[560px] overflow-auto rounded-lg border border-border/50">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-surface text-muted-foreground"><tr>{cols.map((c) => <th key={c.key} className="px-3 py-2 text-left font-medium">{c.zh}</th>)}</tr></thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i} className="border-t border-border/40 hover:bg-overlay">
                  {cols.map((c) => {
                    const v = r[c.key];
                    const num = typeof v === "number";
                    const disp = num ? (c.key === "floatcap_yi" ? `${v.toFixed(2)}亿` : Number.isInteger(v) ? v : v.toFixed(2)) : String(v ?? "—");
                    const red = c.key === "change_pct" && num && (v as number) >= 0;
                    const green = c.key === "change_pct" && num && (v as number) < 0;
                    return <td key={c.key} className={`px-3 py-2 ${red ? "text-red-400" : green ? "text-emerald-400" : ""}`}>{disp}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 text-[11.5px] text-muted-foreground">条件值来自当日全A预计算缓存 × 实时快照联合；缺失读数如实显示「—」。</div>
    </div>
  );
}

/* ---------------- Tab5 产业链研报分析 ---------------- */
type Report = { ts: number; title: string; text: string; tradeDate?: string };

// 全 A 在册名册（P66 受益标的校验用）：一份进程内只拉一次的共享 promise。
// 服务端路由本身已缓存 15 分钟，这里再叠一层客户端去重 —— 切换历史研报 / 反复重新生成
// 都会重复触发校验，不该每次都打一遍接口。失败时也记住结果（不重试到死），
// 但校验条要如实显示"无法校验"，绝不因为拿不到名册就说标的都合规。
type RosterPayload = { ok?: boolean; count?: number; error?: string; names?: { symbol?: string; name?: string }[] };
let rosterLoading: Promise<{ rows: { symbol: string; name: string }[]; error: string }> | null = null;

function loadAShareRoster() {
  if (!rosterLoading) {
    rosterLoading = getJson<RosterPayload>("/api/market/stock-names")
      .then((j) => {
        const rows = (j?.names ?? [])
          .map((x) => ({ symbol: String(x.symbol ?? "").toUpperCase(), name: String(x.name ?? "").trim() }))
          .filter((x) => x.symbol && x.name);
        return { rows, error: rows.length ? "" : String(j?.error ?? "名册接口没返回公司名") };
      })
      .catch((e) => ({ rows: [] as { symbol: string; name: string }[], error: `名册接口无响应（${(e as Error).message}）` }));
  }
  return rosterLoading;
}

function IndustryReportView() {
  const [reports, setReports] = useState<Report[]>([]);
  const [active, setActive] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [booting, setBooting] = useState(true);
  const [fromServer, setFromServer] = useState(false);
  // 流式生成中的正文（边生成边显示）。生成完成后清空，改由 active 渲染最终结果。
  const [draft, setDraft] = useState("");
  // 本轮生成的起始时刻：元信息行「生成时间」在流式期间也要有值，但不能每帧重算 Date.now()
  const [startedAt, setStartedAt] = useState(0);
  // P66：受益标的 A 股核对结果（只在成稿/留档正文上跑，流式草稿边长边校会抖动）
  const [tickerCheck, setTickerCheck] = useState<TickerCheckResult | null>(null);
  const [tickerBusy, setTickerBusy] = useState(false);
  // 两个日期口径分开拿（P63 口径诚实化；判定逻辑在 report-date-core.ts）：
  //   dataEnd   = 复盘统计数据止于哪天（range.to，种子不续写就一直停在那天）
  //   marketDay = 行情源给的最近交易日（会跟着日历走；fromCalendar 时只是工作日推算，不可信）
  // 原来只有 dataEnd 一个数，页面却管它叫「最新交易日」—— 种子一落后就成了谎报，所以补第二个源来交叉核对。
  const [dataEnd, setDataEnd] = useState("");
  const [marketDay, setMarketDay] = useState("");
  const [marketFromCalendar, setMarketFromCalendar] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 并行取两个源：种子终点 + 行情源交易日（都是本机路由，不互相等待）
      const [seed, td] = await Promise.all([
        getJson<{ range?: { to?: string | null } }>("/api/market/review-stats").catch(() => null),
        fetch("/api/market/trade-date", { cache: "no-store" })
          .then((r) => r.json().catch(() => null))
          .catch(() => null),
      ]);
      if (cancelled) return;
      const d = String(seed?.range?.to ?? "").trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) setDataEnd(d);
      const m = String((td as { tradeDate?: unknown } | null)?.tradeDate ?? "").trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(m)) {
        setMarketDay(m);
        setMarketFromCalendar((td as { fromMarketData?: boolean }).fromMarketData !== true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 打开即读：服务端本地留档优先（命中就直接显示，不再等 AI 生成一轮）。
  // 关键路径并行 2 个本地请求（当日全文 + 最新交易日），都是本机路由，不互相等待、不增加首屏等待；
  // 历史列表随后再补，不挡首屏。服务端没有（或读取失败）时退回浏览器本地缓存，保证老数据不丢。
  //
  // 为什么必须先拿「最新交易日」：研报按**交易日**归档（见上）。休市日（周末/节假日）
  // 系统日期当天不会有研报，只按系统日期查会永远查不到，「打开即读」就失效了。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // ① 关键路径：并行取「系统日期那份」+「最新交易日」（两个本机路由，不串行等待）
      let todayReport: Report | null = null;
      let tradeDay = "";
      try {
        const [r, rv] = await Promise.all([
          fetch("/api/industry-report", { cache: "no-store" }),
          fetch("/api/market/review-stats", { cache: "no-store" }),
        ]);
        const j = await r.json().catch(() => null);
        const rj = await rv.json().catch(() => null);
        const d = String(rj?.range?.to ?? "").trim().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) tradeDay = d;
        if (j?.ok && j.found && j.report?.text) todayReport = j.report as Report;
      } catch { /* 服务端不可用，走本地兜底 */ }
      if (cancelled) return;
      // ② 目标 = 最新交易日那份。交易日当天走的就是上面那次请求（零额外等待）；
      //    休市日则按交易日再取一次；复盘接口挂了（tradeDay 为空）就沿用旧的「系统日期那份」口径。
      let hit: Report | null = null;
      if (tradeDay) {
        if (todayReport && todayReport.tradeDate === tradeDay) hit = todayReport;
        else {
          try {
            const res = await fetch(`/api/industry-report?date=${encodeURIComponent(tradeDay)}`, { cache: "no-store" });
            const jj = await res.json();
            if (jj?.ok && jj.found && jj.report?.text) hit = jj.report as Report;
          } catch { /* 取不到就当没有，不报错 */ }
        }
      } else {
        hit = todayReport;
      }
      if (cancelled) return;
      if (hit) {
        setActive(hit);
        setFromServer(true);
        setBooting(false);
        try { localStorage.setItem("mydesk-industry-reports", JSON.stringify([hit])); } catch { /* 忽略配额错误 */ }
        // ③ 后台补历史列表（不挡首屏）
        void (async () => {
          try {
            const lr = await fetch("/api/industry-report?list=1", { cache: "no-store" });
            const lj = await lr.json();
            if (cancelled || !lj?.ok || !Array.isArray(lj.reports)) return;
            setReports((lj.reports as { ts: number; title: string; tradeDate: string }[])
              .map((m) => ({ ts: m.ts, title: m.title, text: "", tradeDate: m.tradeDate })));
          } catch { /* 列表拿不到不影响正文 */ }
        })();
        return;
      }
      // ④ 服务端没有目标记录 → 退回本地缓存，同时仍补一次历史列表
      try { setReports(JSON.parse(localStorage.getItem("mydesk-industry-reports") ?? "[]")); } catch { /* 空 */ }
      try {
        const lr = await fetch("/api/industry-report?list=1", { cache: "no-store" });
        const lj = await lr.json();
        // 列表调用成功即视为权威源，哪怕为空也要覆盖本地缓存：
        // 否则已从服务端留档删掉的旧研报（如非交易日幽灵记录）会一直以历史 chip 挂在页面上。
        // 只有调用失败（catch）时才保留本地缓存，保证服务端不可用时不丢老数据。
        if (!cancelled && lj?.ok && Array.isArray(lj.reports)) {
          setReports((lj.reports as { ts: number; title: string; tradeDate: string }[])
            .map((m) => ({ ts: m.ts, title: m.title, text: "", tradeDate: m.tradeDate })));
        }
      } catch { /* 列表拿不到不影响 */ }
      setBooting(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // P66：正文落定后拿全 A 名册核一遍「核心受益/次级受益」的公司名。
  // 为什么放在生成之后而不是只靠 prompt 禁令：09-24 那份研报 prompt 里已经写了
  // 「受益标的只写 A 股上市公司」，产出里仍然出现「华虹半导体」（在册简称是华虹宏力 688347）、
  // 「华润微电子」（在册简称是华润微 688396）、「金山云」（不是 A 股）—— 禁令挡不住，
  // 只能事后拿真实名册逐条对，并把不对的点名叫给读者看。
  // 依赖只取正文文本：切换历史研报、重新生成完都会重校；名册本身走进程内共享 promise，不重复打接口。
  const activeText = active?.text ?? "";
  useEffect(() => {
    if (busy || !activeText) { setTickerCheck(null); return; }
    let cancelled = false;
    setTickerBusy(true);
    void (async () => {
      const items = extractBeneficiaryNames(activeText);
      const { rows, error } = await loadAShareRoster();
      if (cancelled) return;
      if (!items.length) {
        // 正文里没有受益栏：没什么可核的，但"名册到手了"与"名册没取到"要分开说
        setTickerCheck(summarizeTickerCheck([], rows.length ? rows : null));
        setTickerBusy(false);
        return;
      }
      if (!rows.length) {
        // 名册拿不到：如实回"无法校验"，不许显示成"核对通过"
        setTickerCheck({ checked: false, total: items.length, okCount: 0, alias: [], bad: [], risk: [], reason: `全 A 名册没取到（${error}）：受益标的本次无法校验 —— 这不代表标的都合规` });
      } else {
        setTickerCheck(summarizeTickerCheck(checkBeneficiaryNames(items, rows), rows));
      }
      setTickerBusy(false);
    })();
    return () => { cancelled = true; };
  }, [activeText, busy]);

  // 系统日历日（只用来判断"今天是不是交易日"，不再直接当研报日期）
  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);
  // 研报日 = 复盘数据止于那天（种子取不到才退行情源、再退系统日期）。休市日点生成，产出的是
  // 「上一个交易日」那份，标题与留档键都按交易日走，不产生非交易日的幽灵记录。
  // 措辞（能不能说"最新交易日"）由 report-date-core 按两个源是否一致决定，不在 JSX 里现编。
  const caliber = useMemo(
    () => reportDayCaliber({ dataEnd, marketDay, marketFromCalendar, today: todayStr }),
    [dataEnd, marketDay, marketFromCalendar, todayStr],
  );
  const reportDay = caliber.day;
  const isTradingToday = caliber.isTradingToday;
  const reportLabel = isTradingToday ? "今日研报" : `${reportDay} 研报`;
  const hasTodayReport = useMemo(
    () => !!active && (!active.tradeDate || active.tradeDate === reportDay),
    [active, reportDay],
  );

  // 点历史标签：正文可能还没拉（列表只带元信息），按需从服务端取
  const openReport = useCallback(async (r: Report) => {    if (r.text) { setActive(r); setFromServer(false); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/industry-report?date=${encodeURIComponent(r.tradeDate ?? "")}`, { cache: "no-store" });
      const j = await res.json();
      if (j?.ok && j.report?.text) { setActive(j.report as Report); setFromServer(true); }
    } catch { /* 保持当前 */ } finally { setBusy(false); }
  }, []);

  // 全A真实成交额锚点（P38 复检 #1）：仅取用到的字段；amount_known>0 才代表全A快照真读到成交额。
  type SentimentClient = { ok?: boolean; amount_total_yi?: number; amount_known?: number; as_of?: string };

  const generate = useCallback(async () => {
    setBusy(true); setError(""); setDraft(""); setStartedAt(Date.now());
    try {
      const [rv, tj, shK, szK, cybK, sent] = await Promise.all([
        getJson<{ rows: ReviewRow[] }>("/api/market/review-stats?from=" + shDay(10)).catch(() => ({ rows: [] as ReviewRow[] })),
        getJson<{ main?: Record<string, unknown>[] }>("/api/market/themes").catch(() => ({ main: [] })),
        // 快讯不在这个批次里：它要等 review-stats 回来才知道「研报区间是哪三个交易日」（P65）。
        // 以前这里跟别的请求并发打 /api/market/news（不带日期），拿回来的永远是「抓取那一刻的 12 条」，
        // 于是 09-24 的研报挂的是 09-27 的头条 —— 正文里那句「关联新闻：抓取当天的快讯里没有与该主线直接相关的题目」就是这么来的。
        // 指数真实趋势（P64）：点位 / MA5·10·20·60 / 距 60 日高点。以前不喂这些，模型就在正文里
        // 编「指数在 3000 点附近震荡」「跌破 2950 加仓」「MA5已跌破MA10」—— 真实读数是上证 3888.37、
        // MA5 3927.76 > MA10 3904.37，那三条全是假的。
        getJson<{ candles?: { date: string; c: number }[] }>(klineUrl("000001.SH")).catch(() => ({ candles: undefined })),
        getJson<{ candles?: { date: string; c: number }[] }>(klineUrl("399001.SZ")).catch(() => ({ candles: undefined })),
        getJson<{ candles?: { date: string; c: number }[] }>(klineUrl("399006.SZ")).catch(() => ({ candles: undefined })),
        // 全A真实成交额锚点（P38 复检 #1 / 红线「AI不编数」）：研报里「全市场/两市成交额」必须有真实总量可引用，
        // 否则模型会自己编（实测把 1.45 万亿写成 1.61 万亿）。amount_known>0 才算真读到，否则如实说没读到。
        getJson<SentimentClient>("/api/market/sentiment").catch(
          (): SentimentClient => ({ ok: false, amount_total_yi: undefined, amount_known: 0, as_of: undefined }),
        ),
      ]);
      const rows = (rv.rows ?? []).slice(-3);
      const th = (rv as { themeHeat?: ThemeHeatSeed }).themeHeat ?? null;
      // 报告日 = 本次真实数据覆盖到的最后一个交易日（复盘种子 range.to）。
      // 休市日（周末/节假日）系统日期当天没有行情：必须按交易日走，否则标题与留档键都会错。
      // 取不到（接口异常）才退回 latestTradeDate / 系统日期，与改动前行为一致。
      const dataDay = String((rv as { range?: { to?: string | null } }).range?.to ?? "").trim().slice(0, 10);
      const genDay = /^\d{4}-\d{2}-\d{2}$/.test(dataDay) ? dataDay : reportDay;
      // P64：数据块一律走 report-input-core 的中文口径（原来这里拼 `JSON.stringify(rows)` 直接塞英文字段，
      // 模型不懂语义 → 把「站上最近5天平均占比 27.56%」写成「跌破率 27.56%」、把 microPct 写成「微观成交占比」，
      // 还会把 aboveMa5Pct 这种内部字段名原样漏进正文）。
      const flowsZh = themeFlowsZh(th?.industries, th?.concepts);
      const rowsZh = reviewRowsZh(rows);
      const verdictZh = localVerdictZh(th);
      // 全A真实成交额锚点（P38 复检 #1）：模型写研报时最爱自己编「两市成交额 X 万亿」，
      // 实测 09-30 那份把 1.45 万亿编成 1.61 万亿。这里把全A快照真实合计喂进去当唯一可信总量，
      // amount_known=0（一家都没带成交额字段）时如实说没读到，绝不编一个总量。
      const turnoverYi = typeof sent.amount_total_yi === "number" && Number.isFinite(sent.amount_total_yi) ? sent.amount_total_yi : NaN;
      const turnoverKnown = (sent.amount_known ?? 0) > 0 && Number.isFinite(turnoverYi);
      const turnoverZh = turnoverKnown
        ? `⑦ 全A当日成交额锚点（真实，来自 /api/market/sentiment 全A快照合计，数据截至 ${sent.as_of ?? "未知"}）：约 ${turnoverYi.toFixed(0)} 亿元（≈ ${(turnoverYi / 10000).toFixed(2)} 万亿元）。`
        : `⑦ 全A成交额本次没读到（amount_known=0：全A快照里一家都没带成交额字段，合计 0 不是「今天只成交 0 亿」）。`;
      const indexZh = [
        indexTrendZh("上证指数(000001.SH)", indexTrendFromCandles(shK.candles)),
        indexTrendZh("深证成指(399001.SZ)", indexTrendFromCandles(szK.candles)),
        indexTrendZh("创业板指(399006.SZ)", indexTrendFromCandles(cybK.candles)),
      ];
      // 关联新闻（P65 改口径）：喂「研报区间 = 最近三个交易日」的快讯池，而不是抓取那一刻的 12 条。
      // 为什么放宽到三天：拿稳智那篇的关联新闻去东财归档逐条对过，它引的事件比研报日早 3~9 天
      // （「电子布涨价」原帖在 09-15/09-17），说明这一栏本来就是**跨多日按主线聚合的证据**；
      // 只喂当日快讯的话，单日约 760 条里跟某主线对得上的常常只有个位数，主线就只能挂空。
      // 我们只借这个窗口口径，不借它改写标题/改数字的写法：这里交出去的一律是带完整日期的原标题。
      const poolDates = rows.map((r) => String(r.date ?? "").slice(0, 10)).filter(Boolean).reverse(); // 新→旧
      const nj = await getJson<NewsPoolResp>(newsPoolUrl(poolDates)).catch(() => null);
      const pool: NewsPoolRow[] = (nj?.news ?? []).map((x) => ({
        date: String(x.date ?? "").slice(0, 10),
        time: String(x.time ?? ""),
        title: String(x.title ?? "").trim(),
      })).filter((x) => x.title);
      const hotThemes = [
        ...(th?.industries ?? []).map((x) => x.n),
        ...(th?.concepts ?? []).slice(0, 8).map((x) => x.n),
      ];
      const newsGroups = groupNewsByTheme(hotThemes, pool, { perTheme: 6 });
      const groupedNews = groupedNewsZh(newsGroups);
      const unmatchedNews = unmatchedThemesZh(newsGroups);
      const newsLabel = newsPoolLabelZh({
        dates: poolDates,
        total: pool.length,
        fetchedOn: todayStr,
        source: nj?.source?.provider,
        capped: nj?.capped,
      });
      // 一条主线都没挂上时（接口挂了/池子为空）退化成「按日期列出前 40 条」，让模型至少有无从编造的原料
      const newsBlock = groupedNews
        || pool.slice(0, 40).map((x) => newsQuoteZh(x)).join("")
        || `（本次没有取到快讯：${nj?.error ?? "接口无返回"}。正文里所有「关联新闻」一律写「数据不足」，不许自己编题目。）`;
      const prompt = [
  "你是A股产业链研究分析师，文风对标头部券商每日复盘研报。请基于下方【真实市场数据】撰写当日产业链深度研报（markdown 正文），严格遵循下列格式与文风要求。",
  "",
  "【一、整体格式（逐条照做）】",
  "1. 首行是一级标题，固定写成：# 📈 【A股市场深度复盘与机会前瞻】" + genDay,
  "2. 正文分五节，每节标题必须写成「## + 空格 + emoji + 空格 + 标题」，emoji 与文字照抄下面给出的，不得增删改：",
  "   ## 📊 市场情绪与风格判断",
  "   ## 🚀 核心主线与热点板块",
  "   ## 🧩 潜伏机会与预期差",
  "   ## ⚠️ 风险警示",
  "   ## 🧭 策略总结",
  "3. 每两节之间单独一行写 --- 作为分隔线（共 4 处）。",
  "4. 严禁使用 markdown 表格（正文里不要出现 | 竖线）；所有分层信息一律用「加粗小标题 + 项目符号 -」的嵌套列表表达。",
  "",
  "【二、加粗写法（文风核心，同时是硬红线）】",
  "全文要像研报一样「重点密布」：关键判断、板块名、产业链环节名、公司名、数值结论用 **加粗** 标出。",
  "经验密度：大约每 30 个字出现 1 处加粗（4000 字正文约 120 处，最多不超过 160 处）。不得出现整段没有一个加粗的素文段落，但也不许更密。",
  "红线 1：一处加粗只包一个词或一个短语，长度不超过 14 个字；不要把整句话切碎成十几个连续加粗。",
  "红线 2：两个加粗之间必须有「、」「，」或空格之类的分隔，**绝不允许写成 **A****B** 这种中间连着四个星号的形状**。",
  "红线 3：星号只能成对出现（** 开、** 闭），全文任何位置不得出现连续 3 个以上星号；发现自己在重复打星号就立刻停笔收尾。",
  "红线 4：数值只能照抄下方真实数据。数据里没有的指数点位、价格、止损位一律不许出现（不准写「3000 点」「跌破 2950 加仓」这类编出来的数）；",
  "   没有点位数据时就只引用涨跌幅、家数、资金额这些给到的读数，操作建议按「仓位比例 / 涨跌幅」表述。",
  "",
  "【三、各节的内部结构（字段名照抄）】",
  "▶ 市场情绪与风格判断（用 4 条加粗项 + 1 段收束，不要用 ### 小标题）：",
  "- **市场阶段**：……（用上面「本地量化引擎判读」给的市场桶/阶段定性，并引用指数趋势里的真实点位；判读没给就写「数据不足」，不许自己定性和编点位）",
  "- **情绪温度**：……（用 🟠/🔥/🧊 等 emoji 定性，并引用真实读数）",
  "- **风格研判**：……（大小盘 / 成长价值 / 高低位）",
  "- **核心逻辑**：……（分 1./2./3. 条列出驱动）",
  "**综合判断**：用一段话收束本节。",
  "▶ 核心主线与热点板块（2-3 条主线，每条严格按下面五件套写）：",
  "### 1. 主线名称（🔥 热度：极高｜高｜中高｜中）",
  "> **关联新闻**：“新闻标题1”（09-20 11:28）“新闻标题2”（09-22 09:31）……（只能从下方 ⑥「已按主线预分组」里该主线名下的快讯挑；标题逐字照抄，标题后面的（月-日 时:分）日期标注一并照抄，一条不许少，每条主线至少 3 条，用中文引号串起来）",
  `   （那条主线在下面没有对应快讯时，就写「> **关联新闻**：本区间快讯池里没有与该主线直接相关的题目」，不许挪用别的主题的标题，更不许自己编一条新闻。）`,
  "- **逻辑推演**：……（为什么是主线，结合真实数据）",
  "- **产业链受益**：",
  "  **① 环节名（一句话定性）**",
  "  - 核心受益：**公司A、公司B**（一句理由）；**公司C**（一句理由）",
  "  - 次级受益：**公司D、公司E**（一句理由）",
  "  **② 环节名**",
  "  - 核心受益：……",
  "- **操作建议**：……（分 2-3 条，说清节奏 / 仓位 / 止损）",
  "▶ 潜伏机会与预期差（1-3 个机会点）：",
  "- **① 机会点名称**",
  "  - **逻辑**：……（市场主流预期是什么、可能错在哪）",
  "  - **验证点**：……（盯哪个数据或事件来证实或证伪）",
  "▶ 风险警示（2-4 条，每条「加粗风险名 + 具体描述」）：",
  "- **风险名**：具体描述……",
  "▶ 策略总结：一整段话收束，给出仓位与配置方向。",
  "",
  "【四、结尾（一字不改照抄）】",
  "---",
  "**免责声明**：本分析基于公开信息整理，不构成任何投资建议。A股市场受多重因素影响，历史表现不代表未来。投资者应结合自身风险承受能力独立决策，并对投资结果负责。",
  "",
  "【真实市场数据（全部来自本站真实接口；下面没给的读数一律不许出现在正文里）】",
  "① 指数趋势（真实日K算出，正文里的点位 / 与最近一个月均价的关系 / 回撤只能引用这里）：",
  ...indexZh,
  "② " + verdictZh,
  "③ 指标口径（照这个读，不许按字段名猜）：",
  ...METRIC_DEFS_ZH,
  "④ 最近三个交易日复盘统计：",
  ...rowsZh,
  "⑤ 当日主线热度与 3 日资金（正数=流入）：",
  ...flowsZh,
  `⑥ ${newsLabel}，已按主线预分组（每条标题后面的日期就是它真实发布的日期）：`,
  newsBlock,
  ...(unmatchedNews ? [unmatchedNews] : []),
  turnoverZh,
  turnoverKnown
    ? "  正文里凡提到「全市场成交额 / 两市成交额 / 全A成交额 / 量能总量」这类**总量**读数，只能引用⑦给的数（约 " + (turnoverYi / 10000).toFixed(2) + " 万亿元），不许另编一个总量；分行业/分板块的成交额没给你，要写就写「数据不足」。"
    : "  正文里所有「全市场成交额 / 两市成交额」一律写「数据不足」，不许编一个总量数（本次全A快照没读到成交额字段）。",
  "",
  "【硬性纪律】",
  "1. 所有判断必须与上述数据一致，不得编造读数；数据不足的环节明确写「数据不足」，不编造公司或数字。",
  "1b. 指数与板块涨跌的「方向」只能照抄数据里带正负号的当日涨跌（如 +0.18%=上涨、-0.34%=下跌），",
  "   严禁依据「价格在一个月均价下方」「退潮」等语境自行推测方向——实测曾把真实 +0.18% 写成「跌幅 0.18%」（方向写反）。",
  "2. 产业链受益环节列代表公司时，只用A股真实存在的上市公司。",
  "3. 标题层级只用 # / ## / ###，正文用 - 项目符号；不要表格、不要代码块、不要 JSON。",
  "4. 正文里不许出现内部字段名（aboveMa5Pct、microPct、decliners、limitUp 这类），指标一律用上面「指标口径」给的中文说法。",
  "5. 没有喂业绩、调研、订单类数据：不许写「业绩兑现阶段」「主升浪中段」这种需要产业基本面证据的定性；只能说数据里给到的情绪面 / 资金面 / 热度读数。",
  "6. 新闻只能从 ⑥ 里逐字照抄原标题，并把它后面的日期标注一起抄下来；不许改写、不许自拟、不许把标题里的数字换成别的数。",
  "   反面例子：原帖是「快递“反内卷”引发新一轮涨价 多家公司今起安徽区域单票最低上调0.15元」，",
  "   写成「快递单票价格同比+4%」就是编造（涨幅和口径都是换过的）——读者拿标题去搜搜不到，这种引用一次都不许出现。",
  "7. 受益标的只写 A 股上市公司。反面例子：**星际荣耀**、**华为海思**、**长江存储** 都不是 A 股上市公司，一次都不能作为标的出现；",
  "7b. 全市场/全A成交额只能引用 ⑦ 给的真实总量（本次约 " + (turnoverKnown ? (turnoverYi / 10000).toFixed(2) + " 万亿元" : "未读到") + "），",
  "   严禁自己编一个总量数（实测曾把 1.45 万亿写成 1.61 万亿，这种一眼假的数字一次都不许出现）；分行业成交额没给就写「数据不足」。",
  "   拿不准公司是否上市，就只写产业链环节名，不写公司名。",
  "   公司名必须用**A 股在册证券简称**，不许拿港/美那边的叫法顶替：「华虹半导体」是港股名，A 股在册叫「华虹宏力」；",
  "   「华润微电子」的 A 股在册简称是「华润微」；「金山云」不是 A 股公司，压根不能出现在受益栏。",
  "   这三处写法都会被页面上的「受益标的 A 股核对」程序逐条点名，写错就露错。",
  "   在册简称会随公司状态变：已被风险警示的标的要按在册写法写（300044 现在在册叫「*ST赛为」），沿用改名前的老名会被判成简称不符。",
].join("\n");
      // 流式生成：边生成边显示（详见 streamReport 注释）。
      // 节流：ReportMarkdown 每次都要重解析全文，按帧原样 setState 会 O(n²) 卡顿，120ms 一帧足够顺滑。
      let lastPaint = 0;
      const { text: content } = await streamReport(prompt, (full) => {
        const now = Date.now();
        if (now - lastPaint < 120) return;
        lastPaint = now;
        // 流式期间也过一遍加粗修补：模型边写边出现 `**A****B**` / 奇数个标记的行，
        // 直接画会满屏裸星号（mendBoldSeams 只动星号不动字，且对已修补的文本是幂等的）。
        setDraft(mendBoldSeams(full));
      }, { maxTokens: 6000 });
      if (!content.trim()) throw new Error("研报生成失败：上游未返回内容");
      // 跑偏拦门（P63 实测）：模型偶尔在加粗处塌缩成「连续几千个星号」的复读墙。
      // 这种必须**在入库之前**拦下 —— 留档一天一份、同名即覆盖，
      // 让它进去就会把同一天原本能看的那份研报冲掉（2026-09-27 就这么丢过一次）。
      const shape = screenReportShape(String(content));
      if (!shape.ok) throw new Error(shape.reason);
      // 骨架兜底（P64 实测 12:05 那轮）：口径全对了，但 `## 🚀 核心主线`、`## 🧩 潜伏机会`、
      // `## 🧭 策略总结` 三节标题和结尾【免责声明】被整段跳过 → 页面看着就是缺两节没落款。
      // 只把结构零件插回原位（锚点从正文自身找），内容一个字不替模型写；流式草稿不做这件事，
      // 半截正文里补标题会闪出空壳小节。
      const skeleton = mendReportSkeleton(String(content));
      if (skeleton.inserted.length) console.info("研报骨架已补回：" + skeleton.inserted.join("、"));
      // P63：正文先补断口加粗；标题改由 report-text-core 取 —— 模型会跳过 H1 首行，
      // 「抓第一个非空行」会把 `## 📊 市场情绪与风格判断` 这样的小节标题当成封面大标题。
      // 顺带补两条被证实的文字口误（15仓位→15%仓位、受5基站→受5G基站，只修这两种形状）。
      const text = mendTypos(mendBoldSeams(skeleton.text));
      const title = reportTitleOf(text, genDay);
      // tradeDate 必须显式带上：留档服务的自然键默认取系统日期，休市日会把研报存到非交易日名下
      const rec: Report = { ts: Date.now(), title, text, tradeDate: genDay };
      setReports((prev) => {
        const next = [rec, ...prev.filter((p) => p.tradeDate !== rec.tradeDate)].slice(0, 10);
        try { localStorage.setItem("mydesk-industry-reports", JSON.stringify(next)); } catch { /* 忽略配额错误 */ }
        return next;
      });
      setActive(rec); setFromServer(true);
      // 落服务端本地留档：下次打开直接读，不用再等 AI 生成一轮。
      // 保存失败不阻断展示（研报已经生成好了），只在控制台留痕。
      try {
        const sr = await fetch("/api/industry-report", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ts: rec.ts, title: rec.title, text: rec.text, tradeDate: rec.tradeDate }),
        });
        if (!sr.ok) console.warn("[industry-report] 服务端留档失败:", sr.status);
      } catch (e) { console.warn("[industry-report] 服务端留档异常:", e); }
    } catch (e) { setError(String((e as Error).message || e)); } finally { setBusy(false); setDraft(""); }
  }, []);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[17px] font-semibold">产业链研报分析</div>
          <div className="mt-0.5 text-[13px] text-muted-foreground">
            基于真实市场数据（复盘统计 + 主题榜单 + 研报区间三个交易日的快讯池）由 AI 生成 ·
            研报自动存到本地，下次打开直接读，无需重新生成。
            {caliber.banner && <span className="ml-1 text-amber-300/90">{caliber.banner}</span>}
          </div>
        </div>
        <button onClick={generate} disabled={busy}
          title={hasTodayReport ? `${reportDay} 已有研报，点击会用最新数据重新生成并覆盖` : `基于 ${reportDay} 真实数据生成研报`}
          className="flex items-center gap-1.5 rounded-md bg-sky-600 px-4 py-2 text-[13.5px] font-medium text-white hover:bg-sky-500 disabled:opacity-50">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} {hasTodayReport ? `重新生成${reportLabel}` : `生成${reportLabel}`}
        </button>
      </div>
      {error && <div className="rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-[13.5px] text-red-300">{error}</div>}
      {reports.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {reports.map((r) => (
            <button key={r.ts} onClick={() => { void openReport(r); }}
              title={r.tradeDate ? `交易日 ${r.tradeDate} · 生成于 ${new Date(r.ts).toLocaleString("zh-CN")}` : new Date(r.ts).toLocaleString("zh-CN")}
              className={`rounded-md border px-2.5 py-1.5 text-[12.5px] transition-colors ${active?.ts === r.ts ? "border-sky-400/60 bg-sky-400/15 text-sky-200" : "border-border/60 text-muted-foreground hover:text-foreground"}`}>
              {r.tradeDate ?? new Date(r.ts).toLocaleString("zh-CN")}
            </button>
          ))}
        </div>
      )}
      {/* 渲染优先级：流式草稿 > 成稿 > 读取中 > 生成中（首批内容未到）> 空态。
          草稿必须排在成稿之前 —— 点「重新生成」时 active 里还留着上一份，成稿若排在前面，
          下面那张流式纸面永远走不到：界面会一直显示旧研报，等全文到齐才突然跳成新稿，
          注释里承诺的「边生成边显示」就成了空话（2026-09-27 端到端复测时实测到的）。
          生成失败/中断时 busy 落下、draft 清空，自动退回上一份成稿，不会白屏。 */}
      {busy && draft ? (
        // 骨架与成稿共用 ReportPaper —— 生成中就能看到顶栏/徽标/元信息，不会"先素一页再突然变样"。
        <ReportPaper
          title={reportTitleOf(draft, reportDay)}
          generatedAt={startedAt || Date.now()}
          observeDate={reportDay}
          observeNote={caliber.note}
          chip={
            <span className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11.5px] text-sky-300/90">
              边生成边显示 · 已 {draft.length} 字
            </span>
          }
        >
          <ReportMarkdown text={draft} />
        </ReportPaper>
      ) : active ? (
        <ReportPaper
          title={active.title}
          generatedAt={active.ts}
          observeDate={active.tradeDate ?? reportDay}
          observeNote={active.tradeDate && active.tradeDate !== reportDay ? `当前数据止于 ${reportDay}` : caliber.note}
          chip={fromServer ? (
            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11.5px] text-emerald-300/90">本地留档 · 打开即读</span>
          ) : null}
        >
          {/* 保留 markdown 的 # 标记：章节标题靠它识别（旧版用 pre-wrap 才需要剥掉 #） */}
          <ReportMarkdown text={active.text} />
        </ReportPaper>
      ) : booting ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[13.5px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> 正在读取本地当日记录…
        </div>
      ) : busy ? (
        // 已点生成、首批内容还没到（流式草稿为空）：只给一条加载提示，不铺空骨架。
        <div className="flex items-center justify-center gap-2 py-10 text-[13.5px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> 正在生成 {reportDay} 研报…首批内容到达后自动显示
        </div>
      ) : (
        <div className="py-10 text-center text-[13px] text-muted-foreground">还没有研报：点「生成{reportLabel}」基于 {reportDay} 真实数据生成。</div>
      )}
      {/* P66 受益标的 A 股核对条：这是**我们自己的核对**，故意不并进 ReportPaper 纸面 ——
          研报正文是模型写的，校验结论是程序给的，两者混排读者就分不清哪句是原文哪句是审计。
          配色沿用本页既有的错误条口径（红=写错硬伤、琥珀=疑似简称/在册已风险警示、灰=无法校验），不为它新造一套 .rp-* 度量。 */}
      {active && !busy && (tickerBusy || tickerCheck) ? (
        <div
          className={`rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed ${
            !tickerCheck
              ? "border-border/60 bg-overlay text-muted-foreground"
              : !tickerCheck.checked
                ? "border-border/60 bg-overlay text-muted-foreground"
                : tickerCheck.bad.length
                  ? "border-red-400/25 bg-red-400/10 text-red-200"
                  : tickerCheck.alias.length || tickerCheck.risk.length
                    ? "border-amber-400/25 bg-amber-400/10 text-amber-200"
                    : "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
          }`}
        >
          <div className="mb-1 flex items-center gap-2 text-[12.5px] font-medium">
            <ShieldCheck size={13} className="shrink-0" />
            受益标的 A 股核对
            {tickerBusy && !tickerCheck ? <span className="text-muted-foreground">核对中…</span> : null}
          </div>
          {tickerCheck ? (
            <ul className="space-y-0.5">
              {tickerCheckLinesZh(tickerCheck).map((l, i) => (
                // 纯核给的是整句话，这里只按行铺开；`**…**` 是核心核对结论的强调位
                <li key={i}>{renderInline(l)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const TABS = ["主题热点", "研究池", "板块全景看板", "个股评估矩阵", "产业链研报分析"] as const;
type TabKey = (typeof TABS)[number];

/* ---------------- 产业链研报 · Markdown 排版（对齐稳智「研究结论」观感） ----------------
   仿 aiwuchuan.com/settings 研报页：
   ① 章节标题（## 开头）→ 蓝色粗竖条 + 加粗大字号，层级拉满；
   ② 普通标题 / 强调行 / 列表 / 表格分别给更大字号与更宽行距，正文横向铺满；
   ③ 标题里的 emoji 原样保留，不再额外加工。
*/
type ReportLine = { kind: "h2" | "h3" | "h4" | "strong" | "list" | "table" | "quote" | "hr" | "p" | "empty"; text: string; items?: string[] };

function parseReportLines(md: string): ReportLine[] {
  const lines = md.split(/\r?\n/);
  const out: ReportLine[] = [];
  // 连续的项目符号合并成一个列表（否则每个子弹点各成一个 ul，间距会散开）
  let listBuffer: string[] = [];
  let tableBuffer: string[] = [];
  const flushList = () => {
    if (listBuffer.length) { out.push({ kind: "list", text: "", items: listBuffer }); listBuffer = []; }
  };
  const flushTable = () => {
    if (tableBuffer.length) { out.push({ kind: "table", text: tableBuffer.join("\n") }); tableBuffer = []; }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    // 空行：先收掉正在累积的列表 / 表格
    if (!line.trim()) { flushList(); flushTable(); out.push({ kind: "empty", text: "" }); continue; }
    const h2 = /^##\s+/.exec(line);
    const h3 = /^###\s+/.exec(line);
    const h4 = /^####\s+/.exec(line);
    const h1 = /^#\s+/.exec(line);
    if (h2 || h3 || h4 || h1) {
      flushList(); flushTable();
      // 注意顺序：#### 必须先于 ### 判断，否则会被 ### 抢走
      if (h4) out.push({ kind: "h4", text: line.replace(/^####\s+/, "") });
      else if (h3) out.push({ kind: "h3", text: line.replace(/^###\s+/, "") });
      else if (h2) out.push({ kind: "h2", text: line.replace(/^##\s+/, "") });
      else out.push({ kind: "h2", text: line.replace(/^#\s+/, "") });
      continue;
    }
    if (/^(?:---|\*\*\*|___)\s*$/.test(line.trim())) { flushList(); flushTable(); out.push({ kind: "hr", text: "" }); continue; }
    // 引用块（稳智研报的 `> **关联新闻**：“…”` 就靠它渲染成蓝色引用条，而不是露出一个 ">" 字符）
    if (/^>\s?/.test(line)) { flushList(); flushTable(); out.push({ kind: "quote", text: line.replace(/^>\s?/, "") }); continue; }
    if (/^\s*[-*+]\s+/.test(line)) { flushTable(); listBuffer.push(line.replace(/^\s*[-*+]\s+/, "")); continue; }
    if (/^\|.*\|\s*$/.test(line.trim())) { flushList(); tableBuffer.push(line.trim()); continue; }
    flushList(); flushTable();
    // 行内加粗（**text** / __text__）作为强调段
    if (/^\s*\*\*[^*]+\*\*/.test(line) || /^\s*__[^_]+__/.test(line)) { out.push({ kind: "strong", text: line.trim() }); continue; }
    out.push({ kind: "p", text: line.trim() });
  }
  flushList(); flushTable();
  return out;
}

// 行内标记：只负责「拆出 strong / code」，字号字重一律交给 globals.css 的 .rp-body 后代规则。
// （P63：度量集中一处是这仓的纪律 —— 原来这里把字号写死在组件上，改一档要翻三个文件。）
function renderInline(text: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  // 拆 `code`
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((p, i) => {
    if (p.startsWith("`") && p.endsWith("`")) {
      nodes.push(<code key={i}>{p.slice(1, -1)}</code>);
    } else {
      // 行内加粗 **text**
      const segs = p.split(/(\*\*[^*]+\*\*|__[^_]+__)/g);
      segs.forEach((s, j) => {
        if (/^(\*\*[^*]+\*\*|__[^_]+__)$/.test(s)) {
          nodes.push(<strong key={`${i}-${j}`}>{s.replace(/^\*\*|\*\*$|^__|__$/g, "")}</strong>);
        } else if (s) {
          nodes.push(<span key={`${i}-${j}`}>{s}</span>);
        }
      });
    }
  });
  return nodes;
}

/**
 * 研报正文渲染器（P63 起：只出语义标签 + 类名，不写度量）。
 * 包在哪一层由 ReportPaper 的 .rp-body 决定。
 */
function ReportMarkdown({ text }: { text: string }) {
  // 首行若是与顶部大标题重复的 H1，去掉，避免同一句话出现两次
  // （稳智那侧正是没剥，hero 与正文各印一遍标题 —— 抄骨架时不跟这个瑕疵）
  const body = useMemo(() => text.replace(/^\s*#\s+.*\r?\n/, ""), [text]);
  const lines = useMemo(() => parseReportLines(body), [body]);
  return (
    <>
      {lines.map((l, i) => {
        switch (l.kind) {
          // 章节标题：稳智的「蓝色粗竖条 + 23px/800」（度量在 .rp-h2）
          case "h2":
            return <h2 key={i} className="rp-h rp-h2">{renderInline(l.text)}</h2>;
          case "h3":
            return <h3 key={i} className="rp-h3">{renderInline(l.text)}</h3>;
          case "h4":
            return <h4 key={i} className="rp-h4">{renderInline(l.text)}</h4>;
          case "strong":
            return <p key={i} className="rp-strong-line">{renderInline(l.text)}</p>;
          // 引用块：研报的 `> **关联新闻**：“…”` 靠它成蓝色引用条
          case "quote":
            return <blockquote key={i} className="rp-quote">{renderInline(l.text)}</blockquote>;
          case "list":
            return (
              <ul key={i}>
                {(l.items ?? [l.text]).map((it, k) => <li key={k}>{renderInline(it)}</li>)}
              </ul>
            );
          case "table":
            // prompt 里禁止表格，但历史留档可能还有：借用对话页的表格卡度量，不再自造一套
            return (
              <div key={i} className="wz-table-card desk-scroll overflow-x-auto">
                <table className="wz-table">
                  <tbody>
                    {l.text.split("\n").filter((r) => !/^\|[\s:|-]+\|$/.test(r)).map((row, r) => (
                      <tr key={r}>
                        {row.replace(/^\||\|$/g, "").split("|").map((cell, c) => (
                          r === 0
                            ? <th key={c}>{renderInline(cell.trim())}</th>
                            : <td key={c}>{renderInline(cell.trim())}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={i} />;
          // 空行不再塞占位 div：块间距归 .rp-body > * 的 margin 管
          case "empty":
            return null;
          default:
            return <p key={i}>{renderInline(l.text)}</p>;
        }
      })}
    </>
  );
}

/**
 * 研报纸面骨架（P63 抄自稳智产业链研报页的 DOM 结构，只抄骨架、不抄内容）。
 * 顶栏渐变条 → 英文眉标 → 「研」徽标 + kicker + 大标题 → 分隔线 → 元信息三格 → 正文。
 * 三个元信息格填的是我们自己的记录字段（active.ts / tradeDate / 生成状态），
 * 文案与数据读数没有一个来自对方页面。度量在 globals.css 的 .rp-* 段。
 */
function ReportPaper(props: {
  title: string;
  /** 生成时间：留档记录的 ts；流式生成中还没有落档值，传空由这里用当前时刻 */
  generatedAt: number;
  /** 交易观察日（这份研报的正文归属于哪个交易日） */
  observeDate: string;
  /** 观察日口径说明（例如"复盘统计止于该日"），原样上屏，不替数据撒谎 */
  observeNote?: string;
  chip?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { title, generatedAt, observeDate, observeNote, chip, children } = props;
  return (
    <article className="rp-paper">
      <div className="rp-topbar" aria-hidden />
      <div className="rp-coverline">A-Share Industry Chain Research</div>
      <div className="rp-hero">
        <div className="rp-badge" aria-hidden>研</div>
        <div className="rp-hero-main">
          <div className="rp-kicker">产业链专题复盘</div>
          <h1 className="rp-title">{title}</h1>
        </div>
        {chip ? <div className="shrink-0">{chip}</div> : null}
      </div>
      <div className="rp-divider" aria-hidden />
      <div className="rp-subline">
        <span>生成时间 <strong>{new Date(generatedAt).toLocaleString("zh-CN", { hour12: false })}</strong></span>
        <span>研究视图 · AI 生成正文</span>
        <span>交易观察日 <strong>{observeDate || "—"}</strong>{observeNote ? `（${observeNote}）` : ""}</span>
      </div>
      <div className="rp-body">{children}</div>
    </article>
  );
}

export default function LlmAnalysisPage() {
  const [tab, setTab] = useState<TabKey>("主题热点");
  return (
    <div className="w-full px-8 py-5">
      <div className="text-center">
        <h1 className="text-[23px] font-semibold tracking-tight">LLM分析</h1>
        <p className="mt-1 text-[13.5px] text-muted-foreground">基于公开数据的历史资金流向及涨跌统计分析。所示内容仅供市场研究与分析，不构成任何投资建议。投资有风险，决策需谨慎。</p>
      </div>
      <div className="apple-fade-in mt-4 flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-lg border px-4 py-2 text-[14px] transition-colors ${tab === t ? "border-sky-400/60 bg-sky-400/15 font-medium text-sky-200" : "border-border/60 bg-overlay text-muted-foreground hover:text-foreground"}`}>
            {t}
          </button>
        ))}
      </div>
      <div className="mt-3 space-y-3">
        {tab === "主题热点" && <ThemeHotView />}
        {tab === "研究池" && (
          <div className="rounded-xl border border-border/60 bg-overlay p-4 text-[13.5px] text-muted-foreground">
            研究池 = 量化候选池（冻结时点真实结果）× AI 优选记录。请先在「量化选股」工作台创建候选池/保存策略，这里随后接入池数据。
          </div>
        )}
        {tab === "板块全景看板" && <SectorPanoramaView />}
        {tab === "个股评估矩阵" && <StockMatrixView />}
        {tab === "产业链研报分析" && <IndustryReportView />}
      </div>
    </div>
  );
}
