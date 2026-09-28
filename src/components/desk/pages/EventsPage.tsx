"use client";
// 全球事件雷达页（P2 建页 → P3 增量口径 → P4 历史复盘 → P6-B 事件 AI 理解层）
// 「今天」走 GET/POST /api/events（P2/P3 已验收口径不变）；「历史」走 GET /api/events/history?date=…，
// 读的是 global_event 里 asOf 等于该日的真实行：产业链映射与资金验证都是入库当时算好的值，本页面不重算、不改写。
//
// P6-B 加的是**解释层**，不是第二份事件数据：
// - 列表主体仍然逐条来自 global_event（REAL 层），徽章保持 HISTORICAL；
// - 「AI 理解今日事件」= 客户端拿服务端组装好的提示词调模型 → 模型原文交回服务端复校验落库 →
//   本页再 GET /api/events/interpret 读回（页面自己不解析模型输出、不判断哪条能用，口径在服务端）；
// - AI 未配置时显示 AI_NOT_CONFIGURED（DEGRADED），绝不用本地文案冒充解释；
// - 每条解释都带「原始事件 → AI 提取 → AI 解释」回溯与 status/confidence 的语义说明。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Globe2, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { SourceBadge, PctText } from "../SourceBadge";
import { AutoTaskLine } from "../AutoTaskLine";
import { HistoryBar } from "../HistoryBar";
import { InterpretationCard, interpretKey } from "../EventInterpretation";
import { useDesk } from "@/lib/desk/store";
import { aiReady } from "@/lib/desk/ai";
import { RUN_STATUS_TEXT, runEventInterpretation, type InterpretProgress, type RunStatus } from "@/lib/desk/event-interpret";
import {
  fetchEvents, scanEvents, scanResultNote, fetchEventsHistory, fetchInterpretations,
  type EventHistoryItemClient, type EventItemClient, type HistoryRespClient, type InterpretLoadClient,
} from "@/lib/desk/quant-api";

const LEVEL_TONE: Record<string, string> = {
  全球级事件: "border-violet-500/40 text-violet-300",
  重大产业事件: "border-orange-500/40 text-orange-300",
  重要行业事件: "border-sky-500/40 text-sky-300",
  行业新闻: "border-border text-muted-foreground",
  普通新闻: "border-border text-muted-foreground",
};

const bjTime = (iso: string | null | undefined): string => {
  if (!iso) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
};

export default function EventsPage() {
  const [items, setItems] = useState<EventItemClient[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [unmatched, setUnmatched] = useState<number | null>(null);
  const [asOf, setAsOf] = useState("");
  // 数据来源标注：页面展示的始终是 global_event 库行（GET 读当日；POST 扫描后回读同一天的库行），
  // 不是实时快讯流，故徽章不得写 LIVE（REAL_DATA_ONLY：徽章口径必须等于真实数据链）。
  const [origin, setOrigin] = useState<"db" | "scan">("db");
  const [windowDates, setWindowDates] = useState<string[]>([]); // 「今天」视图的跨日窗口（新→旧）
  const [supplemented, setSupplemented] = useState(false);       // true = 今天不足 20 条、自动补了更早的日子
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [taskTick, setTaskTick] = useState(0); // 手动扫描后自增 → 任务状态条重读 task_run
  const [scanNote, setScanNote] = useState(""); // 本次手动扫描的口径与写库明细（服务端返回，不在前端算）
  // P4 历史视图
  const [view, setView] = useState<"today" | "history">("today");
  const [hist, setHist] = useState<HistoryRespClient<EventHistoryItemClient> | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [metaTick, setMetaTick] = useState(0); // 扫描后自增 → 重读「库里有哪几天可查」，不碰用户所选日期
  // P6-B 事件 AI 理解层（读的是 event_interpretation，与上面的事件列表分列，不混渲染）
  const ai = useDesk((s) => s.ai);
  const [interp, setInterp] = useState<InterpretLoadClient | null>(null);
  const [interpDate, setInterpDate] = useState(""); // 当前解释层对应的那一天（'' = 服务端默认今天）
  const [interpBusy, setInterpBusy] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus | "">("");
  const [runNote, setRunNote] = useState("");
  const [runMissing, setRunMissing] = useState<string[]>([]);
  const [progress, setProgress] = useState<InterpretProgress | null>(null); // 分批进度（点「AI 理解」时逐批更新）

  const load = useCallback(async () => {
    setError("");
    try {
      const j = await fetchEvents();
      setItems(j.items); setAsOf(j.as_of); setOrigin("db");
      setWindowDates(j.window_dates ?? []); setSupplemented(!!j.supplemented);
      setMissing([]); setUnmatched(null);
    } catch (e) { setError(String((e as Error).message || e)); }
  }, []);

  // P6-B：解释层单独读，读回的都是服务端算好的口径（counts/layering/missing/stale/orphan 都不在页面重算）
  const loadInterps = useCallback(async (date?: string) => {
    setInterpBusy(true);
    setInterpDate(date ?? "");
    try { setInterp(await fetchInterpretations(date ?? "")); }
    catch (e) { setError(String((e as Error).message || e)); setInterp(null); }
    finally { setInterpBusy(false); }
  }, []);

  const openHistory = useCallback(async (date?: string) => {
    setHistLoading(true); setError("");
    try {
      const j = await fetchEventsHistory(date ? { date } : {});
      setHist(j); setView("history");
      // 解释层跟着切换：历史那天点过「AI 理解」才会有行，没点过就是空 + 服务端给的原因
      void loadInterps(j.date ?? undefined);
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setHistLoading(false); }
  }, [loadInterps]);

  // 只取「库里有哪几天可查」这份元信息（服务端 groupBy 聚合），不切视图：
  // 否则今天视图里的日期入口拿不到归档清单，会把「其实有数据」显示成「库内暂无归档」。
  const loadHistoryMeta = useCallback(async () => {
    try { setHist(await fetchEventsHistory()); } catch { /* 元信息读不到不影响今日视图，入口自己会显示「正在读取」 */ }
  }, []);

  const scan = async () => {
    setBusy(true); setError(""); setScanNote("");
    try {
      const j = await scanEvents();
      setItems(j.items); setAsOf(j.trade_date); setMissing(j.missing ?? []); setUnmatched(j.unmatched ?? null);
      setWindowDates(j.trade_date ? [j.trade_date] : []); setSupplemented(false); // 扫描写的是单日：窗口收成那一天
      setScanNote(scanResultNote("events", j.mode, j.delta));
      setOrigin("scan");
      setView("today"); // 扫描写的是今天：不把今天的结果摆成历史某天的归档
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); setTaskTick((t) => t + 1); setMetaTick((t) => t + 1); void loadInterps(); }
  };

  // 当天是否已有「未过期」的解释：有就直接读缓存、不再重复调模型（用户要求）。
  // 过时（stale>0）说明事件行被重扫刷新过、解释对不上了，这种情况仍要重跑。
  const todayCached = !!interp && interp.counts.rows > 0 && interp.counts.stale === 0;
  const progressPct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  // P6-B 一次点击的完整链路（模型只在客户端被调用；服务端负责事实与校验）
  // force=true 时才强制重跑模型（「重新理解」按钮）；否则当天有缓存就只读缓存。
  const runAi = async (force = false) => {
    setError(""); setRunNote(""); setRunMissing([]); setProgress(null);
    if (!force && todayCached) {
      setRunStatus("");
      setRunNote(`今日已有 ${interp!.counts.rows} 条解释且未过期：直接读缓存，未重复调用模型（要重跑点旁边「重新理解」）。`);
      await loadInterps();
      return;
    }
    setAiRunning(true);
    try {
      // 分批调模型（默认每批 6 条）：AMD 免费档约 8~10s/条，分批后能边跑边显示进度
      const r = await runEventInterpretation(ai, { limit: 20, onProgress: (p) => setProgress(p) });
      setRunStatus(r.status);
      setRunNote(r.message);
      setRunMissing(r.missing);
    } catch (e) {
      setRunStatus("AI_FAILED");
      setRunNote(String((e as Error).message || e));
    } finally {
      setAiRunning(false); setProgress(null);
      void loadInterps(); // 读回服务端落库后的口径（含 stale/orphan/self_check），页面不自己算
    }
  };

  useEffect(() => { void load(); void loadHistoryMeta(); void loadInterps(); }, [load, loadHistoryMeta, loadInterps, metaTick]);

  // 事件行 ↔ 解释：优先按服务端给的当前行 id 对应，行被重扫换掉 id 时退回「标题+时间」原文匹配
  const interpOf = useMemo(() => {
    const byRow = new Map<string, InterpretLoadClient["items"][number]>();
    for (const i of interp?.items ?? []) byRow.set(interpretKey(i), i);
    return <T extends { id: string; title: string; time?: string }>(ev: T) =>
      byRow.get(ev.id) ?? byRow.get(`${ev.title}|${ev.time ?? ""}`);
  }, [interp]);

  return (
    <div className="w-full space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Globe2 size={18} className="text-sky-400" /> 全球事件雷达</div>
          <div className="text-[12px] text-muted-foreground">快讯关键词映射 → 板块资金验证 · 未命中映射的新闻不入库 · 交易日收盘后由服务进程内的调度器自动扫描一次，也可点「扫描今日」· 历史按留档日只读回看<br />列表是事件事实（库里当日行）；「AI 理解」只对这些已入库事件做分类/摘要/映射/影响解释，属「AI 解释」层，不发现新事件、不产概率</div>
        </div>
        <div className="flex items-center gap-2">
          {view === "today" && asOf && (
            <SourceBadge
              status="HISTORICAL"
              source={origin === "scan" ? "本次扫描写入事件库后回读" : "全球事件当日留档行"}
              time={asOf.slice(0, 10)}
            />
          )}
          <button onClick={scan} disabled={busy || view === "history"}
            title={view === "history" ? "当前在历史归档视图：扫描只会写今天，请先切回「今天」" : "按全量口径重刷今天的事件"}
            className="flex items-center gap-1 rounded-md bg-sky-500 px-2.5 py-1.5 text-xs text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 扫描今日
          </button>
          <button onClick={() => void runAi(false)} disabled={aiRunning || busy || view === "history" || !items.length}
            title={
              view === "history"
                ? "历史视图只读回看：AI 理解针对当天入库的事件，请先切回「今天」"
                : !items.length
                  ? "今天没有已入库事件：没有真实事件就没有可理解的东西，本步骤不会去猜一条新闻"
                  : todayCached
                    ? "今日已有未过期的解释：点击只读缓存，不重复调用模型"
                    : "把今天已入库的真实事件交给本机配置的模型做结构化理解（模型原文交回服务端按库内事实复校验后才落库）"
            }
            className="flex items-center gap-1 rounded-md border border-fuchsia-500/40 bg-fuchsia-500/10 px-2.5 py-1.5 text-xs text-fuchsia-300 hover:bg-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-40">
            {aiRunning ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} {todayCached ? "AI 理解今日事件（读缓存）" : "AI 理解今日事件"}
          </button>
          {view === "today" && todayCached && !aiRunning && (
            <button onClick={() => void runAi(true)} title="忽略缓存，重新调用模型理解一遍"
              className="text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
              重新理解
            </button>
          )}
        </div>
      </div>
      <HistoryBar
        kind="events" view={view} resp={hist} busy={busy || histLoading} loading={histLoading}
        onToday={() => { setView("today"); void load(); void loadInterps(); }}
        onDate={(d) => void openHistory(d)}
      />
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      {view === "today" && <AutoTaskLine kind="events" refreshKey={taskTick} />}
      {view === "today" && scanNote && (
        <div className="text-[11.5px] text-muted-foreground">
          {scanNote}；手动「扫描今日」按全量重刷当日事件；收盘后的自动扫描在当日已有成功游标时按增量写入——窗口内没有新快讯就不写库、也不再请求板块榜，已入库事件的资金验证保持首次扫描时的数值。
        </div>
      )}
      {view === "today" && supplemented && (
        <div className="text-[12.5px] text-amber-300/90">
          今天事件不足 20 条：已自动补上更早的日子（{windowDates.join("、")}），本页共 {items.length} 条（每条自带所属日期）。
        </div>
      )}
      {view === "today" && unmatched !== null && <div className="text-[12px] text-muted-foreground">未映射快讯 {unmatched} 条（已忽略，未编造产业链）</div>}
      {view === "today" && !items.length && !busy && <div className="text-xs text-muted-foreground">尚无入库事件：等待收盘后自动任务，或点击「扫描今日」。</div>}

      {/* P6-B 解释层状态条：这一层的口径全部来自服务端返回，页面只转述。铺满整宽 + 字号放大（可读性） */}
      <div className="w-full rounded-xl border border-fuchsia-500/25 bg-card/40 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SourceBadge
            status={!aiReady(ai) ? "本次未取到" : "AI_INTERPRETATION"}
            source={
              !aiReady(ai)
                ? "本机未配置模型凭据：解释层未运行（事件事实不受影响）"
                : `解释留档${interpDate ? ` · ${interpDate}` : " · 当日"}（解释不是事实）`
            }
            time={interp?.probed_at?.slice(0, 16)}
          />
          {interp && (
            <span className="text-[14px] text-muted-foreground">
              已落库 {interp.counts.rows} 条：已解释 {interp.counts.interpreted} · 部分可用 {interp.counts.partial} · 不可用 {interp.counts.rejected}
              {interp.counts.stale > 0 && <span className="text-amber-300"> · 过时 {interp.counts.stale}</span>}
              {interp.counts.orphan > 0 && <span className="text-amber-300"> · 原事件行已不在 {interp.counts.orphan}</span>}
              {interp.counts.violations > 0 && <span className="text-amber-300"> · 校验违规 {interp.counts.violations}</span>}
              {interp.counts.hypothesis_symbols > 0 && <span className="text-amber-300"> · 假设提及的股票 {interp.counts.hypothesis_symbols}</span>}
              {interpBusy && <Loader2 size={12} className="ml-1 inline animate-spin" />}
            </span>
          )}
          {interp?.available_dates.length ? (
            <span className="ml-auto text-[13.5px] text-muted-foreground">可回看日期：{interp.available_dates.map((d) => `${d.date}(${d.rows})`).join(" ")}</span>
          ) : null}
        </div>
        {interp && <div className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground/90">{interp.layering}</div>}
        {aiRunning && progress && (
          <div className="mt-3">
            <div className="flex items-center justify-between gap-3 text-[15px] font-semibold text-fuchsia-300">
              <span>
                正在分批理解：第 {progress.done}/{progress.total} 批（已覆盖约 {progress.eventsDone}/{progress.eventsTotal} 条
                {progress.failed ? ` · 失败 ${progress.failed} 批` : ""}）
              </span>
              <span className="tabular-nums">{progressPct}%</span>
            </div>
            <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-fuchsia-500/15">
              <div className="h-full rounded-full bg-fuchsia-500 transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="mt-2 text-[13px] text-muted-foreground">每批约 1 分钟，跑完自动读回落库结果</div>
          </div>
        )}
        {(runStatus || runNote) && (
          <div className={`mt-2 text-[14px] ${runStatus === "INTERPRETED" ? "text-emerald-300" : /AI_|NO_EVENTS|REJECTED/.test(runStatus) ? "text-amber-300" : "text-muted-foreground"}`}>
            本次「AI 理解」：{runStatus ? RUN_STATUS_TEXT[runStatus] : ""}{runNote ? `${runStatus ? " —— " : ""}${runNote}` : ""}
          </div>
        )}
        {(runMissing.length > 0 || interp?.missing.length)
          ? <div className="mt-2 text-[13px] text-muted-foreground/80">缺失口径：{[...runMissing, ...(interp?.missing ?? [])].join("；")}</div>
          : null}
        {interp && <div className="mt-1.5 text-[12.5px] text-muted-foreground/70">读库依据：{interp.basis}</div>}
      </div>

      {view === "today" && (
        <div className="space-y-2">
          {items.map((ev) => {
            const itp = interpOf(ev);
            return (
              <div key={ev.id} className={`rounded-xl border bg-card px-4 py-3 ${LEVEL_TONE[ev.level] ?? "border-border"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="text-sm font-medium">{ev.title}</div>
                  <div className="shrink-0 text-[11.5px]">{supplemented && ev.date ? `${ev.date} ` : ""}{ev.time} · {ev.level}</div>
                </div>
                <div className="mt-1 text-[12px] text-muted-foreground">{ev.category} · 映射 {(ev.mappedSectors ?? []).join("、") || "—"}</div>
                <div className="mt-1 text-[12px]">阶段 <b>{ev.stage || ev.fundCheck?.stage}</b> · {ev.fundCheck?.note}</div>
                {!!ev.fundCheck?.boards?.length && (
                  <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
                    {ev.fundCheck.boards.map((b) => (
                      <span key={b.name} className="rounded border border-border px-2 py-0.5">
                        {b.name} <PctText value={b.changePct} /> · {b.mainYi >= 0 ? "+" : ""}{b.mainYi.toFixed(1)}亿 · 第{b.rank}
                      </span>
                    ))}
                  </div>
                )}
                {/* 上面是事实（global_event 库行），下面这条才是 AI 解释：分块显示，不并进同一行文案 */}
                {itp ? <InterpretationCard itp={itp} /> : (
                  <div className="mt-1.5 text-[11px] text-muted-foreground/70">本条还没有 AI 理解：解释只在点「AI 理解今日事件」时产生，缺失就写缺失。</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 历史复盘列表：事件类型 / 来源 / 产业链映射 / asOf 逐条来自库行；库里没有的就写「未记录」 */}
      {view === "history" && (
        <div className="space-y-2">
          {!hist && <div className="text-xs text-muted-foreground">选择日期后读取该日的归档事件（只读，不会触发扫描）。</div>}
          {hist && !hist.items.length && <div className="text-xs text-muted-foreground">该日没有归档事件（缺失说明见上方「缺失口径」）。</div>}
          {hist?.items.map((ev) => {
            const itp = interpOf(ev);
            return (
            <div key={ev.id} className={`rounded-xl border bg-card px-4 py-3 ${LEVEL_TONE[ev.level] ?? "border-border"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="text-sm font-medium">{ev.title}</div>
                <div className="shrink-0 text-[11.5px]">{ev.time || "时间未记录"} · {ev.level || "级别未记录"}</div>
              </div>
              <div className="mt-1 text-[11.5px] text-muted-foreground">
                事件类型 {ev.category || "未记录"} · 留档日 {ev.as_of} · 来源 {ev.source || "未记录（库里该行没有来源）"}
              </div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                产业链映射：{ev.mapped_sectors.length ? ev.mapped_sectors.join("、") : "未命中映射表（入库时即为空，未编造板块）"}
                {ev.related_stocks.length > 0 && <> · 关联股票 {ev.related_stocks.join("、")}</>}
              </div>
              <div className="mt-1 text-[12px]">
                资金验证阶段 <b>{ev.stage || ev.fund_check?.stage || "未记录"}</b> · {String(ev.fund_check?.note ?? "该行未存资金验证说明")}
              </div>
              {!!(ev.fund_check?.boards as { name: string; changePct: number; mainYi: number; rank: number }[] | undefined)?.length && (
                <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
                  {(ev.fund_check.boards as { name: string; changePct: number; mainYi: number; rank: number }[]).map((b) => (
                    <span key={b.name} className="rounded border border-border px-2 py-0.5">
                      {b.name} <PctText value={b.changePct} /> · {b.mainYi >= 0 ? "+" : ""}{b.mainYi.toFixed(1)}亿 · 第{b.rank}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-[11px] text-muted-foreground/80">
                首次入库 {bjTime(ev.created_at)}（北京）
                {!!ev.broken_columns.length && <span className="ml-1 text-amber-300">字段无法解析：{ev.broken_columns.join("、")}（按缺失处理，未当作空值）</span>}
              </div>
              {/* 历史归档同样可以带解释层：读的是 event_interpretation 里那天的快照，与事实分块显示；没有快照就写没有 */}
              {itp ? <InterpretationCard itp={itp} /> : (
                <div className="mt-1.5 text-[11px] text-muted-foreground/70">本条没有 AI 理解：该日解释层为空（只在点「AI 理解今日事件」时产出，缺失就写缺失，不补默认解释）。</div>
              )}
            </div>
            );
          })}
        </div>
      )}
      {view === "today" && !!missing.length && <div className="text-[11.5px] text-muted-foreground/80">{missing.join("；")}</div>}
    </div>
  );
}
