// P7-⑧④ 回测接入对话链路的判定口径（纯内核：不 fetch、不碰库、不碰时钟，node --test 可直跑）。
//
// 为什么单独一层：对话接回测的风险不在「能不能跑」，而在三件事被混起来——
//  1) 模型自由拼因子（跑出一个没人验过的表达式，还把收益报出来）；
//  2) 区间不够硬跑（80 日的样本被说成「长期回测」）；
//  3) 单位与哨兵值读错（winRate 0.53 报成「0.53%」，payoffRatio 的 99 报成「盈亏比 99」）。
// 这三条都是判断，不是取数。放在内核里才能钉住，服务层（chat-tools）只负责按这里的结论执行。
//
// 与任务书的对应（文案按任务书原文，不自创措辞）：
//  - 白名单：因子必须来自数据库里「已入库且 expression 非空」的 factorKey，选不中直接拒绝；
//  - 区间：不足 240 个交易日直接返回「回测区间太短」，不强行计算；
//  - 轮询：固定 1 秒一次、最多 60 秒，超时返回「回测超时，请稍后在策略历史查看结果」；
//  - 护栏：模型说了「回测」但这一轮没真跑成，界面必须标出来，不能让推测冒充计算结果。
import { MISSING_TEXT } from "./context-panel-core.ts";

/** 任务书口径：回测区间下限（交易日）。低于这个数不出结果，只出「回测区间太短」 */
export const BACKTEST_MIN_TRADING_DAYS = 240;
/** 任务书口径：轮询节拍固定 1 秒 */
export const BACKTEST_POLL_INTERVAL_MS = 1000;
/** 任务书口径：最多等 60 秒 */
export const BACKTEST_POLL_TIMEOUT_MS = 60_000;

/** 白名单校验不通过的原文（任务书指定文案，一字不改） */
export const TEXT_NOT_IN_WHITELIST = "当前因子不在可回测白名单，无法执行回测";
/** 区间不足的原文（任务书指定文案） */
export const TEXT_RANGE_TOO_SHORT = "回测区间太短";
/** 等待超时的原文（任务书指定文案）：注意任务还在跑，所以话术是「稍后在策略历史查看」 */
export const TEXT_POLL_TIMEOUT = "回测超时，请稍后在策略历史查看结果";

/** evaluation.computeMetrics 在「有盈利样本、无亏损样本」时给的哨兵值，不是真实比值 */
export const PAYOFF_SENTINEL = 99;

/**
 * 「一笔成交都没有」的说法。
 * 不能写 MISSING_TEXT（引擎确实给了值，只是给的是 0），也不能写 0.0%（那是「全亏」），
 * 更不能不写——回测跑完一次没成交是常事（条件太严），这恰恰是最容易被说成「策略没收益」的一种。
 */
export const NO_TRADE_TEXT = "无成交样本";

// ---------- 白名单 ----------

/** 白名单的一条：只要求这三样，服务层从 quant_factors 捞出来什么形状都能对上 */
export interface WhitelistRow {
  factorKey: string;
  version: number;
  expression: string | null | undefined;
  name?: string | null;
  status?: string | null;
}

/** 模型请求的一个因子项（version/weight/direction 都可省：省略就是「最新入库版本 / 权重 1 / 正向」） */
export interface RequestedFactor {
  factorKey?: unknown;
  version?: unknown;
  weight?: unknown;
  direction?: unknown;
}

/** 过白名单后真正能交给回测引擎的因子（表达式来自库里那一份，不接受模型现写） */
export interface ResolvedFactor {
  factorKey: string;
  version: number;
  weight: number;
  direction: 1 | -1;
  expression: string;
}

export interface FactorResolution {
  resolved: ResolvedFactor[];
  /** 被挡下的因子键原样列出来：拒绝的理由要能对上号，不能只说「有非法因子」 */
  rejected: string[];
  /** 请求里一条都没有（模型没给 factors）——这不该说成「不在白名单」，两件不同的事 */
  empty: boolean;
}

/**
 * 白名单 = 库里已入库、且 expression 非空的因子。
 * 「非空」这条过滤现有代码里没有任何一处做：listLatestFactors 只按 factorKey 取最新版本，
 * 而挖掘中途的占位行（还没写表达式）也在表里。少了这一步，模型就能选中一个算不出东西的因子，
 * 引擎那边报出来的就是「因子不存在」这种对不上号的错。
 */
export function whitelistOf(rows: readonly WhitelistRow[]): WhitelistRow[] {
  return rows.filter((r) => typeof r.expression === "string" && r.expression.trim().length > 0);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

/**
 * 把模型的因子请求钉到白名单上。
 * 三条规则，一条都不给「差不多就行」：
 *  - 没给 version：取白名单里该键的最高版本（用户界面上点选就是按最新版本走的）；
 *  - 给了 version：白名单里必须有这个精确版本。不静默升到最新——模型说「用 v2」而实际跑 v5，
 *    结果就对不上它引用的那份数字，这种错比拒绝难查得多；
 *  - direction 只认 ±1，weight 必须有限值；不认就整项拒绝，不替模型猜。
 * 只要有一项被拒，调用方就整轮拒绝（不「先把能跑的发出去」）：
 * 一半因子被悄悄丢掉跑出来的收益，会被当成用户要的那组因子的收益。
 */
export function resolveWhitelistFactors(
  requested: readonly RequestedFactor[],
  whitelist: readonly WhitelistRow[],
): FactorResolution {
  const byKey = new Map<string, WhitelistRow[]>();
  for (const row of whitelist) {
    const list = byKey.get(row.factorKey) ?? [];
    list.push(row);
    byKey.set(row.factorKey, list);
  }
  for (const list of byKey.values()) list.sort((a, b) => b.version - a.version);

  const resolved: ResolvedFactor[] = [];
  const rejected: string[] = [];
  for (const req of requested) {
    const key = typeof req?.factorKey === "string" ? req.factorKey.trim() : "";
    const rows = key ? byKey.get(key) : undefined;
    if (!rows?.length) {
      rejected.push(key || String(req?.factorKey ?? "(空)"));
      continue;
    }
    const wantsVersion = typeof req.version === "number" && isFinite(req.version) ? Math.trunc(req.version) : null;
    const hit = wantsVersion === null ? rows[0] : rows.find((r) => r.version === wantsVersion);
    if (!hit) {
      // 键在白名单里、版本不在：仍然算「不在可回测白名单」，但理由要说具体，
      // 否则模型下一轮会拿同一个版本再试一次
      rejected.push(`${key}@${req.version}（白名单内该因子只有 ${rows.map((r) => `v${r.version}`).join("/")}）`);
      continue;
    }
    const directionRaw = req.direction;
    const direction: 1 | -1 | null =
      directionRaw === undefined || directionRaw === null ? 1 : directionRaw === 1 || directionRaw === -1 ? directionRaw : null;
    const weight = typeof req.weight === "number" && isFinite(req.weight) ? req.weight : req.weight === undefined || req.weight === null ? 1 : NaN;
    if (direction === null || !isFinite(weight)) {
      rejected.push(`${key}@${hit.version}（weight/direction 非法：weight 需有限数，direction 只能是 1 或 -1）`);
      continue;
    }
    resolved.push({ factorKey: key, version: hit.version, weight, direction, expression: (hit.expression ?? "").trim() });
  }
  return { resolved, rejected, empty: requested.length === 0 };
}

/**
 * 提示词里那一行白名单清单。
 * 有上限：白名单可能有上百个因子键，全塞进提示词会把上下文吃掉，而模型一次最多用几个。
 * 截断必须写明「另有 N 个未列出，可回测因子以数据库为准」，不能让它以为看到的就是全部。
 */
export function whitelistPromptLine(rows: readonly WhitelistRow[], max = 40): string {
  if (!rows.length) return "当前可回测因子白名单为空（库里没有已入库且含表达式的因子）：本轮不要调用 run_backtest，直接说明还没有可回测的因子。";
  const head = rows.slice(0, max).map((r) => `${r.factorKey}@${r.version}`).join("、");
  const rest = rows.length - max;
  return [
    `可回测因子白名单（数据库 quant_factors 中已入库且 expression 非空的因子，共 ${rows.length} 个）：${head}${rest > 0 ? `…另有 ${rest} 个未列出，以数据库为准` : ""}。`,
    "run_backtest 的 factors 只能从这份名单里选（可省 version 表示用最新入库版本）。",
    "名单外的因子一律不得尝试，也不要因为被拒就改写成名单里「差不多」的因子；被拒时按工具返回的原文说明。",
  ].join("");
}

// ---------- 区间预检 ----------

export interface RangeVerdict {
  ok: boolean;
  /** 现有交易日数（本层只判，取数在服务层） */
  tradingDays: number;
  /** 本次要求的交易日数 */
  required: number;
  text: string;
}

/**
 * 区间判定：以「本次要跑多少交易日」为准，而不是永远卡 240。
 * 任务书写的是「不足 240 日直接返回回测区间太短」，所以下限取 max(240, 请求区间)：
 * 用户/模型要 400 日而数据只有 300 日，同样不能跑——那 300 日过了 240 的线，却不是他要的那段区间。
 */
export function rangeVerdict(tradingDays: number, periodDays: number): RangeVerdict {
  const days = Number.isFinite(tradingDays) ? Math.trunc(tradingDays) : 0;
  const required = Math.max(BACKTEST_MIN_TRADING_DAYS, Math.max(1, Math.trunc(Number.isFinite(periodDays) ? periodDays : 0)));
  return {
    ok: days >= required,
    tradingDays: days,
    required,
    text: `区间可交易日 ${days} 日 < 所需 ${required} 日`,
  };
}

// ---------- 轮询节拍 ----------

export type PollAction = "waiting" | "settled" | "timed_out";

const SETTLED = new Set(["done", "failed", "cancelled"]);

/**
 * 每一次轮询后的判定。先判「结束了没有」再判超时：
 * 反过来会把一个刚好在第 60 秒跑完的任务说成超时，那是把成功写成失败。
 * status 传 null 表示 registry 里查不到这个任务（进程重启过 / 任务没建成），
 * 这不算 settled——它没有结果可报，按未结束处理直到超时，最后由调用方如实说明。
 */
export function pollAction(now: number, startedAt: number, status: string | null): PollAction {
  if (status && SETTLED.has(status)) return "settled";
  if (now - startedAt >= BACKTEST_POLL_TIMEOUT_MS) return "timed_out";
  return "waiting";
}

/** 服务重启后按 jobId 现查会走到的说法（前端结果卡用；任务号仍留着，去量化页台账按号回看） */
export const TEXT_JOB_GONE = "本进程已无该回测任务（服务重启过，内存任务列表不保留历史任务）";

export type JobLookup =
  | { kind: "job"; job: Record<string, unknown> }
  /** 接口明确说「任务不存在」：这就是没了，继续按节拍问只会一直 404 */
  | { kind: "missing"; reason: string }
  /** 网络失败 / 网关错误 / 响应体读不出：不能当成「任务没了」 */
  | { kind: "unknown" };

/**
 * 前端「凭 jobId 现查引擎」这一步的判定。
 *
 * 为什么要单独钉：对话的历史记录（localStorage）里存的是 jobId，服务重启之后这些 id 就不在本进程的
 * 任务表里了。此时接口返回 404 `{error:"任务不存在：…"}`，判定必须能区分三件事——
 * 取到了 / 明确没了 / 这次没问出来。把后两者混起来，要么网络抖一下就把一次真实回测说成「没了」，
 * 要么反过来：卡片位置空着、后台每 2.5 秒 404 一次问到老（本轮实机控制台就是这么刷出十几条 404 的）。
 */
export function jobLookupVerdict(httpStatus: number, body: { job?: unknown; error?: unknown } | null): JobLookup {
  const job = body?.job;
  if (job && typeof job === "object") return { kind: "job", job: job as Record<string, unknown> };
  const err = typeof body?.error === "string" ? body.error : "";
  if (httpStatus === 404 || err.includes("不存在")) return { kind: "missing", reason: err || TEXT_JOB_GONE };
  return { kind: "unknown" };
}

// ---------- 读数（单位与哨兵值） ----------

export interface MetricView {
  key: string;
  label: string;
  /** 已带单位的显示串；算不出来就是 MISSING_TEXT，不写 0、不写 “—” */
  value: string;
  /** 口径说明：回撤方向、哨兵值、交易次数的合计口径都写在这里 */
  note?: string;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

/** 小数比例 → 百分数串。引擎给的是 0.53 这种比例，直接当百分数显示就是把胜率说小 100 倍 */
export function ratioToPct(v: unknown, digits = 1): string | null {
  const n = finite(v);
  return n === null ? null : `${(n * 100).toFixed(digits)}%`;
}

/**
 * 五项核心读数的口径换算。
 * 四条容易读错的，一条都不能省：
 *  - maxDrawdown 引擎里是**正数幅度**（(peak-value)/peak），显示要带负号，否则「最大回撤 25%」读起来像赚了 25%；
 *  - payoffRatio 的 99 是「只赚不亏」的哨兵值（evaluation.computeMetrics：losses===0 && wins>0 时给 99），
 *    报成「盈亏比 99」就是把一个占位数字当成市场事实；
 *  - winRate / payoffRatio 在**一笔成交都没有**时引擎回 0。那个 0 不是「全亏」，是没样本，
 *    所以先按 tradeCount 判有没有交易，再谈数值——MISSING≠0 这条在回测读数里同样成立；
 *  - tradeCount 是买 + 卖的合计次数，不是持仓只数；引擎不单独外露盈亏笔数，胜率的口径就写在这条 note 里。
 * 只认引擎已有的字段，不在这里补算任何指标：前端再算一套迟早和引擎对不上。
 */
export function metricViews(metrics: Record<string, unknown> | null | undefined): MetricView[] {
  const m = metrics ?? {};
  const payoff = finite(m.payoffRatio);
  const tradeCount = finite(m.tradeCount);
  const noTrades = tradeCount === 0;
  const isSentinel = payoff !== null && Math.abs(payoff - PAYOFF_SENTINEL) < 1e-9;
  const drawdown = ratioToPct(m.maxDrawdown);
  const winRate = ratioToPct(m.winRate, 1);
  return [
    {
      key: "winRate",
      label: "胜率",
      value: noTrades || winRate === null ? NO_TRADE_TEXT : winRate,
      note: "分母为已平仓的卖出笔数（引擎按 FIFO 成本配对，不外露盈亏笔数）",
    },
    { key: "annualReturn", label: "年化收益率", value: ratioToPct(m.annualReturn, 1) ?? MISSING_TEXT, note: "按 252 交易日折算" },
    {
      key: "maxDrawdown",
      label: "最大回撤",
      value: drawdown === null ? MISSING_TEXT : `-${drawdown}`,
      note: "引擎口径为正数回撤幅度，此处按亏损方向加负号显示",
    },
    {
      key: "payoffRatio",
      label: "盈亏比",
      value: noTrades ? NO_TRADE_TEXT : isSentinel ? "不适用（无亏损样本）" : payoff === null ? MISSING_TEXT : payoff.toFixed(2),
      note: isSentinel ? "引擎以 99 作「有盈利但无亏损」的哨兵值，不是真实比值" : "平均盈利额/平均亏损额（引擎字段）",
    },
    { key: "tradeCount", label: "交易次数", value: tradeCount === null ? MISSING_TEXT : String(tradeCount), note: "买 + 卖合计笔数，不是持仓只数" },
  ];
}

/** 给模型的读数对象（键用中文：模型引用时要连同单位一起带走，别让它自己再换算一次） */
export function metricObject(metrics: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of metricViews(metrics)) out[v.label] = v.value;
  return out;
}

// ---------- 「声称回测但没跑成」护栏 ----------

/** 判「这一轮到底有没有真跑成一次回测」：只看 run_backtest 这一步是否真的成功并带回了任务 */
export function backtestRan(steps: readonly { tool?: string; status?: string }[] | undefined): boolean {
  return (steps ?? []).some((s) => s?.tool === "run_backtest" && s?.status === "ok");
}

/** 正文里出现这些词，才认为它「报了回测读数」——只提一句「回测没做成」不该被警示 */
const BACKTEST_METRIC_RE = /(年化|胜率|回撤|收益率|夏普|盈亏比|收益)/;

/**
 * 回答正文给了回测读数，但这一轮并没有一次成功的 run_backtest —— 给界面登记的警示原文。
 * 为什么要这条：模型完全可以凭「因子名 + 常识」编出一段回测结论，而它看起来和真跑出来的一模一样。
 * REAL_DATA_ONLY 在这条链路上的落点就是这句：跑没跑过看步骤，不看正文。
 *
 * 触发要同时满足「说了回测」和「给了读数指标」两条，少一条都不弹：
 *  - 只说「这些因子不在白名单，做不了回测」不该被警示（那是真话，弹它就是把真话标成假话）；
 *  - 只说「站上 MA20 后持有 5 日胜率 58%」也不该被警示——那是 historical_probability 的样本胜率，
 *    不是回测收益，两个词撞车是必然的（同一个引擎里「胜率」有两处含义）。
 * 仍然会漏判（模型不说「回测」两个字就给出一段编的年化），但那种情况工作过程里根本没有
 * run_backtest 这一步，用户点开就能看见；宁可少弹，不要错怪。
 */
export function backtestClaimWarning(
  steps: readonly { tool?: string; status?: string }[] | undefined,
  content: string,
  ready: boolean = true,
): string | null {
  if (!ready) return null;
  const text = content ?? "";
  if (!/回测/.test(text) || !BACKTEST_METRIC_RE.test(text)) return null;
  if (backtestRan(steps)) return null;
  return "本轮回答给了回测口径的数字，但这一轮没有成功执行过 run_backtest：这些数字不是本机回测引擎算出来的，请以下方「工作过程」为准。";
}

// ---------- 结果读数（拼给模型的那一段） ----------

export interface ReadoutInput {
  asOf: string;
  periodDays: number;
  dataSource: string;
  symbols: number;
  dates: number;
  factors: readonly ResolvedFactor[];
  topN: number;
  rebalanceEvery: number;
  metrics: Record<string, unknown> | null;
  jobId: string;
  /** 面板构建时被剔除的标的说明（引擎已经给了，原样带过去，不替它圆场） */
  coverageNotes?: readonly string[];
}

/**
 * 回测完成后发给模型的读数块。
 * 三件必带：区间与样本（多少日 × 多少只）、因子出处（哪个版本）、指标出处（引擎 + 单位口径）。
 * 少了这些，模型报出一个「胜率 53%」时无从判断这是 240 日 60 只，还是 80 日 8 只。
 */
export function backtestReadout(i: ReadoutInput): string {
  const views = metricViews(i.metrics);
  const lines = [
    `回测已完成（任务 ${i.jobId}）。`,
    `区间：截至 ${i.asOf} 共 ${i.dates} 个交易日 × ${i.symbols} 只标的，要求区间 ${i.periodDays} 交易日。`,
    `数据源：${i.dataSource}。`,
    `因子：${i.factors.map((f) => `${f.factorKey}@${f.version}(权重${f.weight},方向${f.direction})`).join("、")}；TopN ${i.topN}，每 ${i.rebalanceEvery} 日调仓。`,
    `指标（引擎 evaluation.computeMetrics 口径）：${views.map((v) => `${v.label} ${v.value}`).join("；")}。`,
    `单位口径：${views.filter((v) => v.note).map((v) => `${v.label}=${v.note}`).join("；")}。`,
  ];
  if (i.coverageNotes?.length) lines.push(`样本提示：${i.coverageNotes.join("；")}`);
  lines.push("引用这些数字时必须连同区间、样本只数与数据源一起说；这是历史回测，不代表未来收益。");
  return lines.join("\n");
}
