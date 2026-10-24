// P6-B AI 事件理解内核测试（纯内核：不碰网络、不碰库、不调模型）。
//
// 这些断言对应任务书 §八/§九/§十 的三条硬要求，而不是「解析别崩」：
// 1. AI 不得发明事件（§八）：本批真实事件之外的 event_id 必须整条拒收并原文报出；
// 2. AI 不得自生成概率（§九）：模型文本里任何带数字的概率表述都要被剥掉**且留档**，
//    confidence 只能是 0..1 的解释置信度，越界时是 null 而不是 0、也不是替它除以 100；
// 3. 解释必须可回溯（§十）：证据要在原始标题里找得到、标的要有出处、事实字段由服务端按库行回填，
//    模型改了 title 也不影响落库值。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AI_FIELDS, AI_JOBS, DERIVED_FIELDS, FACT_FIELDS, IMPACT_DIRECTIONS, IMPACT_SCOPES, IMPORTANCE_LEVELS,
  INTERPRET_PROMPT_VERSION, REQUIRED_INTERPRET_FIELDS, STATUS_TEXT,
  buildEventInterpretPrompt, clampEnum, evidenceGrounded, extractJsonArray, fieldCompleteness,
  findProbabilityClaims, focusGrounded, fundEvidenceGrounded, interpretLayeringNote, interpretationStatusOf, layerSplitOf, mappingAgreement,
  mergeRawArrays,
  normalizeConfidence, parseEventInterpretations, renderInterpretationTrace, statusDataLayer,
  stripProbabilityClaims, summarizeInterpretations, symbolGrounded,
  type EventFact, type EventInterpretation,
} from "../../src/lib/quant/screener/event-interpret-core.ts";

const fact = (over: Partial<EventFact> = {}): EventFact => ({
  event_id: "evt_1",
  published_at: "21:00",
  title: "美国中央司令部：组建新的霍尔木兹海峡联合攻击无人机部队",
  source: "东财7x24/新浪快讯 + 手工映射表 + 东财板块资金",
  level: "全球级事件",
  category: "重大事件",
  mapped_sectors: ["军工", "航运"],
  related_names: ["航运", "军工"],
  fund_note: "航运 涨幅前列且主力净流入",
  stage: "扩散阶段",
  trade_date: "2026-09-19",
  fund_boards: [{ name: "军工", change_pct: 1.2, main_yi: 5.5, leader: "军工龙头" }],
  fund_leaders: [{ name: "军工龙头", code: "600000", main_net_yi: 1.2 }],
  market: { trade_date: "2026-09-19", limit_up: 40, limit_down: 10, decliners: 1200, above_ma5_pct: 55.0 },
  sector_history: [{ as_of: "2026-09-19", sector: "军工", day_change: 1.2, change_5d: 3.1, change_20d: -2.0, change_60d: 8.5 }],
  ...over,
});

const goodEntry = (over: Record<string, unknown> = {}) => ({
  event_id: "evt_1",
  summary: "美军在霍尔木兹海峡组建无人机部队，属于地缘军事动作。",
  entities: ["美国中央司令部", "霍尔木兹海峡"],
  industries: ["军工"],
  themes: ["航运"],
  affected_symbols: [],
  impact_direction: "利好",
  impact_scope: "板块",
  importance: "高",
  importance_note: "涉及原油运输通道，可能影响航运与油气板块情绪。",
  confidence: 0.62,
  evidence: ["组建新的霍尔木兹海峡联合攻击无人机部队"],
  unknowns: ["是否影响实际航运运价需查运价数据"],
  follow_up_queries: ["今天航运板块主力资金变化"],
  // P7-1 推理字段：引用上面 fact() 给的真实资金/市场数
  reasoning: "军工板块资金净流入 +5.5亿，龙头军工龙头主力净流入 +1.2亿，资金与事件方向一致；全市场涨停 40 / 跌停 10，宽度不差，故判利好。",
  fund_evidence: ["军工板块资金净流入 +5.5亿，板块涨 +1.2%"],
  counter_evidence: ["若军工板块资金由流入转为大幅流出，则利好判断不成立"],
  focus_symbols: [{ name: "军工龙头", code: "600000", reason: "军工板块资金净流入 +5.5亿，龙头主力净流入 +1.2亿" }],
  ...over,
});

// ---------- §九 输出结构 ----------

test("P6-B §九 要求的 21 个字段一条不少：解析结果必须逐字段存在", () => {
  const r = parseEventInterpretations(JSON.stringify([goodEntry()]), [fact()], { model: "test-model", generated_at: "2026-09-19 21:10:00" });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  const itp = r.items[0];
  const c = fieldCompleteness(itp);
  assert.deepEqual(c.missing, [], `缺字段：${c.missing.join(",")}`);
  assert.equal(itp.event_id, "evt_1");
  assert.equal(itp.title, fact().title, "title 必须来自真实库行");
  assert.equal(itp.source, fact().source);
  assert.equal(itp.published_at, "21:00");
  assert.equal(itp.confidence, 0.62);
  assert.equal(itp.model, "test-model");
  assert.equal(itp.prompt_version, INTERPRET_PROMPT_VERSION);
});

test("P6-B 每个 §九 字段都必须有唯一归属（事实 / AI 解释 / 服务端派生），不允许出现没人认领的字段", () => {
  const owned = new Set<string>([...FACT_FIELDS, ...AI_FIELDS, ...DERIVED_FIELDS]);
  const unowned = REQUIRED_INTERPRET_FIELDS.filter((f) => !owned.has(f));
  assert.deepEqual(unowned, []);
  // 事实与解释两个集合不得重叠：重叠就等于「同一句话既算事实又算解释」
  const overlap = FACT_FIELDS.filter((f) => (AI_FIELDS as readonly string[]).includes(f));
  assert.deepEqual(overlap, []);
  // 事件本身是事实：这几项只能是事实字段，AI 无权提供
  for (const f of ["event_id", "source", "published_at", "title"]) assert.ok(FACT_FIELDS.includes(f as never));
});

test("P6-B §八 的 AI 工作清单恰好是那 8 件事，不多不少", () => {
  assert.equal(AI_JOBS.length, 8);
  assert.deepEqual(AI_JOBS.map((j) => j.job), ["分类", "摘要", "实体提取", "行业/主题映射", "潜在影响方向", "影响范围", "重要性解释", "需要进一步验证的数据"]);
});

// ---------- §八 AI 不得发明事件 ----------

test("P6-B AI 给了本批不存在的事件 id：整条拒收并原文报出，不做近似匹配", () => {
  const r = parseEventInterpretations(
    JSON.stringify([goodEntry(), goodEntry({ event_id: "evt_999", summary: "我发明的一条事件" })]),
    [fact()],
  );
  assert.equal(r.items.length, 1, "只有本批真实事件那条留下");
  assert.deepEqual(r.unknown_ids, ["evt_999"]);
  assert.equal(r.items[0].summary.includes("我发明"), false);
  // 本批真实事件里没被答到的，必须逐条列为 missing，不能让页面显示成「一共就 1 条事件」
  const r2 = parseEventInterpretations(JSON.stringify([goodEntry()]), [fact(), fact({ event_id: "evt_2", title: "另一条事件" })]);
  assert.equal(r2.missing.length, 1);
  assert.equal(r2.missing[0].event_id, "evt_2");
  assert.match(r2.missing[0].reason, /未对该事件给出解释/);
});

test("P6-B 缺 event_id 的条目也按「不是本批事件」拒收（不是当成第一条）", () => {
  const r = parseEventInterpretations(JSON.stringify([{ summary: "没有 id 的解释" }]), [fact()]);
  assert.equal(r.items.length, 0);
  assert.deepEqual(r.unknown_ids, ["（缺少 event_id）"]);
});

test("P6-B 同一事件被答两次只留第一条：解释不叠加，另一条计入未覆盖检查", () => {
  const r = parseEventInterpretations(JSON.stringify([goodEntry(), goodEntry({ summary: "第二条重复解释" })]), [fact()]);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].summary.includes("重复"), false);
});

// ---------- §九 AI 不得自生成概率 ----------

test("P6-B 概率断言能被识别（多种措辞），且剔除时留下原文而不是静默删除", () => {
  for (const s of [
    "该股票明天上涨概率 80%",
    "利好概率为 65%",
    "70% 的概率上涨",
    "后市涨 30% 空间",
  ]) {
    const claims = findProbabilityClaims(s);
    assert.ok(claims.length >= 1, `没识别出概率表述：${s}`);
  }
  const { text, claims } = stripProbabilityClaims("美军组建无人机部队，相关股票明天上涨概率 80%，值得注意。");
  assert.equal(claims.length, 1);
  assert.match(claims[0], /概率/);
  assert.ok(!/80%/.test(text), "数字概率必须从正文里剥掉");
  assert.match(text, /已剔除/);
  assert.match(text, /禁止 AI 生成概率/);
  // 留档要留整句：只记「涨概率 80%」会把「明天上」留在正文里，读者以为模型还说过半句话
  assert.equal(claims[0], "明天上涨概率 80%");
  assert.ok(!text.includes("明天"), "前导时间词必须与概率一起剥掉");
  assert.ok(!/明天上?[涨跌]?（/.test(text), "不允许出现「明天上（已剔除）」这类残字");
});

test("P6-B 剔除区间覆盖概率/可能性的各种措辞，且同一处只留一条留档（区间合并）", () => {
  for (const [s, expect] of [
    ["上涨的可能性为 60%", "上涨的可能性为 60%"],
    ["预计明日下跌概率约 40%", "明日下跌概率约 40%"],
    ["20% 的概率回落", "20% 的概率回落"],
    ["短期涨幅 3%", "短期涨幅 3%"],
  ] as [string, string][]) {
    const claims = findProbabilityClaims(s);
    assert.equal(claims.length, 1, `同一处断言被多条规则重复留档：${s} → ${JSON.stringify(claims)}`);
    assert.equal(claims[0], expect);
  }
});

test("P6-B 没有概率表述的正文不被改写（不会把「涨幅 3%」当概率删掉）", () => {
  const clean = "航运板块今日上涨 3.2%，主力净流入。";
  assert.deepEqual(findProbabilityClaims(clean), []);
  assert.equal(stripProbabilityClaims(clean).text, clean);
  // 「概率」这个词本身不是禁句：没有跟着数字（或对未来的幅度预测）就不该动正文
  const noNumber = "概率较高，涉及 5 个板块";
  assert.deepEqual(findProbabilityClaims(noNumber), []);
  assert.equal(stripProbabilityClaims(noNumber).text, noNumber);
});

test("P6-B 模型输出里的概率会进 violations 与 dropped 留档，并把该条降为 PARTIAL", () => {
  const r = parseEventInterpretations(
    JSON.stringify([goodEntry({ summary: "地缘事件影响油气运输，相关股票明天上涨概率 80%。" })]),
    [fact()],
  );
  const itp = r.items[0];
  assert.equal(itp.dropped.probability_claims.length, 1);
  assert.ok(itp.violations.some((v) => v.includes("概率")));
  assert.equal(itp.interpretation_status, "PARTIAL");
  assert.ok(!/80%/.test(itp.summary));
});

test("P6-B confidence 只接受 0..1：百分数写法不猜（80 不是 0.8），越界与缺失都是 null + 违规", () => {
  assert.equal(normalizeConfidence(0.62), 0.62);
  assert.equal(normalizeConfidence("0.9"), 0.9);
  assert.equal(normalizeConfidence(0.004), 0);
  assert.equal(normalizeConfidence(80), null, "不替它除以 100：猜一次就等于替 AI 造了一个置信度");
  assert.equal(normalizeConfidence(-1), null);
  assert.equal(normalizeConfidence("较高"), null);
  assert.equal(normalizeConfidence(undefined), null);
  const r = parseEventInterpretations(JSON.stringify([goodEntry({ confidence: 80 })]), [fact()]);
  assert.equal(r.items[0].confidence, null);
  assert.ok(r.items[0].violations.some((v) => /confidence/.test(v)));
});

test("P6-B confidence 的语义写死为「解释置信度、不是上涨概率」（文案与结构同处，防被页面改口径）", () => {
  const itp = parseEventInterpretations(JSON.stringify([goodEntry()]), [fact()]).items[0];
  const trace = renderInterpretationTrace(itp);
  assert.match(trace, /不是上涨概率/);
  assert.match(trace, /AI 对这段解释的把握度/);
  const split = layerSplitOf(itp);
  assert.ok(split.ai.some((l) => l.includes("不是上涨概率")));
  assert.ok(!split.facts.some((l) => l.includes("confidence")), "置信度不属于事实栏");
});

// ---------- §十 可追溯 ----------

test("P6-B 证据必须能在原始标题里找到：无出处的 evidence 剔除并计入违规", () => {
  assert.equal(evidenceGrounded("组建新的霍尔木兹海峡联合攻击无人机部队", fact()), true);
  assert.equal(evidenceGrounded("据路透报道该部队已部署完成", fact()), false, "标题里没有的内容不能当证据");
  assert.equal(evidenceGrounded("部", fact()), false, "单字不算出处");
  const r = parseEventInterpretations(
    JSON.stringify([goodEntry({ evidence: ["组建新的霍尔木兹海峡联合攻击无人机部队", "伊朗原油出口量为零"] })]),
    [fact()],
  );
  const itp = r.items[0];
  assert.deepEqual(itp.evidence, ["组建新的霍尔木兹海峡联合攻击无人机部队"]);
  assert.deepEqual(itp.dropped.evidence, ["伊朗原油出口量为零"]);
  assert.ok(itp.violations.some((v) => /evidence/.test(v)));
});

test("P6-B 标的必须有出处：标题与该行既有名称之外的一律剔除（不保留 AI 猜的标的）", () => {
  const withCo = fact({ title: "中国船舶：签订约 10 亿元订单 交付在即", related_names: ["航运"] });
  assert.equal(symbolGrounded("中国船舶", withCo), true, "标题里出现的公司名有出处");
  assert.equal(symbolGrounded("航运", fact()), true, "该行入库时已关联的板块名同样算出处");
  assert.equal(symbolGrounded("中船防务", fact()), false, "标题与既有名称里都没有 = AI 猜的");
  assert.equal(symbolGrounded("", fact()), false);
  const r = parseEventInterpretations(
    JSON.stringify([goodEntry({ affected_symbols: ["中国船舶", "中国海油"], hypothesized_symbols: ["中船防务"] })]),
    [withCo],
  );
  const itp = r.items[0];
  assert.deepEqual(itp.affected_symbols, ["中国船舶"]);
  assert.deepEqual(itp.dropped.symbols.slice().sort(), ["中国海油", "中船防务"].slice().sort(), "猜的标的一律剔除并留痕");
  assert.deepEqual(itp.hypothesized_symbols, [], "不再保留 AI 猜的标的（用户明确不要「假设/猜的」）");
  assert.ok(itp.violations.some((v) => /不得猜标的/.test(v)));
});

test("P6-B 模型回传的 title/source 与库内不一致时按库内原文保留，并记违规（AI 不得改写事件）", () => {
  const r = parseEventInterpretations(
    JSON.stringify([goodEntry({ title: "被我改写过的标题", source: "我自己编的来源" })]),
    [fact()],
  );
  const itp = r.items[0];
  assert.equal(itp.title, fact().title);
  assert.equal(itp.source, fact().source);
  assert.ok(itp.violations.some((v) => v.includes("title")));
  assert.ok(itp.violations.some((v) => v.includes("source")));
  assert.deepEqual(itp.dropped.fields, ["title", "source"]);
});

test("P6-B AI 主题映射与手工映射表的重合情况逐类列出（不判谁对谁错）", () => {
  const ma = mappingAgreement(["航运", "AI 算力"], ["军工"], fact());
  assert.deepEqual(ma.matched.sort(), ["军工", "航运"]);
  assert.deepEqual(ma.ai_only, ["AI 算力"]);
  assert.deepEqual(ma.map_only, []);
  assert.match(ma.note, /属解释/);
  const empty = mappingAgreement([], [], fact({ mapped_sectors: [] }));
  assert.match(empty.note, /未命中映射表/);
});

test("P6-B 回溯文本必须能回答 §十 的每个问题：来源/实体/映射/事实还是解释", () => {
  const itp = parseEventInterpretations(JSON.stringify([goodEntry()]), [fact()], { model: "test-model", generated_at: "2026-09-19 21:10:00" }).items[0];
  const trace = renderInterpretationTrace(itp);
  assert.match(trace, /原始事件（事实层）/);
  assert.match(trace, /来源：/);
  assert.match(trace, /不得新增事件/);
  assert.match(trace, /【AI 提取】/);
  assert.match(trace, /【AI 解释】/);
  assert.match(trace, /【主题映射核对】/);
  assert.match(trace, /【证据（逐条可在原标题中找到）】/);
  assert.match(trace, /【仍需验证】/);
  assert.match(trace, /【下一步该查】/);
  assert.match(trace, /AI_INTERPRETATION/);
  assert.match(trace, /test-model/);
  assert.ok(trace.includes(INTERPRET_PROMPT_VERSION), "回溯文本要能看出是哪一版提示词产出的");
});

test("P6-B 没有证据时回溯文本把它写成假设，而不是省略这一段", () => {
  const itp = parseEventInterpretations(JSON.stringify([goodEntry({ evidence: [] })]), [fact()]).items[0];
  assert.match(renderInterpretationTrace(itp), /只能当假设/);
});

// ---------- 状态与分层 ----------

test("P6-B interpretation_status 三态判据：无摘要 REJECTED，有瑕疵 PARTIAL，齐全才 INTERPRETED", () => {
  const full = { summary: "s", evidence: ["e"], impact_direction: "利好" as const, affected_symbols: ["x"], reasoning: "资金流入 +5.5亿", counter_evidence: ["若资金转流出则错"], fund_evidence: ["资金 +5.5亿"] };
  assert.equal(interpretationStatusOf(full, []), "INTERPRETED");
  assert.equal(interpretationStatusOf({ ...full, evidence: [] }, []), "PARTIAL");
  assert.equal(interpretationStatusOf({ ...full, impact_direction: "未知" }, []), "PARTIAL");
  assert.equal(interpretationStatusOf(full, ["一条违规"]), "PARTIAL");
  assert.equal(interpretationStatusOf({ ...full, summary: "" }, []), "REJECTED");
  // P7-1：缺推理 / 缺反证 / 有资金数据却缺资金证据 → PARTIAL
  assert.equal(interpretationStatusOf({ ...full, reasoning: "" }, []), "PARTIAL");
  assert.equal(interpretationStatusOf({ ...full, counter_evidence: [] }, []), "PARTIAL");
  assert.equal(interpretationStatusOf({ ...full, fund_evidence: [], hasFundData: true }, []), "PARTIAL");
  assert.equal(interpretationStatusOf({ ...full, fund_evidence: [], hasFundData: false }, []), "INTERPRETED", "无资金数据时不强制要求资金证据");
  assert.equal(STATUS_TEXT.REJECTED.includes("不产出结论"), true);
});

test("P6-B 任何状态的解释都属于 AI_INTERPRETATION：状态再好也不会变成 REAL", () => {
  for (const s of ["INTERPRETED", "PARTIAL", "REJECTED"] as const) assert.equal(statusDataLayer(s), "AI_INTERPRETATION");
});

test("P6-B 一批解释的汇总口径带计数与分层原文（供 UI 与报告引用同一句话）", () => {
  const items = [
    parseEventInterpretations(JSON.stringify([goodEntry()]), [fact()]).items[0],
    parseEventInterpretations(JSON.stringify([goodEntry({ event_id: "evt_2", evidence: [] })]), [fact({ event_id: "evt_2" })]).items[0],
  ];
  const s = summarizeInterpretations(items, 3, 1);
  assert.equal(s.counts.interpreted, 1);
  assert.equal(s.counts.partial, 1);
  assert.equal(s.counts.rejected, 0);
  assert.equal(s.counts.missing, 3);
  assert.match(s.layering, /另有 3 条真实事件没有拿到解释/);
  assert.match(s.layering, /AI 不得发明事件/);
  assert.match(s.layering, /「AI 解释」层/, "分层纪律的字样不能丢（P15-R15 只把人话读法换了：解释不是事实）");
  assert.match(interpretLayeringNote({ interpreted: 0, partial: 0, rejected: 0, missing: 0, unknown_ids: 0 }), /都拿到了解释/);
});

// ---------- 解析健壮性（失败时不造数据） ----------

test("P6-B 模型回复解析不出 JSON：整批判失败，逐条列为缺失，不产出任何默认解释", () => {
  const facts = [fact(), fact({ event_id: "evt_2" })];
  const r = parseEventInterpretations("抱歉，我无法分析这些事件。", facts);
  assert.equal(r.ok, false);
  assert.equal(r.parse_failed, true);
  assert.equal(r.items.length, 0);
  assert.equal(r.missing.length, 2);
  assert.match(r.error ?? "", /解析失败/);
  assert.match(r.missing[0].reason, /JSON 数组/);
});

test("P6-B extractJsonArray 兼容 ```json 包裹与前后解释文字，但不猜残缺数组", () => {
  assert.deepEqual(extractJsonArray("```json\n[{\"a\":1}]\n```"), [{ a: 1 }]);
  assert.deepEqual(extractJsonArray("结果如下：[{\"a\":1}] 供参考"), [{ a: 1 }]);
  assert.equal(extractJsonArray("[{\"a\":1}"), null);
  assert.equal(extractJsonArray("{\"a\":1}"), null, "对象不是数组：数组口径的输出契约不能松");
});

test("P6-B 枚举只认登记表里的取值：越界取值落回「未知」而不是照抄模型原文", () => {
  assert.equal(clampEnum("利好", IMPACT_DIRECTIONS, "未知"), "利好");
  assert.equal(clampEnum("重大利好", IMPACT_DIRECTIONS, "未知"), "未知");
  assert.equal(clampEnum(undefined, IMPACT_SCOPES, "未知"), "未知");
  assert.equal(clampEnum("高", IMPORTANCE_LEVELS, "无法判断"), "高");
  const r = parseEventInterpretations(JSON.stringify([goodEntry({ impact_direction: "必须买入", impact_scope: "全部", importance: "S级" })]), [fact()]);
  assert.equal(r.items[0].impact_direction, "未知");
  assert.equal(r.items[0].impact_scope, "未知");
  assert.equal(r.items[0].importance, "无法判断");
});

test("P6-B 数组字段做去重/去空/限长，非数组按缺失处理（不把字符串拆成字符）", () => {
  const r = parseEventInterpretations(JSON.stringify([goodEntry({ entities: ["a", "a", "", " b "], themes: "航运" })]), [fact()]);
  assert.deepEqual(r.items[0].entities, ["a", "b"]);
  assert.deepEqual(r.items[0].themes, ["航运"], "单值容忍成一条，但不逐字拆");
  const big = parseEventInterpretations(JSON.stringify([goodEntry({ unknowns: Array.from({ length: 40 }, (_, i) => `u${i}`) })]), [fact()]);
  assert.ok(big.items[0].unknowns.length <= 12);
});

// ---------- 提示词 ----------

test("P6-B 提示词只喂真实入库事件，并把两条禁令原文写进去", () => {
  const facts = [fact(), fact({ event_id: "evt_2", title: "欧洲央行管委：若通胀飙升不排除10月加息可能性", mapped_sectors: [], related_names: [], fund_note: "", stage: "" })];
  const prompt = buildEventInterpretPrompt(facts);
  for (const f of facts) {
    assert.ok(prompt.includes(f.event_id) && prompt.includes(f.title), "每条真实事件都要出现在提示词里");
  }
  assert.match(prompt, /不得新增事件/);
  assert.match(prompt, /禁止输出任何概率数字/);
  assert.match(prompt, /不是股票涨跌概率/);
  assert.match(prompt, /evidence 里的每条都必须是从该条 title 原样摘出/);
  assert.match(prompt, /不许凭行业常识猜股票名/, "禁止猜标的的硬规则要在提示词里");
  // event_id 自带 | 与标题：用竖线分隔字段时模型会在第二个 | 处截断 id → 提示词改用 JSON 行承载，
  // 并加一条「逐字符一致」的硬规则（这条 pin 锁住那次「整批被当发明事件拒收」的回归）。
  assert.match(prompt, /逐字符一致/, "event_id 必须照抄的硬规则要在提示词里");
  assert.ok(prompt.includes('"event_id":"evt_1"'), "event_id 以 JSON 字符串原样给出");
  assert.ok(prompt.includes('"mappedSectors":["军工","航运"]'), "映射板块按 JSON 数组给出");
  assert.ok(prompt.includes('"relatedNames":["航运","军工"]'), "关联名称按 JSON 数组给出");
  assert.ok(!prompt.includes('"relatedNames":[]'), "没有关联名称时不写空字段");
  // 第二条没命中映射表：提示词里不得为它凭空造出映射字段
  assert.equal(prompt.split('"mappedSectors"').length - 1, 1);
  assert.ok(prompt.includes('"fundCheck":"扩散阶段：'), "资金验证按 JSON 字符串给出");
  assert.ok(!prompt.includes('"fundCheck":""'), "没有资金验证时不写空字段");
});

test("P6-B 提示词把 8 项工作与输出字段列全（模型只能按结构回答）", () => {
  const prompt = buildEventInterpretPrompt([fact()]);
  for (const f of ["summary", "entities[]", "industries[]", "themes[]", "affected_symbols[]", "hypothesized_symbols[]", "impact_direction", "impact_scope", "importance", "confidence", "evidence[]", "unknowns[]", "follow_up_queries[]", "focus_symbols[]", "fund_evidence[]", "counter_evidence[]", "reasoning"]) {
    assert.ok(prompt.includes(f), `提示词缺少输出字段 ${f}`);
  }
  assert.match(prompt, /只输出 JSON 数组/);
});

// ---------- 端到端（仍是纯内核：真实形状的两条模型输出） ----------

test("P6-B 一批真实形状的解释：好的留下、越界的逐条留痕，计数与缺失都对得上", () => {
  const facts = [fact(), fact({ event_id: "evt_2", title: "欧洲央行管委斯图纳拉斯：若通胀飙升不排除10月加息可能性 但不应仓促行事", mapped_sectors: [], related_names: [] })];
  const raw = JSON.stringify([
    goodEntry(),
    goodEntry({ event_id: "evt_2", summary: "欧央行表态偏鹰，可能压制风险资产。", evidence: ["若通胀飙升不排除10月加息可能性"], affected_symbols: [], entities: ["欧洲央行"], impact_direction: "利空", impact_scope: "市场整体", importance: "中", confidence: 0.4 }),
    goodEntry({ event_id: "evt_3", summary: "这条是模型自己加的" }),
  ]);
  const r = parseEventInterpretations(raw, facts, { model: "m", generated_at: "t" });
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.unknown_ids, ["evt_3"]);
  assert.equal(r.missing.length, 0);
  assert.equal(summarizeInterpretations(r.items, r.missing.length, r.unknown_ids.length).counts.interpreted, 2);
  assert.equal(r.items.every((i) => i.interpretation_status === "INTERPRETED"), true);
  assert.equal(r.items.map((i) => i.event_id).join(","), "evt_1,evt_2");
  // 每条都能独立回溯到自己的原始事件
  for (const itp of r.items) {
    const f = facts.find((x) => x.event_id === itp.event_id)!;
    assert.equal(itp.title, f.title);
    for (const e of itp.evidence) assert.ok(f.title.includes(e));
  }
});

test("P6-B 分批合并：多批 JSON 数组按字符串拼成一份（兼容 ```json 包裹与前后说明文字）", () => {
  const a = '```json\n[{"event_id":"e1","summary":"s1"}]\n```';
  const b = '结果：[{"event_id":"e2","summary":"s2"}] 供参考';
  const parsed = JSON.parse(mergeRawArrays([a, b])) as { event_id: string }[];
  assert.deepEqual(parsed.map((x) => x.event_id), ["e1", "e2"]);
  // 空批 / 无法识别的段跳过，不产生数组里的逗号空洞
  assert.equal(mergeRawArrays([]), "[]");
  assert.equal(mergeRawArrays(["没有数组", "[]"]), "[]");
  assert.deepEqual(JSON.parse(mergeRawArrays(['[{"a":1}]', "坏批"])), [{ a: 1 }]);
});

test("P6-B 事件理解页：当天有缓存只读缓存（不重复调模型），状态条铺满 + 分批进度条", () => {
  const page = readFileSync(new URL("../../src/components/desk/pages/EventsPage.tsx", import.meta.url), "utf8");
  const orch = readFileSync(new URL("../../src/lib/desk/event-interpret.ts", import.meta.url), "utf8");
  // 缓存命中就不调模型：runAi 里 todayCached 分支直接 return，不落到 runEventInterpretation
  assert.match(page, /const todayCached = !!interp && interp\.counts\.rows > 0 && interp\.counts\.stale === 0/);
  assert.match(page, /直接读缓存，未重复调用模型/);
  assert.match(page, /重新理解/, "缓存命中时仍保留强制重跑入口");
  // 分批 + 进度（铺满整宽 + 进度条宽度按百分比）
  assert.match(orch, /DEFAULT_INTERPRET_CHUNK/);
  assert.match(orch, /onProgress/);
  assert.match(page, /正在分批理解：第 \{progress\.done\}\/\{progress\.total\} 批/);
  assert.match(page, /w-full rounded-xl border border-fuchsia-500\/25/, "解释层状态条要铺满整宽");
  assert.match(page, /style=\{\{ width: `\$\{progressPct\}%` \}\}/, "进度条按百分比铺满");
  // 内容区不再限宽（用户要求铺满，左右不留空）
  assert.match(page, /className="w-full space-y-4 px-6 py-4"/, "事件页内容区铺满整宽");
  assert.ok(!page.includes("mx-auto max-w-5xl"), "事件页不再用居中限宽容器");
});

test("P6-B 最近事件窗口：列表与 AI 理解共用跨日窗口（最近一天不足 20 条自动补更早的日子）", () => {
  const win = readFileSync(new URL("../../src/lib/quant/screener/event-window.ts", import.meta.url), "utf8");
  const evRoute = readFileSync(new URL("../../src/app/api/events/route.ts", import.meta.url), "utf8");
  const svc = readFileSync(new URL("../../src/lib/quant/screener/event-interpret.ts", import.meta.url), "utf8");
  assert.match(win, /EVENT_WINDOW_MIN = 20/, "窗口下限 20（不满二十条补更早的日子）");
  assert.match(win, /orderBy: \{ asOf: "desc" \}/, "日期按新→旧");
  assert.match(evRoute, /recentEventWindow\(\)/, "列表（/api/events）用窗口");
  assert.match(evRoute, /window_dates/, "列表回传窗口日期，页面才能标出每条属于哪天");
  // AI 理解（提示词 + 读回）用同一窗口：看到什么就理解什么
  assert.match(svc, /recentEventWindow\(\)/, "loadEventFacts / loadInterpretations 走同一窗口");
});

test("P6-B 空批次不报错也不产出（库里当天 0 行是真实状态，不是失败）", () => {
  const r = parseEventInterpretations("[]", []);
  assert.equal(r.items.length, 0);
  assert.equal(r.missing.length, 0);
  assert.equal(r.parse_failed, false);
  assert.equal(r.ok, false);
});

// ---------- P7-1 用真实数据推理，不只复述标题 ----------

test("P7-1 提示词把资金/板块/市场上下文给模型，并写明推理、重点票、资金证据、反证规则", () => {
  const prompt = buildEventInterpretPrompt([fact()]);
  // 上下文：板块资金、龙头资金、市场宽度、板块走势
  assert.ok(prompt.includes('"fundBoards"'), "提示词缺少板块资金上下文");
  assert.ok(prompt.includes('"fundLeaders"'), "提示词缺少龙头资金上下文");
  assert.ok(prompt.includes('"market"'), "提示词缺少市场宽度上下文");
  assert.ok(prompt.includes('"sectorHistory"'), "提示词缺少板块走势上下文");
  assert.ok(prompt.includes("军工"), "上下文里要带真实板块名");
  assert.ok(prompt.includes("5.5"), "上下文里要带真实资金数");
  // 规则：推理必须引用数字；重点票只能从资金数据里选；资金证据必须带数；反证至少一条
  assert.match(prompt, /只复述标题、没有数据推理的，视为未理解/);
  assert.match(prompt, /重点票.*只能从本条给的 fund_leaders/);
  assert.match(prompt, /资金证据.*必须引用本次给的/);
  assert.match(prompt, /反证.*至少 1 条/);
  assert.match(prompt, /不许给买卖价/);
  assert.match(prompt, /不许编历史规律|不许编“上次这类事件/);
});

test("P7-1 提示词：无资金数据时明说不要编资金数（不拿别的事件的资金顶替）", () => {
  const noFund = fact({ fund_boards: [], fund_leaders: [], market: null, sector_history: [] });
  const prompt = buildEventInterpretPrompt([noFund]);
  assert.ok(prompt.includes("本条事件无资金验证数据"), "无资金数据时提示词要明说");
  assert.ok(!prompt.includes('"fundBoards"'), "无资金数据时不写空的 fundBoards");
});

test("P7-1 重点票出处：只认资金数据里的龙头，猜的票剔除", () => {
  assert.equal(focusGrounded("军工龙头", "600000", fact()), true, "fund_leaders 里的龙头有出处");
  assert.equal(focusGrounded("军工龙头", undefined, fact()), true, "只给名字也认");
  assert.equal(focusGrounded("茅台", "600519", fact()), false, "资金数据里没有的票 = 猜的");
  const r = parseEventInterpretations(
    JSON.stringify([goodEntry({ focus_symbols: [
      { name: "军工龙头", code: "600000", reason: "军工板块资金净流入 +5.5亿，龙头主力净流入 +1.2亿" },
      { name: "茅台", code: "600519", reason: "白酒龙头" },
      { name: "军工龙头", code: "600000", reason: "" },
    ] })]),
    [fact()],
  );
  assert.deepEqual(r.items[0].focus_symbols.map((f) => f.name), ["军工龙头"], "猜的票与无理由的票都要剔除，只留有出处且有理由的");
  assert.ok(r.items[0].violations.some((v) => /重点票/.test(v)));
  assert.equal(r.items[0].interpretation_status, "PARTIAL");
});

test("P7-1 资金证据出处：有资金数据时必须引用数字，无资金数据时不许编数字", () => {
  assert.equal(fundEvidenceGrounded("军工板块资金净流入 +5.5亿", fact()), true);
  assert.equal(fundEvidenceGrounded("资金面偏积极", fact()), false, "无数字的空话不算资金证据");
  // 口径说明：只要求“至少引用一个给出的数 + 提到给出的名”。全数校验会误杀模型合法推算的比值
  // （如龙头 1.2亿 / 板块 5.5亿 = 21.8%，21.8 不在上下文里但不是编的），所以不要求每个数字都在上下文里。
  const noFund = fact({ fund_boards: [], fund_leaders: [] });
  assert.equal(fundEvidenceGrounded("本条事件无资金验证数据", noFund), true);
  assert.equal(fundEvidenceGrounded("板块资金净流入 +5.5亿", noFund), false, "无资金数据时带数字 = 编的");
  const r = parseEventInterpretations(
    JSON.stringify([goodEntry({ fund_evidence: ["资金面偏积极", "军工板块资金净流入 +5.5亿"] })]),
    [fact()],
  );
  assert.deepEqual(r.items[0].fund_evidence, ["军工板块资金净流入 +5.5亿"]);
  assert.ok(r.items[0].violations.some((v) => /资金证据/.test(v)));
});

test("P7-1 缺推理/缺反证/缺资金证据 → PARTIAL，不再按“有摘要就算理解”放行", () => {
  const noReason = parseEventInterpretations(JSON.stringify([goodEntry({ reasoning: "" })]), [fact()]).items[0];
  assert.equal(noReason.interpretation_status, "PARTIAL");
  assert.ok(noReason.violations.some((v) => /推理/.test(v)));
  const noCounter = parseEventInterpretations(JSON.stringify([goodEntry({ counter_evidence: [] })]), [fact()]).items[0];
  assert.equal(noCounter.interpretation_status, "PARTIAL");
  assert.ok(noCounter.violations.some((v) => /反证/.test(v)));
  const noFundEv = parseEventInterpretations(JSON.stringify([goodEntry({ fund_evidence: [] })]), [fact()]).items[0];
  assert.equal(noFundEv.interpretation_status, "PARTIAL");
  assert.ok(noFundEv.violations.some((v) => /资金证据/.test(v)));
  // 齐全的仍是 INTERPRETED
  const full = parseEventInterpretations(JSON.stringify([goodEntry()]), [fact()]).items[0];
  assert.equal(full.interpretation_status, "INTERPRETED");
  assert.deepEqual(full.focus_symbols.map((f) => f.name), ["军工龙头"]);
});

test("P7-1 回溯文本要能看到推理、资金证据、重点票、反证（不是只看摘要）", () => {
  const itp = parseEventInterpretations(JSON.stringify([goodEntry()]), [fact()]).items[0];
  const trace = renderInterpretationTrace(itp);
  assert.match(trace, /【推理（资金\/板块\/市场数据支撑）】/);
  assert.match(trace, /【资金证据/);
  assert.match(trace, /【重点票/);
  assert.match(trace, /【反证/);
  assert.match(trace, /军工龙头/);
  const split = layerSplitOf(itp);
  assert.ok(split.ai.some((l) => l.startsWith("推理 ")));
  assert.ok(split.ai.some((l) => l.startsWith("重点票 ")));
  assert.ok(split.ai.some((l) => l.startsWith("反证 ")));
});

test("P7-1 affected_symbols 出处包含 fund 数据龙头（与重点票同一份“该行既有名称”集合）", () => {
  assert.equal(symbolGrounded("军工龙头", fact()), true, "fund_leaders 里的龙头是该行已入库的名称");
  assert.equal(symbolGrounded("600000", fact()), true, "fund_leaders 里的代码同样有出处");
  assert.equal(symbolGrounded("中船防务", fact()), false, "fund 数据里也没有 = 猜的");
  const r = parseEventInterpretations(
    JSON.stringify([goodEntry({ affected_symbols: ["军工龙头", "中船防务"] })]),
    [fact()],
  );
  assert.deepEqual(r.items[0].affected_symbols, ["军工龙头"]);
  assert.ok(r.items[0].dropped.symbols.includes("中船防务"));
});

test("P7-1 有资金数据时重点票必须给（留空 → PARTIAL）；无资金数据时留空不扣分", () => {
  const emptyFocus = parseEventInterpretations(JSON.stringify([goodEntry({ focus_symbols: [] })]), [fact()]).items[0];
  assert.equal(emptyFocus.interpretation_status, "PARTIAL");
  assert.ok(emptyFocus.violations.some((v) => /重点票/.test(v)));
  const noFund = fact({ fund_boards: [], fund_leaders: [] });
  const noFundOk = parseEventInterpretations(
    JSON.stringify([goodEntry({ focus_symbols: [], fund_evidence: ["本条事件无资金验证数据"] })]),
    [noFund],
  ).items[0];
  assert.equal(noFundOk.interpretation_status, "INTERPRETED");
});

test("P7-1 资金证据认板块简称与走势板块名（模型常写“煤炭历史 …”而非全称）", () => {
  const f = fact({ sector_history: [{ as_of: "2026-09-29", sector: "煤炭", day_change: -1.39, change_5d: -3.83, change_20d: -12.22, change_60d: 2.94 }] });
  assert.equal(fundEvidenceGrounded("煤炭历史 change5dPct -3.83、change20dPct -12.22", f), true);
  assert.equal(fundEvidenceGrounded("军工板块资金净流出 -5.52亿", f), true, "简称“军工”对应军工板块");
});
