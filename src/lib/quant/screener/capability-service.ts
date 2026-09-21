// P6-A 能力探测层（服务端）：把「登记表说有什么能力」变成「这一次到底取到了没有」。
//
// 为什么要单独一层（而不是让每个页面自己 fetch 一遍）：任务书 §五/§三十二 要的是
// 一次探测多处复用 + 明确的成功/失败/超时/空/降级状态。页面各自请求会同时踩两个坑：
// 上游被反复打，以及同一个能力在不同页面显示成不同状态。
//
// 四条口径纪律（都有对应测试或字段承接）：
// 1) live=false 时不碰外网：只读本地库/账本/MCP 运行态；行情类上游能力返回 probed:false。
//    「没测」和「测了但失败」是两件事，不能压成同一个 MISSING。
// 2) 上游函数把「超时」和「空返回」压成同一个 null 时，本层一律按 request_failed 处理（失败优先），
//    并在 reason 里写明口径受限——宁可说取数失败，也不把失败显示成 0。
// 3) 探测范围写进 evidence.scope：direct=真取了该能力的数据；channel=只验证同一接口族可达；
//    db/static/local=读本地。绝不用「通道通了」冒充「这个能力有数据」。
// 4) 本层不产出任何验证结论：verify/VERIFIED 属于 data/factor-verified.json（正式验证流程写入），
//    这里只如实报告账本里有多少条、文件在不在，绝不替因子判「已验证」。
import { db } from "@/lib/db";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { CONTEXT_DISCIPLINE, PROVENANCE_TEXT } from "@/lib/desk/ai-context-core";
import {
  fetchBoardReal, fetchDetailReal, fetchKlinesReal, fetchNewsReal, fetchQuotesReal, searchReal, symbolToSecid,
} from "@/lib/desk/em";
import { tdxQuotes } from "@/lib/desk/tdx";
import { listAllTools, listServers } from "@/lib/desk/mcp-manager";
import { FACTOR_FIELD_DEFS, verifiedLedgerMeta } from "@/lib/quant/factors/fields";
import { emProvider } from "@/lib/quant/data/em-provider";
import { demoProvider } from "@/lib/quant/data/demo-provider";
import { mcpProvider, mcpConfigured } from "@/lib/quant/data/mcp-provider";
import { CAPABILITIES, findCapability, registryBasis, unavailableNoteWith, type CapabilityDef } from "./capability-core.ts";
import {
  displayOf, envelopeOf, freshWithinDailyFromDateOnly, isUsable, layeringNote, stillFresh,
  type DataStatus, type ObservationKind,
} from "./datastatus-core.ts";

/** 探测范围：这条结论到底测到了什么（防止「通道可达」被读成「有数据」） */
export type ProbeScope = "direct" | "channel" | "db" | "static" | "local" | "none";

interface Sig {
  ran: boolean;
  kind: ObservationKind;
  reason: string;
  as_of: string | null;
  evidence: Record<string, string | number | boolean | null>;
  degraded_from?: string | null;
  scope: ProbeScope;
}

// reason 只写「为什么这次没测」，「未探测」这个前缀由 toProbe 统一加一次（避免「未探测——未探测：…」）
const NOT_RUN: Sig = { ran: false, kind: "no_data", reason: "默认只读本地，本次没有打上游；带 live=1 才会真的探测", as_of: null, evidence: { probed: false }, scope: "none" };

function okSig(scope: ProbeScope, evidence: Sig["evidence"], asOf: string | null, reason = ""): Sig {
  return { ran: true, kind: "value", reason, as_of: asOf, evidence, scope };
}
function emptySig(scope: ProbeScope, reason: string, evidence: Sig["evidence"] = {}): Sig {
  return { ran: true, kind: "no_data", reason, as_of: null, evidence, scope };
}
function failSig(scope: ProbeScope, reason: string, evidence: Sig["evidence"] = {}): Sig {
  return { ran: true, kind: "request_failed", reason, as_of: null, evidence, scope };
}

/** em/tdx 的取数函数把失败与空都返回 null：按失败优先，并把「口径受限」写进原因原文 */
function nullMeansFailure(what: string, upstream: string): string {
  return `${what}未取得数据（${upstream} 返回 null/空）。该上游层不区分超时与空返回，本层按取数失败处理，不显示为 0`;
}

async function guarded<T>(ms: number, p: Promise<T>, onEmpty: string): Promise<{ value: T | null; error: string | null }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const value = await Promise.race<T | null>([
      p,
      new Promise<T | null>((res) => { timer = setTimeout(() => res(null), ms); }),
    ]);
    return value === null || value === undefined ? { value: null, error: onEmpty } : { value, error: null };
  } catch (e) {
    return { value: null, error: `${onEmpty}：${(e as Error).message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 'YYYY-MM-DD HH:mm:ss'（北京时间墙钟）→ 距今秒数；只有日期时返回 null（不知道当天几点，不猜） */
function stampAgeS(stamp: string | null, nowMs: number): number | null {
  if (!stamp) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(stamp.trim());
  if (!m) return null;
  const utcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - 8 * 3600 * 1000;
  if (!isFinite(utcMs)) return null;
  return Math.max(0, Math.round((nowMs - utcMs) / 1000));
}

// ---------- 本地库只读信号：一次并发 count，不逐表串行 ----------

async function dbSignals() {
  const [
    radarRows, radarLive, radarLatest, eventRows, eventLatest, eventDates, interpretRows, interpretLatest,
    researchRows, researchLatest,
    factorTestRows, factorTestKeys,
    poolRows, taskRows, taskLatest, cursorRows, riskSnap, themeSnap, probSnap,
    agentRunRows, agentCallRows, agentRunLatest,
  ] = await Promise.all([
    db.radarFinding.count(),
    db.radarFinding.count({ where: { state: "live" } }),
    db.radarFinding.findFirst({ orderBy: { asOf: "desc" }, select: { asOf: true } }),
    db.globalEvent.count(),
    db.globalEvent.findFirst({ orderBy: { asOf: "desc" }, select: { asOf: true } }),
    db.globalEvent.groupBy({ by: ["asOf"], _count: { _all: true } }),
    db.eventInterpretation.count(),
    db.eventInterpretation.findFirst({ orderBy: { asOf: "desc" }, select: { asOf: true } }),
    db.researchReport.count(),
    db.researchReport.findFirst({ orderBy: { asOf: "desc" }, select: { asOf: true, status: true } }),
    db.factorTest.count(),
    db.factorTest.groupBy({ by: ["factorKey"], _count: { _all: true } }),
    db.candidatePool.count(),
    db.taskRun.count(),
    db.taskRun.findFirst({ orderBy: { startedAt: "desc" }, select: { kind: true, status: true, startedAt: true } }),
    db.scanCursor.count(),
    db.riskSnapshot.count(),
    db.themeSnapshot.count(),
    db.probabilitySnapshot.count(),
    db.agentRun.count(),
    db.agentToolCall.count(),
    db.agentRun.findFirst({ orderBy: { startedAt: "desc" }, select: { runId: true, status: true, answerStatus: true, startedAt: true } }),
  ]);
  return {
    radarRows, radarLive, radarDate: radarLatest?.asOf ?? null,
    eventRows, eventDate: eventLatest?.asOf ?? null, eventDates: eventDates.length,
    interpretRows, interpretDate: interpretLatest?.asOf ?? null,
    researchRows, researchDate: researchLatest?.asOf ?? null, researchStatus: researchLatest?.status ?? null,
    factorTestRows, factorTestKeys: factorTestKeys.length,
    poolRows, taskRows,
    taskKind: taskLatest?.kind ?? null, taskStatus: taskLatest?.status ?? null,
    taskStartedAt: taskLatest?.startedAt ? shanghaiStamp(new Date(taskLatest.startedAt)) : null,
    cursorRows, riskSnap, themeSnap, probSnap,
    agentRunRows, agentCallRows, agentRunLatest,
  };
}

type DbSignals = Awaited<ReturnType<typeof dbSignals>>;

function rowsSig(label: string, rows: number, table: string, date: string | null, liveRows?: number): Sig {
  const evidence: Sig["evidence"] = { rows, table, latest_date: date };
  if (liveRows != null) evidence.live_rows = liveRows;
  if (rows <= 0) return emptySig("db", `${label}：${table} 当前 0 行——库里确实没有行（当日无命中 / 未扫描 / 未留档），不补数据`, evidence);
  return okSig("db", evidence, date, `${label}：库内 ${rows} 行真实数据`);
}

// ---------- 上游信号（只有 live=true 才取） ----------

type Upstream = {
  gateway: Sig; quotes: Sig; kline: Sig; board: Sig; fflow: Sig; news: Sig; search: Sig;
};

async function upstreamSignals(live: boolean): Promise<Upstream> {
  if (!live) {
    return { gateway: NOT_RUN, quotes: NOT_RUN, kline: NOT_RUN, board: NOT_RUN, fflow: NOT_RUN, news: NOT_RUN, search: NOT_RUN };
  }
  const [gw, q, k, b, f, n, s] = await Promise.all([
    guarded(5000, tdxQuotes(["000001.SH"]), "eltdx 网关报价探测无返回"),
    guarded(5000, fetchQuotesReal(["000001.SH"]), "腾讯指数报价探测超时"),
    guarded(5000, fetchKlinesReal("000001.SH", "day", 30), "腾讯日K探测超时"),
    guarded(6000, fetchBoardReal("industry", "in", 5), "东财板块榜探测超时"),
    guarded(6000, fetchDetailReal(symbolToSecid("688256.SH") ?? ""), "东财个股资金流日K探测超时"),
    guarded(6000, fetchNewsReal(3), "东财/新浪快讯探测超时"),
    guarded(5000, searchReal("寒武纪"), "东财代码检索探测超时"),
  ]);
  const stamp = shanghaiStamp();
  const gateway: Sig = (() => {
    const m = gw.value;
    if (m && m.size > 0) return okSig("direct", { gateway: "eltdx", rows: m.size }, stamp, "eltdx 本机网关在线，报价通道可用");
    return failSig("local", `eltdx 网关未取得数据（${gw.error ?? "本机网关未运行"}）：五档/内外盘只有这一条路，不用别的口径冒充`, { gateway: "eltdx" });
  })();
  const quotes: Sig = (() => {
    const row = q.value?.[0];
    if (row && typeof row.price === "number" && isFinite(row.price)) {
      return okSig("direct", { symbol: "000001.SH", price: row.price, change_pct: row.changePct ?? null }, stamp, "腾讯报价通道可用（真实指数价）");
    }
    return failSig("direct", nullMeansFailure("腾讯报价", "qt.gtimg.cn"), { symbol: "000001.SH" });
  })();
  const kline: Sig = (() => {
    const bars = k.value;
    if (bars && bars.length >= 5) {
      const last = String(bars[bars.length - 1].date ?? "").slice(0, 10);
      return okSig("direct", { symbol: "000001.SH", bars: bars.length, last_date: last }, stamp, `真实日K ${bars.length} 根，最后一根 ${last}`);
    }
    return failSig("direct", nullMeansFailure("腾讯日K", "ifzq.gtimg.cn / fqkline"), { symbol: "000001.SH" });
  })();
  const board: Sig = (() => {
    const rows = b.value;
    if (rows && rows.length) {
      return okSig("direct", { boards: rows.length, top: rows[0].name, top_main_yi: rows[0].main }, stamp);
    }
    return failSig("channel", nullMeansFailure("东财板块榜", "push2 clist"), {});
  })();
  const fflow: Sig = (() => {
    const detail = f.value;
    const days = detail?.days ?? null;
    if (days && days.length && detail) {
      return okSig("direct", { symbol: "688256.SH", days: days.length, source: detail.source, last_date: days[days.length - 1].date }, stamp);
    }
    return failSig("direct", nullMeansFailure("个股主力资金日K", "东财 push2his fflow/daykline（新浪 MoneyFlow 备胎同窗未返回）"), { symbol: "688256.SH" });
  })();
  const news: Sig = (() => {
    const items = n.value;
    if (items && items.length) return okSig("direct", { items: items.length, latest_time: items[0].time ?? null }, stamp);
    return failSig("direct", nullMeansFailure("财经快讯", "东财 np-weblist 与新浪 zhibo 两条源"), {});
  })();
  const search: Sig = (() => {
    const items = s.value;
    if (items && items.length) return okSig("direct", { items: items.length, first: items[0].symbol }, stamp);
    return failSig("direct", nullMeansFailure("代码/名称检索", "东财 searchapi suggest"), {});
  })();
  return { gateway, quotes, kline, board, fflow, news, search };
}

function channelOf(sig: Sig, reason: string, extra: Sig["evidence"] = {}): Sig {
  return { ...sig, scope: "channel", reason, evidence: { ...sig.evidence, ...extra, probe_scope: "channel" } };
}

interface Ctx extends Upstream {
  live: boolean;
  now: string;
  today: string;
  db: DbSignals | null;
  dbError: string | null;
  mcp: Sig;
  providers: { id: string; coverage: Record<string, unknown>; configured?: boolean }[];
  ledger: { exists: boolean; mtime_ms: number | null; keys: number; path: string };
}

// ---------- 能力 → 本次探测结论 ----------

function probeOne(cap: CapabilityDef, ctx: Ctx): Sig {
  const name = cap.name;
  const d = ctx.db;
  if (cap.availability === "not_covered") {
    return {
      ran: true, kind: "not_covered", reason: cap.limitations[0] ?? "该字段没有可靠数据源，未覆盖",
      as_of: null, evidence: { availability: "not_covered" }, scope: "none",
    };
  }
  const dbFail = (): Sig => failSig("db", `本地库读取失败：${ctx.dbError ?? "未知错误"}`);
  switch (name) {
    // 行情：网关为主、腾讯兜底；走兜底必须显式记 degraded_from
    case "stock_quote": {
      if (ctx.gateway.ran && isUsable(ctx.gateway.kind)) return ctx.gateway;
      if (!ctx.quotes.ran) return NOT_RUN;
      if (!isUsable(ctx.quotes.kind)) return ctx.quotes;
      return {
        ...ctx.quotes,
        degraded_from: ctx.gateway.ran ? "eltdx 网关" : null,
        reason: "eltdx 网关本次不可用，走腾讯报价兜底（值是真的，来源已降级）",
      };
    }
    case "index_benchmark": return ctx.quotes;
    case "stock_kline": return ctx.kline;
    case "market_snapshot":
    case "screener":
      return ctx.board.ran
        ? channelOf(ctx.board, "东财 push2 clist 通道可达（与全A快照同接口族）。本次未拉全量名单：全量取数请调用对应接口，这里不谎称拉过")
        : NOT_RUN;
    case "sector_rank": return ctx.board;
    case "sector_members":
      return ctx.board.ran ? channelOf(ctx.board, "板块榜 clist 通道可达；成分名单需带板块代码另行取数") : NOT_RUN;
    case "fund_flow_stock": return ctx.fflow;
    case "stock_depth":
    case "stock_trades_money":
    case "stock_trades_proxy":
      if (!ctx.gateway.ran) return NOT_RUN;
      return isUsable(ctx.gateway.kind)
        ? channelOf(ctx.gateway, "eltdx 网关在线（报价字段实测）；本能力的具体字段（五档/逐笔）需按代码另行取数")
        : ctx.gateway;
    case "market_news": return ctx.news;
    case "symbol_search": return ctx.search;
    // 引擎类：上游通道 + 库里留档旁证；不重复拉全量（§三十二 性能要求）
    case "sentiment":
    case "risk":
    case "limitup": {
      if (!ctx.board.ran) return NOT_RUN;
      const extra: Sig["evidence"] = name === "risk" ? { risk_snapshot_rows: d?.riskSnap ?? null } : {};
      return channelOf(ctx.board, "全A快照通道可达；情绪/风险/梯队需当场拉全量才算，本探测不重复拉取", extra);
    }
    case "themes":
      if (!ctx.board.ran) return NOT_RUN;
      return channelOf(ctx.board, "板块榜通道可达；主线判定需当场拉板块+成分扩散，本探测不重复拉取", { theme_snapshot_rows: d?.themeSnap ?? null });
    case "radar": return d ? rowsSig("雷达信号", d.radarRows, "radar_finding", d.radarDate, d.radarLive) : dbFail();
    case "events": return d ? rowsSig("全球事件", d.eventRows, "global_event", d.eventDate) : dbFail();
    case "event_interpret":
      if (!d) return dbFail();
      // 这张表 0 行的原因是「没人点过 AI 理解」，不是失败也不是没有事件：措辞必须和 rowsSig 的通用文案分开
      return d.interpretRows > 0
        ? okSig("db", { rows: d.interpretRows, table: "event_interpretation", latest_date: d.interpretDate, events_rows: d.eventRows },
            d.interpretDate, `已落库 AI 事件解释 ${d.interpretRows} 条（属于 AI_INTERPRETATION 层，不是事实）`)
        : emptySig("db",
            `event_interpretation 当前 0 行：还没有人对事件点过「AI 理解」，这一层就是空的（不是失败，也不会自动生成；当日事件行 ${d.eventRows} 条是可理解的事实原料）`,
            { rows: 0, events_rows: d.eventRows });
    case "market_research":
      if (!d) return dbFail();
      // 与 event_interpret 同一类：这张表 0 行是「没人点过生成研究报告」，既不是失败也不是没有市场数据
      return d.researchRows > 0
        ? okSig("db", { rows: d.researchRows, table: "research_report", latest_date: d.researchDate, latest_status: d.researchStatus },
            d.researchDate, `已落库市场环境研究报告 ${d.researchRows} 条（最新一条状态 ${d.researchStatus ?? "未记录"}；属于 AI_INTERPRETATION 层，不是事实）`)
        : emptySig("db",
            "research_report 当前 0 行：还没有人点过「生成研究报告」，这一层就是空的（不是失败，也不会自动生成；服务端台账能不能取到读数要看 risk/themes/radar/events 各自的探测行）",
            { rows: 0 });
    case "history_radar": return d ? rowsSig("雷达历史归档", d.radarRows, "radar_finding", d.radarDate) : dbFail();
    case "history_events":
      if (!d) return dbFail();
      return d.eventDates > 0
        ? okSig("db", { dates: d.eventDates, rows: d.eventRows, latest_date: d.eventDate }, d.eventDate, `事件归档可回看 ${d.eventDates} 天`)
        : emptySig("db", "事件表没有任何可回看的日期（库里 0 行 ⇒ 无归档），不是「那天没发生事」", { dates: 0 });
    case "snapshot_risk": return d ? rowsSig("风险留档", d.riskSnap, "risk_snapshot", null) : dbFail();
    case "snapshot_themes": return d ? rowsSig("主线留档", d.themeSnap, "theme_snapshot", null) : dbFail();
    case "snapshot_probability": return d ? rowsSig("概率留档", d.probSnap, "probability_snapshot", null) : dbFail();
    case "candidate_pool": return d ? rowsSig("候选池", d.poolRows, "candidate_pool", null) : dbFail();
    case "factor_test":
      if (!d) return dbFail();
      return d.factorTestRows > 0
        ? okSig("db", { rows: d.factorTestRows, keys: d.factorTestKeys }, null, `IC 测试记录 ${d.factorTestRows} 条，覆盖 ${d.factorTestKeys} 个信号键`)
        : emptySig("db", "factor_test 表 0 行：还没有跑过批量 IC 验证 ⇒ 任何因子有效性结论只能是 UNVERIFIED，不是「无效」也不是「有效」", { rows: 0 });
    case "task_status":
      if (!d) return dbFail();
      return d.taskRows > 0
        ? okSig("db", { rows: d.taskRows, latest_kind: d.taskKind, latest_status: d.taskStatus, latest_started_at: d.taskStartedAt, cursors: d.cursorRows }, d.taskStartedAt)
        : emptySig("db", "task_run 0 行：本进程还没跑过扫描。服务未启动的时间段不会有条目——不能据此说「自动跑过」", { rows: 0 });
    case "agent_run_history":
      if (!d) return dbFail();
      // 0 行同样是「没人跑过」而不是失败：自主循环需要客户端带 AI 回复一步一格驱动，服务端不会自动跑
      return d.agentRunRows > 0
        ? okSig("db", {
            rows: d.agentRunRows, table: "agent_run", tool_call_rows: d.agentCallRows,
            latest_run: d.agentRunLatest?.runId ?? null, latest_status: d.agentRunLatest?.status ?? null,
            latest_answer: d.agentRunLatest?.answerStatus ?? null, latest_started_at: d.agentRunLatest?.startedAt ?? null,
          }, d.agentRunLatest?.startedAt ?? null,
          `已落库 Agent 运行 ${d.agentRunRows} 次（调用行 ${d.agentCallRows} 条；最新一次状态 ${d.agentRunLatest?.status ?? "未记录"}/${d.agentRunLatest?.answerStatus || "未收尾"}。调用记录属服务端事实，answer 属 AI_INTERPRETATION 层）`)
        : emptySig("db",
            `agent_run 当前 0 行：还没有跑过 Agent 研究循环（不是失败；服务端不会自动开跑，需要客户端带着 AI 回复逐格调 /api/agent/tool）`,
            { rows: 0, tool_call_rows: d.agentCallRows });
    case "lifecycle_preview":
      if (!d) return dbFail();
      return okSig("db", { detail_rows: d.radarRows + d.eventRows, cursors: d.cursorRows, retention_days: 180 }, null,
        "生命周期预览读数链路正常；具体过期候选日请看 /api/lifecycle/preview");
    case "factor_catalog":
      return okSig("static", {
        factors: FACTOR_FIELD_DEFS.length,
        implemented: FACTOR_FIELD_DEFS.filter((x) => x.implemented !== false).length,
        unimplemented: FACTOR_FIELD_DEFS.filter((x) => x.implemented === false).length,
      }, null);
    case "factor_verified":
      return ctx.ledger.exists
        ? okSig("static", { verified_keys: ctx.ledger.keys, total_factors: FACTOR_FIELD_DEFS.length, ledger_mtime_ms: ctx.ledger.mtime_ms, ledger_path: ctx.ledger.path }, null,
            `验证账本有 ${ctx.ledger.keys} 个信号键（只有正式验证流程能写，本层不改）`)
        : emptySig("static", `data/factor-verified.json（${ctx.ledger.path}）不存在：账本为空 ⇒ 所有因子按 UNVERIFIED 处理（本层不会替它判已验证）`, { verified_keys: 0 });
    case "trade_dates":
      if (!ctx.kline.ran) return NOT_RUN;
      return isUsable(ctx.kline.kind)
        ? channelOf(ctx.kline, "交易日历取自上证指数真实日K：日K可达即可用（没有独立节假日表，取不到日K时返回空，不猜哪天开市）")
        : ctx.kline;
    case "provider_health":
      return okSig("local", {
        providers: ctx.providers.map((p) => p.id).join(","),
        mcp_configured: ctx.providers.find((p) => p.id === "mcp")?.configured ? 1 : 0,
        mcp_url: process.env.QUANT_MCP_URL ? "已配置" : "未配置",
      }, ctx.now);
    case "capability_registry":
      return okSig("static", {
        endpoint: "/api/capabilities",
        capabilities: CAPABILITIES.length,
        read_only: CAPABILITIES.filter((c) => !c.mutating).length,
        not_covered: CAPABILITIES.filter((c) => c.availability === "not_covered").length,
      }, ctx.now);
    case "capability_probe":
      // 探测自己会递归：这次响应本身就是该能力的证据，不假装「又测了一遍」
      return {
        ran: false, kind: "no_data",
        reason: `本接口自身就是这条能力的输出（再对它做一次探测没有意义），结果缓存 ${Math.round(CACHE_TTL_MS / 1000)} 秒；看 cached/cache_age_s 字段即可判断本次是实测还是复用`,
        as_of: null, evidence: { probed: false, endpoint: "/api/capabilities/probe" }, scope: "none",
      };
    case "ai_context_layering":
      return okSig("static", {
        layers: Object.keys(PROVENANCE_TEXT).length,
        discipline_rules: CONTEXT_DISCIPLINE.length,
        wired_pages: "#/assistant,#/analysis",
      }, ctx.now);
    case "mcp_tools": return ctx.mcp;
    case "backtest":
    case "probability":
      return {
        ran: false, kind: "no_data",
        reason: `${cap.title}需要明确的策略/条件与回放区间，健康探测不做全量历史计算（避免无意义地打满上游）`,
        as_of: null, evidence: { probed: false }, scope: "none",
      };
    default:
      return { ...NOT_RUN, reason: `登记表里这条能力还没有对应的探测实现（NOT IMPLEMENTED，不代表可用）` };
  }
}

function mcpSig(): Sig {
  try {
    const servers = listServers();
    const tools = listAllTools();
    const ready = servers.filter((s) => s.status === "ready");
    const evidence: Sig["evidence"] = {
      servers: servers.length,
      ready_servers: ready.length,
      server_status: servers.map((s) => `${s.id}:${s.status}`).join(",") || null,
      tools: tools.length,
      all_trusted: servers.length > 0 && servers.every((s) => s.config?.trusted !== false) ? 1 : 0,
    };
    if (!servers.length) return emptySig("local", "MCP unavailable：未配置任何 MCP 服务器", evidence);
    if (!tools.length) return emptySig("local", `MCP unavailable：已配置 ${servers.length} 个服务器，没有一个 ready（${String(evidence.server_status)}）。本层不会假装调用成功`, evidence);
    return okSig("direct", evidence, shanghaiStamp(), `MCP 可用：${tools.length} 个工具来自 ${ready.length} 个 ready 服务器（外部执行仍需人工确认）`);
  } catch (e) {
    return failSig("local", `MCP 运行态读取失败：${(e as Error).message}`);
  }
}

export interface CapabilityProbe {
  name: string;
  title: string;
  group: CapabilityDef["group"];
  availability: CapabilityDef["availability"];
  /** 该能力声明的新鲜度口径（live/intraday/daily/static）：fresh=false 就是超了这个上限 */
  freshness: CapabilityDef["freshness"];
  mutating: boolean;
  /** 本次是否真的探测过（false=未探测，不能读成「没数据」） */
  probed: boolean;
  kind: ObservationKind | null;
  usable: boolean;
  /** 探测后的分层：未探测时保留登记表声明值并靠 probed:false 表明「这不是本次实测结论」 */
  status: DataStatus;
  note: string;
  reason: string;
  scope: ProbeScope;
  evidence: Record<string, string | number | boolean | null>;
  as_of: string | null;
  freshness_s: number | null;
  /** true=在声明口径内 / false=确认超上限 / null=没有可核对的时刻（未知，不等于超上限） */
  fresh: boolean | null;
  display: string;
  degraded_from: string | null;
  fallbacks: string[];
  limitations: string[];
}

export interface ProbeResult {
  ok: true;
  probed_at: string;
  today: string;
  live: boolean;
  cached: boolean;
  cache_age_s: number | null;
  basis: string;
  gateway_note: string;
  upstream_calls: number;
  probes: CapabilityProbe[];
  counts: Record<string, number>;
  layering: string;
  missing: string[];
  unprobed: string[];
}

/**
 * 三态新鲜度：true=口径内 / false=确认超上限 / null=没有可核对的时刻（未知，不等于超上限）。
 * as_of 只到日期时唯一能证的是「日期就是今天 ⇒ daily 口径必然在限内」，跨天一律判未知。
 */
function freshOf(sig: Sig, cap: CapabilityDef, freshness_s: number | null): boolean | null {
  if (!sig.ran) return null;
  if (freshness_s !== null) return stillFresh(freshness_s, cap.freshness);
  const sameDay = freshWithinDailyFromDateOnly(sig.as_of, shanghaiDate());
  if (sameDay && (cap.freshness === "daily" || cap.freshness === "static")) return true;
  return null;
}

function toProbe(cap: CapabilityDef, sig: Sig, nowMs: number, nowStamp: string): CapabilityProbe {
  const usable = sig.ran && isUsable(sig.kind);
  const freshness_s = stampAgeS(sig.as_of, nowMs);
  // 信封负责强制自洽：不可用 ⇒ status 只能是 MISSING/DEGRADED，不允许「kind 失败但 status:REAL」
  const env = sig.ran
    ? envelopeOf({
        observed: { kind: sig.kind, value: usable ? 1 : null, reason: sig.reason },
        status: cap.data_status,
        source: cap.source,
        source_type: cap.source_type,
        as_of: sig.as_of ?? nowStamp,
        ...(sig.degraded_from ? { degraded_from: sig.degraded_from } : {}),
      })
    : null;
  return {
    name: cap.name,
    title: cap.title,
    group: cap.group,
    availability: cap.availability,
    freshness: cap.freshness,
    mutating: cap.mutating,
    probed: sig.ran,
    kind: sig.ran ? sig.kind : null,
    usable,
    status: env ? env.status : cap.data_status,
    // note 一律是「裸原因」，不带能力标题：面板/missing 行各自加一次标题，避免出现「A：A：…」
    // 未探测的原因同样只加一次前缀（sig.reason 里不再自带「未探测」）
    note: sig.ran
      ? usable ? (sig.reason || "本次取到数据") : unavailableNoteWith(cap, sig.kind, sig.reason)
      : `未探测：${sig.reason}`,
    reason: sig.reason,
    scope: sig.scope,
    evidence: { ...sig.evidence, probe_scope: sig.scope },
    as_of: sig.as_of,
    freshness_s,
    fresh: freshOf(sig, cap, freshness_s),
    display: sig.ran ? displayOf(sig.kind, usable ? "可用" : undefined) : "未探测",
    degraded_from: sig.degraded_from ?? null,
    fallbacks: cap.fallbacks,
    limitations: cap.limitations,
  };
}

// 短时间复用：探测会打上游，页面反复刷新不该每次重打（freshness 由缓存年龄如实反映）
const CACHE_TTL_MS = 20000;
let cacheStore: { live: boolean; at: number; result: ProbeResult } | null = null;

export async function probeCapabilities(opts: { live?: boolean; force?: boolean } = {}): Promise<ProbeResult> {
  const live = opts.live === true;
  const nowMs = Date.now();
  if (!opts.force && cacheStore && cacheStore.live === live && nowMs - cacheStore.at < CACHE_TTL_MS) {
    return { ...cacheStore.result, cached: true, cache_age_s: Math.round((nowMs - cacheStore.at) / 1000) };
  }
  const nowStamp = shanghaiStamp();
  let dbError: string | null = null;
  let signals: DbSignals | null = null;
  try {
    signals = await dbSignals();
  } catch (e) {
    dbError = (e as Error).message;
  }
  let ledger: Ctx["ledger"] = { exists: false, mtime_ms: null, keys: 0, path: "data/factor-verified.json" };
  try {
    ledger = verifiedLedgerMeta();
  } catch (e) {
    dbError = `${dbError ?? ""} 验证账本读取失败：${(e as Error).message}`.trim();
  }
  const upstream = await upstreamSignals(live);
  const ctx: Ctx = {
    ...upstream,
    live,
    now: nowStamp,
    today: shanghaiDate(),
    db: signals,
    dbError,
    mcp: mcpSig(),
    ledger,
    providers: [
      { id: "em", coverage: emProvider.coverage() as unknown as Record<string, unknown> },
      { id: "mcp", coverage: mcpProvider.coverage() as unknown as Record<string, unknown>, configured: mcpConfigured() },
      { id: "demo", coverage: demoProvider.coverage() as unknown as Record<string, unknown> },
    ],
  };
  const probes = CAPABILITIES.map((c) => toProbe(c, probeOne(c, ctx), nowMs, nowStamp));
  const statusCounts: Partial<Record<DataStatus, number>> = {};
  for (const p of probes) statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;
  const result: ProbeResult = {
    ok: true,
    probed_at: nowStamp,
    today: ctx.today,
    live,
    cached: false,
    cache_age_s: 0,
    basis: registryBasis(),
    gateway_note: live
      ? (isUsable(ctx.gateway.kind) ? "eltdx 本机网关：在线" : "eltdx 本机网关：不可用（依赖它的能力已按取数失败处理，不用别的口径冒充五档/内外盘）")
      : "本次未做上游探测：只读了本地库/账本/MCP 运行态；行情类上游能力标 probed:false，不是「没数据」",
    upstream_calls: live ? [ctx.gateway, ctx.quotes, ctx.kline, ctx.board, ctx.fflow, ctx.news, ctx.search].filter((s) => s.ran).length : 0,
    probes,
    counts: {
      total: probes.length,
      usable: probes.filter((p) => p.usable).length,
      unprobed: probes.filter((p) => !p.probed).length,
      no_data: probes.filter((p) => p.probed && p.kind === "no_data").length,
      request_failed: probes.filter((p) => p.probed && p.kind === "request_failed").length,
      not_covered: probes.filter((p) => p.probed && p.kind === "not_covered").length,
      degraded: probes.filter((p) => p.status === "DEGRADED").length,
      read_only: probes.filter((p) => !p.mutating).length,
      mutating: probes.filter((p) => p.mutating).length,
    },
    layering: layeringNote(statusCounts),
    missing: probes.filter((p) => p.probed && !p.usable).map((p) => `${p.title}：${p.note}`),
    unprobed: probes.filter((p) => !p.probed).map((p) => p.title),
  };
  // 缓存起点用「探测完成」的时刻，不用请求进入的时刻：一次 live 探测本身要花十几秒，
  // 按开始时刻记会让结果刚落盘就过期，页面每次刷新都重打上游。
  cacheStore = { live, at: Date.now(), result };
  return result;
}

/** 登记表静态视图（不探测、不碰网络）：给 Agent 组提示词、给能力面板列清单 */
export function registryView(): {
  ok: true;
  basis: string;
  counts: { total: number; read_only: number; mutating: number; not_covered: number };
  groups: { group: CapabilityDef["group"]; items: CapabilityDef[] }[];
  not_covered: { name: string; title: string; why: string }[];
} {
  const groups = [...new Set(CAPABILITIES.map((c) => c.group))].map((g) => ({
    group: g,
    items: CAPABILITIES.filter((c) => c.group === g),
  }));
  const nc = CAPABILITIES.filter((c) => c.availability === "not_covered");
  return {
    ok: true,
    basis: registryBasis(),
    counts: {
      total: CAPABILITIES.length,
      read_only: CAPABILITIES.filter((c) => !c.mutating).length,
      mutating: CAPABILITIES.filter((c) => c.mutating).length,
      not_covered: nc.length,
    },
    groups,
    not_covered: nc.map((c) => ({ name: c.name, title: c.title, why: c.limitations[0] ?? "" })),
  };
}

export { findCapability };
