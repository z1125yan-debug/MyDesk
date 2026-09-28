// P8-①/② 回归测试：数据新鲜度检查（freshness-core）+ v3 结论契约（decision-core P8 节）。
//
// 每条断言都对应用户开工令里点名的一个风险点或任务书的一句要求：
//  - 风险点 1：时区折算不能 double-count；unknown 一律不得被当成新鲜，也不得静默；
//  - 风险点 2：全工程只有一份「日期没对上」的规则（decision-service 已改调 dateMismatch，用源码文本钉住）；
//  - 风险点 3：契约闸只认个股研判场景，纯行情查询走不到注入路径；
//  - 风险点 4：校验不一致只出警告文案，文案里必须写清「原文未改、没有重答」。
// 服务层（scene-dispatch）与路由 import 了网络/prisma，不可直测——按 p7-dispatch 的老办法用源码文本断言。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  toShanghaiDay, calendarDayGap, dateMismatch, latestNotAfter, judgeBarFreshness, gapTradingDays,
  klineLastDatesFromResult, freshnessLine, buildFreshnessReport, freshnessPromptRule,
} from "../../src/lib/desk/freshness-core.ts";
import {
  buildDecisionContract, renderDecisionContract, shouldBuildDecisionContract,
  extractContractCitations, verifyContractCitations, contractWarningText,
  CONTRACT_QUOTE_RULE, GRADE_ORDER, type Decision,
} from "../../src/lib/quant/screener/decision-core.ts";
import { asStreamEvent } from "../../src/lib/desk/chat-stream-core.ts";

/** 源码文本断言统一走相对本文件的 URL：不依赖 node --test 的启动目录 */
const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

// ---------- P8-① freshness-core ----------

test("freshness-core 是零依赖纯核：不 import 任何运行时模块（node --test 可直跑的根）", () => {
  const src = readSrc("src/lib/desk/freshness-core.ts");
  assert.ok(!/^import\s/m.test(src), "freshness-core 不应有任何 import（判定全部吃调用方传入的读数）");
  assert.ok(!/require\(/.test(src));
});

test("toShanghaiDay：裸日期原样取日期段，带 Z/±hh:mm 的折到东八区日历日，只信一次偏移", () => {
  assert.equal(toShanghaiDay("2026-09-18"), "2026-09-18");
  // eltdx 形态：带时间无偏移 = 数据源自报的北京交易时间，原样取日期段
  assert.equal(toShanghaiDay("2026-09-18 15:00"), "2026-09-18");
  // 风险点 1 的例：UTC 时刻不能再手动减偏移（那是把偏移算两遍）
  assert.equal(toShanghaiDay("2026-09-18T16:30:00Z"), "2026-09-19");
  assert.equal(toShanghaiDay("2026-09-18T09:00:00+08:00"), "2026-09-18");
  // 09:00−05:00 = 14:00Z = 北京 22:00 同一天（跨不跨日要真按时刻算，不凭符号猜）
  assert.equal(toShanghaiDay("2026-09-18T09:00:00-05:00"), "2026-09-18");
  assert.equal(toShanghaiDay("2026-09-18T20:00:00-05:00"), "2026-09-19");
  assert.equal(toShanghaiDay("2026-13-45"), null);
  assert.equal(toShanghaiDay(20260918), null);
  assert.equal(toShanghaiDay(null), null);
});

test("calendarDayGap 按自然日差、与时区无关；不可解析交 null 不硬算", () => {
  assert.equal(calendarDayGap("2026-09-18", "2026-09-21"), 3);
  assert.equal(calendarDayGap("2026-09-21", "2026-09-18"), -3);
  assert.equal(calendarDayGap("昨天", "2026-09-21"), null);
});

test("dateMismatch 是既有 stale 口径的唯一出处：不同即 true，带时区标记先折算再比", () => {
  assert.equal(dateMismatch("2026-09-18", "2026-09-19"), true);
  assert.equal(dateMismatch("2026-09-18", "2026-09-18"), false);
  // UTC 串折算后与北京交易日对齐 → 不误报（原裸字符串比对会 true）
  assert.equal(dateMismatch("2026-09-18T16:30:00Z", "2026-09-19"), false);
  // 认不出的串不当违规下结论——误报也是错
  assert.equal(dateMismatch(null, "2026-09-19"), false);
  assert.equal(dateMismatch("不是日期", "2026-09-19"), false);
  // 风险点 2 的落点：decision-service 不再自己写裸比对，改为调用本函数
  const svc = readSrc("src/lib/quant/screener/decision-service.ts");
  assert.ok(/from "@\/lib\/desk\/freshness-core"/.test(svc), "decision-service 必须 import freshness-core 的 dateMismatch");
  assert.ok(/dateMismatch\(tech\.bar_date, tradeDate\)/.test(svc), "结论卡的滞后提醒必须走 dateMismatch");
  assert.ok(!/tech\.bar_date\s*!==\s*tradeDate/.test(svc), "不许留着第二处裸字符串比对（两处各一套迟早漂移）");
});

test("latestNotAfter：基准取日历里不晚于今日的最近交易日——周末/盘前不误报滞后", () => {
  const cal = ["2026-09-21", "2026-09-18", "2026-09-17"];
  assert.equal(latestNotAfter(cal, "2026-09-21"), "2026-09-21");
  // 周日问话：基准应是上周五，K 线只到周五 = fresh，而不是误报「滞后 2 天」
  assert.equal(latestNotAfter(cal, "2026-09-20"), "2026-09-18");
  // 盘前（今日有交易日身份但日历还没有今天的 bar）：同样落在上一交易日
  assert.equal(latestNotAfter(cal, "2026-09-21T09:10:00+08:00"), "2026-09-21");
  assert.equal(latestNotAfter([], "2026-09-21"), null);
  assert.equal(latestNotAfter(cal, "坏日期"), null);
});

test("judgeBarFreshness：三态齐全，unknown 三种成因各有直白原因，绝不冒充 fresh", () => {
  const fresh = judgeBarFreshness({ label: "600519.SH 日K", last_date: "2026-09-18", expected_date: "2026-09-18" });
  assert.equal(fresh.state, "fresh");
  assert.equal(freshnessLine(fresh), null, "fresh 没话找话只会稀释指令");

  const stale = judgeBarFreshness({ label: "600519.SH 日K", last_date: "2026-09-16", expected_date: "2026-09-18" });
  assert.equal(stale.state, "stale");
  assert.equal(stale.lag_days, 2);
  assert.match(freshnessLine(stale) ?? "", /数据滞后.*只到 2026-09-16.*基准交易日已到 2026-09-18/);

  // 风险点 1 的三种 unknown：基准没有 / 读数没有 / 读数比基准还晚（日历异常）
  const noBase = judgeBarFreshness({ label: "x", last_date: "2026-09-18", expected_date: null });
  assert.equal(noBase.state, "unknown");
  assert.match(freshnessLine(noBase) ?? "", /新鲜度无法判定/);
  const noLast = judgeBarFreshness({ label: "x", last_date: null, expected_date: "2026-09-18" });
  assert.equal(noLast.state, "unknown");
  const future = judgeBarFreshness({ label: "x", last_date: "2026-09-25", expected_date: "2026-09-18" });
  assert.equal(future.state, "unknown");
  assert.match(future.reason ?? "", /日历异常/);
  // unknown 同样要出提示行：「没查出来」不能被静默成「查了、没问题」
  for (const u of [noBase, noLast, future]) assert.ok(freshnessLine(u), "unknown 不得静默");
});

test("gapTradingDays：只报有证据的断档；样本不足或没日历交 null，不谎报「无断档」", () => {
  const cal = ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];
  assert.deepEqual(gapTradingDays(["2026-09-15", "2026-09-17", "2026-09-18"], cal), ["2026-09-16"]);
  assert.deepEqual(gapTradingDays(["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"], cal), []);
  assert.equal(gapTradingDays(["2026-09-15"], cal), null, "单根序列无从核对断档");
  assert.equal(gapTradingDays(["2026-09-15", "2026-09-18"], []), null, "没有日历就没有「缺」的证据");
});

test("klineLastDatesFromResult：认得 stock_kline_summary 的「最近5日」，其它形状交空数组（是「没查」不是「新鲜」）", () => {
  const dates = klineLastDatesFromResult({
    最近5日: [{ 日期: "2026-09-17" }, { 日期: "2026-09-18" }, { 日期: "2026-09-18T16:30:00Z" }],
  });
  assert.deepEqual(dates, ["2026-09-17", "2026-09-18", "2026-09-19"], "带时区标记的日期按北京日历日归一");
  assert.deepEqual(klineLastDatesFromResult({ missing: "接口无返回" }), []);
  assert.deepEqual(klineLastDatesFromResult(null), []);
  assert.deepEqual(klineLastDatesFromResult({ 最近5日: "不是数组" }), []);
});

test("buildFreshnessReport：全新鲜不报事；滞后/无法判定/断档都进 lines 且 has_issues", () => {
  const allFresh = buildFreshnessReport([
    judgeBarFreshness({ label: "a", last_date: "2026-09-18", expected_date: "2026-09-18" }),
  ]);
  assert.equal(allFresh.has_issues, false);
  assert.deepEqual(allFresh.lines, []);

  const mixed = buildFreshnessReport(
    [
      judgeBarFreshness({ label: "600519.SH 日K", last_date: "2026-09-16", expected_date: "2026-09-18" }),
      judgeBarFreshness({ label: "b", last_date: "2026-09-18", expected_date: "2026-09-18" }),
    ],
    [{ label: "600519.SH 日K", missing: ["2026-09-17"] }],
  );
  assert.equal(mixed.has_issues, true);
  assert.equal(mixed.lines.length, 2, "一条滞后 + 一条断档，fresh 不进 lines");
  assert.match(mixed.lines.join("\n"), /序列断档：600519\.SH 日K 在覆盖区间内缺 1 个交易日（2026-09-17）/);
});

test("freshnessPromptRule：纪律段带核对结果原文，并写明滞后要点名幅度、无法判定不得写成正常", () => {
  const text = freshnessPromptRule(["数据滞后：x 的读数只到 2026-09-16，基准交易日已到 2026-09-18（相差 2 个自然日）。"]);
  assert.match(text, /【数据新鲜度检查/);
  assert.match(text, /必须在回答里点名滞后幅度/);
  assert.match(text, /不得写成「数据正常\/最新」/);
  assert.ok(text.indexOf("数据滞后：x") > text.indexOf("【数据新鲜度检查"), "核对结果原文在规则标题之后");
});

// ---------- P8-② 结论契约 ----------

/** 造一份最小可判的 Decision：契约层只按字段读，不重算任何分 */
function fakeDecision(over: Partial<Decision> = {}): Decision {
  const d = (key: Decision["dimensions"][number]["key"], raw: number | null, norm: number | null) => ({
    key, score: raw, raw_score: raw, norm_score: norm, bounds: null, rule_version: `r.${key}.v1`,
    items: [], missing: [], status: "REAL" as const,
  });
  return {
    protocol_version: "p7.decision.v3",
    subject: "600519.SH",
    final_score: 32.6,
    grade: "偏强看多",
    single_side: false,
    conflict: null,
    statement: "测试用结论",
    dimensions: [d("technical", 18, 36), d("probability", null, null), d("market", 12, 24), d("event", 5, 10)],
    included: ["technical", "market", "event"],
    excluded: [{ key: "probability", reason: "缺读数" }],
    weights: { requested: {} as never, applied: {} as never, renormalized: false },
    layers: ["REAL"],
    attainable: { min: -88.75, max: 100, unreachable_grades: [] },
    sources: [],
    basis: "test",
    ...over,
  } as Decision;
}

function fakeView(decision: Decision) {
  return {
    decision,
    as_of: "2026-09-21 09:40:00",
    trade_date: "2026-09-21",
    wiring: { technical_bar_date: "2026-09-18" },
  };
}

test("契约闸（风险点 3）：只有个股研判场景建契约，纯行情查询与其余场景一律不注入", () => {
  assert.equal(shouldBuildDecisionContract("stock_analysis"), true);
  for (const s of ["quote", "market_overview", "general", "sector", "", "Stock_Analysis", "stockanalysis"]) {
    assert.equal(shouldBuildDecisionContract(s), false, `场景 ${JSON.stringify(s)} 不该走结论卡这条路`);
  }
});

test("renderDecisionContract：键序固定、两次渲染逐字节一致；字段一格不少", () => {
  const view = fakeView(fakeDecision());
  const a = renderDecisionContract(view);
  const b = renderDecisionContract(view);
  assert.equal(a, b);
  const obj = JSON.parse(a) as Record<string, unknown>;
  assert.deepEqual(Object.keys(obj), [
    "protocol_version", "grade_mapping_version", "subject", "final_score", "grade",
    "dimensions", "as_of", "trade_date", "technical_bar_date",
  ]);
  assert.equal(obj.final_score, 32.6);
  assert.equal(obj.grade, "偏强看多");
  assert.equal(obj.technical_bar_date, "2026-09-18");
  const dims = obj.dimensions as { key: string; label: string; raw_score: number | null; norm_score: number | null }[];
  assert.equal(dims.length, 4);
  assert.equal(dims[0].label, "技术结构");
  assert.equal(dims[1].norm_score, null, "算不出的维保持 null，不拿 0 冒充");
  // subject 缺省时交 null，不拿代码凑
  assert.equal(buildDecisionContract(fakeView(fakeDecision({ subject: null }))).subject, null);
});

test("extractContractCitations：只认明确挂词的引用，普通行文里的数字不误伤", () => {
  const cites = extractContractCitations("本轮综合得分 32.6，技术面得分 18，市场面折算得分 24.0，趋势等级为偏强看多。涨停了 12 家，成交额 4500 亿。");
  const finals = cites.filter((c) => c.target === "final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].cited, 32.6);
  const grades = cites.filter((c) => c.target === "grade");
  assert.equal(grades.length, 1);
  assert.equal(grades[0].cited_text, "偏强看多");
  const dims = cites.filter((c) => c.target === "technical" || c.target === "market");
  assert.deepEqual(dims.map((c) => c.cited).sort((x, y) => x! - y!), [18, 24]);
  // 「12 家」「4500 亿」没挂得分字样：不算引用（宁可漏报不误判）
  assert.ok(!cites.some((c) => c.cited === 12 || c.cited === 4500));
  // 负号要带得出来：「综合得分 −12.5」在文本里是全角Minus…用半角测
  assert.equal(extractContractCitations("综合得分 -12.5")[0].cited, -12.5);
  assert.deepEqual(extractContractCitations(""), []);
});

test("verifyContractCitations：一致放行；不一致、错档报违规；引用位数少的按四舍五入等价", () => {
  const contract = buildDecisionContract(fakeView(fakeDecision()));
  assert.deepEqual(verifyContractCitations("综合得分 32.6，趋势等级偏强看多，技术面得分 18。", contract), []);
  // 四舍五入等价：写 33 对上 32.6 是显示精度，不是造假；写 35 就不是精度问题了
  assert.deepEqual(verifyContractCitations("综合得分 33", contract), []);
  const bad = verifyContractCitations("综合得分 35", contract);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].engine_value, "32.6");
  // 维度：raw 或 norm 任一对上即通过（模型引用哪一层的数都合法）
  assert.deepEqual(verifyContractCitations("技术面得分 36", contract), [], "norm 对上");
  assert.equal(verifyContractCitations("技术面得分 90", contract).length, 1);
  // 算不出的维（norm/raw 都 null）不拿它当违规依据
  assert.deepEqual(verifyContractCitations("历史概率得分 50", contract), []);
  // 等级：六档词表里挂了「等级」字样才算引用；与契约不同即违规
  const gradeBad = verifyContractCitations("趋势等级：强势看多", contract);
  assert.equal(gradeBad.length, 1);
  assert.equal(gradeBad[0].engine_value, "偏强看多");
  // 引擎没判出等级（grade null）：不拿空契约误判
  const noGrade = buildDecisionContract(fakeView(fakeDecision({ grade: null, final_score: null })));
  assert.deepEqual(verifyContractCitations("趋势等级偏弱，综合得分 10", noGrade), []);
});

test("六档等级词表与契约同源：每个档位名单独挂「等级」都能被抽为引用", () => {
  for (const g of GRADE_ORDER) {
    const cites = extractContractCitations(`趋势等级为${g}。`);
    assert.ok(cites.some((c) => c.target === "grade" && c.cited_text === g), `档位 ${g} 应可被识别`);
  }
});

test("警告文案（风险点 4）：只公示不改动——文案必须写清「原文未被改动，也没有自动重答」", () => {
  const text = contractWarningText([{ field: "综合得分", cited_text: "综合得分 35", engine_value: "32.6" }]);
  assert.match(text, /结论契约校验/);
  assert.match(text, /以本地引擎为准/);
  assert.match(text, /模型原文未被改动，也没有自动重答/);
  assert.match(CONTRACT_QUOTE_RULE, /只能逐字引用契约里的值/);
  assert.match(CONTRACT_QUOTE_RULE, /\[本地决策结论卡\]/, "规则原文要指到注入块的位置，模型才找得到契约 JSON");
});

// ---------- 传输层与接线（源码文本断言：这些文件带网络/prisma，不可直测） ----------

test("stale 状态穿得过 SSE 解码：step 帧的 status 与词表两边同口径", () => {
  const ev = asStreamEvent(JSON.parse(JSON.stringify({
    type: "step",
    data: { step: 9, label: "比对真实交易日历核对日K新鲜度", status: "stale", source: "prefetch", detail: "数据滞后：x 只到 2026-09-16" },
  })));
  assert.ok(ev && ev.type === "step");
  assert.equal(ev.data.status, "stale");
  assert.equal(ev.data.source, "prefetch");
  // 认不出的状态退回 ok 的行为不变（不能让坏帧带崩已收到的回答）
  const bogus = asStreamEvent({ type: "step", data: { step: 1, label: "a", status: "weird" } });
  assert.ok(bogus && bogus.type === "step" && bogus.data.status === "ok");
});

test("scene-dispatch 接线：契约注入走闸、校验只出警告，两个端点两条传输都接上 contractWarningOf", () => {
  const dispatch = readSrc("src/lib/desk/scene-dispatch.ts");
  assert.match(dispatch, /shouldBuildDecisionContract\(intent\.scene\)/, "构建结论卡的入口条件必须过场景闸");
  assert.match(dispatch, /intent\.symbol/, "没有标的的研判不硬建契约");
  assert.match(dispatch, /buildDecisionWithTimeout/, "结论卡构建要有时间闸，不给对话加无上限的等待");
  assert.match(dispatch, /freshnessPromptRule/, "核对结果要进提示词纪律段");
  assert.match(dispatch, /status: freshness\.has_issues \? "stale" : "ok"/, "时间线要有新鲜度这一步");

  const chat = readSrc("src/app/api/ai/chat/route.ts");
  const proxy = readSrc("src/app/api/ai/proxy/route.ts");
  // chat：非流式 JSON 与流式 done 前各核一次（两条传输同口径）
  // P52 起非流式那处核的是「输出边界护栏清洗后的正文」（局部量 content，= guard.text 的兜底版本），口径不变（仍两条传输各核一次）
  assert.equal((chat.match(/contractWarningOf\(turn, (r\.content|guard\.text|content)\)/g) ?? []).length, 2, "chat 端点两条传输都要接契约校验");
  // proxy：流式 / 降级非流式 / 整体返回三处
  assert.equal((proxy.match(/contractWarningOf\(turn, (content|c2)\)/g) ?? []).length, 3, "proxy 端点三条路径都要接契约校验");
  // 风险点 4 的结构证据：校验点之后没有第二次模型调用（模型调用函数只在原有路径出现）
  const chatCalls = (chat.match(/runToolLoop\(/g) ?? []).length;
  assert.ok(chatCalls >= 1);
  assert.ok(!/contractWarningOf[\s\S]*?runToolLoop\(/.test(chat.slice(chat.lastIndexOf("contractWarningOf"))), "流式路径校验之后不得再触发模型调用（不自动重试）");
});

test("SceneTurn/PrefetchResult 的返回契约：contract/freshness 字段与 raws 收集在服务层落地", () => {
  const dispatch = readSrc("src/lib/desk/scene-dispatch.ts");
  assert.match(dispatch, /contract: DecisionContract \| null;/);
  assert.match(dispatch, /freshness: FreshnessReport \| null;/);
  assert.match(dispatch, /raws\.push\(\{ tool: call\.tool, args: call\.args, out \}\)/, "新鲜度要吃序列化前的原始结果，不能吃截断过的注入块");
  // 结论卡与交易日历并行：慢路先发起，快路取数时不排队
  assert.ok(dispatch.indexOf("buildDecisionWithTimeout(intent.symbol)") < dispatch.indexOf('fetchBarsHybridTracked(["000001.SH"]'), "结论卡构建必须先于日历取数发起（并行而非串行）");
});
