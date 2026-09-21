// P7-④ 决策服务层（P7-⑦ v3 起为唯一的决策取数入口）：把真实读数取回来 → 交纯接线内核映射 → 调 buildDecision。
//
// 三条硬边界：
// 1) **只读**。不写库、不触发扫描、不调模型。事件面读的是 P6-B **已落库**的 event_interpretation：
//    没有人点过「AI 理解今日事件」时它就是空的，本层不会为了把结论凑完整而现场生成一份解释。
// 2) **判断放在可测的那一层**。每个「把上游补出来的 0 还原成缺失」的决定都写在 decision-wiring-core.ts 里，
//    由 tests/quant/p7-wiring.test.ts 钉住；本文件只负责取数、拼装与如实登记取数过程。
// 3) **同源只取一次**：一次决策只调一次 computeSentiment、一次 discoverThemes、一次批量 fetchBarsHybridTracked
//    （标的与基准指数在同一批里），沿用 §三十二「四组读数共用一份快照」的既有口径。
//
// 取数来源（逐条对应页面上的来源标签，不写本项目没有的源）：
//   - 日K（标的 + 基准指数）：eltdx 网关优先、腾讯日K兜底（data/hybrid.ts，逐只观测结论见 hybrid-core.ts）；
//   - 市场广度/涨跌停/炸板率/主力净额/成交额/风险等级/指数：screener/sentiment.ts（东财全A快照 + 腾讯指数）；
//   - 放量/缩量的历史均值基线：risk_snapshot 表（P5 起的每日 /api/market/risk 响应留档，只读）；
//   - 板块主线（含榜首 RPS 与口径原文）：screener/themes.ts（东财板块榜 + 成分扩散）；
//   - 事件解释：event_interpretation 表（AI_INTERPRETATION 层，不是事实本身）。
import { db } from "@/lib/db";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
// P8-①（风险点 2）：「日K日期没对上决策参考日」的判定收编进 freshness-core.dateMismatch，
// 与对话链路的新鲜度核对共用同一份规则——原来这里是裸字符串 !== 比对，两处各写一套迟早漂移。
import { dateMismatch } from "@/lib/desk/freshness-core";
import { getProvider } from "@/lib/quant/data/index";
import { fetchBarsHybridTracked } from "@/lib/quant/data/hybrid";
import type { BarsLike } from "@/lib/quant/factors/fields.ts";
import { buildDecision, decisionToText, type Horizon } from "./decision-core";
import {
  BASE_INDEX, INDEX_MA_WINDOW_DEFAULT, PRIMARY_HORIZON_DEFAULT, WIRING_VERSION,
  eventsFromInterpretations, interpretationWireFromRow,
  marketFromWiring, probabilityFromSimilarEnv, technicalFromBars, themesWire, windowStart,
  type DecisionSourceBadge, type DecisionView, type InterpretationWire, type SentimentWire, type ThemesWire, type TurnoverDayWire,
} from "./decision-wiring-core";
import { eventExternal, EVENT_STALE_AFTER_DAYS_DEFAULT } from "./event-score-core";
import { marketExternal } from "./market-score-core";
import { similarReturnForward } from "./similar-env";
import { computeSentiment, type SentimentResult } from "./sentiment";
import { discoverThemes } from "./themes";

/** 响应契约（DecisionView / DecisionSourceBadge）定义在纯接线内核里，页面封装与服务层共用同一份定义 */
export type { DecisionSourceBadge, DecisionView };

/** 日K回溯根数：MA20 要 20 根、MACD 的 EMA 要长序列才收敛，与 /api/stock/profile 同口径取 480 */
export const DECISION_BAR_LOOKBACK = 480;
/** 单次读取的事件解释行上限：事件面按归一化倾向计分，多读不会加分，所以宁可封顶并如实登记 */
export const DECISION_EVENT_LIMIT = 200;
/** 相似环境引擎自己的最低门槛（similar-env.ts：不足 40 根直接返回空统计） */
const SIMILAR_ENV_MIN_BARS = 40;

/** 上游报错原文可能很长，进 missing 前裁一下（不改写内容，只截断） */
function clip(s: string, n = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
const errText = (e: unknown) => clip(String((e as Error)?.message ?? e ?? "未知错误"));

/**
 * SentimentResult → SentimentWire。本层唯一一处「按上游写法解释上游字段」的地方：
 * 主力净额的家数登记（main_net_known）就是为 sentiment 里那句 `mainNetSum += m.mainNet ?? 0` 准备的，
 * 旧版本没有这个字段时按「未确认口径」传 null，让打分表把它记成缺失而不是 0 亿。
 * 成交额（amount_*）同理：上游那句 `amountSum += m.amount ?? 0` 也需要一个家数才能被解释成读数。
 */
export function sentimentWireOf(s: SentimentResult): SentimentWire {
  const box = s as unknown as { main_net_known?: number | null; amount_known?: number | null };
  const known = box.main_net_known;
  const amtKnown = box.amount_known;
  return {
    trade_date: s.trade_date,
    live: s.live,
    total: s.total,
    advancers: s.advancers,
    decliners: s.decliners,
    limit_up: s.limit_up,
    limit_down: s.limit_down,
    break_rate: s.break_rate,
    main_net_sum_yi: s.main_net_sum_yi,
    main_net_known: typeof known === "number" ? known : null,
    amount_total_yi: Number.isFinite(s.amount_total_yi) ? s.amount_total_yi : null,
    amount_known: typeof amtKnown === "number" ? amtKnown : null,
    median_pct: s.median_pct,
    indices: s.indices.map((i) => ({ symbol: i.symbol, changePct: Number.isFinite(i.changePct) ? i.changePct : null })),
    risk_level: s.risk.level,
  };
}

/** ThemeDiscovery.main → 榜首读数（强度取真实最大值；RPS 取榜首那条自己的，口径带 themes 自报的那句） */
export function themesWireOf(
  main: { score?: number; rps?: number }[] | null | undefined,
  rpsScope?: string | null,
): ThemesWire | null {
  if (!main) return null;
  return themesWire(main.map((m) => ({ score: typeof m?.score === "number" ? m.score : NaN, rps: typeof m?.rps === "number" ? m.rps : undefined })), rpsScope ?? null);
}

/**
 * 成交额基线的数据源：本项目自己的 risk_snapshot 留档（P5 起的每日 /api/market/risk 响应存档）。
 * 为什么不是别处：全 A 成交额是「逐只快照累加」的口径，只有这份留档与今日读数同源；
 * 指数日K（腾讯/通达信）没有成交额列，拿它当基线等于换口径。留档不够 ⇒ 交 null，由接线层登记。
 */
const TURNOVER_ARCHIVE_ROWS = 40;

export async function readTurnoverArchive(): Promise<TurnoverDayWire[]> {
  const rows = await db.riskSnapshot.findMany({
    orderBy: [{ computedAt: "desc" }, { id: "desc" }],
    take: TURNOVER_ARCHIVE_ROWS,
    select: { tradeDate: true, payload: true },
  });
  // 同一 tradeDate 可能有多次留档（同日多次真实计算）：按留档倒序取，每个交易日只认最近那一次
  const byDate = new Map<string, TurnoverDayWire>();
  for (const r of rows) {
    let o: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(String(r.payload ?? "")) as unknown;
      o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      o = null;
    }
    const ak = o?.amount_known;
    const at = o?.amount_total_yi;
    const wire: TurnoverDayWire = {
      trade_date: typeof r.tradeDate === "string" ? r.tradeDate.slice(0, 10) : null,
      amount_total_yi: typeof at === "number" && Number.isFinite(at) ? at : null,
      // 旧留档没有这一格：null 表示「口径未确认」，接线层不会拿它进基线（不是 0 家）
      amount_known: typeof ak === "number" && Number.isFinite(ak) ? ak : null,
    };
    const key = wire.trade_date ?? `__no_date_${byDate.size}`;
    if (!byDate.has(key)) byDate.set(key, wire);
  }
  return [...byDate.values()].sort((a, b) => ((a.trade_date ?? "") < (b.trade_date ?? "") ? 1 : -1));
}

/**
 * 出一个标的的四维决策。任何一路取数失败都不让整条结论消失：那一维会带着「为什么没算进来」进 missing，
 * 页面与 AI 上下文看到的仍是同一份 buildDecision 结果（缺的那一维权重由内核从分母里拿掉）。
 */
export async function buildDecisionForSymbol(
  symbolRaw: string,
  opts: { stale_after_days?: number; rsi_period?: number; horizon?: Horizon } = {},
): Promise<DecisionView> {
  const subject = String(symbolRaw ?? "").trim().toUpperCase();
  const tradeDate = shanghaiDate();
  const asOf = shanghaiStamp();
  const staleAfter = opts.stale_after_days ?? EVENT_STALE_AFTER_DAYS_DEFAULT;
  const notes: string[] = [];
  const sources: DecisionSourceBadge[] = [];

  if (!/^[0-9]{6}\.(SH|SZ|BJ)$/.test(subject)) {
    throw new Error(`标的代码格式不接受：「${clip(subject, 24) || "空"}」。需要 6 位代码 + 交易所后缀（如 600519.SH）——本层不猜它属于哪个市场`);
  }

  // ---- 1) 日K：标的与基准指数同批取（eltdx 优先、腾讯兜底、连续失败熔断） ----
  const wanted = [subject, BASE_INDEX.symbol].filter((s, i, a) => a.indexOf(s) === i);
  const barsBySymbol = new Map<string, BarsLike[]>();
  try {
    const r = await fetchBarsHybridTracked(wanted, tradeDate, DECISION_BAR_LOOKBACK);
    for (const sym of wanted) {
      const list = r.bars.get(sym) ?? [];
      barsBySymbol.set(sym, list);
      const o = r.outcomes.find((x) => x.symbol === sym) ?? null;
      const label = sym === subject ? `日K（标的 ${sym}）` : `日K（${BASE_INDEX.label} ${sym}）`;
      sources.push({
        id: `bars:${sym}`, label,
        detail: o
          ? `${o.channel === "tdx" ? "eltdx 网关" : o.channel === "tencent" ? "腾讯日K（兜底通道）" : "无可用通道"}｜${list.length} 根${o.reason ? `｜${clip(o.reason, 70)}` : ""}`
          : "取数层未给逐只观测结论",
        used: list.length > 0,
        as_of: list.length ? String(list[list.length - 1].date).slice(0, 10) : null,
      });
      if (!o) notes.push(`${label}：取数层没有返回逐只观测结论，无法确认这 ${list.length} 根是真读数还是空数组 —— 按未确认处理`);
      else if (o.kind !== "value") notes.push(`${label} 本次不是可用读数（${clip(o.reason || o.kind, 70)}）：相关分项按缺失处理，不把空数组当成「这只票没有行情」`);
      else if (o.degraded && list.length) notes.push(`${label} 走的是兜底通道（${o.channel === "tencent" ? "腾讯日K" : String(o.channel)}）：与主通道口径可能有差，这一维按降级看`);
    }
  } catch (e) {
    for (const sym of wanted) {
      sources.push({ id: `bars:${sym}`, label: `日K（${sym}）`, detail: `批量取数抛错：${errText(e)}`, used: false, as_of: null });
    }
    notes.push(`日K批量取数失败（${errText(e)}）：技术结构与相似环境概率两维按缺失处理`);
  }

  // ---- 2) 标的名称：只用于事件相关性的名称匹配（取不到不猜，E-SUBJECT 走「无判定」） ----
  let subjectName: string | null = null;
  try {
    const provider = await getProvider("em");
    const meta = (await provider.listUniverse({ kind: "custom", symbols: [subject] }, tradeDate).catch(() => []))[0];
    subjectName = meta?.name?.trim() ? meta.name.trim() : null;
    sources.push({
      id: "universe", label: "全A快照（标的属性）",
      detail: meta ? `东财 clist：${meta.name || "名称缺失"}${meta.industry ? `／${meta.industry}` : ""}` : "当日快照里没有这只票（代码不存在或快照未覆盖）",
      used: !!meta, as_of: tradeDate,
    });
    if (!meta) notes.push(`${subject} 不在当日全A快照里：本层不猜它的名称，事件相关性只能按代码匹配`);
  } catch (e) {
    sources.push({ id: "universe", label: "全A快照（标的属性）", detail: `取数抛错：${errText(e)}`, used: false, as_of: null });
    notes.push(`全A快照读取失败（${errText(e)}）：标的名称不可得，事件面的名称匹配按「无判定」处理`);
  }

  // ---- 3) 市场面：computeSentiment + discoverThemes（各一次，同源不重复打） ----
  let sentWire: SentimentWire | null = null;
  try {
    const s = await computeSentiment();
    sentWire = sentimentWireOf(s);
    sources.push({
      id: "sentiment", label: "市场广度/涨跌停/炸板率/主力净额/风险等级",
      detail: `${s.source.provider}｜参与统计 ${s.total} 家｜${s.live ? "盘中实时（收盘前会变）" : "收盘/休市值"}`,
      used: true, as_of: s.as_of,
    });
    if (s.missing.length) notes.push(`市场情绪引擎自报缺口：${s.missing.slice(0, 3).map((m) => clip(m, 60)).join("；")}`);
  } catch (e) {
    sources.push({ id: "sentiment", label: "市场广度/涨跌停/炸板率/主力净额/风险等级", detail: `取数抛错：${errText(e)}`, used: false, as_of: null });
    notes.push(`市场情绪快照读取失败（${errText(e)}）：市场环境这一维按缺失处理，不按 0 分参与加权`);
  }
  let themesArg: ThemesWire | null = null;
  try {
    const t = await discoverThemes();
    // RPS 口径原文就写在 themes 自报的 missing 里（"RPS=行业+概念合并榜内涨幅百分位（非全市场）"）：
    // 换一个地方再抄一遍这句话迟早和上游漂移，所以直接从读数里取，取不到时由打分表登记「口径未声明」。
    const rpsLine = t.missing.find((m) => m.startsWith("RPS=")) ?? null;
    themesArg = themesWireOf(t.main, rpsLine);
    sources.push({
      id: "themes", label: "板块主线强度",
      detail: `${t.source.provider}｜主线 ${t.main.length} 个${t.missing.length ? `｜上游自报口径 ${t.missing.length} 条` : ""}`,
      used: true, as_of: t.as_of,
    });
    if (t.missing.length) notes.push(`主线引擎自报口径：${t.missing.slice(0, 2).map((m) => clip(m, 60)).join("；")}`);
  } catch (e) {
    sources.push({ id: "themes", label: "板块主线强度", detail: `取数抛错：${errText(e)}`, used: false, as_of: null });
    notes.push(`板块主线读取失败（${errText(e)}）：M-THEME 按缺失处理 —— 本层不会把「没读到」写成「当日未判出主线」，那是两个不同的事实`);
  }

  // ---- 3b) 成交额基线：risk_snapshot 留档（M-TURNOVER 的均值只能来自这里，见 readTurnoverArchive 注释） ----
  let priorTurnover: TurnoverDayWire[] | null = null;
  try {
    priorTurnover = await readTurnoverArchive();
    const confirmed = priorTurnover.filter((d) => typeof d.amount_known === "number" && d.amount_known > 0).length;
    sources.push({
      id: "turnover-archive", label: "全 A 成交额留档（放量/缩量的基线）",
      detail: `risk_snapshot 表（只读）｜不同交易日 ${priorTurnover.length} 天，其中成交额口径可确认 ${confirmed} 天`,
      used: priorTurnover.length > 0,
      as_of: priorTurnover[0]?.trade_date ?? null,
    });
  } catch (e) {
    sources.push({ id: "turnover-archive", label: "全 A 成交额留档（放量/缩量的基线）", detail: `查询抛错：${errText(e)}`, used: false, as_of: null });
    notes.push(`成交额留档读取失败（${errText(e)}）：M-TURNOVER 按缺失处理，本层不拿别处的成交额凑基线`);
  }

  const market = marketFromWiring(sentWire, themesArg, {
    index_bars: (barsBySymbol.get(BASE_INDEX.symbol) ?? []).map((b) => ({ date: String(b.date), c: b.c })),
    index_ma_window: INDEX_MA_WINDOW_DEFAULT,
    prior_turnover: priorTurnover,
    exclude_trade_date: tradeDate,
  });
  notes.push(...market.notes);

  // ---- 4) 概率面：相似环境（口径序列＝基准指数，本层显式声明，不留给读者猜） ----
  const indexBars = (barsBySymbol.get(BASE_INDEX.symbol) ?? [])
    .map((b) => ({ date: String(b.date).slice(0, 10), c: b.c }))
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && Number.isFinite(b.c) && b.c > 0);
  const sim = indexBars.length >= SIMILAR_ENV_MIN_BARS ? similarReturnForward(indexBars) : null;
  if (!sim) notes.push(`${BASE_INDEX.label}的可用日K不足 ${SIMILAR_ENV_MIN_BARS} 根（本次 ${indexBars.length} 根）：相似环境无法计算，概率面按缺失处理`);
  const prob = probabilityFromSimilarEnv(sim, {
    trade_date: indexBars.length ? indexBars[indexBars.length - 1].date : null,
    primary_horizon: opts.horizon ?? PRIMARY_HORIZON_DEFAULT,
  });
  notes.push(...prob.notes);
  sources.push({
    id: "similar-env", label: "历史概率（相似环境统计）",
    detail: sim
      ? `${BASE_INDEX.label} ${BASE_INDEX.symbol}｜打分周期 ${prob.input?.primary_horizon ?? "未声明"} 日｜涨跌幅带宽 ${sim.band}pp｜样本 ${sim.sample_size}（sample_ok=${sim.sample_ok}）｜样本区间 ${sim.period ? `${sim.period.start}→${sim.period.end}` : "未给出"}`
      : "本次无统计结果",
    used: !!sim,
    as_of: prob.input?.readings[0]?.trade_date ?? null,
  });

  // ---- 5) 事件面：event_interpretation 只读，窗口 = 新鲜度窗口 ----
  const eventEnd = tradeDate;
  const eventStart = windowStart(eventEnd, staleAfter);
  let eventRows: InterpretationWire[] | null = null;
  let payloadBroken = 0;
  try {
    const rows = await db.eventInterpretation.findMany({
      where: { asOf: { gte: eventStart, lte: eventEnd } },
      // 多字段排序**必须写成数组**：`orderBy: { asOf: "desc", publishedAt: "desc" }` 会被 Prisma 判成
      // 「一个对象里给了两个字段」直接抛错（实测：Argument `orderBy`: Invalid value provided. Expected …[]）。
      // 这里之所以专门留一句：该错误会被下面的 catch 吞成「事件面读取失败」，症状和「库里没解读」很像，
      // 但真实原因是查询压根没跑成 —— 冒烟时就是靠逐路来源的 detail 原文才看出来的。
      orderBy: [{ asOf: "desc" }, { publishedAt: "desc" }],
      take: DECISION_EVENT_LIMIT,
    });
    const wired = rows.map((r) => interpretationWireFromRow({
      eventKey: r.eventKey, asOf: r.asOf, title: r.title, status: r.status, payload: r.payload,
    }));
    payloadBroken = wired.filter((w) => w.broken !== null).length;
    eventRows = wired.map((w) => w.wire).filter((w): w is InterpretationWire => w !== null);
    if (payloadBroken) notes.push(`${payloadBroken} 行 event_interpretation 的 payload 解析不出对象：按缺失剔除，不猜它当时说了什么`);
    if (rows.length >= DECISION_EVENT_LIMIT) notes.push(`窗口内解读行数已达单次上限 ${DECISION_EVENT_LIMIT}（只取窗口内最近的这些）：事件面按归一化倾向计分，条数不进分数`);
    sources.push({
      id: "events", label: "AI 事件解释",
      detail: `event_interpretation 表（只读，${eventStart}→${eventEnd}）｜取到 ${eventRows.length} 行${payloadBroken ? `，另 ${payloadBroken} 行 payload 不可解析` : ""}`,
      used: eventRows.length > 0,
      as_of: eventRows.length ? eventRows[0].trade_date : null,
    });
  } catch (e) {
    sources.push({ id: "events", label: "AI 事件解释", detail: `查询抛错：${errText(e)}`, used: false, as_of: null });
    notes.push(`事件解释表读取失败（${errText(e)}）：事件面按缺失处理，不当成「今天没有消息」`);
  }
  const events = eventsFromInterpretations(eventRows, {
    ref_date: eventEnd,
    subject,
    subject_tokens: [subject, subject.split(".")[0], subjectName ?? ""].filter(Boolean),
    stale_after_days: staleAfter,
  });
  notes.push(...events.notes);

  // ---- 6) 汇总：技术 / 概率 / 市场 / 事件 → buildDecision ----
  const tech = technicalFromBars(barsBySymbol.get(subject) ?? [], { rsi_period: opts.rsi_period });
  notes.push(...tech.notes);
  // 与 P8-① 同源的单处规则：dateMismatch 语义与原裸比对一致（不同即提醒），差别只在带时区标记的串
  // 先折算北京日历日再比、认不出的串不误报。
  if (dateMismatch(tech.bar_date, tradeDate)) {
    notes.push(`技术面取的是 ${tech.bar_date} 那根日K，而决策参考日是 ${tradeDate}：休市或数据滞后时的正常情形，但这一维说的不是 ${tradeDate} 当天的结构`);
  }
  const decision = buildDecision({
    technical: tech.input,
    probability: prob.input ?? [],
    external: [marketExternal(market.input), eventExternal(events.input)],
    subject,
  });
  return {
    ok: true,
    subject,
    subject_name: subjectName,
    as_of: asOf,
    trade_date: tradeDate,
    decision,
    text: decisionToText(decision),
    wiring: {
      wiring_version: WIRING_VERSION,
      base_index: { symbol: BASE_INDEX.symbol, label: BASE_INDEX.label },
      technical_bar_date: tech.bar_date,
      technical_bars: tech.bars_used,
      rsi_period: tech.input.rsi_period ?? 14,
      volume_window: tech.input.volume_window ?? null,
      prior_high_window: tech.input.prior_high_window ?? null,
      probability_scope: prob.notes[0] ?? "",
      probability_horizon: prob.input?.primary_horizon ?? null,
      event_window: {
        start: eventStart, end: eventEnd,
        rows: eventRows?.length ?? 0, payload_broken: payloadBroken,
        stale_after_days: staleAfter,
      },
      turnover_baseline_days: market.input.turnover?.window ?? null,
      notes,
    },
    sources,
  };
}
