// P6-D Agent 工具执行服务层：把登记表里的执行器 id 派发到仓库里**已经跑通**的函数。
//
// 这一层的立场（任务书 §二十六「不要重新造一套相同工具」）：
// - **不发明取数路径**：每个 case 调的都是页面同源的那一个函数（computeSentiment / discoverThemes /
//   fetchBoardReal / readRadarDay / listSnapshotRows / probeCapabilities…），本文件里没有指标公式、
//   没有新的 HTTP 端点、没有新的 SQL。
// - **只读**（§二十八）：这里只有 findMany / count / 上游 GET。写操作（扫描、留档、清理、下单）
//   不在这张表里出现，路由也不给它们入口。
// - **失败优先，空不等于失败**（沿用 P6-A capability-service 的口径）：
//   上游返回 null/超时 ⇒ request_failed（原因写原文）；库里 0 行 ⇒ no_data 并说明「为什么是空的」；
//   真实 0 与「没取到」永不合并成一个数字。
// - 每条结果都回一个 ToolObservation（agent-tools-core 的契约）：kind / summary / payload / source /
//   as_of / data_status / degraded_from / reason。页面与日志只能照这个说，不允许在中间层再压平。
import { db } from "@/lib/db";
import {
  fetchDetailReal, fetchKlinesReal, fetchNewsReal, fetchQuotesReal, searchReal, symbolToSecid,
  type RealQuote,
} from "@/lib/desk/em";
import { fetchBoardRowsRescued } from "@/lib/desk/board-rescue";
import { tdxDepth, tdxKlines, tdxQuotes, tdxTradesMoney, type TdxQuote } from "@/lib/desk/tdx";
import { listAllTools, listServers } from "@/lib/desk/mcp-manager";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { getProvider, listProviderIds } from "@/lib/quant/data/index";
import { fetchBarsHybridTracked } from "@/lib/quant/data/hybrid";
import { mcpConfigured } from "@/lib/quant/data/mcp-provider";
import { FACTOR_FIELD_DEFS, factorCatalog, verifiedLedgerMeta } from "@/lib/quant/factors/fields";
import { computeLimitUp } from "./limitup";
import { computeSentiment } from "./sentiment";
import { discoverThemes } from "./themes";
import { loadInterpretations } from "./event-interpret";
import { eventDateBuckets, radarDateBuckets, readEventDay, readRadarDay } from "./history";
import { parseJsonColumn, parseStateFilter } from "./history-core.ts";
import { listSnapshotRows, snapshotDateRows } from "./snapshot";
import type { SnapshotKind } from "./snapshot-core.ts";
import { currentPlan } from "./lifecycle-service";
import { probeCapabilities, registryView } from "./capability-service";
import { capabilitiesForNeed, findCapability } from "./capability-core";
import { similarReturnForward } from "./similar-env";
import {
  clipText, emptyObs, failedObs, findTool, notCoveredObs, okObs, TOOL_DEFS, unsupportedToolReason,
  validateToolParams, type ToolObservation,
} from "./agent-tools-core.ts";

// ---------- 小工具：文本与数值口径（与 research.ts 同一套写法，不另立第三种） ----------

const n1 = (v: unknown): string => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? String(Math.round(x * 10) / 10) : "null";
};
const signed = (v: unknown): string => {
  const x = Number(v);
  if (!Number.isFinite(x)) return "null";
  return `${x > 0 ? "+" : ""}${Math.round(x * 10) / 10}`;
};
/** 元 → 亿：null 保持 null（停牌/无字段不等于 0，把 null 变成 0 就是任务书 §六 禁止的那种伪装） */
const yi = (vuan: number | undefined | null): number | null =>
  typeof vuan === "number" && isFinite(vuan) ? Math.round((vuan / 1e8) * 100) / 100 : null;
/** 日期列统一取前 10 位；空值返回 ""，由落库层写成「未记录」 */
const dayOf = (v: unknown): string => String(v ?? "").slice(0, 10);
/** payload 里的列表裁剪：血缘只抽前若干条主键，整包塞回去会让响应与日志胀到不可读 */
const capRows = <T>(rows: T[], max = 8): T[] => (rows ?? []).slice(0, max);
/** candidate_pool.rows 是 JSON 文本列：解析不出就算 0 只并照说，不猜一个数 */
const poolSize = (raw: unknown): number => parseJsonColumn<unknown[]>(String(raw ?? ""), []).value.length;

/**
 * 软超时（§十七 的执行点之一）。三条口径：
 * 1) 超时与「请求成功但返回空」分开报：timed_out=true 时上层写 output_status=timeout；
 * 2) 上游把两者都压成 null 时（em.ts / tdx.ts 的既有约定）一律按**失败**处理，不写成「今天没有数据」；
 * 3) fetch 取消不了，底层 promise 仍会跑完：这里挂一个 catch，避免未处理拒绝把进程搞崩。
 */
const TIMEOUT = Symbol("timeout");

async function timed<T>(
  ms: number, label: string, make: () => Promise<T | null>,
): Promise<{ value: T | null; error: string | null; timed_out: boolean }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const work = make();
  work.catch(() => undefined);
  try {
    const raced = await Promise.race<T | null | typeof TIMEOUT>([
      work,
      new Promise<typeof TIMEOUT>((res) => { timer = setTimeout(() => res(TIMEOUT), ms); }),
    ]);
    if (raced === TIMEOUT) {
      return { value: null, error: `${label} 超过 ${ms}ms 超时上限：按取数失败处理（不猜值、不显示为 0）`, timed_out: true };
    }
    return { value: raced, error: null, timed_out: false };
  } catch (e) {
    return { value: null, error: `${label} 请求失败：${String((e as Error)?.message ?? e).slice(0, 180)}`, timed_out: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 上游返回 null / 抛错 / 超时 ⇒ 失败（原因原文可贴，不允许只写「异常」） */
function upstreamNull(what: string, upstream: string, timedOut: boolean, error: string | null): ToolObservation {
  if (timedOut) return failedObs(error ?? `${what} 超时`, upstream, { timed_out: true });
  return failedObs(
    error ?? `${what}未取得数据（${upstream} 返回 null/空）。该上游层不区分超时与空返回，本层按取数失败处理，不显示为 0`,
    upstream,
  );
}

export interface AgentToolRun {
  tool: string;
  title: string;
  capability: string;
  executor: string | null;
  /** 校验后的入参（校验失败时是 {}）：与 call_key 同一份，页面显示的入参就是实际执行的入参 */
  params: Record<string, string | number | boolean | string[]>;
  /** 参数不合规的原文清单（非空 ⇒ 本次没有执行） */
  param_errors: string[];
  obs: ToolObservation;
  latency_ms: number;
  timeout_ms: number;
}

type Params = Record<string, string | number | boolean | string[]>;
const str = (p: Params, key: string, d = ""): string => (typeof p[key] === "string" ? (p[key] as string) : d);
const num = (p: Params, key: string, d: number): number => (typeof p[key] === "number" ? (p[key] as number) : d);
const flag = (p: Params, key: string): boolean => p[key] === true;
const list = (p: Params, key: string): string[] => (Array.isArray(p[key]) ? (p[key] as string[]) : []);

// ---------- 行情：网关为主、腾讯兜底；走兜底必须显式记 degraded_from ----------

const INDEX_DEFAULT = ["000001.SH", "000300.SH", "399006.SZ"];
const INDEX_NAMES: Record<string, string> = { "000001.SH": "上证指数", "000300.SH": "沪深300", "399006.SZ": "创业板指" };

function quoteSummary(rows: { symbol: string; name?: string; price: number; changePct: number }[]): string {
  return rows.map((r) => `${r.name || INDEX_NAMES[r.symbol] || r.symbol} ${n1(r.price)}（${signed(r.changePct)}%）`).join("；");
}

async function quotesViaGateway(symbols: string[], ms: number): Promise<ToolObservation> {
  const gw = await timed(ms, "eltdx 网关报价", () => tdxQuotes(symbols));
  const hits = symbols.map((s) => gw.value?.get(s)).filter((r): r is TdxQuote => !!r);
  if (hits.length) {
    return okObs({
      summary: clipText(`${hits.map((r) => `${r.symbol} 现价 ${n1(r.price)}（${signed(r.changePct)}%）成交 ${n1(r.amountYi)}亿`).join("；")}（eltdx 网关快照：含内外盘/振幅口径，非集合竞价阶段为最新一笔）`),
      payload: {
        quotes: capRows(hits.map((r) => ({
          symbol: r.symbol, price: r.price, changePct: r.changePct, high: r.high, low: r.low,
          prevClose: r.prevClose, amountYi: r.amountYi, insideHand: r.insideHand ?? null, outerHand: r.outerHand ?? null,
        }))),
      },
      source: "eltdx 本机网关 quotes.get_snapshots", as_of: shanghaiStamp(), data_status: "REAL",
    });
  }
  // 兜底：腾讯报价。值是真的，但网关独有字段没有 ⇒ 分层降为 DEGRADED 并写明从哪降级
  const tc = await timed(ms, "腾讯报价兜底", async () => (await fetchQuotesReal(symbols)).filter((q): q is RealQuote => !!q && typeof q.price === "number"));
  const rows = tc.value ?? [];
  if (rows.length) {
    return okObs({
      summary: clipText(`${quoteSummary(rows)}（eltdx 网关本次不可用，走腾讯报价兜底：价是真的，五档/内外盘这类网关字段本次没有）`),
      payload: {
        quotes: capRows(rows.map((r) => ({
          symbol: r.symbol, name: r.name, price: r.price, changePct: r.changePct,
          high: r.high ?? null, low: r.low ?? null, prevClose: r.prevClose ?? null, amountYi: r.amountYi ?? null,
        }))),
      },
      source: "腾讯 qt.gtimg.cn（eltdx 兜底）", as_of: shanghaiStamp(), data_status: "DEGRADED",
      degraded_from: "eltdx 网关报价", notes: [`网关侧原因：${gw.error ?? "未取得数据"}`],
    });
  }
  return upstreamNull("报价", "eltdx 网关与腾讯两条报价通道", tc.timed_out || gw.timed_out, tc.error ?? gw.error ?? "两条报价通道都没有返回");
}

async function indexQuotes(symbols: string[], ms: number): Promise<ToolObservation> {
  const r = await timed(ms, "腾讯指数报价", async () => (await fetchQuotesReal(symbols)).filter((q): q is RealQuote => !!q && typeof q.price === "number"));
  const rows = r.value ?? [];
  if (!rows.length) return upstreamNull("指数报价", "腾讯 qt.gtimg.cn / mkline", r.timed_out, r.error);
  return okObs({
    summary: clipText(quoteSummary(rows)),
    payload: { indexes: capRows(rows.map((q) => ({ symbol: q.symbol, name: q.name, price: q.price, changePct: q.changePct }))) },
    source: "腾讯 qt.gtimg.cn", as_of: shanghaiStamp(), data_status: "REAL",
  });
}

interface BarRow { date: string; o: number; h: number; l: number; c: number; v?: number; amount?: number }

function barsObs(symbol: string, tf: string, rows: BarRow[], source: string, as_of: string, degraded_from: string | null): ToolObservation {
  const last = rows[rows.length - 1];
  return okObs({
    summary: clipText(`${symbol} ${tf} 线 ${rows.length} 根：${dayOf(rows[0].date)}→${dayOf(last.date)}，最后一根 开${n1(last.o)} 高${n1(last.h)} 低${n1(last.l)} 收${n1(last.c)}${last.amount != null ? ` 成交额 ${n1(yi(last.amount))}亿` : ""}${degraded_from ? `（主源 ${degraded_from} 本次不可用，已兜底）` : ""}`),
    payload: {
      symbol, tf, bars_count: rows.length, last_date: dayOf(last.date),
      bars: rows.slice(-8).map((b) => ({ date: dayOf(b.date), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? null, amount_yi: yi(b.amount) })),
    },
    source, as_of, data_status: "HISTORICAL", degraded_from,
  });
}

async function barsOf(symbol: string, tf: string, lookback: number, asOf: string, ms: number): Promise<ToolObservation> {
  if (tf !== "day") {
    // 分钟线只有网关 + 腾讯两条路（hybrid 层只做日线）
    const gw = await timed(ms, `eltdx ${tf} 线`, async () => {
      const rows = await tdxKlines(symbol, tf, Math.min(500, Math.max(5, lookback)));
      return rows ? rows.map((r) => ({ date: r.date, o: r.o, h: r.h, l: r.l, c: r.c })) : null;
    });
    const mine = (gw.value ?? []).slice(-lookback);
    if (mine.length) return barsObs(symbol, tf, mine, `eltdx 本机网关 ${tf} 线`, shanghaiStamp(), null);
    const tc = await timed(ms, `腾讯 ${tf} 线兜底`, () => fetchKlinesReal(symbol, tf, lookback));
    const tcRows = (tc.value ?? []).slice(-lookback);
    if (tcRows.length) return barsObs(symbol, tf, tcRows, `腾讯 ifzq ${tf} 线（eltdx 兜底）`, shanghaiStamp(), "eltdx 网关");
    return upstreamNull(`${tf} 线`, "eltdx 网关与腾讯", tc.timed_out || gw.timed_out, tc.error ?? gw.error ?? "两条通道都没有返回");
  }
  const r = await timed(ms, "日K（eltdx 优先、腾讯兜底）", async () => fetchBarsHybridTracked([symbol], asOf, lookback));
  const res = r.value;
  if (r.timed_out) return failedObs(r.error ?? "日K 超时", "eltdx 日K → 腾讯兜底（hybrid 层）", { timed_out: true });
  const out = res?.bars.get(symbol) ?? [];
  const outcome = res?.outcomes[0] ?? null;
  if (!out.length) {
    // hybrid 层分得开「两条通道都没取到」与「取到了但截断后为空」：照它的结论说，不自己判
    return failedObs(
      `日K 未取得任何一根（${symbol}，asOf ${asOf}，请求 ${lookback} 根）：${outcome?.reason ?? "hybrid 层没有返回该代码的任何K线"}。这是取数结果，不等于「该股票没有历史」`,
      "eltdx 日K → 腾讯兜底（hybrid 层）",
    );
  }
  const degraded = outcome?.channel === "tencent" ? "eltdx 日K" : null;
  return barsObs(
    symbol, "day", out as BarRow[],
    outcome?.channel === "tencent" ? "腾讯 ifzq 日K（eltdx 兜底）" : `eltdx 日K（${outcome?.channel ?? "hybrid"} 通道）`,
    dayOf(out[out.length - 1].date), degraded,
  );
}

// ---------- 东财直连 ----------

async function boardMembers(boardCode: string, kind: "industry" | "concept", ms: number): Promise<ToolObservation> {
  const r = await timed(ms, `板块成分（${boardCode}）`, async () => {
    const provider = await getProvider("em");
    return provider.listUniverse({ kind, boardCode }, shanghaiDate());
  });
  const rows = r.value ?? [];
  if (r.timed_out) return failedObs(r.error ?? "成分名单超时", `东财 clist b:${boardCode}`, { timed_out: true });
  if (!rows.length) {
    return emptyObs(`板块 ${boardCode} 本次没有返回成分行（该板块代码不在当日榜单过滤结果里，或当日无行情）：这是空结果，不是「该板块没有股票」`, `东财 clist b:${boardCode}`);
  }
  const withFlow = rows.filter((m) => typeof m.mainNet === "number");
  const top = [...rows].sort((a, b) => (b.mainNet ?? 0) - (a.mainNet ?? 0)).slice(0, 10);
  return okObs({
    summary: clipText(`${boardCode}（${kind}）成分 ${rows.length} 只：主力净流入前 ${Math.min(5, top.length)} ${top.slice(0, 5).map((m) => `${m.name}(${m.symbol}) ${signed(m.changePct)}%/主力 ${signed(yi(m.mainNet))}亿`).join("；")}${withFlow.length < rows.length ? `；仅 ${withFlow.length} 只有主力资金字段（其余为 null，不按 0 处理）` : ""}`),
    payload: {
      board_code: boardCode, kind, members_count: rows.length,
      members: capRows(top.map((m) => ({ symbol: m.symbol, name: m.name, changePct: m.changePct ?? null, mainNetYi: yi(m.mainNet), industry: m.industry ?? null })), 12),
    },
    source: `东财 clist b:${boardCode}`, as_of: shanghaiStamp(), data_status: "REAL",
  });
}

async function fullUniverse(ms: number): Promise<ToolObservation> {
  const r = await timed(ms, "全A快照", async () => {
    const provider = await getProvider("em");
    return provider.listUniverse({ kind: "all" }, shanghaiDate());
  });
  const rows = r.value ?? [];
  if (r.timed_out) return failedObs(r.error ?? "全A快照超时", "东财 push2 clist（全A）", { timed_out: true });
  if (!rows.length) {
    return upstreamNull("全A快照", "东财 push2 clist", false, "全A快照返回 0 行：该接口按分页取全市场，0 行意味着没取到（不存在「今天全市场 0 只股票」），按失败处理");
  }
  const priced = rows.filter((m) => typeof m.price === "number");
  const adv = priced.filter((m) => (m.changePct ?? 0) > 0).length;
  const dec = priced.filter((m) => (m.changePct ?? 0) < 0).length;
  const byMain = [...rows].sort((a, b) => (b.mainNet ?? 0) - (a.mainNet ?? 0)).slice(0, 6);
  const byPct = [...rows].sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999)).slice(0, 5);
  return okObs({
    summary: clipText(`全A快照 ${rows.length} 只（有价 ${priced.length}、无价=停牌或当日无成交 ${rows.length - priced.length}）：上涨 ${adv}、下跌 ${dec}。主力净流入前 6：${byMain.map((m) => `${m.name} ${signed(yi(m.mainNet))}亿`).join("；")}；涨幅前 5：${byPct.map((m) => `${m.name} ${signed(m.changePct)}%`).join("；")}`),
    payload: {
      rows_count: rows.length, priced_count: priced.length, advancers: adv, decliners: dec,
      top_main_net: capRows(byMain.map((m) => ({ symbol: m.symbol, name: m.name, changePct: m.changePct ?? null, mainNetYi: yi(m.mainNet), industry: m.industry ?? null })), 12),
      top_change: capRows(byPct.map((m) => ({ symbol: m.symbol, name: m.name, changePct: m.changePct ?? null, turnover: m.turnover ?? null })), 10),
    },
    source: "东财 push2 clist 全A快照（emProvider 5 分钟缓存）", as_of: shanghaiStamp(), data_status: "REAL",
  });
}

// ---------- 引擎：一律调已有计算函数，本层不写公式（§十一） ----------

async function sentimentObs(ms: number): Promise<ToolObservation> {
  const r = await timed(ms, "情绪/广度引擎", () => computeSentiment());
  const s = r.value;
  if (!s) return failedObs(r.error ?? "sentiment 引擎未返回", "全A快照 + 指数实时（sentiment 引擎）", { timed_out: r.timed_out });
  return okObs({
    summary: clipText(`全A ${s.total} 只：涨 ${s.advancers}/跌 ${s.decliners}/平 ${s.flat}，中位 ${n1(s.median_pct)}%；涨停 ${s.limit_up}、跌停 ${s.limit_down}、炸板率 ${s.break_rate === null ? "算不出（当日触板 0，不以 0% 代替）" : `${n1(s.break_rate)}%`}；成交 ${n1(s.amount_total_yi)}亿、主力净额 ${signed(s.main_net_sum_yi)}亿；风险等级「${s.risk.level}」；${s.live ? "盘中实时" : "收盘/休市值（非盘中实时）"}`),
    payload: {
      trade_date: s.trade_date, total: s.total, advancers: s.advancers, decliners: s.decliners,
      limit_up: s.limit_up, limit_down: s.limit_down, break_rate: s.break_rate, median_pct: s.median_pct,
      amount_total_yi: s.amount_total_yi, main_net_sum_yi: s.main_net_sum_yi, live: s.live,
      risk_level: s.risk.level, risk_triggers: s.risk.triggers, indices: capRows(s.indices ?? [], 5),
    },
    source: `sentiment 引擎（${s.source?.provider ?? "全A快照"}）`, as_of: s.as_of, data_status: "DERIVED",
    notes: (s.missing ?? []).map((m) => `引擎自报缺失：${m}`),
  });
}

async function riskObs(ms: number): Promise<ToolObservation> {
  const r = await timed(ms, "风险引擎（与 /api/market/risk 同一实现）", () => computeSentiment());
  const s = r.value;
  if (!s) return failedObs(r.error ?? "风险引擎未返回", "全A快照风险引擎", { timed_out: r.timed_out });
  const notes: string[] = (s.missing ?? []).map((m) => `引擎自报缺失：${m}`);
  let hist: ReturnType<typeof similarReturnForward> | null = null;
  const hb = await timed(ms, "上证日K（相似日统计用）", async () => {
    const res = await fetchBarsHybridTracked(["000001.SH"], shanghaiDate(), 520);
    return res.bars.get("000001.SH") ?? [];
  });
  const bars = hb.value ?? [];
  if (bars.length >= 40) hist = similarReturnForward(bars.map((b) => ({ date: b.date, c: b.c })), 0.8);
  else notes.push(`相似日统计本次没有可用日K（取到 ${bars.length} 根，不足 40 根）：只有当日风险分项，没有历史参照${hb.error ? `（原因：${hb.error}）` : ""}`);
  const hz = hist?.horizons.find((x) => x.win_rate !== null);
  // P7-②：样本区间提成第二层标量。period 本来是 {start,end} 对象，落在 extractRefs 的 depth>2 位置（agent-loop-core.ts 的 walk），
  // 永远进不了台账 refs——这就是 P6-D 那次「同一台机器 5 分钟内相似日样本 113→225，事后却无法从库里重建窗口」的根因。
  const envWindow = hist?.period ? `，样本区间 ${hist.period.start}→${hist.period.end}` : "，样本区间未给出（引擎没返回 period，不猜窗口）";
  return okObs({
    summary: clipText(`风险等级「${s.risk.level}」（触发：${s.risk.triggers?.length ? s.risk.triggers.join("、") : "本次无指标越线；空不等于安全，只是没触发这套阈值"}）；涨跌家数 ${s.advancers}/${s.decliners}；炸板率 ${s.break_rate === null ? "算不出（触板 0）" : `${n1(s.break_rate)}%`}；${hist ? `上证相似环境后续统计：样本 ${hist.sample_size} 个${hz ? `，${hz.h}日胜率 ${n1(hz.win_rate)}%（HISTORICAL，不是今天的预测）` : "，各期限胜率都算不出"}${envWindow}${hist.sample_ok ? "" : "；样本不足 30：仅供参考"}` : "本次没有相似日历史参照"}`),
    payload: {
      trade_date: s.trade_date, level: s.risk.level, triggers: s.risk.triggers ?? [], live: s.live,
      advancers: s.advancers, decliners: s.decliners, break_rate: s.break_rate, main_net_sum_yi: s.main_net_sum_yi,
      similar_env: hist ? { sample: hist.sample_size, sample_ok: hist.sample_ok, period: hist.period, period_start: hist.period?.start ?? null, period_end: hist.period?.end ?? null, horizon: hz ? hz.h : null, horizons: capRows(hist.horizons.map((x) => ({ horizon: x.h, win_rate: x.win_rate, sample: x.sample_size })), 3) } : null,
    },
    source: "sentiment 引擎风险分项 + 上证相似日统计（similar-env）", as_of: s.as_of, data_status: "DERIVED", notes,
  });
}

async function themesObs(force: boolean, ms: number): Promise<ToolObservation> {
  const r = await timed(ms, "主线发现引擎", () => discoverThemes({ force }));
  const th = r.value;
  if (!th) return failedObs(r.error ?? "主线引擎未返回", "东财板块榜 + 成分扩散 + 资金（themes 引擎）", { timed_out: r.timed_out });
  const names = (g: typeof th.main) => g.map((t) => `${t.name}(${n1(t.score)}分)`).join("、");
  const anyGroup = th.main.length + th.sub.length + th.rotation.length + th.watch.length;
  if (!anyGroup) {
    return emptyObs("主线发现本次没有任何分组结果：涨幅/RPS/扩散/资金/连续强势五项都不足以判出主线（这是判定结果，不是「没有主线=安全」）", "themes 引擎", (th.missing ?? []).map((m) => `引擎自报缺失：${m}`));
  }
  const row = (t: typeof th.main[number]) => ({ theme_id: t.code, name: t.name, score: Math.round(t.score * 10) / 10, role: t.role, diffusion: t.diffusion, streak_pct: t.streakPct, main_yi: t.mainYi, reasons: (t.reasons ?? []).slice(0, 3) });
  return okObs({
    summary: clipText(`主线 ${th.main.length} 个（${names(th.main) || "无"}）、次主线 ${th.sub.length}、轮动 ${th.rotation.length}、观察 ${th.watch.length}；判定口径=涨幅/RPS/扩散/资金同步/连续强势（板块代码即 theme_id，可回看板块成分）`),
    payload: {
      trade_date: th.trade_date,
      main: capRows(th.main.map(row), 6), sub: capRows(th.sub.map(row), 5), rotation: capRows(th.rotation.map(row), 5),
    },
    source: `themes 引擎（${th.source?.provider ?? "东财板块榜+扩散+资金"}）`, as_of: th.as_of, data_status: "DERIVED",
    notes: (th.missing ?? []).map((m) => `引擎自报缺失：${m}`),
  });
}

async function limitUpObs(ms: number): Promise<ToolObservation> {
  const r = await timed(ms, "涨停梯队引擎", () => computeLimitUp());
  const lu = r.value;
  if (!lu) return failedObs(r.error ?? "涨停梯队引擎未返回", "全A快照 + 涨跌停判定引擎", { timed_out: r.timed_out });
  const tiers = lu.tiers.slice(-3).map((t) => `${t.label} ${t.stocks.length}家（${t.stocks.slice(0, 4).map((s) => `${s.name}${s.boards}板`).join("、")}）`).join("；");
  return okObs({
    summary: clipText(`收盘涨停 ${lu.limit_up_count} 家、触板 ${lu.touched_count}、炸板 ${lu.broken_count}，炸板率 ${lu.break_rate === null ? "算不出（触板 0，不以 0% 代替）" : `${n1(lu.break_rate)}%`}；最高 ${lu.max_boards} 连板。梯队：${tiers || "本次没有分层名单"}`),
    payload: {
      trade_date: lu.trade_date, limit_up_count: lu.limit_up_count, touched: lu.touched_count, broken: lu.broken_count,
      break_rate: lu.break_rate, max_boards: lu.max_boards,
      tiers: capRows(lu.tiers.map((t) => ({ label: t.label, count: t.stocks.length, stocks: capRows(t.stocks.map((s) => ({ symbol: s.symbol, name: s.name, boards: s.boards, industry: s.industry })), 8) })), 6),
    },
    source: "limitup 引擎（快照口径涨停判定 + 日K连板回溯）", as_of: lu.as_of, data_status: "DERIVED",
    notes: [lu.note].filter(Boolean).concat([`连板口径是 20 根日K窗口内的快照+日K回溯，capped=true 表示真实连板数 ≥20（不是恰好 20）`]),
  });
}

// ---------- 库里读数：0 行 = 真实为空（说清为什么空），读不到 = 失败 ----------

interface RowsObsInput {
  label: string;
  table: string;
  date: string;
  rows: Record<string, unknown>[];
  total: number;
  summary: (rows: Record<string, unknown>[]) => string;
  payload?: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
  data_status: ToolObservation["data_status"];
  emptyNote: string;
  source: string;
  as_of?: string;
  notes?: string[];
}

/** 库里表统一的「有行 / 真空 / 读失败」出口：0 行永远走 emptyObs，不会被写成 0 个信号=一切正常 */
function rowsObs(o: RowsObsInput): ToolObservation {
  if (!o.rows.length) return emptyObs(`${o.label}：${o.table} 在 ${o.date || "本库"} 没有行 —— ${o.emptyNote}`, o.source, o.notes);
  return okObs({
    summary: clipText(o.summary(o.rows)),
    payload: { table: o.table, date: o.date, rows_count: o.total, rows: capRows((o.payload ? o.payload(o.rows) : o.rows), 8) },
    source: o.source, as_of: o.as_of || o.date, data_status: o.data_status, notes: o.notes,
  });
}

const radarPayload = (rows: Record<string, unknown>[]): Record<string, unknown>[] => rows.map((r) => ({
  finding_id: String(r.id ?? ""), kind: r.kind, title: r.title, detail: clipText(r.detail, 160),
  state: r.state, trade_date: dayOf(r.asOf),
}));

const eventPayload = (rows: Record<string, unknown>[]): Record<string, unknown>[] => rows.map((r) => ({
  event_id: String(r.id ?? ""), trade_date: dayOf(r.asOf), time: String(r.time ?? ""), title: r.title,
  level: r.level, source: String(r.source ?? ""),
  mapped_sectors: parseJsonColumn<string[]>(String(r.mappedSectors ?? "[]"), []).value,
}));

// ---------- 快照留档行 → 带口径的 payload ----------

const SNAPSHOT_TABLE: Record<SnapshotKind, string> = { risk: "risk_snapshot", themes: "theme_snapshot", probability: "probability_snapshot" };
const SNAPSHOT_EMPTY_NOTE: Record<SnapshotKind, string> = {
  risk: "风险留档只在人工点「留档今天」时产生（写操作，Agent 不做），没点的那天就没有行",
  themes: "主线留档同上：留档不是自动的，没有行就是那天没留过档，不是「那天没有主线」",
  probability: "概率必须连着当时的 conditions 一起留档才有意义；没有行 ⇒ 那组条件从没算过，本层不会现编一组条件去算",
};

function snapshotPayload(kind: SnapshotKind, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    if (kind === "probability") {
      const pooled = parseJsonColumn<{ h: number; win_rate: number | null; sample_size: number }[]>(String(r.pooled ?? "[]"), []).value;
      return {
        trade_date: dayOf(r.tradeDate), sample: pooled[0]?.sample_size ?? null, horizon: pooled[0]?.h ?? null,
        win_rate_pct: pooled[0]?.win_rate ?? null, sample_ok: r.sampleOk === true, scope: String(r.scope ?? ""),
        computed_at: String(r.computedAt ?? ""), pooled: pooled.map((x) => ({ horizon: x.h, win_rate: x.win_rate, sample: x.sample_size })),
      };
    }
    if (kind === "risk") {
      return {
        trade_date: dayOf(r.tradeDate), level: String(r.level ?? ""), live: r.live === true, break_rate: r.breakRate ?? null,
        advancers: r.advancers, decliners: r.decliners, computed_at: String(r.computedAt ?? ""),
      };
    }
    return {
      trade_date: dayOf(r.tradeDate), main_count: r.mainCount, sub_count: r.subCount,
      top_main: parseJsonColumn<unknown[]>(String(r.topMain ?? "[]"), []).value, computed_at: String(r.computedAt ?? ""),
    };
  });
}

function snapshotSummary(kind: SnapshotKind, latest: Record<string, unknown>, days: number): string {
  if (kind === "probability") {
    const pooled = parseJsonColumn<{ h: number; win_rate: number | null; sample_size: number }[]>(String(latest.pooled ?? "[]"), []).value;
    const hs = pooled.length
      ? pooled.map((x) => `${x.h}日胜率 ${n1(x.win_rate)}%（样本 ${x.sample_size}${x.sample_size < 30 ? "，不足 30：仅供参考" : ""}）`).join("；")
      : "pooled 列为空（留档当时就没算出任何期限的汇总）";
    return `概率留档（基准日 ${latest.tradeDate}${latest.tradeDateIsHistorical ? "，历史回放" : ""}）：${hs}。这是 historical/statistical，不等于今天上涨的概率`;
  }
  if (kind === "risk") {
    return `风险留档：${latest.tradeDate} 等级「${latest.level}」（留档时刻 ${latest.computedAt}，当时 live=${latest.live}；炸板率 ${latest.breakRate === null ? "当时算不出" : `${n1(latest.breakRate)}%`}）。留档是那一刻的快照，不是实时`;
  }
  return `主线留档：${latest.tradeDate} 主线 ${latest.mainCount}／次主线 ${latest.subCount}／轮动 ${latest.rotationCount}／观察 ${latest.watchCount}（留档时刻 ${latest.computedAt}）`;
}

async function snapshotObs(kind: SnapshotKind, date: string, ms: number): Promise<ToolObservation> {
  const r = await timed(ms, `${kind} 留档读取`, () => Promise.all([listSnapshotRows(db, kind, date, 5), snapshotDateRows(db, kind)]));
  const found = r.value;
  if (!found) return failedObs(r.error ?? `读取 ${SNAPSHOT_TABLE[kind]} 失败`, `${kind}_snapshot 表`, { timed_out: r.timed_out });
  const [rows, days] = found;
  const daySet = [...new Set(days.map((d) => d.tradeDate))].sort().reverse();
  const notes = [`留档不是自动的：有档的交易日 ${daySet.length} 个${daySet.length ? `（最近 ${daySet.slice(0, 6).join("、")}）` : ""}`];
  if (!rows.length) {
    return emptyObs(`${kind} 留档在 ${date || "最近"} 没有行：${SNAPSHOT_EMPTY_NOTE[kind]}`, `${kind}_snapshot 表`, notes);
  }
  const latest = rows[0] as Record<string, unknown>;
  return okObs({
    summary: clipText(`${snapshotSummary(kind, latest, daySet.length)}。${notes[0]}`),
    payload: { table: SNAPSHOT_TABLE[kind], rows_count: rows.length, days_covered: daySet.length, rows: capRows(snapshotPayload(kind, rows as Record<string, unknown>[]), 5) },
    source: `${kind}_snapshot 表（由 ${kind} 引擎产出后留档）`,
    as_of: String(latest.computedAt ?? latest.tradeDate ?? ""), data_status: "SNAPSHOT", notes,
  });
}

// ---------- 执行器派发 ----------

/** 本层已实现分支的执行器 id（与 dispatch 的 case 逐条对应，由测试核对两边不漂移） */
export const DISPATCHED_EXECUTORS = [
  "gateway.quotes", "gateway.bars", "gateway.depth", "gateway.trades-money",
  "em.universe", "em.boards", "em.board-members", "em.fflow-daykline", "em.news", "em.search",
  "engine.sentiment", "engine.risk", "engine.themes", "engine.limitup", "engine.trade-dates", "engine.health",
  "db.radar", "db.events", "db.event-interpret", "db.research", "db.factor-test", "db.candidate-pool",
  "db.history-radar", "db.history-events", "db.snapshot-risk", "db.snapshot-themes", "db.snapshot-probability",
  "db.task-status", "db.lifecycle-preview", "db.agent-run",
  "static.factors", "static.verified-ledger", "static.registry-view", "probe.capabilities",
] as const;

async function dispatch(executor: string | null, toolName: string, p: Params, ms: number): Promise<ToolObservation> {
  switch (executor) {
    // ---- 本机 eltdx 网关 ----
    case "gateway.quotes":
      return toolName === "index_benchmark" ? indexQuotes(list(p, "symbols").length ? list(p, "symbols") : INDEX_DEFAULT, ms) : quotesViaGateway(list(p, "symbols"), ms);
    case "gateway.bars":
      return barsOf(str(p, "symbol"), str(p, "tf", "day"), num(p, "lookback", 60), str(p, "asOf", shanghaiDate()) || shanghaiDate(), ms);
    case "gateway.depth": {
      const symbol = str(p, "symbol");
      const r = await timed(ms, "eltdx 五档", () => tdxDepth([symbol]));
      const d = r.value?.get(symbol);
      if (!d) return failedObs(r.error ?? `eltdx 网关没有返回 ${symbol} 的五档（网关未运行或该代码无快照）。五档只有这一条路，不用别的口径冒充`, "eltdx quotes.get_depth", { timed_out: r.timed_out });
      return okObs({
        summary: clipText(`${symbol} 五档：买一 ${n1(d.bids[0]?.price)}×${d.bids[0]?.volume ?? "null"}手…卖一 ${n1(d.asks[0]?.price)}×${d.asks[0]?.volume ?? "null"}手；内盘 ${d.insideHand}手／外盘 ${d.outerHand}手（现手 ${d.activeHand}）。盘口是瞬时值，两次抓取可以不同`),
        payload: { symbol, last_price: d.lastPrice, bids: d.bids.slice(0, 5), asks: d.asks.slice(0, 5), inside_hand: d.insideHand, outer_hand: d.outerHand },
        source: "eltdx quotes.get_depth", as_of: shanghaiStamp(), data_status: "REAL",
      });
    }
    case "gateway.trades-money": {
      const symbol = str(p, "symbol");
      const r = await timed(ms, "eltdx 逐笔分档代理", () => tdxTradesMoney(symbol));
      const m = r.value;
      if (!m) return failedObs(r.error ?? `未取得 ${symbol} 的内外盘成交额（依赖网关报价的全日累计字段，缺字段时本层不折算）。这是代理口径，不是交易所官方逐笔`, "eltdx quotes.get_snapshots（内外盘）", { timed_out: r.timed_out });
      return okObs({
        summary: clipText(`${symbol} 主动买 ${n1(m.buyAmountYi)}亿／主动卖 ${n1(m.sellAmountYi)}亿／净额 ${signed(m.netYi)}亿（${m.basis}；代理口径，非官方逐笔成交）`),
        payload: { symbol, buy_yi: Math.round(m.buyAmountYi * 100) / 100, sell_yi: Math.round(m.sellAmountYi * 100) / 100, net_yi: Math.round(m.netYi * 100) / 100, basis: m.basis },
        source: "eltdx 内外盘 × 成交均价（代理口径）", as_of: shanghaiStamp(), data_status: "DERIVED",
      });
    }
    // ---- 东财直连 ----
    case "em.universe":
      return fullUniverse(ms);
    case "em.boards": {
      const kind = str(p, "kind", "industry") === "concept" ? "concept" : "industry";
      const dir = str(p, "dir", "in") === "out" ? "out" : "in";
      // R8：走带同花顺整榜兜底的单点入口——过去东财断源时 fetchBoardReal 会带回腾讯涨幅榜
      // （资金列全是占位 0），本层按 main 正负一过滤就是 0 行，台账把它说成「真实为空」，
      // 这是拿口径缺陷冒充市场事实；换源后要么给净额真数，要么保留原话术。
      const r = await timed(ms, "板块榜（东财+同花顺兜底）", () => fetchBoardRowsRescued(kind, dir, num(p, "size", 20)));
      const rows = r.value?.rows ?? null;
      const fromThs = r.value?.fromThs ?? false;
      if (!rows) return upstreamNull("板块榜", "东财 push2 clist（同花顺兜底亦无返回）", r.timed_out, r.error ?? "上游无返回");
      if (!rows) return upstreamNull("板块榜", "东财 push2 clist（同花顺兜底亦无返回）", r.timed_out, r.error);
      if (!rows.length) return emptyObs(`板块榜 ${kind}/${dir} 本次 0 行：${dir === "in" ? "没有主力净额为正的板块" : "没有主力净额为负的板块"}（该榜按主力净额正负过滤，0 行是真实为空，不是取数失败）`, fromThs ? "同花顺板块资金流榜（净额口径）" : "东财 clist 板块榜");
      const boardSource = fromThs ? "同花顺板块资金流榜（东财断源兜底，本机直连；净额=流入−流出）" : "东财 clist 板块榜（本机直连）";
      return okObs({
        summary: clipText(`${kind === "industry" ? "行业" : "概念"}板块${dir === "in" ? "净流入" : "净流出"}榜 ${rows.length} 条：${rows.slice(0, 5).map((b) => `${b.name} ${signed(b.main)}亿/${signed(b.changePct)}%（净占比 ${b.fundsMissing || b.breakdownMissing ? "无该口径读数" : `${n1(b.ratio)}%`}，领涨 ${b.leader || "未记录"}）`).join("；")}${fromThs ? "；同花顺榜只有净额口径，无净占比/超大单/大单拆分" : ""}`),
        payload: { boards: capRows(rows.map((b) => ({ board_code: b.code, name: b.name, changePct: b.changePct, mainYi: b.fundsMissing ? null : b.main, ratio: b.fundsMissing || b.breakdownMissing ? null : b.ratio, leader: b.leader })), 12) },
        source: boardSource, as_of: shanghaiStamp(), data_status: fromThs ? "DEGRADED" : "REAL",
      });
    }
    case "em.board-members":
      return boardMembers(str(p, "boardCode"), str(p, "kind", "industry") === "concept" ? "concept" : "industry", ms);
    case "em.fflow-daykline": {
      const symbol = str(p, "symbol");
      const secid = symbolToSecid(symbol);
      if (!secid) return failedObs(`代码 ${symbol} 无法转成东财 secid（市场段/后缀不认识）：这是入参问题，不是该股票没有资金流数据`, "东财 push2his fflow/daykline");
      const r = await timed(ms, "个股主力资金日K", () => fetchDetailReal(secid));
      const days = r.value?.days ?? [];
      if (r.timed_out) return failedObs(r.error ?? "主力资金日K 超时", "东财 push2his fflow/daykline（新浪备胎同窗未返回）", { timed_out: true });
      if (!days.length) return emptyObs(`${symbol} 的主力资金日K本次没有返回任何一天（东财 fflow 与新浪备胎都没给数；部分新股/停牌股本来无数据）：不补 0，也不拿别的股票顶上`, "东财 fflow/daykline + 新浪 MoneyFlow");
      const last = days[days.length - 1];
      return okObs({
        summary: clipText(`${symbol} 近 ${days.length} 日主力净额：${days.slice(-5).map((d) => `${d.date} ${signed(d.value)}亿`).join("；")}（最新 ${last.date} ${signed(last.value)}亿）${r.value?.source === "sina" ? "［新浪日度净额口径：东财 fflow 断源时的备胎，与东财 f62 不完全等价］" : ""}`),
        payload: { symbol, days_count: days.length, last_date: last.date, todayYi: last.value, days: days.slice(-10) },
        source: r.value?.source === "sina" ? "新浪 MoneyFlow 日度净额（东财 push2his 断源备胎）" : "东财 fflow/daykline（本机直连）",
        as_of: `${last.date} 收盘后`, data_status: "REAL",
      });
    }
    case "em.news": {
      const r = await timed(ms, "财经快讯", () => fetchNewsReal(num(p, "limit", 12)));
      const items = r.value;
      if (!items) return upstreamNull("财经快讯", "东财 np-weblist 与新浪 zhibo 两条源", r.timed_out, r.error);
      if (!items.length) return emptyObs("快讯两条源本次都没有返回条目（请求成功但列表为空）：这是空结果，不是失败", "东财/新浪 7x24");
      return okObs({
        summary: clipText(`财经快讯 ${items.length} 条（最新 ${items[0].time || "时间未记录"}）：${items.slice(0, 3).map((i) => i.title).join(" / ")}`),
        payload: { items: capRows(items.map((i) => ({ time: i.time, title: i.title })), 12), latest_time: items[0].time || null },
        source: "东财 7x24 → 新浪 zhibo（互为兜底）", as_of: items[0].time || shanghaiStamp(), data_status: "REAL",
      });
    }
    case "em.search": {
      const q = str(p, "q");
      const r = await timed(ms, "代码/名称检索", () => searchReal(q));
      const items = r.value ?? [];
      if (r.timed_out) return failedObs(r.error ?? "检索超时", "东财 searchapi suggest", { timed_out: true });
      if (!items.length) return emptyObs(`检索「${q}」没有任何返回：可能关键词不是股票/板块名，本层不会猜一个代码给模型`, "东财 searchapi suggest");
      return okObs({
        summary: clipText(`检索「${q}」命中 ${items.length} 条：${items.slice(0, 5).map((i) => `${i.name}(${i.symbol}，${i.type})`).join("；")}`),
        payload: { query: q, items: capRows(items.map((i) => ({ symbol: i.symbol, name: i.name, type: i.type })), 10) },
        source: "东财 searchapi suggest", as_of: shanghaiStamp(), data_status: "REAL",
      });
    }
    // ---- 引擎（现算，公式都在引擎里） ----
    case "engine.sentiment":
      return sentimentObs(ms);
    case "engine.risk":
      return riskObs(ms);
    case "engine.themes":
      return themesObs(flag(p, "force"), ms);
    case "engine.limitup":
      return limitUpObs(ms);
    case "engine.trade-dates": {
      const n = num(p, "n", 60);
      const today = shanghaiDate();
      const r = await timed(ms, "上证日K（交易日历）", async () => (await fetchBarsHybridTracked(["000001.SH"], today, Math.ceil(n * 1.6))).bars.get("000001.SH") ?? []);
      const dates = (r.value ?? []).map((b) => dayOf(b.date)).filter(Boolean).sort().reverse().slice(0, n);
      if (!dates.length) return upstreamNull("交易日历", "上证指数日K（没有独立节假日表）", r.timed_out, r.error ?? "日K 无返回：无法据此说哪天开市，本层不猜");
      return okObs({
        summary: clipText(`最近 ${dates.length} 个真实交易日（取自上证指数日K实际存在的日子）：${dates.slice(0, 6).join("、")}${dates.length > 6 ? " …" : ""}；最新交易日 ${dates[0]}。没有独立节假日表，取不到日K 时返回空而不是猜哪天开市`),
        payload: { dates: dates.slice(0, 30), dates_count: dates.length, last_trade_date: dates[0], as_of_trade_date: today },
        source: "上证指数日K（hybrid 层：eltdx 优先、腾讯兜底）", as_of: `${dates[0]} 收盘后`, data_status: "HISTORICAL",
      });
    }
    case "engine.health": {
      const coverage: Record<string, unknown>[] = [];
      for (const id of listProviderIds()) {
        try {
          const prov = await getProvider(id);
          coverage.push({ id, coverage: prov.coverage(), configured: id === "mcp" ? mcpConfigured() : true });
        } catch (e) {
          coverage.push({ id, error: String((e as Error)?.message ?? e).slice(0, 120) });
        }
      }
      const gw = await timed(3000, "eltdx 探活", () => tdxQuotes(["000001.SH"]));
      const servers = listServers();
      const tools = listAllTools();
      return okObs({
        summary: clipText(`Provider 注册：${coverage.map((c) => `${c.id}${c.error ? "=注册失败" : ""}${c.configured === false ? "=未配置" : ""}`).join("、")}；eltdx 网关${gw.value && gw.value.size ? "在线" : `不可用（${gw.error ?? "无返回"}）`}；MCP ${servers.length} 个服务器/${tools.length} 个工具${tools.length ? "" : "（不可用：本层不会假装调用成功）"}`),
        payload: {
          providers: coverage, gateway_up: !!(gw.value && gw.value.size), gateway_error: gw.error ?? null,
          mcp_servers: servers.length, mcp_ready: servers.filter((s) => s.status === "ready").length, mcp_tools: tools.length,
        },
        source: "Provider 注册表 + eltdx /rpc 探活 + MCP 运行态", as_of: shanghaiStamp(), data_status: "REAL",
      });
    }
    // ---- 本地库（只读） ----
    case "db.radar": {
      const date = shanghaiDate();
      const filter = parseStateFilter(str(p, "state", "live")) ?? "live";
      const [rows, total] = await Promise.all([
        readRadarDay(db, date, filter),
        db.radarFinding.count({ where: { asOf: date } }),
      ]);
      const byKind = new Map<string, number>();
      for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
      return rowsObs({
        label: "当日雷达", table: "radar_finding", date, rows: rows as unknown as Record<string, unknown>[], total,
        summary: (rs) => `当日（${date}）雷达 ${filter} 信号 ${rs.length} 条（库内当日共 ${total} 行）：按类型 ${[...byKind.entries()].map(([k, v]) => `${k} ${v}`).join("、")}。样例：${rs.slice(0, 3).map((r) => `${r.kind}｜${r.title}`).join(" / ")}`,
        payload: radarPayload, data_status: "REAL",
        source: "radar_finding 表（上次扫描落库；本层不触发扫描）",
        emptyNote: filter === "live" ? "当天没扫描、或扫描了但规则没命中；要新结果必须显式触发扫描（写操作，Agent 不做）" : `该状态下当日没有行（当日总行数 ${total}）`,
      });
    }
    case "db.events": {
      const date = shanghaiDate();
      const rows = await readEventDay(db, date);
      const hit = new Map<string, number>();
      for (const r of rows) for (const s of parseJsonColumn<string[]>(r.mappedSectors, []).value) hit.set(s, (hit.get(s) ?? 0) + 1);
      return rowsObs({
        label: "当日全球事件", table: "global_event", date, rows: rows as unknown as Record<string, unknown>[], total: rows.length,
        summary: (rs) => `当日事件 ${rs.length} 条（时间倒序）；产业链映射命中板块 ${hit.size} 个（${[...hit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`).join("、") || "本批事件都没命中映射表，映射为空是入库时的事实"}）。样例：${rs.slice(0, 3).map((r) => `${r.level}｜${r.title}`).join(" / ")}`,
        payload: eventPayload, data_status: "REAL", source: "global_event 表（快讯来自东财/新浪）",
        emptyNote: "当天没有事件行（未扫描，或上游窗口内没有命中的快讯），不是「今天全世界没发生事」",
      });
    }
    case "db.event-interpret": {
      const date = str(p, "date", "") || shanghaiDate();
      const bundle = await loadInterpretations({ date });
      const items = bundle.items;
      return rowsObs({
        label: "AI 事件解释", table: "event_interpretation", date, rows: items as unknown as Record<string, unknown>[], total: items.length,
        summary: (rs) => `已落库 AI 事件解释 ${rs.length} 条（${date}；状态 ${bundle.counts.interpreted} INTERPRETED / ${bundle.counts.partial} PARTIAL / ${bundle.counts.rejected} REJECTED，另有 ${bundle.counts.stale} 条对应事件内容已变、${bundle.counts.orphan} 条已找不到事件行）。属于 AI_INTERPRETATION 层：是对真实事件的说法，不是事实本身`,
        payload: (rs) => rs.map((r) => ({
          event_id: String(r.eventId ?? ""), trade_date: dayOf(r.asOf), title: r.title, status: r.status,
          model: String(r.model ?? ""), stale: r.stale === true, orphan: r.orphan === true,
        })),
        data_status: "AI_INTERPRETATION", source: "event_interpretation 表（模型产出经服务端复校验后落库）", as_of: bundle.as_of || date,
        emptyNote: "还没有人对当日事件点过「AI 理解」：这一层是空的，不会自动生成（当日事件行仍是可理解的事实原料）",
        notes: bundle.missing?.length ? [`服务端自报口径：${bundle.missing.slice(0, 3).join("；")}`] : [],
      });
    }
    case "db.research": {
      const date = str(p, "date", "") || shanghaiDate();
      const row = await db.researchReport.findFirst({ where: { reportKey: `market|${date}` }, orderBy: { createdAt: "desc" } });
      if (!row) {
        return emptyObs(`research_report 没有 ${date}（scope=market）的报告行：还没有人点过「生成研究报告」，本层不会凭问题现编一份市场环境报告`, "research_report 表", ["没有报告 ≠ 市场没有变化：台账读数在各能力自己的工具里，可直接取"]);
      }
      const missing = parseJsonColumn<string[]>(row.missingJson, []).value;
      return okObs({
        summary: clipText(`${date} 市场环境研究报告：状态 ${row.status}、模型 ${row.model || "未记录"}、台账 ${row.evidenceTotal} 行、缺失口径 ${missing.length} 条。标题「${row.headline || "未记录"}」。属于 AI_INTERPRETATION 层，不是事实`),
        payload: {
          report_key: row.reportKey, trade_date: dayOf(row.asOf), status: row.status, evidence_total: row.evidenceTotal,
          posture: row.marketPosture, missing: capRows(missing, 8), prompt_version: row.promptVersion,
        },
        source: "research_report 表（P6-C 落库）", as_of: row.generatedAt || date, data_status: "AI_INTERPRETATION",
      });
    }
    case "db.factor-test": {
      const key = str(p, "factorKey", "");
      const [rows, total] = await Promise.all([
        db.factorTest.findMany({ where: key ? { factorKey: key } : {}, orderBy: { createdAt: "desc" }, take: 8 }),
        db.factorTest.count({ where: key ? { factorKey: key } : {} }),
      ]);
      return rowsObs({
        label: "因子 IC 跑批记录", table: "factor_test", date: key || "全部因子", rows: rows as unknown as Record<string, unknown>[], total,
        summary: (rs) => `factor_test 共 ${total} 次记录，最近 ${rs.length} 次：${rs.slice(0, 4).map((r) => `${r.factorKey}（区间 ${r.dataRange || "未记录"}，样本 ${r.sampleStocks} 只/${r.sampleDates} 日，前瞻 ${r.horizon} 日，RankIC ${n1(r.rankIc)}，ICIR ${n1(r.icIr)}，${r.passed ? "通过" : "未通过"}）`).join("；")}。这是 HISTORICAL：过去样本不等于今天有效`,
        payload: (rs) => rs.map((r) => ({
          factor_key: String(r.factorKey ?? ""), trade_date: dayOf(r.createdAt), sample: Number(r.sampleStocks ?? 0),
          horizon: Number(r.horizon ?? 0), rank_ic: r.rankIc, icir: r.icIr, passed: r.passed, data_range: String(r.dataRange ?? ""),
        })),
        data_status: "HISTORICAL", source: "factor_test 表（因子测试台跑批）",
        emptyNote: "还没有跑过批量 IC 验证 ⇒ 任何因子有效性结论只能是 UNVERIFIED，既不是「无效」也不是「有效」",
      });
    }
    case "db.candidate-pool": {
      const [rows, total] = await Promise.all([db.candidatePool.findMany({ orderBy: { createdAt: "desc" }, take: 5 }), db.candidatePool.count()]);
      return rowsObs({
        label: "候选池", table: "candidate_pool", date: "", rows: rows as unknown as Record<string, unknown>[], total,
        summary: (rs) => `候选池共 ${total} 个冻结池，最近 ${rs.length} 个：${rs.map((r) => `${r.poolId}（${dayOf(r.asOf)}，${poolSize(r.rows)} 只，复权口径 ${String(r.dataSource ?? "") || "未记录"}，验证${r.verify ? "已回填" : "未回填"}）`).join("；")}。冻结后 rows 永不覆盖`,
        payload: (rs) => rs.map((r) => ({
          report_key: String(r.poolId ?? ""), trade_date: dayOf(r.asOf),
          sample: poolSize(r.rows), data_source: String(r.dataSource ?? ""),
        })),
        data_status: "REAL", source: "candidate_pool 表",
        emptyNote: "还没冻结过任何候选池（页面「冻结」是写操作，Agent 不做）",
      });
    }
    case "db.history-radar": {
      const buckets = await radarDateBuckets(db);
      if (!buckets.length) return emptyObs("radar_finding 表没有任何日期：库里还没落过雷达行（从未扫描），不是「扫描了但每天 0 条」", "radar_finding 表（只读）");
      const date = str(p, "date", "") || buckets[0].date;
      const filter = parseStateFilter(str(p, "state", "live")) ?? "live";
      const rows = await readRadarDay(db, date, filter);
      const bucket = buckets.find((b) => b.date === date);
      return rowsObs({
        label: `雷达归档 ${date}`, table: "radar_finding", date, rows: rows as unknown as Record<string, unknown>[], total: bucket?.rows ?? rows.length,
        summary: (rs) => `${date} 雷达 ${filter} 归档 ${rs.length} 条（当日总行 ${bucket?.rows ?? "未记录"}、live ${bucket?.live ?? "未记录"}）：${rs.slice(0, 3).map((r) => `${r.kind}｜${r.title}`).join(" / ")}。可回看日期 ${buckets.length} 天（${buckets.slice(0, 5).map((b) => b.date).join("、")}）`,
        payload: radarPayload, data_status: "HISTORICAL", source: "radar_finding 表（只读归档）",
        emptyNote: `该日期在库里没有 ${filter} 行；有归档的日期共 ${buckets.length} 天：${buckets.slice(0, 8).map((b) => `${b.date}(${b.rows})`).join("、")}`,
      });
    }
    case "db.history-events": {
      const buckets = await eventDateBuckets(db);
      if (!buckets.length) return emptyObs("global_event 表没有任何日期：事件从未入库（未扫描），与「那天没发生事」是两回事", "global_event 表（只读）");
      const date = str(p, "date", "") || buckets[0].date;
      const rows = await readEventDay(db, date);
      return rowsObs({
        label: `事件归档 ${date}`, table: "global_event", date, rows: rows as unknown as Record<string, unknown>[], total: rows.length,
        summary: (rs) => `${date} 事件归档 ${rs.length} 条：${rs.slice(0, 3).map((r) => `${r.level}｜${r.title}`).join(" / ")}。可回看日期 ${buckets.length} 天（${buckets.slice(0, 5).map((b) => `${b.date}×${b.rows}`).join("、")}）`,
        payload: eventPayload, data_status: "HISTORICAL", source: "global_event 表（只读归档）",
        emptyNote: "该日期没有事件行（当日扫描未产出，或该行所在日期已被历史清理——清理是人工确认后才做的）",
      });
    }
    case "db.snapshot-risk":
      return snapshotObs("risk", str(p, "date", ""), ms);
    case "db.snapshot-themes":
      return snapshotObs("themes", str(p, "date", ""), ms);
    case "db.snapshot-probability":
      return snapshotObs("probability", str(p, "date", ""), ms);
    case "db.agent-run": {
      // 直接查两张表而不是复用 agent-run.ts：那个文件动态 import 本文件（避免循环依赖），这里再引回去就成环了。
      const runId = str(p, "run_id").trim();
      if (runId) {
        const [run, calls] = await Promise.all([
          db.agentRun.findUnique({ where: { runId } }),
          db.agentToolCall.findMany({ where: { runId }, orderBy: { step: "asc" }, take: 30 }),
        ]);
        if (!run) {
          return emptyObs(`找不到 run_id「${runId}」：库里没有这次运行（这不等于「跑过但没结果」——那种情况会有行并带停止原因）`, "agent_run + agent_tool_call 表");
        }
        return rowsObs({
          label: "一次 Agent 运行", table: "agent_tool_call", date: "", rows: calls as unknown as Record<string, unknown>[],
          total: calls.length, source: "agent_run + agent_tool_call 表", data_status: "REAL",
          as_of: String(run.startedAt ?? ""),
          summary: (rs) => `运行 ${runId}（问题「${clipText(run.question, 60)}」，状态 ${run.status}/${run.answerStatus || "未收尾"}，${run.steps} 步 / ${run.toolCalls} 次调用 / 台账 ${run.evidenceLines} 行 / 缺口 ${run.missingLines} 条，停止原因 ${run.stopReason || "未记录"}）：${rs.map((r) => `第 ${r.step} 步 ${r.tool}→${r.outputStatus}${r.source ? `（${clipText(r.source, 30)}）` : ""}`).join("；")}`,
          payload: (rs) => rs.map((r) => ({
            step: r.step, tool: r.tool, output_status: r.outputStatus, kind: r.kind, data_status: r.dataStatus,
            source: r.source, as_of: r.asOf, latency_ms: r.latencyMs, error: clipText(r.error, 120),
            fallback_of: r.fallbackOf, degraded_from: r.degradedFrom, attempt: r.attempt, evidence_id: r.evidenceId,
          })),
          notes: ["答案原文与判定（ACCEPTED/PARTIAL/REJECTED）在 /api/agent/run 的完整视图里；answer 属 AI_INTERPRETATION 层"],
          emptyNote: "这次运行一条调用记录都没有：要么是刚开跑还没执行任何工具，要么是这一步没被记进日志（后者属于 bug，不能读成「Agent 什么都没调」）",
        });
      }
      const [runs, total] = await Promise.all([db.agentRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 }), db.agentRun.count()]);
      return rowsObs({
        label: "Agent 运行", table: "agent_run", date: "", rows: runs as unknown as Record<string, unknown>[], total,
        source: "agent_run 表", data_status: "REAL", as_of: String(runs[0]?.startedAt ?? ""),
        summary: (rs) => `agent_run 共 ${total} 次运行，最近 ${rs.length} 次：${rs.map((r) => `${r.runId}（${r.status}/${r.answerStatus || "未收尾"}，${r.steps} 步 ${r.toolCalls} 次调用，台账 ${r.evidenceLines} 行）`).join("；")}。每次运行的问题、预算与停止原因都在库里，进程重启不丢`,
        payload: (rs) => rs.map((r) => ({
          run_id: String(r.runId ?? ""), question: clipText(r.question, 80), status: r.status,
          answer_status: r.answerStatus, steps: r.steps, tool_calls: r.toolCalls,
          evidence_lines: r.evidenceLines, missing_lines: r.missingLines, stop_reason: r.stopReason,
          started_at: String(r.startedAt ?? ""),
        })),
        emptyNote: "还没有跑过 Agent 研究循环（服务端不会自动跑：每一步都要客户端带着 AI 回复回来驱动）",
      });
    }
    case "db.task-status": {
      const [rows, total, cursors] = await Promise.all([db.taskRun.findMany({ orderBy: { startedAt: "desc" }, take: 8 }), db.taskRun.count(), db.scanCursor.count()]);
      if (!rows.length) return emptyObs("task_run 0 行：本进程还没跑过扫描。服务未启动的时间段不会有条目 —— 不能据此说「自动跑过」", "task_run + scan_cursor 表");
      return okObs({
        summary: clipText(`task_run 共 ${total} 条，最近 ${rows.length} 条：${rows.slice(0, 4).map((r) => `${r.kind} ${r.tradeDate} ${r.status}（${r.trigger}，扫 ${r.scanned}/落 ${r.results}${r.error ? `，${clipText(r.error, 60)}` : ""}）`).join("；")}；增量游标 ${cursors} 条。任务随服务端进程运行，进程没启动时不会执行`),
        payload: {
          rows_count: total, cursors,
          rows: capRows(rows.map((r) => ({ trade_date: r.tradeDate, kind: r.kind, status: r.status, trigger: r.trigger, scanned: r.scanned, results: r.results, error: clipText(r.error, 120) })), 10),
        },
        source: "task_run + scan_cursor 表", as_of: shanghaiStamp(new Date(rows[0].startedAt)), data_status: "REAL",
      });
    }
    case "db.lifecycle-preview": {
      const { plan, totalRows, expired } = await currentPlan();
      const candTables = plan.candidates.reduce<Record<string, number>>((acc, c) => { acc[c.table] = (acc[c.table] ?? 0) + c.rows; return acc; }, {});
      return okObs({
        summary: clipText(`生命周期 dry-run：保留 ${plan.retention_days} 天（由用户决定，本层不改），截止日 ${plan.cutoff}，明细行共 ${totalRows} 行；过期候选 ${plan.totals.candidate_rows} 行／${plan.totals.candidate_days} 天（${Object.entries(candTables).map(([k, v]) => `${k} ${v}`).join("、") || "本次无过期行"}），受保护 ${plan.totals.protected_rows} 行；运行态表过期 ${expired.map((e) => `${e.table} ${e.rows}`).join("、") || "无"}。这只是预览，本层不会真的清理`),
        payload: {
          retention_days: plan.retention_days, cutoff: plan.cutoff, today: plan.today, total_rows: totalRows,
          candidate_rows: plan.totals.candidate_rows, protected_rows: plan.totals.protected_rows, plan_hash: plan.plan_hash,
          run_tables_expired: expired.map((e) => ({ table: e.table, rows: e.rows })),
        },
        source: "lifecycle 计划（dry-run，与页面预览同一实现）", as_of: shanghaiStamp(), data_status: "DERIVED",
        notes: ["旧数据保留天数由用户决定；Agent 不执行清理，也不声称清理已做过"],
      });
    }
    // ---- 静态配置 / 账本 ----
    case "static.factors": {
      const cat = factorCatalog();
      const impl = cat.fields.filter((f) => f.implemented !== false);
      const verified = cat.fields.filter((f) => f.verified);
      return okObs({
        summary: clipText(`因子目录 ${cat.fields.length} 条（已实现 ${impl.length}、登记但未实现 ${cat.fields.length - impl.length}），其中账本标记 verified 的 ${verified.length} 条（例：${verified.slice(0, 5).map((f) => f.key).join("、") || "无"}）。目录是静态声明，不代表任何因子今天有效`),
        payload: {
          factors_count: cat.fields.length, implemented: impl.length, verified: verified.length,
          factors: capRows(cat.fields.slice(0, 40).map((f) => ({ factor_key: f.key, name: f.zh, category: f.category, implemented: f.implemented !== false, verified: !!f.verified })), 40),
        },
        source: "fields.ts 因子目录 + data/factor-verified.json 覆盖标记", as_of: shanghaiDate(), data_status: "REAL",
      });
    }
    case "static.verified-ledger": {
      const meta = verifiedLedgerMeta();
      if (!meta.exists) {
        return emptyObs(`data/factor-verified.json（${meta.path}）不存在：账本为空 ⇒ 所有因子按 UNVERIFIED 处理（本层不会替它判「已验证」）`, meta.path);
      }
      return okObs({
        summary: clipText(`验证账本 ${meta.path} 现有 ${meta.keys} 个信号键（共 ${FACTOR_FIELD_DEFS.length} 个已定义因子；文件日期 ${meta.mtime_ms ? dayOf(new Date(meta.mtime_ms).toISOString()) : "未记录"}）。只有正式批量 IC 流程能写这本账，AI 与 Agent 都不能改`),
        payload: { verified_keys: meta.keys, total_factors: FACTOR_FIELD_DEFS.length, ledger_path: meta.path },
        source: meta.path, as_of: meta.mtime_ms ? dayOf(new Date(meta.mtime_ms).toISOString()) : "", data_status: "REAL",
      });
    }
    case "static.registry-view": {
      const single = str(p, "name", "");
      const need = str(p, "need", "");
      if (single) {
        const cap = findCapability(single);
        if (!cap) return emptyObs(`登记表里没有名为「${single}」的能力（名字不存在，不是取数失败）：可用 name 精确匹配或 need 自然语言匹配`, "capability-core 登记表");
        return okObs({
          summary: clipText(`${cap.name}（${cap.title}）：${cap.description}｜来源 ${cap.source}｜新鲜度 ${cap.freshness}｜可用性 ${cap.availability}｜分层 ${cap.data_status}｜兜底 ${cap.fallbacks.join("→") || "无"}`),
          payload: { name: cap.name, availability: cap.availability, freshness: cap.freshness, data_status: cap.data_status, fallbacks: cap.fallbacks, limitations: cap.limitations },
          source: "capability-core 登记表", as_of: shanghaiDate(), data_status: "REAL",
        });
      }
      if (need) {
        const hits = capabilitiesForNeed(need);
        if (!hits.length) return emptyObs(`按需求「${need}」没有匹配到能力（关键词表未命中，不代表该数据不存在）：可换关键词或直接看全表`, "capability-core 登记表");
        return okObs({
          summary: clipText(`需求「${need}」匹配 ${hits.length} 条能力：${hits.slice(0, 8).map((h) => `${h.name}（${findCapability(h.name)?.title ?? "未登记标题"}）`).join("、")}`),
          payload: { need, matched: capRows(hits.map((h) => ({ name: h.name, title: findCapability(h.name)?.title ?? "", why: h.matched.join("/") })), 10) },
          source: "capability-core 登记表（need 关键词匹配）", as_of: shanghaiDate(), data_status: "REAL",
        });
      }
      const rv = registryView();
      return okObs({
        summary: clipText(`能力登记表 ${rv.counts.total} 条（只读 ${rv.counts.read_only}、写操作 ${rv.counts.mutating}、无可靠来源 ${rv.counts.not_covered}）：${rv.groups.map((g) => `${g.group} ${g.items.length}`).join("、")}。${rv.basis}`),
        payload: { counts: rv.counts, groups: rv.groups.map((g) => ({ group: g.group, items: g.items.map((i) => i.name) })), not_covered: rv.not_covered },
        source: "capability-core 登记表（静态）", as_of: shanghaiDate(), data_status: "REAL",
      });
    }
    // ---- 探测层：登记表说有什么 → 这次到底取到没有 ----
    case "probe.capabilities": {
      const r = await timed(ms, "能力探测", () => probeCapabilities({ live: flag(p, "live"), force: flag(p, "force") }));
      const res = r.value;
      if (!res) return failedObs(r.error ?? "能力探测未返回（本地库或账本读取异常）", "capability-service 探测层", { timed_out: r.timed_out });
      const only = str(p, "only", "");
      const picked = only ? res.probes.filter((x) => x.name === only || x.title.includes(only)) : res.probes;
      if (only && !picked.length) return emptyObs(`探测结果里没有「${only}」这条能力（登记表里不存在该名字，不是取数失败）`, "capability-service 探测层");
      const usable = picked.filter((x) => x.usable).length;
      const notProbed = picked.filter((x) => !x.probed).length;
      return okObs({
        summary: clipText(`能力探测（${res.probed_at}，live=${res.live}，${res.cached ? "复用 20 秒内缓存" : "本次现测"}）：${picked.length} 条里 ${usable} 条可用、${picked.length - usable - notProbed} 条不可用、${notProbed} 条未探测。${res.layering}`),
        payload: {
          probed_at: res.probed_at, live: res.live, cached: res.cached, counts: res.counts,
          probes: capRows(picked.map((x) => ({ name: x.name, probed: x.probed, kind: x.kind, usable: x.usable, status: x.status, scope: x.scope, as_of: x.as_of, reason: clipText(x.reason, 120) })), 20),
        },
        source: "capability-service 探测层（本地库/账本 + 可选上游小请求）", as_of: res.probed_at, data_status: "DERIVED",
        notes: res.live ? [] : ["本次没有打上游：行情类能力的 probed=false 表示「没测」，不是「没数据」"],
      });
    }
    default:
      return failedObs(`NOT IMPLEMENTED：登记表把 ${toolName} 派给了执行器 id「${executor}」，但本层没有对应分支（这是实现缺口，不代表该能力可用）`, "agent-tools.ts");
  }
}

export interface RunAgentToolOptions {
  /** 覆盖登记表声明的超时（联调用；默认取 tool.timeout_ms） */
  timeout_ms?: number;
}

/**
 * 执行一次工具调用（只读）。返回的一定是一个观测：
 * 未知/未开放的工具与参数不合规都在这里判掉（调用方不能绕过校验直接跑执行器）。
 * 预算、重试计数、同参数缓存不在这里做 —— 那是循环内核（admitCall / recordCall）的职责。
 */
export async function runAgentTool(name: string, rawParams: unknown, opts: RunAgentToolOptions = {}): Promise<AgentToolRun> {
  const t0 = Date.now();
  const tool = findTool(name);
  if (!tool) {
    const reason = unsupportedToolReason(name);
    return { tool: String(name ?? ""), title: "", capability: "", executor: null, params: {}, param_errors: [], obs: notCoveredObs(reason, "agent-tools-core 注册表"), latency_ms: Date.now() - t0, timeout_ms: 0 };
  }
  const timeout_ms = opts.timeout_ms ?? tool.timeout_ms;
  if (!tool.enabled) {
    return { tool: tool.name, title: tool.title, capability: tool.capability, executor: null, params: {}, param_errors: [], obs: notCoveredObs(unsupportedToolReason(tool.name), tool.source), latency_ms: Date.now() - t0, timeout_ms };
  }
  const check = validateToolParams(tool.name, rawParams);
  if (!check.ok) {
    return { tool: tool.name, title: tool.title, capability: tool.capability, executor: tool.executor, params: {}, param_errors: check.errors, obs: failedObs(`参数不合规，本次没有执行：${check.errors.join("；")}`, tool.source), latency_ms: Date.now() - t0, timeout_ms };
  }
  const p = check.value as unknown as Params;
  let obs: ToolObservation;
  try {
    obs = await dispatch(tool.executor, tool.name, p, timeout_ms);
  } catch (e) {
    obs = failedObs(`执行器 ${tool.executor} 抛出异常：${String((e as Error)?.message ?? e).slice(0, 180)}`, tool.source);
  }
  return { tool: tool.name, title: tool.title, capability: tool.capability, executor: tool.executor, params: p, param_errors: [], obs, latency_ms: Date.now() - t0, timeout_ms };
}

/** 启动自检：登记表声明的每个 executor 都必须在本层有分支（漏一条 = 「表里有、跑不了」的假能力） */
export function unimplementedExecutors(): string[] {
  const done = new Set<string>(DISPATCHED_EXECUTORS);
  return [...new Set(TOOL_DEFS.map((t) => t.executor).filter((x): x is string => !!x))].filter((id) => !done.has(id));
}
