// P8 子轮 B（③ 技能插件体系 + ④ Agent Loop 闭环）回归测试。
//
// ③ 的口径是「表驱动重构，行为一字不变」：旧 p7-intent 的 25 条调度断言仍是总闸，
// 这里补的是「表」本身——注册项能被消费、坏注册被如实拒绝、required 标记与旧 switch 的必读集一致。
// ④ 的口径是「不足先补一轮，补不齐如实留痕」：判定全在 agent-loop-core 纯函数里，
// 用假 rows/missing 钉死对账、去重、按位配 why（不按工具名）这些容易说谎的点；
// 接线（scene-dispatch）与工具注册口（chat-tools）不可纯测，用源码文本断言钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyIntent, planDispatch, toolsForScene, type Intent } from "../../src/lib/desk/intent-core.ts";
import {
  BUILTIN_SKILLS, SKILLS, createSkillRegistry, registerSkill,
  DISPATCH_MAX_SYMBOLS, DISPATCH_ANALYSIS_MAX, type Skill,
} from "../../src/lib/desk/skills-core.ts";
import {
  AGENT_LOOP_MAX_ROUNDS, completenessVerdict, findRequiredGaps, mergeSupplement,
  planSupplementRound, stillMissingNote, type RequiredGap,
} from "../../src/lib/desk/agent-loop-core.ts";
import type { DispatchRow } from "../../src/lib/desk/dispatch-core.ts";

// 场景由 extra 显式钉住：这些用例测的是「表怎么被消费」，不该跟着词表哪天改了一个词一起漂
function intent(question: string, extra: Partial<Intent> = {}): Intent {
  return { ...classifyIntent({ question }), ...extra };
}

// ---------- ③ 注册表本体 ----------

test("内置技能表形状：13 个工具、plan 覆盖 6 个自动调度场景（P10 起含选股；R10 扩容加个股消息面）", () => {
  assert.equal(BUILTIN_SKILLS.length, 13, "与 chat-tools TOOLS 的注册项数一致（多了/少了都要两边同步改）");
  // 口径迁移（P10 择优轮，用户裁定改口径）：本条原钉「深水区与选股类工具不进自动调度
  // （预取＝替用户猜条件、每轮多打接口）」——factor_screener 按 aiwuchuan「候选池→择优」
  // 链路改为预取（抽不到的条件走默认活跃池并如实标注，不再替用户猜）；其余四个冷工具原样。
  for (const cold of ["stock_depth", "stock_trades", "historical_probability", "run_backtest"]) {
    assert.ok(BUILTIN_SKILLS.find((s) => s.name === cold), `${cold} 仍在技能表里（模型可自取）`);
    assert.ok(!BUILTIN_SKILLS.find((s) => s.name === cold)!.plan?.length, `${cold} 不参与自动调度`);
  }
  const fs = BUILTIN_SKILLS.find((s) => s.name === "factor_screener");
  assert.ok(fs?.plan?.some((e) => e.scene === "screener" && e.args === "screener_pool"), "选股场景现跑候选池");
  assert.ok(!SKILLS.requiredToolsForScene("screener").has("factor_screener"), "候选池不是必读项：池挂了走 missing 留痕，不触发补跑整池");
  assert.ok(!BUILTIN_SKILLS.some((s) => (s.plan ?? []).some((e) => e.scene === "qimen" || e.scene === "general")));
});

test("required 标记＝旧链路的「必读」口径：场景主数据 + 个股四件套（含消息面） + 自选总览", () => {
  assert.deepEqual([...SKILLS.requiredToolsForScene("sentiment")], ["market_sentiment"]);
  assert.deepEqual([...SKILLS.requiredToolsForScene("sector")], ["sector_rank"]);
  assert.deepEqual([...SKILLS.requiredToolsForScene("quote")], ["stock_snapshot"]);
  // R10 扩容：stock_news 进个股分析必读——用户口径「除了技术还要结合新闻回答我」，
  // 消息面从「gate 附加项」升为「每只票都要有的主数据」（3014 实测模型不会自己调，必须先替它到齐）。
  assert.deepEqual(
    [...SKILLS.requiredToolsForScene("stock_analysis")].sort(),
    ["stock_fund_flow", "stock_kline_summary", "stock_news", "stock_snapshot"],
  );
  assert.deepEqual([...SKILLS.requiredToolsForScene("watchlist")], ["watchlist_overview"]);
  // 快讯是 gate 附加项，缺了不算洞（用户没问消息面时它本来就不出场）
  assert.ok(!SKILLS.requiredToolsForScene("sentiment").has("market_news"));
  assert.equal(SKILLS.requiredToolsForScene("qimen").size, 0);
  assert.equal(SKILLS.requiredToolsForScene("general").size, 0);
});

test("注册新技能即生效：entriesForScene / requiredToolsForScene / prefersForScene 都读活表", () => {
  const reg = createSkillRegistry(BUILTIN_SKILLS);
  const skill: Skill = {
    name: "dragon_tiger_board",
    desc: "个股龙虎榜席位（示例扩展位）",
    plan: [{ scene: "stock_analysis", spread: "once", args: "empty", reason: "scene", required: true }],
  };
  assert.deepEqual(reg.register(skill), { ok: true });
  const r = planDispatch({ intent: intent("688256 怎么看", { scene: "stock_analysis", symbol: "688256.SH", symbols: ["688256.SH"] }) }, reg);
  assert.deepEqual(r.calls.map((c) => c.tool), ["stock_snapshot", "stock_kline_summary", "stock_fund_flow", "stock_news", "dragon_tiger_board"],
    "per_symbol 四件套照旧逐只成组，once 新项排在后面——加技能不改调度代码");
  assert.ok(reg.requiredToolsForScene("stock_analysis").has("dragon_tiger_board"));
  // 默认表看不到新技能：注册作用域跟着实例走，单例不被测试污染
  const plain = planDispatch({ intent: intent("688256 怎么看", { scene: "stock_analysis", symbol: "688256.SH", symbols: ["688256.SH"] }) });
  assert.deepEqual(plain.calls.map((c) => c.tool), ["stock_snapshot", "stock_kline_summary", "stock_fund_flow", "stock_news"]);
});

test("坏注册被如实拒绝：重名、缺描述、空名、指向不存在的场景，一律回原因不静默吞", () => {
  const reg = createSkillRegistry(BUILTIN_SKILLS);
  assert.match(reg.register({ name: "market_sentiment", desc: "顶替内置" }).error ?? "", /已注册，不静默覆盖/);
  assert.match(reg.register({ name: "no_desc" } as Skill).error ?? "", /缺 desc/);
  assert.match(reg.register({ name: "", desc: "空名" }).error ?? "", /非空字符串/);
  assert.match(
    reg.register({ name: "ghost", desc: "指向假场景", plan: [{ scene: "no_such_scene" as never, spread: "once", args: "empty", reason: "scene" }] }).error ?? "",
    /不存在的场景/,
  );
  assert.equal(reg.get("ghost"), undefined, "被拒的注册不得留下半个实例");
});

test("单例注册口可用且不破坏既有场景：只登记无 plan 的自取工具", () => {
  const r = registerSkill({ name: "p8test_self_serve_only", desc: "只被模型自取的示例技能" });
  assert.deepEqual(r, { ok: true });
  assert.equal(SKILLS.get("p8test_self_serve_only")?.desc, "只被模型自取的示例技能");
  assert.equal(SKILLS.entriesForScene("quote").every((e) => e.tool !== "p8test_self_serve_only"), true, "无 plan = 永不进自动调度");
  assert.match(registerSkill({ name: "p8test_self_serve_only", desc: "重名" }).error ?? "", /已注册/);
});

test("toolsForScene 也走注册表：换一份 prefers 表，推荐工具就跟着换（模型自取面同样可插拔）", () => {
  const reg = createSkillRegistry(BUILTIN_SKILLS, undefined, { sector: ["sector_rank", "dragon_tiger"] });
  assert.deepEqual(toolsForScene("sector", reg), ["sector_rank", "dragon_tiger"]);
  assert.deepEqual(toolsForScene("sector"), ["sector_rank", "market_sentiment"], "默认表保持旧口径");
});

test("场景级参数在表里不在代码里：个股分析 symbol_max=3，全局上限 5 仍兜底", () => {
  const many = ["1.SH", "2.SH", "3.SH", "4.SH", "5.SH", "6.SH"];
  const analysis = planDispatch({ intent: intent("1 2 3 4 5 6 怎么看", { scene: "stock_analysis", symbols: many }) });
  // R10 扩容：每只票的预取从三件套变四件套（+stock_news 消息面），上限 3 只的口径不变
  assert.equal(analysis.calls.length, DISPATCH_ANALYSIS_MAX * 4, "分析场景按场景上限展开，不是全局上限");
  const quote = planDispatch({ intent: intent("现价", { scene: "quote", symbols: many }) });
  assert.equal(quote.calls.length, DISPATCH_MAX_SYMBOLS);
  assert.ok(quote.skipped.some((s) => s.includes(`只取前 ${DISPATCH_MAX_SYMBOLS} 个`)));
});

// ---------- ④ 完整性校验与补充轮（纯函数 + 假数据） ----------

const CALLS = [
  { tool: "stock_snapshot", args: { symbol: "688256.SH" }, reason: "按场景取快照" },
  { tool: "stock_kline_summary", args: { symbol: "688256.SH" }, reason: "取日 K" },
  { tool: "stock_fund_flow", args: { symbol: "688256.SH" }, reason: "取资金流" },
];
const REQUIRED = new Set(["stock_snapshot", "stock_kline_summary", "stock_fund_flow"]);

function row(tool: string, ok: boolean): DispatchRow {
  return { tool, ok, text: ok ? `${tool} 数据（假）` : "缺失：接口失败" };
}

test("findRequiredGaps：必读项按计划位次定位缺口，missIdx 与 missing 数组对位", () => {
  const rows = [row("stock_snapshot", true), row("stock_kline_summary", false), row("stock_fund_flow", true)];
  const missing = [{ tool: "stock_kline_summary", why: "调用失败：东财接口超时" }];
  const gaps = findRequiredGaps({ calls: CALLS, rows, missing, required: REQUIRED });
  assert.deepEqual(gaps, [{ idx: 1, tool: "stock_kline_summary", why: "调用失败：东财接口超时", missIdx: 0 }]);
});

test("findRequiredGaps：非必读项缺了不算洞；账对不上（非 ok 行数 ≠ missing 条数）时不猜、返空", () => {
  const rows = [row("stock_snapshot", true), row("market_news", false), row("stock_fund_flow", true)];
  const missing = [{ tool: "market_news", why: "调用失败" }];
  assert.deepEqual(findRequiredGaps({ calls: [{ ...CALLS[0] }, { tool: "market_news", args: {}, reason: "r" }, { ...CALLS[2] }], rows, missing, required: REQUIRED }), []);
  // 对不上账：2 个非 ok 行、1 条 missing —— 编排层被改坏的信号，宁可保持原清单
  const broken = [row("stock_snapshot", false), row("stock_kline_summary", false), row("stock_fund_flow", true)];
  assert.deepEqual(findRequiredGaps({ calls: CALLS, rows: broken, missing: [{ tool: "stock_snapshot", why: "x" }], required: REQUIRED }), []);
  assert.deepEqual(findRequiredGaps({ calls: CALLS, rows: [row("stock_kline_summary", false)], missing: [], required: REQUIRED }), [], "空 rows 直接返空");
});

test("planSupplementRound：只重跑缺项、args 深拷贝原样、理由写明轮次与上一轮话术", () => {
  const gaps: RequiredGap[] = [
    { idx: 1, tool: "stock_kline_summary", why: "调用失败：东财接口超时", missIdx: 0 },
    { idx: 2, tool: "stock_fund_flow", why: "缺失：非交易时段", missIdx: 1 },
  ];
  const plan = planSupplementRound(gaps, CALLS);
  assert.deepEqual(plan.map((c) => c.tool), ["stock_kline_summary", "stock_fund_flow"], "整批重跑等于把行情接口再打一遍");
  assert.deepEqual(plan[0].args, { symbol: "688256.SH" });
  assert.notEqual(plan[0].args, CALLS[1].args, "args 必须是拷贝：补充轮改参数不能回头污染首轮计划");
  assert.equal(plan[1].reason, "补充调用（第 2 轮）：上一轮缺失：非交易时段");
  // 同一 idx 出现两次（理论上不该，来了也不重复打接口）
  assert.equal(planSupplementRound([gaps[0], { ...gaps[0] }], CALLS).length, 1);
  assert.equal(AGENT_LOOP_MAX_ROUNDS, 2, "上限一轮含首轮：502 风暴期补三轮也只是三轮失败");
});

test("mergeSupplement：补到的顶掉缺口行、清单里摘掉；仍旧缺的两轮话术都留底", () => {
  const rows = [row("stock_snapshot", true), row("stock_kline_summary", false), row("stock_fund_flow", true)];
  const missing = [{ tool: "stock_kline_summary", why: "调用失败：东财接口超时" }];
  const gaps = [{ idx: 1, tool: "stock_kline_summary", why: "调用失败：东财接口超时", missIdx: 0 }];
  const fixed = mergeSupplement({ rows, missing }, gaps, { rows: [row("stock_kline_summary", true)], missing: [] });
  assert.equal(fixed.rows[1].ok, true, "注入块里要有这份补回来的真数据");
  assert.deepEqual(fixed.missing, [], "补到了就不能再留在未取到清单");
  assert.equal(fixed.rows[0], rows[0], "与缺口无关的行原样保留");

  const still = mergeSupplement({ rows, missing }, gaps, { rows: [row("stock_kline_summary", false)], missing: [{ tool: "stock_kline_summary", why: "调用失败：仍超时" }] });
  assert.equal(still.missing.length, 1);
  assert.equal(still.missing[0].why, "补充后仍缺：调用失败：仍超时（首轮：调用失败：东财接口超时）", "两轮留底，不粉饰成一次失败");
});

test("mergeSupplement 按位配 why，不按工具名：同批重试两只票的快照，各自的洞各自的因", () => {
  const calls = [
    { tool: "stock_snapshot", args: { symbol: "688256.SH" }, reason: "r" },
    { tool: "stock_snapshot", args: { symbol: "600519.SH" }, reason: "r" },
  ];
  const rows = [row("stock_snapshot", false), row("stock_snapshot", false)];
  const missing = [
    { tool: "stock_snapshot", why: "688256 停牌" },
    { tool: "stock_snapshot", why: "600519 接口超时" },
  ];
  const gaps = findRequiredGaps({ calls, rows, missing, required: new Set(["stock_snapshot"]) });
  assert.equal(gaps.length, 2);
  const second = {
    rows: [row("stock_snapshot", false), row("stock_snapshot", false)],
    missing: [
      { tool: "stock_snapshot", why: "688256 仍无数据" },
      { tool: "stock_snapshot", why: "600519 恢复失败" },
    ],
  };
  const merged = mergeSupplement({ rows, missing }, gaps, second);
  assert.deepEqual(merged.missing.map((m) => m.why), [
    "补充后仍缺：688256 仍无数据（首轮：688256 停牌）",
    "补充后仍缺：600519 恢复失败（首轮：600519 接口超时）",
  ], "按名字 find 会把第一只的因安到第二只头上——这是最典型的「说谎」形状");
});

test("completenessVerdict / stillMissingNote：齐与不齐都只陈述事实", () => {
  assert.deepEqual(completenessVerdict([], 3), { status: "ok", detail: "3 项必读读数齐（首轮）" });
  const gaps: RequiredGap[] = [{ idx: 1, tool: "stock_kline_summary", why: "调用失败：超时", missIdx: 0 }];
  const v = completenessVerdict(gaps, 3);
  assert.equal(v.status, "missing");
  assert.match(v.detail, /必读 3 项里缺 1 项：stock_kline_summary（调用失败：超时），做一轮补充调用/);
  assert.equal(stillMissingNote(gaps, { rows: [row("stock_kline_summary", true)] }), null, "补齐了就别留「仍缺」的谎");
  const note = stillMissingNote([...gaps, { idx: 2, tool: "stock_fund_flow", why: "w", missIdx: 1 }], { rows: [row("x", false), row("y", false)] });
  assert.match(note ?? "", /补充调用后仍缺 2 项必读读数：stock_kline_summary、stock_fund_flow/);
  assert.match(stillMissingNote(gaps, { rows: [] }) ?? "", /仍缺 1 项/, "补充轮整轮没回（断开）也按仍缺处理");
});

// ---------- 接线：判定不外溢（源码文本断言） ----------

const sceneSrc = readFileSync(new URL("../../src/lib/desk/scene-dispatch.ts", import.meta.url), "utf8");
const intentSrc = readFileSync(new URL("../../src/lib/desk/intent-core.ts", import.meta.url), "utf8");
const toolsSrc = readFileSync(new URL("../../src/lib/desk/chat-tools.ts", import.meta.url), "utf8");

test("③ 表驱动落地：planDispatch 从注册表取条目，服务/判定层没有第二张表", () => {
  const body = intentSrc.slice(intentSrc.indexOf("export function planDispatch"));
  assert.match(body, /registry\.entriesForScene\(intent\.scene\)/, "调度条目必须来自注册表");
  assert.match(body, /registry\.configForScene\(intent\.scene\)/, "场景参数（symbol_max/skip）必须来自表");
  assert.ok(!/"stock_kline_summary"|"watchlist_overview"|"market_news"/.test(body.split("renderDispatchBlock")[0]),
    "planDispatch 里再出现工具名字面量＝表和 switch 各一套，漂移开始");
  assert.match(intentSrc, /import \{[\s\S]{0,120}SKILLS, DISPATCH_MAX_SYMBOLS, DISPATCH_ANALYSIS_MAX,[\s\S]{0,160}\} from "\.\/skills-core\.ts"/);
  assert.match(intentSrc, /export function toolsForScene\(scene: Scene, registry: SkillRegistry = SKILLS\)/);
});

test("④ 接线在预取之后、注入之前：校验步进时间线、补充轮复用同一 execute 与步骤号", () => {
  assert.match(sceneSrc, /import \{ completenessVerdict, findRequiredGaps, mergeSupplement, planSupplementRound, stillMissingNote \} from "\.\/agent-loop-core"/);
  assert.match(sceneSrc, /const required = SKILLS\.requiredToolsForScene\(opts\.intent\.scene\);/);
  assert.match(sceneSrc, /label: "校验本轮取数完整性（必读读数逐项对账）"/, "校验本身要在时间线上看得见（⑤ 要靠步骤重放链路）");
  assert.match(sceneSrc, /reason: "P8-④：不足先补一轮再进综合分析，不拿缺口当齐备下结论"/);
  assert.match(sceneSrc, /if \(gaps\.length && !opts\.isCancelled\?\.\(\)\)/, "客户端断开就不再补，和首轮同一条取消语义");
  assert.match(sceneSrc, /stepStart: stepNo/, "补充轮步骤号接着首轮往下编，两套不能都从 1 开始");
  assert.match(sceneSrc, /const merged = mergeSupplement\(\{ rows, missing \}, gaps, r2\);[\s\S]{0,120}rows = merged\.rows;[\s\S]{0,60}missing = merged\.missing;/);
  assert.match(sceneSrc, /if \(still\) skipped\.push\(still\)/, "补不齐的要在「本轮没做成什么」里看得到");
  // 补充轮走的是同一个 execute：新鲜度 raws 自动包含补回来的 kline/fund 原始结果
  assert.equal((sceneSrc.match(/execute,/g) ?? []).length, 2, "首轮与补充轮共用同一份 execute 闭包");
  assert.match(sceneSrc, /raws\.push\(\{ tool: call\.tool, args: call\.args, out \}\)/, "A 轮口径不破：新鲜度仍吃序列化前的原始结果");
});

test("chat-tools 注册口：校验形状、拒重名、不静默覆盖；读活表所以注册即生效", () => {
  assert.match(toolsSrc, /export function registerChatTool\(tool: ChatTool\): \{ ok: boolean; error\?: string \}/);
  assert.match(toolsSrc, /已注册，不静默覆盖/);
  assert.match(toolsSrc, /缺 params（JSON schema）/);
  assert.match(toolsSrc, /TOOLS\.push\(tool\)/);
  assert.match(toolsSrc, /findTool\(/, "findTool 读 TOOLS 本体：注册后模型下一轮就能看见");
});
