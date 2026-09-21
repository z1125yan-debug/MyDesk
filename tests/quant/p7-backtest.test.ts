// P7-⑧④ 回测接入对话链路的回归测试（纯内存：不 fetch、不碰库、不起服务）。
//
// 这一层的全部风险是「让一句听起来很像回测的话冒充回测结果」，所以断言按四条纪律来写：
//  1) 白名单只认「库里已入库且 expression 非空」的因子，版本对不上就是不在名单，绝不静默升级；
//     一项被拒就整轮拒（跑一半因子报出来的收益不是用户要的那组）；
//  2) 区间下限按「本次要跑多少交易日」判，不是永远卡 240；
//  3) 轮询节拍先判结束再判超时，否则刚好在第 60 秒跑完的任务会被说成超时；
//  4) 指标单位与哨兵值：0.53 是 53%、回撤幅度要带负号、payoffRatio 的 99 不是比值、
//     一笔成交都没有时不能把引擎的 0 报成「胜率 0%」。
//  5) 前端凭 jobId 现查引擎：「查到了」「这个任务号本进程没有」「这次没问出来」是三件事，
//     只有第二件该停轮询并如实说一句，混起来就会出现空白卡或无限 404。
// 三条任务书原文（白名单拒绝 / 区间太短 / 回测超时）逐字断言：那是给用户看的口径，改一个字就算改口径。
// 用例里的因子键与数值都是手写的形状样例，不是真实提问，也不是任何行情事实。
import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKTEST_MIN_TRADING_DAYS, BACKTEST_POLL_INTERVAL_MS, BACKTEST_POLL_TIMEOUT_MS,
  NO_TRADE_TEXT, PAYOFF_SENTINEL, TEXT_JOB_GONE, TEXT_NOT_IN_WHITELIST, TEXT_POLL_TIMEOUT, TEXT_RANGE_TOO_SHORT,
  backtestRan, backtestReadout, backtestClaimWarning, jobLookupVerdict, metricObject, metricViews, pollAction,
  rangeVerdict, ratioToPct, resolveWhitelistFactors, whitelistOf, whitelistPromptLine, type WhitelistRow,
} from "../../src/lib/desk/backtest-core.ts";
// 缺数措辞的出处就是面板那份（backtest-core 只 import 不另立一名），断言时也从那里取
import { MISSING_TEXT } from "../../src/lib/desk/context-panel-core.ts";
import { scenePrompt, classifyIntent } from "../../src/lib/desk/intent-core.ts";
import { STEP_STATUS_WORD } from "../../src/lib/desk/chat-core.ts";

const rows = (...specs: [string, number, string | null][]): WhitelistRow[] =>
  specs.map(([factorKey, version, expression]) => ({ factorKey, version, expression }));

const KEYS = {
  rps: rows(["rps_50", 1, "rank(rps_50)"], ["rps_50", 3, "rank(rps_50)"]),
  macd: rows(["macd_cross", 2, "macd_cross"]),
};

// ---------- 任务书原文与节拍常量 ----------

test("三条固定文案与任务书原文逐字一致", () => {
  assert.equal(TEXT_NOT_IN_WHITELIST, "当前因子不在可回测白名单，无法执行回测");
  assert.equal(TEXT_RANGE_TOO_SHORT, "回测区间太短");
  assert.equal(TEXT_POLL_TIMEOUT, "回测超时，请稍后在策略历史查看结果");
});

test("节拍口径：240 交易日下限、1 秒一次、最多 60 秒", () => {
  assert.equal(BACKTEST_MIN_TRADING_DAYS, 240);
  assert.equal(BACKTEST_POLL_INTERVAL_MS, 1000);
  assert.equal(BACKTEST_POLL_TIMEOUT_MS, 60_000);
});

// ---------- 白名单 ----------

test("白名单只收 expression 非空的因子（空串与纯空白都不算）", () => {
  const all = rows(["a", 1, "x+1"], ["b", 1, ""], ["c", 1, "   "], ["d", 1, null]);
  const wl = whitelistOf(all);
  assert.deepEqual(wl.map((r) => r.factorKey), ["a"]);
});

test("省略 version 时取白名单里的最高版本，而不是表里第一条", () => {
  const { resolved, rejected } = resolveWhitelistFactors([{ factorKey: "rps_50" }], KEYS.rps);
  assert.equal(rejected.length, 0);
  assert.equal(resolved[0].version, 3);
  assert.equal(resolved[0].expression, "rank(rps_50)");
  // 权重与方向缺省口径和引擎一致：权重 1、正向
  assert.equal(resolved[0].weight, 1);
  assert.equal(resolved[0].direction, 1);
});

test("给了 version 就必须精确命中：不静默升到最新", () => {
  const { resolved, rejected } = resolveWhitelistFactors([{ factorKey: "rps_50", version: 1 }], KEYS.rps);
  assert.equal(rejected.length, 0);
  assert.equal(resolved[0].version, 1, "v1 在白名单里就该用 v1");
  const stale = resolveWhitelistFactors([{ factorKey: "rps_50", version: 9 }], KEYS.rps);
  assert.equal(stale.resolved.length, 0);
  assert.equal(stale.rejected.length, 1);
  // 拒绝理由要带上名单里到底有哪些版本，否则模型下一轮还会拿同一个版本号再试
  assert.match(stale.rejected[0], /v3\/v1/);
});

test("名单外的因子键整项拒绝，且保留原样键名", () => {
  const { resolved, rejected } = resolveWhitelistFactors([{ factorKey: "i_made_this_up" }], [...KEYS.rps, ...KEYS.macd]);
  assert.equal(resolved.length, 0);
  assert.deepEqual(rejected, ["i_made_this_up"]);
});

test("direction 只认 ±1、weight 必须是有限数：不替模型猜", () => {
  const badDir = resolveWhitelistFactors([{ factorKey: "rps_50", direction: 0 }], KEYS.rps);
  assert.equal(badDir.resolved.length, 0);
  assert.match(badDir.rejected[0], /direction/);
  const badWeight = resolveWhitelistFactors([{ factorKey: "rps_50", weight: "1" }], KEYS.rps);
  assert.equal(badWeight.resolved.length, 0);
  assert.match(badWeight.rejected[0], /weight/);
  // -1 是合法的反向选股，不能被当成非法值挡掉
  const ok = resolveWhitelistFactors([{ factorKey: "rps_50", weight: 0.5, direction: -1 }], KEYS.rps);
  assert.deepEqual([ok.resolved[0].weight, ok.resolved[0].direction], [0.5, -1]);
});

test("一组因子里只要有一个不合法就整组被拒（不跑「能跑的那半」）", () => {
  const { resolved, rejected } = resolveWhitelistFactors(
    [{ factorKey: "rps_50" }, { factorKey: "not_in_whitelist" }],
    [...KEYS.rps, ...KEYS.macd],
  );
  assert.equal(rejected.length, 1);
  assert.equal(resolved.length, 1, "内核只负责标记被拒项；调用方看到 rejected 非空就必须整轮拒绝");
});

test("没给任何因子时是 empty，不是「不在白名单」（两件事不能用同一句话）", () => {
  const r = resolveWhitelistFactors([], KEYS.rps);
  assert.equal(r.empty, true);
  assert.equal(r.rejected.length, 0);
});

test("提示词那一行：空名单要说不为空、超长名单要写明截断", () => {
  assert.match(whitelistPromptLine([]), /白名单为空/);
  assert.match(whitelistPromptLine([]), /本轮不要调用 run_backtest/);
  const many = rows(...(Array.from({ length: 45 }, (_, i) => [`f${i}`, 1, "x"]) as [string, number, string | null][]));
  const line = whitelistPromptLine(many, 40);
  assert.match(line, /共 45 个/);
  assert.match(line, /另有 5 个未列出/);
  assert.match(line, /f0@1/);
  assert.doesNotMatch(line, /f44@1/, "超出上限的键不该被列出来");
});

// ---------- 区间预检 ----------

test("区间判定以下限与请求区间的较大者为准", () => {
  assert.equal(rangeVerdict(240, 240).ok, true);
  assert.equal(rangeVerdict(239, 240).ok, false);
  // 300 日过了 240 的线，但用户要的是 400 日：这段区间不是他要的那段，同样不能跑
  const short = rangeVerdict(300, 400);
  assert.equal(short.ok, false);
  assert.equal(short.required, 400);
  assert.match(short.text, /区间可交易日 300 日 < 所需 400 日/);
  // 非有限值按 0 日处理，不能因为 NaN 判成「够」
  assert.equal(rangeVerdict(NaN, 240).ok, false);
});

// ---------- 轮询节拍 ----------

test("轮询判定：先认结束、再认超时", () => {
  assert.equal(pollAction(1000, 0, "running"), "waiting");
  assert.equal(pollAction(1000, 0, null), "waiting", "registry 里查不到任务时按未结束处理（没有结果可报）");
  assert.equal(pollAction(BACKTEST_POLL_TIMEOUT_MS + 5_000, 0, "running"), "timed_out");
  // 刚好卡在 60 秒完成：这是成功，不是超时——顺序反了就会把成功写成失败
  assert.equal(pollAction(BACKTEST_POLL_TIMEOUT_MS, 0, "done"), "settled");
  assert.equal(pollAction(BACKTEST_POLL_TIMEOUT_MS + 1, 0, "failed"), "settled");
  assert.equal(pollAction(BACKTEST_POLL_TIMEOUT_MS + 1, 0, "cancelled"), "settled");
});

// ---------- 指标单位与哨兵值 ----------

test("ratioToPct：小数比例按百分数说，非有限值不给数字", () => {
  assert.equal(ratioToPct(0.53, 1), "53.0%");
  assert.equal(ratioToPct(-0.123, 1), "-12.3%");
  assert.equal(ratioToPct(0, 1), "0.0%", "真的是 0 就要显示成 0，不能和缺数混成一个词");
  assert.equal(ratioToPct(null), null);
  assert.equal(ratioToPct(Number.NaN), null);
});

test("五项读数：胜率/年化带百分号，回撤带负号，盈亏比不带单位", () => {
  const views = Object.fromEntries(metricViews({
    winRate: 0.53, annualReturn: 0.21, maxDrawdown: 0.25, payoffRatio: 1.8, tradeCount: 40,
  }).map((v) => [v.key, v.value]));
  assert.equal(views.winRate, "53.0%");
  assert.equal(views.annualReturn, "21.0%");
  // 引擎给的是正数回撤幅度，界面必须按亏损方向说
  assert.equal(views.maxDrawdown, "-25.0%");
  assert.equal(views.payoffRatio, "1.80");
  assert.equal(views.tradeCount, "40");
});

test("payoffRatio 的 99 是哨兵值，不能报成「盈亏比 99」", () => {
  const v = metricViews({ tradeCount: 20, payoffRatio: PAYOFF_SENTINEL, winRate: 1 }).find((x) => x.key === "payoffRatio");
  assert.equal(v?.value, "不适用（无亏损样本）");
  assert.match(v?.note ?? "", /哨兵值/);
});

test("一笔成交都没有：引擎的 0 不是「胜率 0%」，是没样本", () => {
  const byKey = Object.fromEntries(metricViews({ winRate: 0, payoffRatio: 0, tradeCount: 0 }).map((v) => [v.key, v.value]));
  assert.equal(byKey.winRate, NO_TRADE_TEXT);
  assert.equal(byKey.payoffRatio, NO_TRADE_TEXT);
  assert.equal(byKey.tradeCount, "0", "交易次数本身要照原样是 0");
});

test("指标缺字段时写「本次未取到」，不写 0 也不写 —", () => {
  const views = metricViews({ tradeCount: 12 });
  const byKey = Object.fromEntries(views.map((v) => [v.key, v.value]));
  assert.equal(byKey.annualReturn, MISSING_TEXT);
  assert.equal(byKey.maxDrawdown, MISSING_TEXT);
  // 与 P7-⑧③ 面板同一份缺数措辞：两处各写一套，用户就分不清是没取到还是真为 0
  assert.equal(MISSING_TEXT, "本次未取到");
  assert.equal(metricViews(null).length, 5);
  assert.equal(Object.keys(metricObject({ tradeCount: 3 })).length, 5, "给模型的读数必须是五项中文键");
});

// ---------- 「声称回测但没跑成」护栏 ----------

test("backtestRan 只认真正成功的 run_backtest 步骤", () => {
  assert.equal(backtestRan([{ tool: "run_backtest", status: "ok" }]), true);
  assert.equal(backtestRan([{ tool: "run_backtest", status: "missing" }]), false, "被白名单挡下不算跑成");
  assert.equal(backtestRan([{ tool: "factor_screener", status: "ok" }]), false);
  assert.equal(backtestRan(undefined), false);
});

test("正文给了回测读数却没跑成 → 出警示；老实说没做成 → 不警示", () => {
  const warn = backtestClaimWarning([{ tool: "stock_snapshot", status: "ok" }], "回测显示年化收益率 21%，胜率 53%。");
  assert.ok(warn);
  assert.match(warn, /没有成功执行过 run_backtest/);
  // 「回测」+「胜率」都出现，但这一轮真跑成了：不该有警示
  assert.equal(backtestClaimWarning([{ tool: "run_backtest", status: "ok" }], "回测显示年化 21%"), null);
  // 只说做不了回测（真话）不该被标成假话
  assert.equal(backtestClaimWarning([], "这些因子不在可回测白名单，本轮无法执行回测。"), null);
  // 只提样本胜率、没提回测：那是 historical_probability 的读数，不是回测收益
  assert.equal(backtestClaimWarning([], "站上 MA20 后持有 5 日的历史胜率是 58%（样本 42 次）。"), null);
  // 回测没接入的那条链路（/api/ai/proxy）由提示词管，这里不重复弹
  assert.equal(backtestClaimWarning([], "回测显示年化 21%", false), null);
});

test("步骤状态词与既有那份同源（面板/时间线/回测卡不能各说一套）", () => {
  assert.equal(STEP_STATUS_WORD.ok, "已取到");
  assert.equal(STEP_STATUS_WORD.missing, "缺数据");
});

// ---------- 读数块 ----------

test("回测读数块自带区间、样本、因子版本与单位口径", () => {
  const text = backtestReadout({
    asOf: "2026-09-21", periodDays: 240, dataSource: "回测引擎 quant_backtest（数据源 em）",
    symbols: 60, dates: 240, topN: 10, rebalanceEvery: 5, jobId: "qj_test_1",
    factors: [{ factorKey: "rps_50", version: 3, weight: 1, direction: 1, expression: "rank(rps_50)" }],
    metrics: { winRate: 0.53, annualReturn: 0.21, maxDrawdown: 0.25, payoffRatio: 1.8, tradeCount: 40 },
    coverageNotes: ["8 只无K线数据"],
  });
  assert.match(text, /240 个交易日 × 60 只/);
  assert.match(text, /rps_50@3/);
  assert.match(text, /胜率 53\.0%/);
  assert.match(text, /最大回撤 -25\.0%/);
  assert.match(text, /8 只无K线数据/);
  assert.match(text, /不代表未来收益/);
  assert.match(text, /任务 qj_test_1/);
});

// ---------- 场景提示词那一侧 ----------

const intentOf = (question: string) => classifyIntent({ question, focusSymbol: null, sessionSymbol: null, prevScene: null });

test("backtestReady 为真且有名单时：提示词给出白名单与引用纪律", () => {
  const text = scenePrompt("stock_analysis", {
    intent: intentOf("用 rps_50 回测一下"),
    backtestReady: true,
    backtestPromptLine: whitelistPromptLine(KEYS.rps),
  });
  assert.match(text, /可回测因子白名单/);
  assert.match(text, /rps_50@3/);
  assert.match(text, /只能从这份名单里选/);
  assert.match(text, /绝不给「大概年化多少」/);
  // 已接入时不能再出现「还没做」那句假话
  assert.doesNotMatch(text, /本轮没有可用的回测工具/);
});

test("backtestReady 为真但这一轮没查名单时：不提名单，也不说「尚未接入」", () => {
  const text = scenePrompt("stock_analysis", { intent: intentOf("用 rps_50 回测一下"), backtestReady: true });
  assert.doesNotMatch(text, /可回测因子白名单/);
  assert.doesNotMatch(text, /没有可用的回测工具/);
});

test("backtestReady 为假（无工具环的那条路）：禁止声称已回测", () => {
  const text = scenePrompt("stock_analysis", { intent: intentOf("帮我回测一下刚才说的策略"), backtestReady: false });
  assert.match(text, /不得声称已回测/);
  assert.doesNotMatch(text, /P7-⑦ 之后才做/, "回测已经做了，这句理由过期了");
});

// ---------- 前端凭 jobId 现查引擎的判定（P7-⑧④ 收尾补） ----------
// 起因是实机抓到的真缺陷：对话历史里存的是 jobId，服务重启后这些 id 不在本进程任务表里，
// 接口每次 404，而旧版轮询只在「查到 done」时才停 ⇒ 每 2.5 秒一条 404 一直问下去，卡片位置留一块空白。

test("jobLookupVerdict：查到任务就用那份任务，missing 为空", () => {
  const v = jobLookupVerdict(200, { job: { id: "qj_1", status: "running" } });
  assert.equal(v.kind, "job");
  assert.equal(v.kind === "job" ? v.job.status : null, "running");
});

test("jobLookupVerdict：404 + 「任务不存在」判成没了，并带回接口原话", () => {
  const v = jobLookupVerdict(404, { error: "任务不存在：qj_1" });
  assert.equal(v.kind, "missing");
  assert.equal(v.kind === "missing" ? v.reason : null, "任务不存在：qj_1");
});

test("jobLookupVerdict：只给 404 没给原因时也有说法，不留空串", () => {
  const v = jobLookupVerdict(404, null);
  assert.equal(v.kind === "missing" ? v.reason : null, TEXT_JOB_GONE);
  assert.match(TEXT_JOB_GONE, /本进程已无/);
});

test("jobLookupVerdict：网络/网关那一类的失败不能报成「任务没了」", () => {
  // 502 空响应体、200 但 body 读不出、以及只有 job:null 的一次抖动 —— 三种都只能算「这次没问出来」
  assert.equal(jobLookupVerdict(502, null).kind, "unknown");
  assert.equal(jobLookupVerdict(200, null).kind, "unknown");
  assert.equal(jobLookupVerdict(200, { job: null, error: "upstream busy" }).kind, "unknown");
});
