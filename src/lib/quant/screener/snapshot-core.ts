// P5 第五阶段 每日留档的纯内核：把「一次接口响应」整理成可入库的列 + 一句人话摘要，并负责所有口径文案。
//
// 为什么要有这一层：留档行将来要和第四阶段的历史层一样被回看，
// 一旦「提取哪些列、缺数据怎么显示」散进路由和页面，就会出现两套说法。这里集中一处，node --test 可直跑。
//
// 关键约束（REAL_DATA_ONLY）：
// - 输入永远是服务端自己调用页面同源计算函数拿到的响应，不是前端传上来的数字；
// - 提取失败 ⇒ { ok:false, error }，调用方必须拒绝写库，而不是写一行空壳进去；
// - 算不出来的量保持 null / 空数组，并把它写进 missing，绝不用 0 代替。
import { parseJsonColumn } from "./history-core.ts";
import { isValidDate } from "./lifecycle-core.ts"; // 日历合法性只有一套判定：非法日期不进留档

export type SnapshotKind = "risk" | "themes" | "probability";
export const SNAPSHOT_KINDS: SnapshotKind[] = ["risk", "themes", "probability"];
export const SNAPSHOT_TEXT: Record<SnapshotKind, string> = {
  risk: "风险监控（Risk）",
  themes: "主线发现（Themes）",
  probability: "条件概率（Probability）",
};
export const SNAPSHOT_TABLE: Record<SnapshotKind, string> = {
  risk: "risk_snapshot",
  themes: "theme_snapshot",
  probability: "probability_snapshot",
};

export function parseSnapshotKind(raw: string | null | undefined): SnapshotKind | null {
  const v = String(raw ?? "").trim() as SnapshotKind;
  return SNAPSHOT_KINDS.includes(v) ? v : null;
}

export interface ExtractOk<T> { ok: true; columns: T }
export interface ExtractErr { ok: false; error: string }

function num(v: unknown, at: string): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function needNum(o: Record<string, unknown>, key: string, at: string): number | null {
  const n = num(o[key], `${at}.${key}`);
  return n;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

/** 留档的通用口径：一句话讲清「这行是怎么来的」，页面直接显示 */
export function snapshotBasis(kind: SnapshotKind): string {
  return `${SNAPSHOT_TEXT[kind]} 的留档行由服务端在点击「留档今天」那一刻重新调用页面同源的计算链路算出` +
    `（${SNAPSHOT_TABLE[kind]} 存当次完整响应），不是前端算好上传的数字，也不是事后重算的回放。` +
    `它记录的是「那一刻算出来的结果」，同日多次留档会各自成行、互不覆盖。`;
}

export function noSnapshotNote(kind: SnapshotKind): string {
  return `${SNAPSHOT_TEXT[kind]} 目前一条留档都没有：这三页在本阶段之前完全不落库（每次打开现算），` +
    `库里没有历史可回看是事实，不是查询失败。点「留档今天」会产生第一条真实计算结果。`;
}

export function emptyDaySnapshotNote(kind: SnapshotKind, date: string, totalDates: number): string {
  return `${SNAPSHOT_TEXT[kind]} 在 ${date} 没有留档行` +
    (totalDates ? `（库里已有 ${totalDates} 个留档日，见 available_dates）` : "（库里还没有任何留档日）") +
    `。留档只在点击「留档今天」时发生，没留过的那天不会自动补出来，查询也不会拿别的日子顶上。`;
}

// ---------- Risk ----------

export interface RiskColumns {
  tradeDate: string; level: string; total: number; advancers: number; decliners: number;
  limitUp: number; limitDown: number; breakRate: number | null; mainNetYi: number; medianPct: number;
  live: boolean; missing: string[]; source: string;
}

export function riskColumnsFrom(payload: unknown, computedAt: string): ExtractOk<RiskColumns> | ExtractErr {
  const p = payload as Record<string, unknown> | null;
  if (!p || p.ok !== true) return { ok: false, error: `风险接口本次没返回成功结果（ok≠true）：${str(p?.error) || "无错误信息"}；未留档` };
  const tradeDate = str(p.trade_date);
  if (!isValidDate(tradeDate)) return { ok: false, error: `风险响应里的 trade_date「${tradeDate || "空"}」不是 YYYY-MM-DD 合法日历日：无法确定留档日期，未留档` };
  const risk = (p.risk ?? {}) as Record<string, unknown>;
  const level = str(risk.level);
  if (!level) return { ok: false, error: "风险响应缺少 risk.level：没有等级就不算一次可用留档，未留档" };
  const src = (p.source ?? {}) as Record<string, unknown>;
  const breakRate = num(p.break_rate, "break_rate");
  return {
    ok: true,
    columns: {
      tradeDate, level,
      total: needNum(p, "total", "risk") ?? 0,
      advancers: needNum(p, "advancers", "risk") ?? 0,
      decliners: needNum(p, "decliners", "risk") ?? 0,
      limitUp: needNum(p, "limit_up", "risk") ?? 0,
      limitDown: needNum(p, "limit_down", "risk") ?? 0,
      breakRate, // null = 当日触板为 0，算不出比率（不以 0 代替）
      mainNetYi: needNum(p, "main_net_sum_yi", "risk") ?? 0,
      medianPct: needNum(p, "median_pct", "risk") ?? 0,
      live: p.live === true,
      missing: arr(p.missing),
      source: [str(src.provider), str(src.universe_endpoint), str(src.indices_endpoint)].filter(Boolean).join(" · ")
        + ` · 留档时刻 ${computedAt}`,
    },
  };
}

function pct(v: number | null, digits = 1): string {
  return v === null ? "—" : `${v.toFixed(digits)}%`;
}

export function riskHeadline(payload: unknown, computedAt: string): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const risk = (p.risk ?? {}) as Record<string, unknown>;
  const triggers = arr(risk.triggers);
  const breakRate = num(p.break_rate, "break_rate");
  const hist = p.history_ref as Record<string, unknown> | null;
  return [
    `风险等级 ${str(risk.level) || "未知"}`,
    `涨 ${num(p.advancers, "a") ?? 0} / 跌 ${num(p.decliners, "d") ?? 0} / 平 ${num(p.flat, "f") ?? 0}（参与统计 ${num(p.total, "t") ?? 0} 只）`,
    `涨停 ${num(p.limit_up, "lu") ?? 0} · 跌停 ${num(p.limit_down, "ld") ?? 0} · 触板 ${num(p.touched_limit, "tp") ?? 0} · 炸板率 ${breakRate === null ? "算不出（当日触板 0）" : pct(breakRate, 0)}`,
    `主力净流 ${str((num(p.main_net_sum_yi, "m") ?? 0).toFixed(1))} 亿 · 中位涨跌幅 ${pct(num(p.median_pct, "md"), 2)}`,
    `计算时${p.live === true ? "处于交易时段（盘中值）" : "非交易时段（收盘/休市值）"} · 时刻 ${computedAt}`,
    triggers.length ? `触发：${triggers.join("；")}` : "无触发项",
    hist && Object.keys(hist).length ? "含相似历史日参考统计" : "相似历史日参考：本次未取到",
  ].join(" · ");
}

// ---------- Themes ----------

export interface ThemeColumns {
  tradeDate: string; mainCount: number; subCount: number; rotationCount: number; watchCount: number;
  topMain: unknown[]; missing: string[]; source: string;
}

export function themeColumnsFrom(payload: unknown, computedAt: string): ExtractOk<ThemeColumns> | ExtractErr {
  const p = payload as Record<string, unknown> | null;
  if (!p || p.ok !== true) return { ok: false, error: `主线接口本次没返回成功结果（ok≠true）：${str(p?.error) || "无错误信息"}；未留档` };
  const tradeDate = str(p.trade_date);
  if (!isValidDate(tradeDate)) return { ok: false, error: `主线响应里的 trade_date「${tradeDate || "空"}」不是 YYYY-MM-DD 合法日历日：无法确定留档日期，未留档` };
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const main = list(p.main);
  const src = (p.source ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    columns: {
      tradeDate,
      mainCount: main.length,
      subCount: list(p.sub).length,
      rotationCount: list(p.rotation).length,
      watchCount: list(p.watch).length,
      topMain: main.slice(0, 6).map((m) => {
        const r = (m ?? {}) as Record<string, unknown>;
        return { name: str(r.name), score: num(r.score, "score"), changePct: num(r.changePct, "changePct"), mainYi: num(r.mainYi, "mainYi") };
      }),
      missing: arr(p.missing),
      source: [str(src.provider), str(src.note)].filter(Boolean).join(" · ") + ` · 留档时刻 ${computedAt}`,
    },
  };
}

export function themeHeadline(payload: unknown, computedAt: string): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const names = list(p.main).map((m) => {
    const r = (m ?? {}) as Record<string, unknown>;
    const s = num(r.score, "s");
    return `${str(r.name) || "无名"}${s === null ? "" : `(${s.toFixed(0)})`}`;
  });
  return [
    `主线 ${list(p.main).length} / 次主线 ${list(p.sub).length} / 轮动 ${list(p.rotation).length} / 观察 ${list(p.watch).length}`,
    names.length ? `主线：${names.join("、")}` : "本次未产出主线（评分未达阈值或板块数据不足）",
    `时刻 ${computedAt}`,
  ].join(" · ");
}

// ---------- Probability ----------

export interface ProbabilityRequest {
  conditions: Record<string, unknown>[];
  universe?: string;
  symbols?: string[];
  lookback?: number;
  trade_date?: string;
}

/** 只放行页面真正需要的字段进服务端；多余键一律丢掉，不给「借留档接口跑任意参数」留口子 */
export function sanitizeProbabilityRequest(body: unknown): ProbabilityRequest | string {
  const b = body as Record<string, unknown> | null;
  if (!b || !Array.isArray(b.conditions) || !b.conditions.length) {
    return "留档概率结果必须带上当次的筛选条件：没有条件的胜率数字无法复现也无法解释，本次不留档";
  }
  const conditions = b.conditions.slice(0, 12).map((c) => {
    const r = (c ?? {}) as Record<string, unknown>;
    // value 原样保留（数字就是数字、字符串就是字符串）：in / not in 这类操作的值是 "688,30" 这样的字符串，
    // 顺手 Number() 一下会改变条件语义，留档存的必须是这次真正参与计算的那组条件本身。
    const value = typeof r.value === "number" || typeof r.value === "string" ? r.value : String(r.value ?? "");
    return {
      field: str(r.field), op: str(r.op), value,
      ...(r.type ? { type: str(r.type) } : {}),
      ...(r.window ? { window: num(r.window, "w") } : {}),
      ...(r.min_match_days ? { min_match_days: num(r.min_match_days, "mmd") } : {}),
    };
  });
  const universe = str(b.universe) === "custom" ? "custom" : "index";
  const symbols = Array.isArray(b.symbols) ? b.symbols.map((s) => str(s).trim().toUpperCase()).filter(Boolean).slice(0, 12) : [];
  const lookbackRaw = num(b.lookback, "lookback");
  return {
    conditions,
    universe,
    ...(symbols.length ? { symbols } : {}),
    lookback: lookbackRaw === null ? 520 : Math.min(800, Math.max(120, Math.round(lookbackRaw))),
    ...(isValidDate(str(b.trade_date)) ? { trade_date: str(b.trade_date) } : {}),
  };
}

export interface ProbabilityColumns {
  tradeDate: string; tradeDateIsHistorical: boolean; scope: string; conditions: unknown[];
  universe: string; lookback: number; pooled: unknown[]; sampleOk: boolean; benchmark: string; missing: string[]; source: string;
}

export function probabilityColumnsFrom(payload: unknown, req: ProbabilityRequest, computedAt: string): ExtractOk<ProbabilityColumns> | ExtractErr {
  const p = payload as Record<string, unknown> | null;
  if (!p || p.ok !== true) return { ok: false, error: `概率计算本次没返回成功结果（ok≠true）：${str(p?.error) || "无错误信息"}；未留档` };
  const tradeDate = str(p.as_of_trade_date);
  if (!isValidDate(tradeDate)) return { ok: false, error: `概率响应里的 as_of_trade_date「${tradeDate || "空"}」不是 YYYY-MM-DD 合法日历日：无法确定留档日期，未留档` };
  const lookback = num(p.lookback, "lookback") ?? req.lookback ?? 520;
  const bench = (p.benchmark ?? {}) as Record<string, unknown>;
  const per = Array.isArray(p.per_symbol) ? p.per_symbol : [];
  const pooled = Array.isArray(p.pooled) ? p.pooled : [];
  const universe = str(p.universe) || req.universe || "index";
  return {
    ok: true,
    columns: {
      tradeDate,
      tradeDateIsHistorical: p.trade_date_is_historical === true,
      scope: `${universe === "custom" ? `自定义池 ${(req.symbols ?? []).length || per.length} 只` : "指数池"} · 回看 ${lookback} 根K线 · 条件 ${req.conditions.length} 条`,
      conditions: req.conditions,
      universe,
      lookback,
      pooled,
      sampleOk: p.sample_ok === true,
      benchmark: `${str(bench.name) || "—"}（${str(bench.symbol) || "—"}）K线 ${num(bench.bars, "bars") ?? 0} 根`,
      missing: arr(p.warnings),
      source: `服务端同源计算 /api/quant/probability · 留档时刻 ${computedAt}`,
    },
  };
}

export function probabilityHeadline(payload: unknown, computedAt: string): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const pooled = Array.isArray(p.pooled) ? p.pooled : [];
  const parts = pooled.map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const wr = num(r.win_rate, "win_rate");
    const avg = num(r.avg_return, "avg_return");
    return `${num(r.h, "h") ?? "?"}日 ${wr === null ? "无样本" : pct(wr)}（n=${num(r.sample_size, "n") ?? 0}${avg === null ? "" : `，均值 ${avg.toFixed(2)}%`}）`;
  });
  return [
    `基准日 ${str(p.as_of_trade_date) || "未知"}${p.trade_date_is_historical === true ? "（历史回放，非当日）" : ""}`,
    parts.join(" / ") || "各期限都没有命中样本",
    p.sample_ok === true ? "样本量达标（≥30）" : "样本量不足 30：只作统计提示，不构成可依赖的胜率",
    `时刻 ${computedAt}`,
  ].join(" · ");
}

/** 三种留档共用的回看条目整形：payload 原样带回，摘要由服务端算好 */
export interface SnapshotItem {
  id: string;
  kind: SnapshotKind;
  trade_date: string;
  computed_at: string;
  headline: string;
  missing: string[];
  source: string;
  payload: unknown;
  payload_broken: boolean;
}

export function snapshotItem(kind: SnapshotKind, row: Record<string, unknown>): SnapshotItem {
  const payloadCol = parseJsonColumn<Record<string, unknown>>(str(row.payload), {});
  const computedAt = str(row.computedAt);
  const headline = kind === "risk" ? riskHeadline(payloadCol.value, computedAt)
    : kind === "themes" ? themeHeadline(payloadCol.value, computedAt)
      : probabilityHeadline(payloadCol.value, computedAt);
  const missingCol = parseJsonColumn<string[]>(str(row.missing), []);
  return {
    id: str(row.id),
    kind,
    trade_date: str(row.tradeDate),
    computed_at: computedAt,
    headline,
    missing: missingCol.value.map((m) => String(m)),
    source: str(row.source),
    payload: payloadCol.value,
    payload_broken: payloadCol.broken,
  };
}

/** 按留档日分组计数（供日期入口显示「有 N 个留档日」），纯函数，便于单测 */
export function snapshotDateBuckets(rows: { tradeDate: string }[]): { date: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.tradeDate, (m.get(r.tradeDate) ?? 0) + 1);
  return [...m.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => (a.date < b.date ? 1 : -1));
}
