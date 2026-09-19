// P6-C AI Market Research 内核测试（纯内核：不碰网络、不碰库、不调模型）。
//
// 对应任务书 §十三/§十四/§二十二 的可核对部分：
// 1. 七层分区必须有唯一实现处（页面与提示词共用），FACTS/SIGNALS/HISTORICAL_EVIDENCE 属服务端产出；
// 2. AI 的判断必须能回到台账行：编造的引用被剔除并留档，没有引用的判断被标为不可回溯（不删原文但不算站住）；
// 3. 台账里没有的市场化数字不得被当成结论：逐条标注、保留原文（本层不重算也不替模型圆场）；
// 4. §二十二：历史统计 ≠ 当前预测，这类措辞被抓出来并降级，但不会被静默改写。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_FORBIDDEN, AI_LAYERS, AI_RESEARCH_JOBS, MAX_RAW_CHARS, RESEARCH_LAYERS, RESEARCH_NOT_RUN_STATUSES,
  RESEARCH_PROMPT_VERSION, RESEARCH_STATUSES, RESEARCH_SYSTEM_PROMPT, SERVER_LAYERS,
  assignEvidenceIds, buildResearchPrompt, capLedger, evidenceLedgerText, extractJsonObject,
  findHistoricalAsCurrentClaims, findUnsourcedNumbers, MAX_LEDGER_LINES, numbersIn, parseResearchOutput,
  renderResearchTrace, researchFieldCompleteness, researchLayerSections, researchLayeringNote,
  RESEARCH_SCOPE_NOT_IMPLEMENTED, RESEARCH_SCOPES, researchDateError, researchScopeErrorText,
  researchScopeOf, researchReportKey,
  researchStatusOf, statusDataLayer, summarizeResearchReports,
  type EvidenceLine, type ResearchReport,
} from "../../src/lib/quant/screener/research-core.ts";

const line = (over: Partial<EvidenceLine> & { layer: EvidenceLine["layer"]; text: string }): EvidenceLine => ({
  id: "F01",
  capability: "sector_rank",
  source: "东财板块榜（本机直连）",
  as_of: "2026-09-19 21:05",
  data_status: "REAL",
  ...over,
});

const LEDGER: EvidenceLine[] = assignEvidenceIds([
  { layer: "FACTS", text: "半导体板块涨 3.07%，主力净流入 182.2亿", capability: "sector_rank", source: "东财板块榜（本机直连）", as_of: "2026-09-19 21:05", data_status: "REAL" },
  { layer: "FACTS", text: "布伦特原油暗盘突破 99 美元，日内涨超 0.7%", capability: "market_news", source: "东财7x24/新浪快讯", as_of: "2026-09-19 20:14", data_status: "REAL" },
  { layer: "SIGNALS", text: "雷达当日 13 条 live 信号，其中扩散阶段 4 条", capability: "radar", source: "radar_finding 表", as_of: "2026-09-19", data_status: "DERIVED" },
  { layer: "SIGNALS", text: "今日事件 7 条入库，产业链映射命中 3 个板块", capability: "events", source: "global_event 表", as_of: "2026-09-19", data_status: "HISTORICAL" },
  { layer: "HISTORICAL_EVIDENCE", text: "过去 713 个样本中胜率 51.75%（historical/statistical，样本充足）", capability: "probability", source: "factors/probability.ts 引擎", as_of: "2026-09-18", data_status: "HISTORICAL" },
  { layer: "HISTORICAL_EVIDENCE", text: "北向净流入：无可靠来源（本层未覆盖）", capability: "northbound", source: "capability-core", as_of: "未记录", data_status: "MISSING" },
]);
const ids = LEDGER.map((l) => l.id);

// ---------- §十三 七层结构 ----------

test("P6-C 七层齐名且不重叠：服务端三层 + AI 四层，并集就是 RESEARCH_LAYERS", () => {
  assert.deepEqual([...RESEARCH_LAYERS], ["FACTS", "SIGNALS", "HISTORICAL_EVIDENCE", "INTERPRETATION", "RISKS", "UNKNOWN", "NEXT_CHECKS"]);
  assert.equal(new Set([...SERVER_LAYERS, ...AI_LAYERS]).size, 7);
  assert.equal(SERVER_LAYERS.filter((l) => (AI_LAYERS as readonly string[]).includes(l)).length, 0);
  assert.equal(RESEARCH_LAYERS.filter((l) => !SERVER_LAYERS.includes(l as never) && !AI_LAYERS.includes(l as never)).length, 0);
  assert.match(RESEARCH_LAYERS.length + "", /^\d$/);
  assert.equal(AI_FORBIDDEN.length, 12, "§十四「AI 不得」共 12 条原文，条目数被改动就说明口径变了");
  assert.equal(AI_RESEARCH_JOBS.length, 6);
  assert.equal(MAX_RAW_CHARS, 200_000);
  assert.equal(RESEARCH_PROMPT_VERSION, "p6c-1");
});

test("P6-C 台账编号按层加前缀，页面上层与 id 一一对应", () => {
  assert.deepEqual(ids, ["F01", "F02", "S01", "S02", "H01", "H02"]);
  const text = evidenceLedgerText(LEDGER);
  for (const l of LEDGER) {
    assert.ok(text.includes(`[${l.id}]`), `${l.id} 没进台账文本`);
    assert.ok(text.includes(l.source) && text.includes(l.as_of) && text.includes(l.capability), "台账行必须带出处/时刻/能力名");
  }
  assert.match(text, /事实（服务端从已注册能力取到的真实读数，AI 不得改写）/);
  assert.match(evidenceLedgerText([]), /本批没有可用台账行/);
});

// ---------- 提示词 ----------

test("P6-C 提示词把七层、12 条禁令、可用 id 清单与服务端缺口原文写进去", () => {
  const p = buildResearchPrompt({ question: "分析今天市场", as_of: "2026-09-19", lines: LEDGER, missing: ["board_day_streak：无可靠来源"] });
  for (const layer of RESEARCH_LAYERS) assert.ok(p.includes(layer), `提示词缺层 ${layer}`);
  for (const forbid of AI_FORBIDDEN) assert.ok(p.includes(`不得${forbid}`), `禁令缺：${forbid}`);
  for (const job of AI_RESEARCH_JOBS) assert.ok(p.includes(job), `可做清单缺：${job}`);
  for (const id of ids) assert.ok(p.includes(id), `台账 id ${id} 没进提示词`);
  assert.match(p, /可用 id：F01 F02 S01 S02 H01 H02/);
  assert.match(p, /禁止输出任何概率数字/);
  assert.match(p, /历史统计不等于当前预测/);
  assert.match(p, /FACTS \/ SIGNALS \/ HISTORICAL_EVIDENCE 三层由服务端产出，你不得复述成自己的结论/);
  assert.match(p, /board_day_streak：无可靠来源/, "服务端缺口必须原样进提示词");
  assert.ok(!/请你(计算|取数|抓取)/.test(p), "提示词不得要求模型自己取数或计算（§十一）");
  assert.match(RESEARCH_SYSTEM_PROMPT, /只能引用给定台账行/);
});

// ---------- 数字出处 ----------

test("P6-C 市场化数字按「自己声明的精度」对台账：3% 可以是 3.07%，20% 不行", () => {
  assert.deepEqual(numbersIn("涨 3.07%，净流入 182.2亿，共 7 条"), [3.07, 182.2, 7]);
  assert.deepEqual(findUnsourcedNumbers("半导体涨 3%，主力净流入 182.2亿", LEDGER), []);
  const bad = findUnsourcedNumbers("半导体涨 20%，主力净流入 50亿", LEDGER);
  assert.deepEqual(bad.map((b) => b.claim), ["涨 20", "20%", "净流入 50", "50亿"]);
  // 台账的 as_of/source 里有 2026-09-19、20:14 这类日期时刻片段：它们不能当数字出处，
  // 否则「涨 19%」「涨 20%」都会被日期子串放行，核查就形同虚设。
  assert.deepEqual(findUnsourcedNumbers("板块涨 19%", LEDGER).map((b) => b.claim), ["涨 19", "19%"]);
  assert.deepEqual(findUnsourcedNumbers("2026-09-19 收盘半导体涨 3.07%", LEDGER), [], "引用日期 + 有出处的数字：不误报");
  assert.deepEqual(findUnsourcedNumbers("过去 713 个样本中胜率 51.75%", LEDGER).map((b) => b.claim), []);
  assert.deepEqual(findUnsourcedNumbers("51.8% 的胜率", LEDGER), [], "51.75 在 1 位精度下就是 51.8");
  assert.equal(findUnsourcedNumbers("涉及两个板块，还有 3 家分公司", LEDGER).length, 0, "计数词不当市场化数字处理");
});

test("P6-C 「历史统计写成当前预测」能被识别，纯历史句子不误报（§二十二）", () => {
  assert.deepEqual(findHistoricalAsCurrentClaims("过去 713 个样本中胜率 51.75%"), []);
  assert.ok(findHistoricalAsCurrentClaims("样本充足，所以今天的上涨概率也是这个水平").length >= 1);
  assert.ok(findHistoricalAsCurrentClaims("这说明明天市场大概率走强").length >= 1);
});

test("P6-C 残缺 JSON 不猜：extractJsonObject 只认完整对象，兼容 ```json 包裹与前后解释", () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('这是结果：\n```json\n{"a":2}\n```\n以上。'), { a: 2 });
  assert.deepEqual(extractJsonObject('前言 {"a":{"b":3}} 后语'), { a: { b: 3 } });
  assert.equal(extractJsonObject('{"a":1'), null);
  assert.equal(extractJsonObject("[1,2]"), null);
  assert.equal(extractJsonObject(""), null);
});

// ---------- 复校验主流程 ----------

const entry = (over: Partial<{ text: string; cites: string[] }> = {}) => ({ text: over.text ?? "半导体资金面与事件面同时给出同向证据", cites: over.cites ?? ["F01", "S01"] });
const goodOutput = (over: Record<string, unknown> = {}) => JSON.stringify({
  headline: "事件与资金同向，但历史样本只支持统计口径",
  market_posture: "均衡",
  posture_cites: ["F01"],
  interpretation: [entry()],
  risks: [{ text: "北向净流入本层未覆盖，无法用资金流反证", cites: ["H02"] }],
  unknowns: ["缺少北向净流入的可靠来源"],
  next_checks: ["查 sector_rank 的当日完整榜单"],
  ...over,
});

test("P6-C 干净输出：引用回填台账原文，状态 INTERPRETED（正向路径必须存在）", () => {
  const r = parseResearchOutput(goodOutput(), LEDGER, { question: "分析今天市场", as_of: "2026-09-19", model: "m", generated_at: "2026-09-19 21:30:00" });
  assert.equal(r.ok, true);
  const rep = r.report!;
  assert.equal(rep.interpretation_status, "INTERPRETED");
  assert.deepEqual(rep.violations, []);
  assert.equal(rep.data_layer, "AI_INTERPRETATION");
  assert.deepEqual(rep.interpretation[0].cited_text[0].slice(0, 10), "[F01] 半导体板");
  assert.equal(rep.evidence_by_layer.FACTS, 2);
  assert.equal(rep.evidence_by_layer.SIGNALS, 2);
  assert.equal(rep.evidence_by_layer.HISTORICAL_EVIDENCE, 2);
  assert.equal(rep.prompt_version, RESEARCH_PROMPT_VERSION);
  assert.equal(statusDataLayer("INTERPRETED"), "AI_INTERPRETATION", "状态再好也不会变成事实层");
});

test("P6-C 编造的引用被剔除并留档，该条降为不可回溯（§十三 每条解释可回溯）", () => {
  const r = parseResearchOutput(
    goodOutput({ interpretation: [entry({ cites: ["F01", "X99"] }), entry({ text: "没有任何引用的判断", cites: [] })] }),
    LEDGER,
  );
  const rep = r.report!;
  assert.deepEqual(rep.dropped.invalid_cites, ["X99"]);
  assert.ok(rep.violations.some((v) => v.includes("不在本批台账里")));
  assert.ok(rep.violations.some((v) => v.includes("没有任何台账引用")));
  assert.equal(rep.interpretation[0].cites.length, 1);
  assert.equal(rep.interpretation[1].fully_grounded, false);
  assert.equal(rep.interpretation_status, "PARTIAL");
});

test("P6-C 台账里没有的数字：保留原文 + 逐条标注，不静默删除也不当成已核实", () => {
  const r = parseResearchOutput(goodOutput({ interpretation: [entry({ text: "半导体净流入 50亿，板块涨 20%", cites: ["F01"] })] }), LEDGER);
  const it = r.report!.interpretation[0];
  assert.ok(it.text.includes("50亿"), "原文不得被删改");
  assert.ok(it.unsourced_numbers.length >= 2, JSON.stringify(it.unsourced_numbers));
  assert.ok(r.report!.violations.some((v) => v.includes("找不到出处")));
  assert.equal(r.report!.interpretation_status, "PARTIAL");
});

test("P6-C 概率与涨幅预测在落库前剥掉并留档（与 P6-B 同一套剥离）", () => {
  const r = parseResearchOutput(
    goodOutput({
      headline: "板块明天上涨概率 80%",
      interpretation: [entry({ text: "短期涨幅 3%，值得注意" })],
    }),
    LEDGER,
  );
  const rep = r.report!;
  assert.ok(!/80%/.test(rep.headline) && !/明天/.test(rep.headline), rep.headline);
  assert.ok(!/3%/.test(rep.interpretation[0].text), rep.interpretation[0].text);
  assert.deepEqual(rep.dropped.probability_claims.sort(), ["明天上涨概率 80%", "短期涨幅 3%"]);
  assert.ok(rep.violations.some((v) => v.includes("禁止")));
  assert.equal(rep.interpretation_status, "PARTIAL");
});

test("P6-C 把历史统计写成当前预测：标注 + 降级，但不改写模型原文", () => {
  const text = "过去 713 个样本中胜率 51.75%，所以今天的上涨水平也差不多";
  const r = parseResearchOutput(goodOutput({ interpretation: [entry({ text })] }), LEDGER);
  const it = r.report!.interpretation[0];
  assert.equal(it.text, text.replace(/\s+/g, " ").trim(), "该句不属于概率，原文必须保留");
  assert.ok(it.historical_as_current.length >= 1);
  assert.ok(r.report!.violations.some((v) => v.includes("历史")));
  assert.equal(r.report!.interpretation_status, "PARTIAL");
});

test("P6-C market_posture 越界取值保留原文并标「未登记」，不猜成四态之一", () => {
  const r = parseResearchOutput(goodOutput({ market_posture: "全力看多" }), LEDGER);
  assert.equal(r.report!.market_posture, "未登记取值：全力看多");
  assert.ok(r.report!.violations.some((v) => v.includes("market_posture")));
  assert.equal(r.report!.interpretation_status, "PARTIAL");
});

test("P6-C 没有任何 interpretation：REJECTED，不产出默认报告", () => {
  const r = parseResearchOutput(goodOutput({ interpretation: [] }), LEDGER);
  assert.equal(r.ok, false);
  assert.equal(r.report!.interpretation_status, "REJECTED");
  assert.ok(r.error.includes("不产出默认"));
});

test("P6-C 模型回复不是 JSON：整批失败，逐条写明原因，不产出报告内容", () => {
  const r = parseResearchOutput("抱歉，我无法分析市场。", LEDGER);
  assert.equal(r.ok, false);
  assert.equal(r.report!.interpretation_status, "REJECTED");
  assert.deepEqual(r.report!.violations, ["模型回复里没有可解析的 JSON 对象"]);
  assert.equal(r.no_evidence, false, "「没有台账」与「模型失败」必须区分");
});

test("P6-C 台账为空时即便模型说了话也不采纳：没有真实读数就没有市场环境报告", () => {
  const r = parseResearchOutput(goodOutput(), []);
  assert.equal(r.ok, false);
  assert.equal(r.no_evidence, true);
  assert.equal(r.report!.interpretation_status, "REJECTED");
  assert.ok(r.report!.violations.some((v) => v.includes("不会去猜一份市场环境报告")));
  assert.equal(r.report!.interpretation.length, 0);
});

test("P6-C 数组字段不是数组时按缺失处理，不把字符串拆成字符凑条目", () => {
  const r = parseResearchOutput(goodOutput({ risks: "有风险", unknowns: "缺数据" }), LEDGER);
  assert.equal(r.report!.risks.length, 0);
  assert.equal(r.report!.unknowns.length, 0);
  assert.ok(r.report!.violations.some((v) => v.includes("不是数组")));
});

test("P6-C 三态判据本身：干净 INTERPRETED，有瑕疵 PARTIAL，无解释 REJECTED", () => {
  const mk = (over: Partial<Parameters<typeof researchStatusOf>[0]> = {}) => ({
    lines: LEDGER,
    interpretation: [{ text: "x", cites: ["F01"], cited_text: [], unsourced_numbers: [], historical_as_current: [], fully_grounded: true }],
    risks: [],
    violations: [] as string[],
    dropped: { invalid_cites: [], probability_claims: [], fields: [] },
    ...over,
  });
  assert.equal(researchStatusOf(mk()), "INTERPRETED");
  assert.equal(researchStatusOf(mk({ violations: ["a"] })), "PARTIAL");
  assert.equal(researchStatusOf(mk({ dropped: { invalid_cites: ["X1"], probability_claims: [], fields: [] } })), "PARTIAL");
  assert.equal(researchStatusOf(mk({ interpretation: [] })), "REJECTED");
  assert.equal(researchStatusOf(mk({ lines: [] })), "REJECTED");
  assert.deepEqual([...RESEARCH_STATUSES], ["INTERPRETED", "PARTIAL", "REJECTED"]);
  assert.deepEqual(Object.values(RESEARCH_NOT_RUN_STATUSES), ["AI_NOT_CONFIGURED", "AI_FAILED", "NO_EVIDENCE"]);
});

// ---------- 呈现 ----------

test("P6-C 七层分区渲染只有一处实现：服务端三层带台账，AI 四层各归各段", () => {
  const rep = parseResearchOutput(goodOutput(), LEDGER).report!;
  const sections = researchLayerSections(rep, LEDGER);
  assert.deepEqual(sections.map((s) => s.layer), [...RESEARCH_LAYERS]);
  assert.equal(sections[0].owner, "服务端");
  assert.equal((sections[0] as { lines: EvidenceLine[] }).lines.length, 2);
  assert.equal((sections[3] as { items: unknown[] }).items.length, 1);
  assert.equal((sections[5] as { strings: string[] }).strings[0], "缺少北向净流入的可靠来源");
});

test("P6-C 回溯文本能回答「这句话从哪来」：台账/引用/留痕/状态分层全在", () => {
  const rep = parseResearchOutput(
    goodOutput({ interpretation: [entry({ text: "半导体净流入 50亿", cites: ["F01", "Z9"] })] }),
    LEDGER,
  ).report!;
  const trace = renderResearchTrace(rep, LEDGER);
  assert.match(trace, /【问题】/);
  assert.match(trace, /\[F01\]（FACTS｜REAL/);
  assert.match(trace, /引用：\[F01\]/);
  assert.match(trace, /无出处数字/);
  assert.match(trace, /编造引用 Z9/);
  assert.match(trace, /【服务端已知缺口】/);
  assert.match(trace, /不是市场事实/);
  assert.match(trace, /提示词 p6c-1/);
});

test("P6-C 汇总与完整度口径：空段落如实列出，不写「一切正常」", () => {
  const rep = parseResearchOutput(goodOutput({ risks: [], unknowns: [], next_checks: [] }), LEDGER).report!;
  const sum = summarizeResearchReports([rep]);
  assert.deepEqual(
    { rows: sum.rows, interpreted: sum.interpreted, partial: sum.partial, rejected: sum.rejected },
    { rows: 1, interpreted: 1, partial: 0, rejected: 0 },
  );
  const comp = researchFieldCompleteness(rep);
  assert.deepEqual(comp.empty.sort(), ["next_checks", "risks", "unknowns"]);
  assert.ok(comp.filled.includes("headline"));
  const note = researchLayeringNote(rep, { rows: 1 });
  assert.match(note, /AI_INTERPRETATION/);
  assert.match(note, /不重算指标、不产概率/);
  assert.match(note, /历史统计不等于当前预测/);
  assert.match(researchLayeringNote(null, { rows: 0 }), /已落库研究报告 0 份/);
});

// ---------- scope / 自然键 / 台账上限：接口与服务层共用的口径 ----------

test("P6-C scope 只认 market：其它值返回 null 由调用方判 400，不偷偷按全市场产出", () => {
  assert.deepEqual([...RESEARCH_SCOPES], ["market"]);
  assert.equal(researchScopeOf("market"), "market");
  assert.equal(researchScopeOf(" MARKET "), "market", "大小写与首尾空格不影响合法值");
  assert.equal(researchScopeOf(null), "market", "缺省即 market");
  assert.equal(researchScopeOf(undefined), "market");
  assert.equal(researchScopeOf("stock"), null);
  assert.equal(researchScopeOf("sector"), null);
  assert.equal(researchScopeOf(""), "market", "空串按缺省处理，不当成非法值");
  assert.match(RESEARCH_SCOPE_NOT_IMPLEMENTED, /NOT IMPLEMENTED/);
  assert.match(RESEARCH_SCOPE_NOT_IMPLEMENTED, /不会把别的范围偷偷按全市场产出/);
});

test("P6-C 自然键 = scope|date：同一天同范围只有一行，表天然有界（§三十四）", () => {
  assert.equal(researchReportKey("market", "2026-09-19"), "market|2026-09-19");
  assert.notEqual(researchReportKey("market", "2026-09-19"), researchReportKey("market", "2026-09-18"));
  assert.equal(researchReportKey("market", "2026-09-19"), researchReportKey("market", "2026-09-19"));
});

test("P6-C 台账超上限：按采集顺序截断并回报被丢条数，不重排、不补齐", () => {
  const many = Array.from({ length: MAX_LEDGER_LINES + 7 }, (_, i) => ({
    layer: "FACTS" as const,
    text: `读数 ${i}`,
    capability: "market_snapshot",
    source: "全 A 快照",
    as_of: "2026-09-19",
    data_status: "REAL" as const,
  }));
  const capped = capLedger(many);
  assert.equal(capped.kept.length, MAX_LEDGER_LINES);
  assert.equal(capped.dropped, 7);
  assert.deepEqual(capped.kept.map((l) => l.text), many.slice(0, MAX_LEDGER_LINES).map((l) => l.text), "保留的是前 N 条原序");
  const within = capLedger(many.slice(0, 10));
  assert.deepEqual({ kept: within.kept.length, dropped: within.dropped }, { kept: 10, dropped: 0 });
  assert.deepEqual(capLedger([]), { kept: [], dropped: 0 });
  // 上限的存在是为了让提示词装得下；截断本身必须被写进 missing（由服务层负责），这里只保证不静默丢
  assert.equal(capLedger(many, 3).dropped, MAX_LEDGER_LINES + 4);
});

test("P6-C 日期口径：非法日期必须被抓出来，不能被读成「那天没有报告」（§三十一 无 silent failure）", () => {
  // 没传 = 合法（调用方回落到当天）；传了就必须是真实存在的 YYYY-MM-DD
  assert.equal(researchDateError(null), null);
  assert.equal(researchDateError(undefined), null);
  assert.equal(researchDateError("   "), null, "纯空白等于没传");
  assert.equal(researchDateError("2026-09-19"), null);
  assert.equal(researchDateError("2024-02-29"), null, "闰年的 2/29 是真实存在的日子");
  assert.match(String(researchDateError("2026-02-29")), /不是真实存在的日历日/, "2026 非闰年：格式对但日子不存在，同样要拒");
  assert.match(String(researchDateError("2026-13-99")), /YYYY-MM-DD|真实存在/, "月份越界要说清楚");
  assert.match(String(researchDateError("2026/09/19")), /YYYY-MM-DD/);
  assert.match(String(researchDateError("today")), /YYYY-MM-DD/);
  assert.match(String(researchDateError("2026-02-30")), /不是真实存在的日历日/);
  assert.match(String(researchDateError("2026-13-99")), /不会被当成|不会被读/, "文案要说明它不会被当成空数据");
});

test("P6-C 400 文案带上收到的原值：读者能分清「参数被拒」和「market 也没跑成」", () => {
  const t = researchScopeErrorText("stock");
  assert.match(t, /NOT IMPLEMENTED/);
  assert.match(t, /stock/, "原文值要出现在消息里");
  assert.equal(researchScopeErrorText(""), RESEARCH_SCOPE_NOT_IMPLEMENTED, "空值不追加「收到的值」");
});
