// P6-D② Agent 循环控制内核测试（纯内核：不调模型、不取数、不写库）。
//
// 对应任务书 §十七/§十六/§十八/§十九 与 §二十九 里「Agent tool selection / retry / loop limit /
// fallback / evidence lineage / REAL_DATA_ONLY regression」这些条目——全都用可断言的形式钉住：
// 「受控」不是文案，是超预算时 admitCall 必须返回 allowed=false 且不再打上游。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_PROTOCOL_VERSION, BUDGET_HARD_CAPS, DEFAULT_AGENT_BUDGET, LOG_STATUSES,
  AGENT_STOP_REASONS, AGENT_STOP_REASON_TEXT, LOG_STATUS_TEXT, OBS_KIND_TEXT,
  FAILURE_TEXT, LOG_FIELDS, AGENT_FAILURE_KINDS, agentLedgerText, agentToolSummary, admitCall, buildAgentSystemPrompt,
  buildAgentTurnPrompt, buildAgentFinalTurnText, budgetRemaining, classifyDeadEnd, evidenceLayerOf, extractRefs, lineageOf, logStatusOf, nextAction,
  normalizeBudget, parseAgentDirective, recordCall, startRun, summarizeRun, verifyAgentAnswer,
  type AgentState, type RecordInput,
} from "../../src/lib/quant/screener/agent-loop-core.ts";
import type { ObservationKind } from "../../src/lib/quant/screener/datastatus-core.ts";
import { canonicalCallKey } from "../../src/lib/quant/screener/agent-tools-core.ts";

const T0 = 1_000_000;
const NOW = "2026-09-20 10:00:00";

function fresh(over: { question?: string; budget?: unknown } = {}): { state: AgentState; notes: string[] } {
  return startRun({ run_id: "r1", question: over.question ?? "为什么今天半导体板块这么强？", budget: over.budget, started_at: NOW, started_ms: T0 });
}

/** 走一遍「请求→准入→记账」的正常路径，返回新 state */
function call(state: AgentState, tool: string, args: Record<string, unknown>, res: Partial<RecordInput> = {}): { state: AgentState; entry: ReturnType<typeof recordCall>["entry"] } {
  const a = admitCall(state, tool, args, T0 + 1000);
  assert.equal(a.allowed, true, `准入被拒：${a.reason}`);
  return recordCall(state, {
    tool, input: args, output_status: "ok", kind: "value",
    call_key: a.call_key, timestamp: NOW, ...res,
  });
}

// ---------- §十七 预算 ----------

test("P6-D② §十七：默认预算就是任务书推荐值，且每项都有硬上限", () => {
  assert.equal(DEFAULT_AGENT_BUDGET.max_tool_calls, 12);
  assert.equal(DEFAULT_AGENT_BUDGET.max_retries_per_tool, 2);
  for (const k of Object.keys(DEFAULT_AGENT_BUDGET) as (keyof typeof DEFAULT_AGENT_BUDGET)[]) {
    assert.ok(DEFAULT_AGENT_BUDGET[k] > 0, `${k} 必须有正值`);
    assert.ok(BUDGET_HARD_CAPS[k] >= DEFAULT_AGENT_BUDGET[k], `${k} 硬上限不能小于默认值`);
    assert.ok(Number.isFinite(BUDGET_HARD_CAPS[k]) && BUDGET_HARD_CAPS[k] > 0, `${k} 必须有明确上限（不能 unlimited）`);
  }
});

test("P6-D② §十七：预算入参非法不静默接受（0/负数/无限/字符串都回落并说明）", () => {
  assert.deepEqual(normalizeBudget(undefined).budget, DEFAULT_AGENT_BUDGET);
  assert.deepEqual(normalizeBudget({}).budget, DEFAULT_AGENT_BUDGET);
  const zero = normalizeBudget({ max_tool_calls: 0 });
  assert.equal(zero.budget.max_tool_calls, 12, "0 次调用等于关掉循环，不能当成合法预算");
  assert.ok(zero.notes.some((n) => /不是正整数/.test(n)), zero.notes.join(" / "));

  const neg = normalizeBudget({ max_steps: -3 });
  assert.equal(neg.budget.max_steps, DEFAULT_AGENT_BUDGET.max_steps);
  assert.ok(neg.notes.length === 1 && /步数/.test(neg.notes[0]), neg.notes.join(" / "));

  const inf = normalizeBudget({ max_total_ms: Number.POSITIVE_INFINITY });
  assert.equal(inf.budget.max_total_ms, DEFAULT_AGENT_BUDGET.max_total_ms, "Infinity 会被当成「没有时间预算」，必须回落");

  const over = normalizeBudget({ max_tool_calls: 9999, max_steps: 9999 });
  assert.equal(over.budget.max_tool_calls, BUDGET_HARD_CAPS.max_tool_calls, "超上限的必须被钳住");
  assert.equal(over.budget.max_steps, BUDGET_HARD_CAPS.max_steps);
  assert.ok(over.notes.some((n) => /硬上限/.test(n)) && over.notes.length === 2, over.notes.join(" / "));

  const junk = normalizeBudget("12");
  assert.deepEqual(junk.budget, DEFAULT_AGENT_BUDGET, "整个预算不是对象时回落默认，不猜它想给多少");
});

// ---------- §十六 碰壁分类 ----------

test("P6-D② §十六：六种碰壁判断各归各位，措辞不互相冒充", () => {
  assert.deepEqual([...AGENT_FAILURE_KINDS], ["bad_params", "no_data", "source_failed", "not_supported", "timeout", "budget"]);
  const bad = classifyDeadEnd({ tool: "stock_quote", params_invalid: ["symbols 缺失：代码数组"] });
  assert.equal(bad.failure, "bad_params");
  assert.equal(bad.next_action, "fix_params");
  assert.match(bad.reason, /symbols 缺失/);
  assert.equal(bad.retryable, true, "参数错了改对再试是有意义的");

  const failed = classifyDeadEnd({ tool: "stock_quote", kind: "request_failed", error: "腾讯报价未取得数据", budget_left: { steps: 3, tool_calls: 6, ms: 5000, retries_left: 1 } });
  assert.equal(failed.failure, "source_failed");
  assert.equal(failed.retryable, true);
  assert.equal(failed.next_action, "retry_same_tool");
  assert.match(FAILURE_TEXT.source_failed, /不显示为 0/, "数据源失败不能说成 0");

  const empty = classifyDeadEnd({ tool: "radar", kind: "no_data", error: "库里确实没有行" });
  assert.equal(empty.failure, "no_data");
  assert.equal(empty.retryable, false, "空返回重跑一次不会变出数据");
  assert.notEqual(empty.failure, "source_failed", "「没有内容」与「取数失败」是两件事");

  const unsup = classifyDeadEnd({ tool: "probability", not_supported: "probability 当前不可由 Agent 执行：新算要对全 universe 回放" });
  assert.equal(unsup.failure, "not_supported");
  assert.deepEqual(unsup.fallback_tools, ["snapshot_probability"], "「不支持」不等于此路不通：登记表里写了留档读法就要指过去（§二十 AI 可查询 probability）");
  assert.equal(unsup.next_action, "try_fallback");
  assert.match(unsup.user_note, /还有兜底工具：snapshot_probability/);

  const dead = classifyDeadEnd({ tool: "northbound_flow", not_supported: "没有可靠的免费北向净买入口径（登记表里就是 not_covered）" });
  assert.equal(dead.next_action, "answer_with_gap");
  assert.deepEqual(dead.fallback_tools, [], "登记表没写兜底源就是真没有，不能现编一个");
  assert.match(dead.user_note, /当前缺少 northbound_flow 的数据/, "碰壁到底要说「缺少 X，因此无法验证 Y」");
  assert.match(dead.user_note, /没有可用的兜底源，因此与之相关的结论无法验证/);

  const to = classifyDeadEnd({ tool: "stock_kline", timed_out: true, budget_left: { steps: 1, tool_calls: 2, ms: 100, retries_left: 0 } });
  assert.equal(to.failure, "timeout");
  assert.equal(to.retryable, false, "重试预算没了就不该再试");
  assert.equal(to.next_action, "answer_with_gap");
});

test("P6-D② §十六：Tool A failed → fallback Tool B 的链路是登记表给的，不自己编", () => {
  const a = classifyDeadEnd({ tool: "risk", kind: "request_failed", error: "引擎超时", budget_left: { steps: 2, tool_calls: 4, ms: 900, retries_left: 0 } });
  assert.equal(a.has_fallback, true);
  assert.deepEqual(a.fallback_tools, ["snapshot_risk"]);
  assert.equal(a.next_action, "try_fallback");
  assert.match(a.user_note, /还有兜底工具：snapshot_risk/, "有兜底时不能说「无法验证」");
  const none = classifyDeadEnd({ tool: "stock_kline", kind: "request_failed", error: "两条通道都没返回" });
  assert.deepEqual(none.fallback_tools, []);
  assert.equal(none.next_action, "answer_with_gap");
  assert.match(none.user_note, /没有可用的兜底源/);
});

// ---------- §十七 + §三十二：准入判定 ----------

test("P6-D② §十七：不存在的工具与被禁的工具都在准入这步被挡下", () => {
  const { state } = fresh();
  const unknown = admitCall(state, "order_buy", {}, T0);
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.failure, "not_supported");
  assert.match(unknown.reason, /capability 不支持/);
  const disabled = admitCall(state, "probability", {}, T0);
  assert.equal(disabled.allowed, false);
  assert.match(disabled.reason, /不可由 Agent 执行/);
  const mutating = admitCall(state, "mcp_tools", { server: "x", tool: "y" }, T0);
  assert.equal(mutating.allowed, false, "MCP 执行通道是 mutating 能力，准入这步就要拒掉");
  assert.match(mutating.reason, /mutating=true/);
});

test("P6-D② §十七：参数错误不消耗调用预算，也不打上游", () => {
  const { state } = fresh();
  const a = admitCall(state, "stock_quote", { symbols: ["688256"] }, T0);
  assert.equal(a.allowed, false);
  assert.equal(a.failure, "bad_params");
  assert.match(a.reason, /后缀必填/);
  assert.equal(a.call_key, "", "参数不合法时不该产生缓存键（否则会把错误入参记成已取过）");
  assert.equal(state.tool_calls, 0);
});

test("P6-D② §三十二：相同参数的第二次请求命中缓存，不再打上游", () => {
  let { state } = fresh();
  const out = call(state, "radar", { state: "live" }, {
    source: "radar_finding 表", as_of: "2026-09-18", data_status: "REAL",
    summary: "雷达当日 13 条 live 信号", payload: { finding_id: "RF-1", rows: 13 },
  });
  state = out.state;
  assert.equal(state.evidence.length, 1);
  const key = canonicalCallKey("radar", { state: "live" });
  assert.equal(state.cache[key], state.evidence[0].line.id);

  const again = admitCall(state, "radar", { state: "live" }, T0 + 2000);
  assert.equal(again.allowed, false, "重复调用检测：同参数第二次不该被放行");
  assert.equal(again.failure, null, "命中缓存不是失败，不能说成取数失败");
  assert.equal(again.cached_from, "F01");
  assert.match(again.reason, /不重复打上游/);

  const before = state.tool_calls;
  const reused = recordCall(state, { tool: "radar", input: { state: "live" }, output_status: "cached", call_key: key, cached_from: "F01", timestamp: NOW });
  assert.equal(reused.state.tool_calls, before, "缓存命中不计入工具调用预算");
  assert.equal(reused.entry.evidence_id, "F01");
  assert.equal(reused.state.evidence.length, 1, "同一条读数不能被记两行台账");

  const other = admitCall(reused.state, "radar", { state: "all" }, T0 + 3000);
  assert.equal(other.allowed, true, "参数不同就是另一次取数，不能被缓存误伤");
});

test("P6-D② §十七：三种预算各自能触发停止，且停止后不再放行任何调用", () => {
  const steps = fresh({ budget: { max_steps: 1 } }).state;
  const r1 = call(steps, "events", {}, { source: "global_event 表", as_of: "2026-09-18", data_status: "REAL", summary: "今日事件 7 条入库" });
  assert.equal(nextAction(r1.state, T0 + 1000).reason, "max_steps");
  const blocked = admitCall(r1.state, "radar", {}, T0 + 1000);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /步数预算已用满/);

  const calls = fresh({ budget: { max_tool_calls: 1 } }).state;
  const c1 = call(calls, "events", {}, { source: "global_event 表", as_of: "2026-09-18", data_status: "REAL", summary: "今日事件 7 条入库" });
  const c2 = admitCall(c1.state, "radar", {}, T0 + 1000);
  assert.equal(c2.allowed, false);
  assert.match(c2.reason, /工具调用预算已用满（1 次，§十七）/, c2.reason);

  const timey = fresh({ budget: { max_total_ms: 1000 } }).state;
  const left = budgetRemaining(timey, T0 + 5000);
  assert.equal(left.ms, 0);
  const late = admitCall(timey, "events", {}, T0 + 5000);
  assert.equal(late.allowed, false);
  // 整轮总时长用尽 = 这条调用根本没被执行（被预算挡在准入阶段）⇒ 归 budget，不许冒充 timeout：
  // timeout 说的是「某一次调用真的打上游并超时」，两者在页面上的文案与统计口径不同（§十七/§三十一）。
  // 也不许归 no_data：那是「请求成功但本次没有内容」，而这里连请求都没发。
  assert.equal(late.failure, "budget", "整轮总时长用尽必须归 budget，不是 timeout/no_data");
  assert.match(late.reason, /总时长预算/);
  assert.match(late.reason, /不是某一次调用超时/, "原因原文要自己说清这不是单次超时：页面只照抄，不另拼一句");
});

test("P6-D② §十七：同一工具的重试上限独立计数，用尽后要指兜底", () => {
  let { state } = fresh({ budget: { max_retries_per_tool: 1 } });
  const fail = (s: AgentState) => {
    const a = admitCall(s, "stock_quote", { symbols: ["688256.SH"] }, T0);
    assert.equal(a.allowed, true, "本次还该放行");
    return recordCall(s, { tool: "stock_quote", input: { symbols: ["688256.SH"] }, output_status: "failed", kind: "request_failed", call_key: a.call_key, error: "网关未运行", timestamp: NOW }).state;
  };
  state = fail(state);
  state = fail(state);
  const third = admitCall(state, "stock_quote", { symbols: ["688256.SH"] }, T0 + 500);
  assert.equal(third.allowed, false);
  assert.match(third.reason, /达到重试上限/, third.reason);
  assert.match(third.reason, /请改走兜底：market_snapshot/, "重试上限到了要给出下一步，而不是让模型原地打转");
  assert.equal(state.attempts_by_tool.stock_quote, 2);
});

test("P6-D② §三十二：连续 3 次没有新读数就判停摆（防止空转打上游）", () => {
  let { state } = fresh();
  const tools = ["events", "radar", "risk"];
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const a = admitCall(state, tool, {}, T0 + i * 1000);
    assert.equal(a.allowed, true);
    state = recordCall(state, { tool, input: {}, output_status: "failed", kind: "request_failed", call_key: a.call_key, error: `第 ${i + 1} 次取数失败`, timestamp: NOW }).state;
  }
  const stop = nextAction(state, T0 + 9000);
  assert.equal(stop.action, "stop");
  assert.equal(stop.reason, "no_progress");
  assert.match(stop.detail, /连续 3 次调用没有产生新读数/);
  // 一次成功就把计数清零：不能因为历史上失败过一次就永远停在「快停摆」状态
  const ok = call(state, "radar", { state: "live" }, { source: "radar_finding 表", as_of: "2026-09-18", data_status: "REAL", summary: "雷达当日 13 条 live 信号" });
  assert.equal(ok.state.consecutive_no_progress, 0);
});

// ---------- §十八 日志形状 ----------

test("P6-D② §十八：每条调用日志都答得出「调了什么/为什么/结果/有没有兜底」", () => {
  const { state } = fresh();
  const r = call(state, "sector_rank", { kind: "industry", size: 5 }, {
    source: "东财 clist（板块）", as_of: "2026-09-20 09:55", data_status: "REAL", latency_ms: 812,
    summary: "半导体板块涨 3.07%，主力净流入 182.2亿", thought: "先看板块资金排行确认强势是否资金驱动",
    payload: { board_code: "BK1036", name: "半导体" },
  });
  const e = r.entry;
  for (const f of LOG_FIELDS) {
    assert.ok(f in e, `日志缺 §十八 字段 ${f}`);
    assert.notEqual(e[f as keyof typeof e], undefined, `${f} 不能是 undefined（缺值要写 null 而不是没有这个键）`);
  }
  assert.equal(e.run_id, "r1");
  assert.equal(e.step, 1);
  assert.equal(e.tool, "sector_rank");
  assert.deepEqual(e.input, { kind: "industry", size: 5 });
  assert.equal(e.output_status, "ok");
  assert.equal(e.latency_ms, 812);
  assert.equal(e.source, "东财 clist（板块）");
  assert.equal(e.as_of, "2026-09-20 09:55");
  assert.equal(e.fallback_of, null, "本次是主源，兜底字段要显式为 null 而不是省略");
  assert.equal(e.error, null);
  assert.equal(e.timestamp, NOW);
  assert.equal(e.thought, "先看板块资金排行确认强势是否资金驱动");
  assert.equal(e.evidence_id, "F01");

  const fb = recordCall(r.state, {
    tool: "snapshot_risk", input: {}, output_status: "ok", kind: "value", call_key: "k2", timestamp: NOW,
    source: "risk_snapshot 表", as_of: "2026-09-18", data_status: "SNAPSHOT", summary: "风险留档 21 个分项",
    fallback_of: "risk", degraded_from: "risk", thought: "引擎超时，改读留档",
  });
  assert.equal(fb.entry.fallback_of, "risk", "Tool A failed → Tool B 的来路必须留在日志里");
  assert.equal(fb.entry.degraded_from, "risk");
  assert.equal(fb.entry.evidence_id, "H01", "SNAPSHOT 属历史证据层，编号走 H 前缀");
});

test("P6-D② §十八：失败与空各自留原文，且都进缺口清单（不静默丢）", () => {
  let { state } = fresh();
  const a = admitCall(state, "events", {}, T0);
  state = recordCall(state, { tool: "events", input: {}, output_status: "failed", kind: "request_failed", call_key: a.call_key, error: "本地库读取失败", timestamp: NOW }).state;
  const b = admitCall(state, "history_events", { date: "2026-01-05" }, T0 + 1000);
  state = recordCall(state, { tool: "history_events", input: { date: "2026-01-05" }, output_status: "empty", kind: "no_data", call_key: b.call_key, error: "库里 0 行", timestamp: NOW }).state;
  assert.equal(state.evidence.length, 0);
  assert.equal(state.missing.length, 2, state.missing.join(" / "));
  assert.match(state.missing[0], /events：本地库读取失败/);
  assert.match(state.missing[0], /登记表中无兜底源|兜底可试/);
  assert.match(state.missing[1], /history_events：库里 0 行/);
  assert.ok(state.missing[0] !== state.missing[1], "「取数失败」与「确实没有行」不能写成同一句");
});

// ---------- 台账与分层 ----------

test("P6-D② 分层：MISSING 不进台账，DERIVED/HISTORICAL 各归各层", () => {
  assert.equal(evidenceLayerOf("REAL"), "FACTS");
  assert.equal(evidenceLayerOf("DEGRADED"), "FACTS", "降级读数仍是事实，靠 data_status=DEGRADED 表达到层里");
  assert.equal(evidenceLayerOf("DERIVED"), "SIGNALS");
  assert.equal(evidenceLayerOf("AI_INTERPRETATION"), "SIGNALS");
  assert.equal(evidenceLayerOf("HISTORICAL"), "HISTORICAL_EVIDENCE");
  assert.equal(evidenceLayerOf("SNAPSHOT"), "HISTORICAL_EVIDENCE");
  assert.equal(evidenceLayerOf("MISSING"), null, "缺失是缺口，不是台账行");

  const { state } = fresh();
  const a = admitCall(state, "themes", {}, T0);
  const s1 = recordCall(state, { tool: "themes", input: {}, output_status: "ok", kind: "value", call_key: a.call_key, data_status: "MISSING", summary: "取数失败所以没有主线", timestamp: NOW });
  assert.equal(s1.state.evidence.length, 0, "被标成成功但分层 MISSING：不能编一行台账");
  assert.match(s1.state.missing[0], /分层是 MISSING/);

  const b = admitCall(s1.state, "limitup", {}, T0 + 1000);
  const s2 = recordCall(s1.state, { tool: "limitup", input: {}, output_status: "ok", kind: "value", call_key: b.call_key, data_status: "DERIVED", source: "引擎现算", as_of: "2026-09-20 10:00", timestamp: NOW });
  assert.match(s2.state.missing.join(" "), /成功但没有可引用的一行摘要/, "没有 summary 就不该凭空造一句");
  assert.equal(s2.state.evidence.length, 0);
});

test("P6-D② §十九：血缘把 Answer→Evidence→Tool→Data Source 串起来，业务主键可点回去", () => {
  let { state } = fresh();
  const a = admitCall(state, "radar", {}, T0);
  state = recordCall(state, {
    tool: "radar", input: {}, output_status: "ok", kind: "value", call_key: a.call_key,
    source: "radar_finding 表", as_of: "2026-09-18", data_status: "REAL", timestamp: NOW,
    summary: "雷达当日 13 条 live 信号，其中扩散阶段 4 条",
    payload: { items: [{ finding_id: "RF-9", title: "半导体扩散" }, { finding_id: "RF-10" }], max: 13 },
  }).state;
  const rec = state.evidence[0];
  assert.equal(rec.tool, "radar");
  assert.equal(rec.executor, "db.radar", "血缘要能回到执行器（哪条已有实现取的数据）");
  assert.deepEqual(rec.refs, ["finding_id=RF-9", "finding_id=RF-10"], "只抽白名单主键，不整包塞进血缘");
  assert.ok(extractRefs({ nested: { theme_id: "T7", secret: "x" } }, 3).includes("theme_id=T7"));
  assert.ok(!extractRefs({ secret: "x" }).length, "白名单外的字段不进血缘");
  assert.equal(extractRefs(Array.from({ length: 40 }, (_, i) => ({ event_id: `E${i}` })), 5).length, 5, "refs 有上限，防台账胀掉");

  const lin = lineageOf(["F01"], state.evidence);
  assert.deepEqual(lin.invalid, []);
  assert.equal(lin.used[0].tool, "radar");
  assert.equal(lin.used[0].source, "radar_finding 表");
  assert.equal(lin.used[0].data_status, "REAL");
  assert.equal(lin.used[0].step, 1);
  assert.deepEqual(lineageOf(["F99"], state.evidence).invalid, ["F99"], "编出来的引用要单独列出来");
});

// ---------- 协议与提示词 ----------

test("P6-D② 协议口径：没有原生 function-calling，工具调用靠文本内 JSON，且模型说什么不算数", () => {
  assert.equal(AGENT_PROTOCOL_VERSION, "p6d.agent.v1");
  const sys = buildAgentSystemPrompt("【可用工具】共 1 条\n- events（全球事件）");
  assert.match(sys, /只读、不取数、不写库、不下单、不改账户/);
  assert.match(sys, /只能输出一个 JSON 对象/);
  assert.match(sys, /capability 不支持/);
  assert.match(sys, /台账里没有的数字不能出现在结论里/);
  assert.match(sys, /禁止事项/, "AI 不得越过的动作清单要随提示词给出去");
  const summary = agentToolSummary();
  // 登记条目数：P6-D③ 加了 agent_run_history（读 Agent 自己的运行记录）⇒ 35。这条断言的意义是「目录数量被钉住」，改动登记表必须显式来这里更新一次
  assert.equal(summary.enabled, 35);
  assert.ok(summary.names.includes("sector_rank") && !summary.names.includes("mcp_tools"));
  assert.equal(summary.disabled.includes("probability"), true);
});

test("P6-D② 解析：合法指令、fenced 代码块、final、以及各种 invalid", () => {
  const t = parseAgentDirective('{"thought":"看板块","tool":"sector_rank","args":{"kind":"industry","size":5}}');
  assert.equal(t.kind, "tool");
  assert.deepEqual(t.tool, "sector_rank");
  assert.deepEqual((t as { args: unknown }).args, { kind: "industry", size: 5 });

  const fenced = parseAgentDirective("```json\n{\"tool\":\"events\",\"args\":{}}\n```");
  assert.equal(fenced.kind, "tool");
  assert.equal((fenced as { thought: string }).thought, "", "模型没给理由就是空串，不替它编一个「为了研究」");

  const f = parseAgentDirective('{"final":{"answer":"半导体强势有资金与主题两重支撑 [F01]","cites":["F01"],"gaps":["缺板块成交额"]}}');
  assert.equal(f.kind, "final");
  assert.deepEqual((f as { cites: string[] }).cites, ["F01"]);
  assert.deepEqual((f as { gaps: string[] }).gaps, ["缺板块成交额"]);

  const shorthand = parseAgentDirective('{"final":"一句话结论"}');
  assert.equal(shorthand.kind, "final");
  assert.equal((shorthand as { answer: string }).answer, "一句话结论");

  assert.equal(parseAgentDirective("我觉得应该看一下板块").kind, "invalid");
  assert.match((parseAgentDirective("我觉得应该看一下板块") as { error: string }).error, /没有可解析的 JSON 对象/);
  assert.match((parseAgentDirective('{"thought":"x"}') as { error: string }).error, /既没有 final 也没有 tool/);
  assert.match((parseAgentDirective('{"tool":"","args":{}}') as { error: string }).error, /既没有 final 也没有 tool/);
  assert.match((parseAgentDirective('{"tools":["events","radar"],"thought":"两个一起"}') as { error: string }).error, /既没有 final 也没有 tool/, "一步只能一个工具：数组形式的 tools 不被接受");
  assert.match((parseAgentDirective('{"final":{"cites":["F01"]}}') as { error: string }).error, /没有 answer 文本/);
  assert.match((parseAgentDirective('{"tool":"events","args":[]}') as { error: string }).error, /args 必须是 JSON 对象/);
});

test("P6-D② 提示词：预算、已调用记录、台账、缺口、协议五项都在，且引用格式与 P6-C 同一份", () => {
  let { state } = fresh({ budget: { max_steps: 4 } });
  const a = admitCall(state, "events", {}, T0);
  state = recordCall(state, { tool: "events", input: {}, output_status: "failed", kind: "request_failed", call_key: a.call_key, error: "本地库读取失败", thought: "先看当日事件", timestamp: NOW }).state;
  const b = admitCall(state, "themes", {}, T0 + 1000);
  state = recordCall(state, { tool: "themes", input: {}, output_status: "ok", kind: "value", call_key: b.call_key, source: "引擎现算", as_of: "2026-09-20 09:58", data_status: "DERIVED", summary: "主题共振命中半导体，扩散度 0.62", thought: "看主题是否共振", timestamp: NOW }).state;

  const prompt = buildAgentTurnPrompt(state, { now_ms: T0 + 2000, now: NOW });
  assert.match(prompt, /研究问题：为什么今天半导体板块这么强？/);
  assert.match(prompt, /剩余预算：步 2\/4｜工具调用 10\/12｜时长 118s｜台账 39\/40/, "给模型看的是「还剩多少」，不是配了多少");
  assert.match(prompt, /\[步 1\] events 第 1 次｜入参 \{\}｜理由：先看当日事件｜结果：failed｜本地库读取失败/);
  assert.match(prompt, /\[S01\]（/, "派生读数进 SIGNALS 层，编号沿用 P6-C 的 F/S/H");
  assert.match(prompt, /出处：引擎现算/);
  assert.match(prompt, /【已知缺口（本次没取到的，必须写进结论的 gaps，不能凭印象补）】\n1\. events：本地库读取失败/, "缺口要逐条编号喂回模型，不然它会以为什么都没缺");
  assert.match(prompt, /按问题关键词初筛的工具/);
  assert.match(prompt, /调用工具：\{"thought":"为什么要这条","tool":"工具名","args":\{\.\.\.\}\}/);
  assert.match(prompt, /台账已能回答的部分不要重复取数（§三十二）/);
  assert.match(prompt, /服务端基准时刻：2026-09-20 10:00:00/, "时间只由服务端给，不让模型自己判断今天几号");
  assert.equal(agentLedgerText(state).includes("S01"), true);
});

// ---------- §十九 + REAL_DATA_ONLY：最终答案复校验 ----------

function runWithEvidence(): AgentState {
  let { state } = fresh();
  const a = admitCall(state, "sector_rank", { kind: "industry" }, T0);
  state = recordCall(state, {
    tool: "sector_rank", input: { kind: "industry" }, output_status: "ok", kind: "value", call_key: a.call_key,
    source: "东财 clist（板块）", as_of: "2026-09-20 09:55", data_status: "REAL", timestamp: NOW,
    summary: "半导体板块涨 3.07%，主力净流入 182.2亿", payload: { board_code: "BK1036" },
  }).state;
  const b = admitCall(state, "themes", {}, T0 + 1000);
  state = recordCall(state, {
    tool: "themes", input: {}, output_status: "ok", kind: "value", call_key: b.call_key,
    source: "discoverThemes 引擎现算", as_of: "2026-09-20 09:56", data_status: "DERIVED", timestamp: NOW,
    summary: "主题共振命中半导体（theme_id=T-SEMI），扩散度 0.62", payload: { theme_id: "T-SEMI" },
  }).state;
  const c = admitCall(state, "probability", {}, T0 + 2000);
  state = recordCall(state, { tool: "probability", input: {}, output_status: "not_supported", call_key: c.call_key, error: c.reason, timestamp: NOW }).state;
  return state;
}

test("P6-D② §十九：引用命中、数字有出处、血缘齐 ⇒ ACCEPTED", () => {
  const state = runWithEvidence();
  const check = verifyAgentAnswer({
    answer: "半导体今日涨 3.07%、主力净流入 182.2亿 [F01]，且主题共振扩散度 0.62 [S01]。",
    cites: ["F01", "S01"], gaps: ["缺少历史条件概率：probability 不由 Agent 执行"], state,
  });
  assert.equal(check.status, "ACCEPTED", check.violations.join(" / "));
  assert.deepEqual(check.cites_valid, ["F01", "S01"]);
  assert.deepEqual(check.unsourced_numbers, []);
  assert.equal(check.lineage.length, 2);
  assert.equal(check.lineage[1].refs.includes("theme_id=T-SEMI"), true, "血缘要能点到 theme_id（§十九 的例子）");
  assert.deepEqual(check.violations, []);
});

test("P6-D② REAL_DATA_ONLY 回归：编造引用 / 无出处数字 / 历史当今天 / 凭空概率，全部被点名且不静默改写", () => {
  const state = runWithEvidence();
  const check = verifyAgentAnswer({
    answer: "半导体涨 5.5%，主力净流入 999亿 [F01][F77]；历史上这类情况明天必涨，胜率 80%。",
    cites: ["F01", "F77"], gaps: [], state,
  });
  assert.equal(check.status, "PARTIAL", "有引用但违规：不能算 ACCEPTED");
  assert.deepEqual(check.cites_invalid, ["F77"]);
  const claims = check.unsourced_numbers.map((u) => u.claim);
  assert.ok(claims.includes("5.5%") && claims.includes("999亿") && claims.includes("80%"), `凭空数字没被抓全：${claims.join("、")}`);
  assert.ok(claims.includes("胜率 80"), `概率动词后面的凭空数字也要被抓（行情动词是判据之一）：${claims.join("、")}`);
  assert.ok(!claims.some((c) => c.includes("[F") || c.includes("F01")), `台账引用标记是引用语法不是市场数字：${claims.join("、")}`);
  assert.match(check.violations.join(" / "), /台账里不存在的行：F77/);
  assert.match(check.violations.join(" / "), /找不到出处/);
  assert.ok(check.probability_gaps.length >= 1, "凭空概率必须被点名");
  assert.match(check.probability_gaps.join(" / "), /没有一条来自概率类工具/);
  assert.match(check.answer, /明天必涨/, "原文照抄：本层只判定，不替模型改写让它过关");
});

test("P6-D② §十六 兜到底：一条读数都没取到时答案是 REJECTED，且缺口清单不空", () => {
  let { state } = fresh();
  for (const tool of ["events", "radar", "risk"]) {
    const a = admitCall(state, tool, {}, T0);
    state = recordCall(state, { tool, input: {}, output_status: "failed", kind: "request_failed", call_key: a.call_key, error: `${tool} 本次取数失败`, timestamp: NOW }).state;
  }
  const check = verifyAgentAnswer({ answer: "今天市场整体偏强，成交 1.2万亿。", cites: [], gaps: [], state });
  assert.equal(check.status, "REJECTED");
  assert.match(check.violations.join(" / "), /没有引用任何台账行/);
  assert.equal(check.lineage.length, 0, "REJECTED 的答案没有血缘可言");
  assert.equal(state.evidence.length, 0);
  assert.equal(check.gaps.length, 3, check.gaps.join(" / "));
  assert.ok(check.gaps.every((g) => g.startsWith("（服务端标注、模型未回应）")), "模型一句都没提：三条缺口全部原样并进 gaps，不悄悄丢掉");
});

test("P6-D② §十九：概率引用必须带 trade_date/sample/horizon，缺项就判不成立", () => {
  let { state } = fresh();
  const a = admitCall(state, "snapshot_probability", { date: "2026-09-18" }, T0);
  state = recordCall(state, {
    tool: "snapshot_probability", input: { date: "2026-09-18" }, output_status: "ok", kind: "value", call_key: a.call_key,
    source: "probability_snapshot 表", as_of: "2026-09-18", data_status: "SNAPSHOT", timestamp: NOW,
    summary: "该条件历史胜率 51.75%", payload: { trade_date: "2026-09-18", sample: 713, horizon: 5 },
  }).state;
  const id = state.evidence[0].line.id;
  const good = verifyAgentAnswer({ answer: `该条件历史胜率 51.75%（过去样本）[${id}]`, cites: [id], gaps: [], state });
  assert.deepEqual(good.probability_gaps, [], good.probability_gaps.join(" / "));
  assert.equal(good.status, "ACCEPTED", "带齐 trade_date/sample/horizon 的历史概率可以过关：它没说「今天会涨」");
  assert.deepEqual(good.lineage[0].refs.sort(), ["horizon=5", "sample=713", "trade_date=2026-09-18"], "§十九 要求的概率口径必须能在血缘里看到");

  // 台账行本身没带口径（服务层写漏了）：引用它说概率就要被抓出来
  const bare: AgentState = {
    ...state,
    evidence: [{ ...state.evidence[0], refs: [] }],
  };
  const bad = verifyAgentAnswer({ answer: `该条件历史胜率 51.75%（过去样本）[${id}]`, cites: [id], gaps: [], state: bare });
  assert.match(bad.probability_gaps.join(" / "), /trade_date、sample、horizon/, bad.probability_gaps.join(" / "));
});

// 真实模型跑出来的缺陷（run_id ui-mu8xng0k-7uxyft，2026-09-20，mercury-2）：
// risk 工具的摘要自己就写着「上证相似环境后续统计：样本 113 个，1日胜率 46.9%」，
// 模型照抄这句却被 probabilityCheck 判成「凭空给概率」——数字在台账里，判据却只认工具名与出处串。
test("P6-D② §十九 真实回归：概率数字写在非概率工具的台账原文里，认它做出处但仍要三项口径", () => {
  const RISK_SUMMARY = "风险等级「正常」；涨跌家数 4234/1152；炸板率 27.8%；上证相似环境后续统计：样本 113 个，1日胜率 46.9%（HISTORICAL，不是今天的预测）";
  const { state: s0 } = fresh();
  const { state } = call(s0, "risk", {}, {
    source: "sentiment 引擎风险分项 + 上证相似日统计（similar-env）", data_status: "DERIVED",
    summary: RISK_SUMMARY, payload: { trade_date: "2026-09-20", level: "正常", similar_env: { sample: 113, horizon: 1 } },
  });
  const id = state.evidence[0].line.id;
  assert.deepEqual(state.evidence[0].refs, ["trade_date=2026-09-20", "sample=113", "horizon=1"],
    `similar_env 下一层的 horizon 必须被 extractRefs 抽到（服务层就是靠这个字段带口径）：${state.evidence[0].refs.join("、")}`);

  const answer = `风险监控给出相似环境 1 日胜率 46.9%（历史样本 113 个，不是今天的预测）[${id}]`;
  const ok = verifyAgentAnswer({ answer, cites: [id], gaps: [], state });
  assert.deepEqual(ok.probability_gaps, [], ok.probability_gaps.join(" / "));
  assert.equal(ok.status, "ACCEPTED", "工具名不在概率白名单不要紧：数字有台账出处且三项口径齐全就可以过关");

  // 同一条行少了 horizon：不再判「凭空给概率」（那是假指控），改判缺口径，照样不成立
  const noHorizon: AgentState = { ...state, evidence: [{ ...state.evidence[0], refs: ["trade_date=2026-09-20", "sample=113"] }] };
  const partial = verifyAgentAnswer({ answer, cites: [id], gaps: [], state: noHorizon });
  assert.match(partial.probability_gaps.join(" / "), /缺口径字段：horizon/, partial.probability_gaps.join(" / "));
  assert.ok(!partial.probability_gaps.join(" / ").includes("没有一条来自概率类工具"), "明明在台账里，就不能指控它凭空捏造");
  assert.equal(partial.status, "PARTIAL");

  // 判据没被放宽：台账里一个字都没提概率时，答案里的胜率仍然按「凭空给概率」处理
  const { state: s2 } = call(s0, "risk", {}, {
    source: "sentiment 引擎风险分项", data_status: "DERIVED",
    summary: "风险等级「正常」；涨跌家数 4234/1152；炸板率 27.8%", payload: { trade_date: "2026-09-20", level: "正常" },
  });
  const id2 = s2.evidence[0].line.id;
  const madeUp = verifyAgentAnswer({ answer: `风险等级「正常」[${id2}]，明天上涨概率 80%。`, cites: [id2], gaps: [], state: s2 });
  assert.match(madeUp.probability_gaps.join(" / "), /没有一条来自概率类工具/, madeUp.probability_gaps.join(" / "));
});

test("P6-D② §十九：模型没回应的服务端缺口会被并进 gaps（不能悄悄丢掉）", () => {
  const state = runWithEvidence();
  const check = verifyAgentAnswer({
    answer: "半导体涨 3.07% [F01]。", cites: ["F01"], gaps: ["我自己想到的一个缺口"], state,
  });
  assert.equal(check.gaps.length, 2, check.gaps.join(" / "));
  assert.ok(check.gaps.some((g) => g.startsWith("我自己想到的一个缺口")));
  assert.ok(check.gaps.some((g) => g.startsWith("（服务端标注、模型未回应）") && g.includes("probability")), "probability 不支持这条必须出现在缺口里");
  assert.deepEqual(check.unused_evidence, ["S01"], "取到了却没引用要提示（这是白跑的调用）");
});

test("P6-D② §十八/§三十九：运行摘要只报真实计数，不掺任何编出来的读数", () => {
  const state = runWithEvidence();
  const check = verifyAgentAnswer({ answer: "涨 3.07% [F01]", cites: ["F01"], gaps: [], state });
  const sum = summarizeRun(state, check, T0 + 3000);
  assert.equal(sum.run_id, "r1");
  assert.equal(sum.steps, 3);
  assert.equal(sum.tool_calls, 3);
  assert.equal(sum.distinct_tools, 3);
  assert.equal(sum.evidence_lines, 2);
  assert.equal(sum.missing_lines, 1);
  assert.equal(sum.protocol, AGENT_PROTOCOL_VERSION);
  assert.equal(sum.answer_status, "ACCEPTED", "复校验结论原样带进摘要，不在这里改口");
  assert.equal(sum.fallback_used, 0);
  assert.equal(sum.cached_hits, 0);
  assert.equal(sum.latency_total_ms, 0, "没给 latency 就是 0：不能凭空凑一个耗时");
  assert.equal(typeof sum.log_status_counts, "string");
  assert.match(String(sum.log_status_counts), /ok=2/, String(sum.log_status_counts));
  assert.match(String(sum.log_status_counts), /not_supported=1/);
  assert.equal(sum.stop_reason, null, "预算没用完时摘要要写「没有停止原因」，而不是编一个 max_steps");
  assert.equal(sum.stop_detail, "");

  // 真正被预算停住的那次：stop 由调用方（run 服务层）写进 state，摘要照实报
  const stopped: AgentState = { ...state, stop: { reason: "max_steps", detail: `已达 ${state.budget.max_steps} 步上限` } };
  const sum2 = summarizeRun(stopped, check, T0 + 3000);
  assert.equal(sum2.stop_reason, "max_steps");
  assert.match(String(sum2.stop_detail), /步上限/);
  const afterStop = admitCall(stopped, "market_snapshot", {}, T0 + 3000);
  assert.equal(afterStop.allowed, false, "已停止的运行不再放行任何调用（§十七 不允许无限循环）");
  assert.equal(afterStop.failure, "budget");
});

// ---------- §十八 状态口径：观测四态 → 日志状态只有一份映射（P6-D③ 执行层靠它写日志） ----------

const ALL_KINDS: (ObservationKind | null)[] = ["value", "real_zero", "no_data", "request_failed", "not_covered", null];

test("P6-D②/③ §十八：logStatusOf 是四态到日志状态的唯一映射，超时单独占一档", () => {
  assert.equal(logStatusOf("value"), "ok");
  assert.equal(logStatusOf("real_zero"), "ok", "真实 0 是成功读数：它进台账，不能和「没取到」共用一个状态");
  assert.equal(logStatusOf("no_data"), "empty");
  assert.equal(logStatusOf("request_failed"), "failed");
  assert.equal(logStatusOf("not_covered"), "not_supported");
  assert.equal(logStatusOf(null), "failed", "没有观测（执行器抛异常）按失败记，绝不默认成 ok");

  for (const k of ALL_KINDS) {
    assert.equal(logStatusOf(k, true), "timeout", `${String(k)} 的超时必须是 timeout：§三十一 要求 timeout 可单独统计`);
  }
  const notTimeout = ALL_KINDS.filter((k) => k !== null).map((k) => logStatusOf(k));
  assert.equal(new Set(notTimeout).size, 4, "四种非空观测必须落在四个不同状态上（压成同一个值就没法回答「为什么没结果」）");
  for (const s of notTimeout) assert.ok((LOG_STATUSES as readonly string[]).includes(s), `映射出了枚举外的状态：${s}`);
});

test("P6-D②/③ §十八：准入侧的状态（参数/预算/缓存/答案否决）不是观测映射出来的，两者不互相冒充", () => {
  for (const s of ["bad_params", "budget", "cached", "rejected", "invalid_directive"] as const) {
    assert.ok((LOG_STATUSES as readonly string[]).includes(s), `${s} 必须在枚举里`);
    for (const k of ALL_KINDS) {
      assert.notEqual(logStatusOf(k), s, `观测映射不该产出 ${s}：它是准入/校验结论，不是「这次取数怎么样」`);
      assert.notEqual(logStatusOf(k, true), s);
    }
  }
  // 缓存命中：内核仍要留下原始那次观测的 kind 与台账 id，页面才答得出「这条读数是几号取到的」
  const state = startRun({ run_id: "r-cache", question: "缓存留痕", started_at: NOW, started_ms: T0 }).state;
  const first = recordCall(state, {
    tool: "market_snapshot", input: {}, call_key: "k1", timestamp: NOW,
    output_status: "ok", kind: "value", summary: "上证指数 3894.4 点", source: "tdx 直连", as_of: "2026-09-18 15:00:00", data_status: "REAL",
  });
  assert.ok(first.evidence_id, "第一次成功读数应进台账");
  const again = recordCall(first.state, {
    tool: "market_snapshot", input: {}, call_key: "k1", timestamp: NOW,
    output_status: "cached", kind: "value", summary: "上证指数 3894.4 点", source: "tdx 直连", as_of: "2026-09-18 15:00:00", data_status: "REAL",
    cached_from: first.evidence_id,
  });
  const entry = again.state.log[again.state.log.length - 1];
  assert.equal(entry.output_status, "cached");
  assert.equal(entry.as_of, "2026-09-18 15:00:00", "缓存命中的那一条要能答出「原始读数是几号的」，否则缓存就是隐藏旧数据");
  assert.equal(again.entry.evidence_id, first.evidence_id, "缓存复用第一次那条台账行：不重复编号，也不重复占预算");
  assert.equal(again.state.evidence.length, first.state.evidence.length, "台账行数不因缓存增长");
  assert.equal(again.state.tool_calls, first.state.tool_calls, "cached 不消耗调用预算（§十七 的预算数的是真的上游请求）");
});

// ---------- 页面文案的唯一来源（④ 的 Agent 页只引用这三张表，不在组件里另写一套） ----------

test("§十八/§三十一 文案表与常量一一对应：不多不少，且不许把 empty/failed/not_supported 压成同一句话", () => {
  const keys = <T extends object>(o: T) => Object.keys(o).sort();
  assert.deepEqual(keys(LOG_STATUS_TEXT), [...LOG_STATUSES].sort(), "output_status 文案表与 LOG_STATUSES 不同名：页面会出现没文案的状态");
  assert.deepEqual(keys(AGENT_STOP_REASON_TEXT), [...AGENT_STOP_REASONS].sort(), "停止原因文案表与 AGENT_STOP_REASONS 不同名");
  const OBS_KINDS: ObservationKind[] = ["value", "real_zero", "no_data", "request_failed", "not_covered"];
  assert.deepEqual(keys(OBS_KIND_TEXT), [...OBS_KINDS].sort(), "观测口径文案表与 ObservationKind 不同名");
  for (const [name, map] of [["LOG_STATUS_TEXT", LOG_STATUS_TEXT], ["AGENT_STOP_REASON_TEXT", AGENT_STOP_REASON_TEXT], ["OBS_KIND_TEXT", OBS_KIND_TEXT]] as const) {
    for (const [k, v] of Object.entries(map)) {
      assert.ok(typeof v === "string" && v.trim().length >= 3, `${name}.${k} 的文案太短或为空：那等于页面自己编说明`);
      assert.notEqual(v.trim(), k, `${name}.${k} 的文案就是键名本身：页面等于没解释`);
    }
  }
  // 三条老口径不许被合并成一句话（任务书 §六/§十六：空 ≠ 失败 ≠ 不支持）
  const distinct = new Set([LOG_STATUS_TEXT.empty, LOG_STATUS_TEXT.failed, LOG_STATUS_TEXT.not_supported, LOG_STATUS_TEXT.cached, LOG_STATUS_TEXT.budget]);
  assert.equal(distinct.size, 5, "empty/failed/not_supported/cached/budget 里出现了同一句话：状态被文案压平了");
  // 观测五态同样不许合并（尤其是 no_data 与 request_failed：空 ≠ 失败，§六）
  assert.equal(new Set(Object.values(OBS_KIND_TEXT)).size, 5, "OBS_KIND_TEXT 里出现了同一句话：观测口径被压平了");
  // 单次超时与整轮时长停止各自有名（否则读者会把「那次请求超时」当成「整轮为什么停」）
  assert.notEqual(AGENT_STOP_REASON_TEXT.max_total_ms, FAILURE_TEXT.timeout);
  assert.match(AGENT_STOP_REASON_TEXT.max_total_ms, /总时长/);
  assert.match(FAILURE_TEXT.timeout, /本次调用|这一次|超过本工具/);
});

test("§十七 受控停止后那一轮：只准给结论、不再给工具协议样例，缺口要写进 gaps", () => {
  const text = buildAgentFinalTurnText("已达 6 步上限", { steps: 0, tool_calls: 5, ms: 42_000, retries_left: 1, evidence_lines: 3 });
  assert.match(text, /已达 6 步上限/, "停止原因要交给模型：不说是哪条预算撞了，它会接着试同一条路");
  assert.match(text, /不再接受工具调用/);
  assert.doesNotMatch(text, /"tool"\s*:\s*"工具名"/, "收尾轮里不能再出现「调用工具」的协议样例：那是在教它继续要工具");
  assert.match(text, /"final"/, "仍然要给 final 的 JSON 形状：与 buildAgentTurnPrompt 同一套协议，不在这里另立一套");
  assert.match(text, /gaps/);
  assert.match(text, /台账 3 行可引用/, "可引用的台账行数要说清：那是它能引用的全部来源");
  assert.match(text, /时长 42s/, "毫秒要化成秒：给模型看 42000 是在考它算术");
  assert.match(buildAgentFinalTurnText("", { steps: 0, tool_calls: 0, ms: 0, retries_left: 0, evidence_lines: 0 }), /原因：预算已到/, "没给原因要写成「预算已到」，不能留一个空「原因：」");
});
