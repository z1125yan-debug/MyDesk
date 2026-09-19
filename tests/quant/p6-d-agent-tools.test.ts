// P6-D① Agent Tool Registry 纯内核测试（不碰网络、不碰库、不调模型）。
//
// 这份测试盯的是任务书里最容易被「写得很顺」糊过去的四件事：
// 1) §二十七 的 11 个字段必须逐条真在对象上（不是写在注释里）；
// 2) §二十六「不要重新造一套相同工具」：工具与能力登记表 1:1，source/freshness/limitations/fallbacks 原文一致；
// 3) §二十八 只读边界：mutating 的能力一条都不能进工具集，且「不可执行」必须带原因（静默消失 = 伪装成可用）；
// 4) §十六 参数错误 ≠ capability 不支持 ≠ 数据不存在：三种措辞不得互相冒充，尤其不能把不支持说成「没有数据」。
//
// 文末另有一节 P6-D③ 的执行器契约测试：okObs/emptyObs/failedObs/notCoveredObs 是工具执行层
// （agent-tools.ts）唯一的返回出口，它们能不能把四态压平，在这里钉死——执行层本身要真联网，
// 放到 §三十七 的真实数据 smoke 里跑，不在单测里伪造。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, findCapability, readOnlyCapabilities } from "../../src/lib/quant/screener/capability-core.ts";
import {
  INPUT_ONLY_FLAGS, SUMMARY_MAX_LEN, TOOL_DEFS, TOOL_NAMES, agentToolBasis, agentToolCatalogText, canonicalCallKey,
  clipText, disabledTools, emptyObs, enabledTools, failedObs, fallbackTools, findTool, notCoveredObs, obsNotes, okObs,
  readOnlyViolations, shortlistTools, unaccountedTools, unsupportedToolReason, validateToolParams, type ToolDefinition,
} from "../../src/lib/quant/screener/agent-tools-core.ts";
import { logStatusOf } from "../../src/lib/quant/screener/agent-loop-core.ts";

const READ_CAP_NAMES = readOnlyCapabilities().map((c) => c.name);

/** §十九 要求概率引用带 trade_date/sample/horizon：口径必须写在工具的输出说明里，不能等页面补 */
const snapshotProbRefs = () =>
  ["trade_date", "sample", "horizon"].every((k) => (findTool("snapshot_probability")?.outputSchema ?? "").includes(k));

// ---------- §二十七：字段形状 ----------

test("P6-D① §二十七：每条工具都带齐 registry 要求的 11 个字段", () => {
  assert.ok(TOOL_DEFS.length > 0);
  for (const t of TOOL_DEFS) {
    const need: [string, unknown][] = [
      ["name", t.name], ["description", t.description], ["inputSchema", t.inputSchema],
      ["outputSchema", t.outputSchema], ["source", t.source], ["freshness", t.freshness],
      ["riskLevel", t.riskLevel], ["enabled", t.enabled], ["fallbacks", t.fallbacks],
      ["limitations", t.limitations], ["examples", t.examples],
    ];
    for (const [k, v] of need) {
      assert.ok(v !== undefined && v !== null, `${t.name} 缺字段 ${k}（§二十七 要求逐条给出）`);
    }
    assert.equal(typeof t.description, "string");
    assert.ok(t.description.length > 5, `${t.name} 的 description 太短，模型无法据此选工具`);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name}：多传参数必须被拒，不能被塞给数据源`);
    assert.ok(Array.isArray(t.inputSchema.required));
    assert.ok(Array.isArray(t.fallbacks) && Array.isArray(t.limitations) && Array.isArray(t.examples), `${t.name}：fallbacks/limitations/examples 必须是数组`);
    assert.ok(["low", "medium", "high"].includes(t.riskLevel), `${t.name}：riskLevel 取值非法`);
    assert.ok(["live", "intraday", "daily", "static"].includes(t.freshness), `${t.name}：freshness 必须是登记表口径`);
  }
});

test("P6-D① §二十七：inputSchema 的每个属性都由 ParamSpec 生成，且 required 与之一致", () => {
  for (const t of TOOL_DEFS) {
    assert.deepEqual(Object.keys(t.inputSchema.properties), t.params.map((p) => p.key), `${t.name}：schema 属性与参数表不一致`);
    assert.deepEqual(t.inputSchema.required, t.params.filter((p) => p.required).map((p) => p.key), `${t.name}：required 与参数表不一致`);
    for (const p of t.params) {
      const node = t.inputSchema.properties[p.key];
      assert.equal(node.type, p.type);
      assert.equal(node.description, p.description, `${t.name}.${p.key}：schema 说明必须与参数表同源`);
      if (p.enum_values) assert.deepEqual(node.enum, [...p.enum_values]);
      if (p.pattern) assert.equal(node.pattern, p.pattern);
      if (p.default !== undefined) assert.deepEqual(node.default, p.default);
      if (p.type === "array") assert.equal(node.items?.type, "string");
    }
  }
});

// ---------- §二十六：不重复建模，与能力登记表逐条同源 ----------

test("P6-D① §二十六：工具集 = 只读能力集（1:1 映射，不多不少、不改名）", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...READ_CAP_NAMES].sort());
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, "工具名不能重复");
  for (const t of TOOL_DEFS) {
    assert.equal(t.name, t.capability, `${t.name}：工具名与能力名必须一致（mapping 而不是再造一套）`);
    assert.ok(findCapability(t.capability), `${t.capability} 在能力登记表里不存在`);
  }
});

test("P6-D① §二十六：source/freshness/limitations/fallbacks/data_status 沿用登记表原文，未各说一套", () => {
  for (const t of TOOL_DEFS) {
    const cap = findCapability(t.capability)!;
    assert.equal(t.source, cap.source, `${t.name}：来源被改写了`);
    assert.equal(t.freshness, cap.freshness, `${t.name}：新鲜度口径被改写了`);
    assert.deepEqual(t.limitations, cap.limitations, `${t.name}：局限必须原文回传，不允许省略`);
    assert.deepEqual(t.fallbacks, cap.fallbacks, `${t.name}：兜底链与登记表不一致`);
    assert.deepEqual(t.examples, cap.examples, `${t.name}：examples 不一致`);
    assert.equal(t.data_status, cap.data_status, `${t.name}：分层不一致会把派生当事实`);
    assert.equal(t.description, cap.description, `${t.name}：描述与登记表分叉了（两处必须同源）`);
    assert.equal(t.inputNote, cap.input, `${t.name}：入参说明原文丢失`);
  }
});

test("P6-D① §二十七：入参表与 CapabilityDef.input 双向同源（含显式豁免）", () => {
  for (const t of TOOL_DEFS) {
    const exempt = INPUT_ONLY_FLAGS[t.name]?.keys ?? [];
    // 正向：声明的每个参数键都得在 input 原文里出现（防止 registry 与 schema 长歪）
    for (const p of t.params) {
      assert.ok(t.inputNote.includes(p.key), `${t.name}.${p.key}：input 原文里没有这个参数名，两处不同源`);
    }
    // 反向：input 原文里写成 key= 的令牌要么是真参数，要么在豁免表里写了原因
    for (const m of t.inputNote.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g)) {
      const key = m[1];
      if (t.params.some((p) => p.key === key)) continue;
      assert.ok(exempt.includes(key), `${t.name}：input 提到「${key}=」但既没建参数也没登记豁免原因`);
      if (exempt.includes(key)) {
        assert.ok((INPUT_ONLY_FLAGS[t.name]?.reason ?? "").length > 5, `${t.name}：豁免 ${key} 必须写原因`);
      }
    }
    assert.deepEqual(exempt.filter((k) => !t.inputNote.includes(k)), [], `${t.name}：豁免表里有 input 原文不存在的令牌（过期豁免要清掉）`);
  }
});

// ---------- §二十八：只读边界 ----------

test("P6-D① §二十八：登记表中 mutating 的能力一条都不在工具集里", () => {
  const mutating = CAPABILITIES.filter((c) => c.mutating).map((c) => c.name);
  assert.ok(mutating.length > 0, "登记表本身就该标出写能力（今天只有 mcp_tools）");
  for (const name of mutating) {
    assert.ok(!TOOL_NAMES.includes(name), `${name} 是 mutating 能力，绝不能进 Agent 工具集`);
  }
  assert.ok(!TOOL_NAMES.includes("mcp_tools"), "MCP 执行通道不进自主循环（§二十六：不可用要标 MCP unavailable，不假装调用成功）");
});

test("P6-D① §二十八：只读自检函数干净，且能抓出越界样本", () => {
  assert.deepEqual(readOnlyViolations(), [], `只读边界自检应无违规：${readOnlyViolations().join(" / ")}`);
  // 反向证明这条护栏不是空转：塞一条越界样本进去，自检必须报错（try/finally 保证表不被测试改坏）
  const dirty = { ...findTool("stock_quote")!, executor: "em.place_order", sideEffect: "read", enabled: true } as ToolDefinition;
  const before = TOOL_DEFS.length;
  TOOL_DEFS.push(dirty);
  let viols: string[] = [];
  try {
    viols = readOnlyViolations();
  } finally {
    TOOL_DEFS.pop();
  }
  assert.ok(viols.some((v) => v.includes("em.place_order")), `越界样本没被抓出来：${viols.join(" / ")}`);
  assert.equal(TOOL_DEFS.length, before, "自检不得永久修改登记表");
});

test("P6-D① §二十八：不可执行的工具全部带原因，且没有一条是 riskLevel=high", () => {
  for (const t of TOOL_DEFS) {
    if (!t.enabled) {
      assert.ok((t.disabledReason ?? "").length > 10, `${t.name}：enabled=false 必须写清为什么不开放（静默不可用等于伪装）`);
      assert.equal(t.executor, null, `${t.name}：不可执行的工具不该有执行器`);
      assert.equal(t.timeout_ms, 0, `${t.name}：不可执行的工具没有超时口径可谈`);
    } else {
      assert.ok(t.executor && /^(gateway|em|db|engine|static|probe)\./.test(t.executor), `${t.name}：执行器 id 必须落在只读前缀内`);
      assert.notEqual(t.sideEffect, "none", `${t.name}：enabled 的工具必须声明怎么产生读数`);
      assert.ok(t.timeout_ms > 0, `${t.name}：enabled 的工具必须有超时上限（§十七）`);
      assert.notEqual(t.riskLevel, "high", `${t.name}：高风险工具不进自主循环，应改成 enabled=false`);
    }
  }
});

test("P6-D① 覆盖自检：每条只读能力都在工具表里有归属（执行器或不可执行原因）", () => {
  assert.deepEqual(unaccountedTools(), [], `存在没归属的能力：${unaccountedTools().join("、")}`);
  assert.equal(TOOL_DEFS.length, READ_CAP_NAMES.length);
});

// ---------- §十五：例子里那条链路必须真的可执行 ----------

test("P6-D① §十五：sector→snapshot→quote→events 这条自主研究链路是可用工具", () => {
  for (const name of ["sector_rank", "market_snapshot", "stock_quote", "events", "themes", "risk"]) {
    const t = findTool(name);
    assert.ok(t, `${name} 必须在工具集里`);
    assert.equal(t!.enabled, true, `${name} 必须可执行，否则 §十五 的例子跑不通：${t!.disabledReason}`);
  }
  // 三条重计算路径明确不开放，且原因里要说清「由人发起」而不是「没有数据」
  for (const name of ["backtest", "probability", "screener"]) {
    const t = findTool(name)!;
    assert.equal(t.enabled, false, `${name} 本阶段不开放给自主循环`);
    assert.match(t.disabledReason ?? "", /人|页面|发起|不自动/, `${name} 的原因要说清该由谁发起`);
  }
  // §二十 允许「查询 probability/backtest」：不可执行不等于没承接路径，原因里必须点名替代的只读工具
  assert.match(findTool("probability")!.disabledReason ?? "", /snapshot_probability/, "概率查询要指到已入库留档");
  assert.match(findTool("backtest")!.disabledReason ?? "", /factor_test/, "回测/IC 查询要指到已入库读数");
  assert.ok(findTool("snapshot_probability")!.enabled && findTool("factor_test")!.enabled, "被指为替代路径的工具必须真的可执行");
  assert.ok(snapshotProbRefs(), "snapshot_probability 的口径字段（trade_date/sample/horizon）要写在表里");
  // 三条无可靠来源的能力要留在表里，并且措辞是「capability 不支持」
  for (const name of ["northbound_flow", "stock_announcements", "board_day_streak"]) {
    const t = findTool(name)!;
    assert.equal(t.enabled, false);
    assert.match(t.disabledReason ?? "", /没有可靠数据源|无可靠来源/, `${name}：要说的是没来源，不是取数失败`);
    assert.match(t.disabledReason ?? "", /不支持|无法验证/);
  }
});

// ---------- §十六 参数错误 vs 不支持 ----------

test("P6-D① §十六：正常入参通过，并回填默认值", () => {
  const r = validateToolParams("sector_rank", { kind: "concept", dir: "out", size: 5 });
  assert.equal(r.ok, true, r.errors.join(" / "));
  assert.deepEqual(r.value, { kind: "concept", dir: "out", size: 5 });

  const d = validateToolParams("stock_kline", { symbol: "688256.SH" });
  assert.equal(d.ok, true, d.errors.join(" / "));
  assert.deepEqual(d.value, { symbol: "688256.SH", tf: "day", lookback: 60 }, "默认值必须补齐，执行器不读模型原文");

  const noParam = validateToolParams("market_snapshot", {});
  assert.equal(noParam.ok, true);
  assert.deepEqual(noParam.value, {});
  assert.equal(validateToolParams("market_snapshot", undefined).ok, true, "无参工具允许不传");
});

test("P6-D① §十六：缺必填 / 格式非法 / 枚举越界 / 越界整数 / 多余参数都被判参数错误", () => {
  const miss = validateToolParams("stock_quote", {});
  assert.equal(miss.ok, false);
  assert.match(miss.errors.join(" "), /symbols 缺失/, miss.errors.join(" "));
  assert.deepEqual(miss.value, {}, "参数错误时不得返回半成品入参给执行器");

  const badSym = validateToolParams("stock_quote", { symbols: ["688256"] });
  assert.equal(badSym.ok, false);
  assert.match(badSym.errors.join(" "), /后缀必填/);

  const badEnum = validateToolParams("sector_rank", { kind: "industry_x" });
  assert.equal(badEnum.ok, false);
  assert.match(badEnum.errors.join(" "), /不在允许取值里/, badEnum.errors.join(" "));

  const bigInt = validateToolParams("sector_rank", { size: 500 });
  assert.equal(bigInt.ok, false);
  assert.match(bigInt.errors.join(" "), /超过上限 50/);

  const tiny = validateToolParams("stock_kline", { symbol: "688256.SH", lookback: 1 });
  assert.equal(tiny.ok, false);
  assert.match(tiny.errors.join(" "), /小于下限 5/);

  const extra = validateToolParams("market_news", { limit: 5, offset: 3 });
  assert.equal(extra.ok, false);
  assert.match(extra.errors.join(" "), /多余参数 offset/, extra.errors.join(" "));
  assert.match(extra.errors.join(" "), /不会被塞给数据源/);

  assert.equal(validateToolParams("sector_members", { boardCode: "BK1" }).ok, false, "板块代码格式必须校验");
  assert.equal(validateToolParams("market_research", { date: "2026-13-99" }).ok, false, "非法日期不能被当成「那天没有报告」");
  assert.equal(validateToolParams("history_radar", { date: "2026-02-29" }).ok, false, "2026 年没有 2 月 29 日：格式对不等于日历上存在");
  assert.equal(validateToolParams("history_events", { date: "today" }).ok, false, "相对日期不在服务端猜，必须给 YYYY-MM-DD");
  assert.equal(validateToolParams("history_events", { date: "2024-02-29" }).ok, true, "真实存在的闰日不能被误判为非法");
  assert.equal(validateToolParams("stock_kline", { symbol: "688256.SH", asOf: "2026-09-19" }).ok, true);
  assert.equal(validateToolParams("stock_kline", { symbol: "688256.SH", asOf: "2026-09-31" }).ok, false, "asOf 同样要过日历校验");
  assert.equal(validateToolParams("events", ["nonsense" as never]).ok, false, "参数不是对象要报错");
  assert.equal(validateToolParams("symbol_search", { q: "   " }).ok, false, "空关键词不算合法入参");
});

test("P6-D① §十六：数组上限与批量口径", () => {
  const many = validateToolParams("stock_quote", { symbols: Array.from({ length: 25 }, (_, i) => `${600000 + i}.SH`) });
  assert.equal(many.ok, false);
  assert.match(many.errors.join(" "), /一次最多 20 项/, many.errors.join(" "));
  const empty = validateToolParams("stock_quote", { symbols: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(" "), /空数组/);
});

test("P6-D① §十六：常见规范化要留痕（逗号串→数组、字符串→布尔），不静默改口径", () => {
  const r = validateToolParams("stock_quote", { symbols: "688256.SH,000001.SH 300750.SZ" });
  assert.equal(r.ok, true, r.errors.join(" / "));
  assert.deepEqual(r.value.symbols, ["688256.SH", "000001.SH", "300750.SZ"]);
  assert.equal(r.coerced.length, 1);
  assert.match(r.coerced[0], /逗号字符串已按分隔符转成数组/);
  const b = validateToolParams("capability_probe", { live: "1" });
  assert.equal(b.ok, true, b.errors.join(" / "));
  assert.equal(b.value.live, true);
  assert.ok(b.coerced.length >= 1, "布尔规范化也要留痕");
  const dedup = validateToolParams("stock_quote", { symbols: ["688256.SH", "688256.SH"] });
  assert.deepEqual(dedup.value.symbols, ["688256.SH"], "重复代码合并，避免同一标的重复打上游（§三十二）");
});

test("P6-D① §十六：不支持的工具说「不支持」，绝不说成「没有数据」", () => {
  const unknown = unsupportedToolReason("order_stock");
  assert.match(unknown, /capability 不支持/);
  assert.match(unknown, /不是「查了没有数据」/);
  assert.ok(!/库里没有|没有该数据/.test(unknown), unknown);

  const disabled = unsupportedToolReason("probability");
  assert.match(disabled, /不可由 Agent 执行/);
  assert.match(disabled, /universe|K线/, disabled);

  const mutatingCap = unsupportedToolReason("mcp_tools");
  assert.match(mutatingCap, /mutating=true/, "MCP 执行通道被白名单挡掉的事实要直说");

  assert.equal(validateToolParams("order_stock", {}).ok, false);
  assert.equal(validateToolParams("probability", {}).ok, false, "不可执行的工具在参数校验这一步就被挡下");
  assert.equal(validateToolParams("mcp_tools", { server: "x" }).ok, false);
  assert.match(unsupportedToolReason(""), /空/, "空名字也要给原文，不能返回空串让页面显示成空白");
});

// ---------- §三十二 缓存键 + 兜底链 + 初筛 ----------

test("P6-D① §三十二：缓存键与参数顺序无关、与工具名和取值有关", () => {
  assert.equal(canonicalCallKey("sector_rank", { size: 5, kind: "industry" }), canonicalCallKey("sector_rank", { kind: "industry", size: 5 }));
  assert.notEqual(canonicalCallKey("sector_rank", { size: 5 }), canonicalCallKey("sector_rank", { size: 6 }));
  assert.notEqual(canonicalCallKey("sector_rank", { size: 5 }), canonicalCallKey("risk", { size: 5 }));
  assert.equal(canonicalCallKey("stock_quote", { symbols: ["688256.SH", "000001.SH"] }), "stock_quote{symbols=688256.SH,000001.SH}");
  assert.equal(canonicalCallKey("market_snapshot", {}), "market_snapshot{}");
});

test("P6-D① 兜底链只给仍可执行的工具", () => {
  assert.deepEqual(fallbackTools("stock_quote").map((t) => t.name), ["market_snapshot"]);
  assert.deepEqual(fallbackTools("risk").map((t) => t.name), ["snapshot_risk"]);
  assert.deepEqual(fallbackTools("events").map((t) => t.name), ["history_events"]);
  assert.deepEqual(fallbackTools("nope"), []);
  for (const t of fallbackTools("stock_depth").concat(fallbackTools("probability"))) {
    assert.equal(t.enabled, true, "兜底建议不能指向撞墙的工具");
  }
});

test("P6-D① §十五 初筛：只给可执行工具，且补齐市场环境读数", () => {
  const list = shortlistTools("为什么今天半导体板块这么强？").map((t) => t.name);
  assert.ok(list.includes("sector_rank") || list.includes("sector_members"), `板块类问题要出板块工具：${list.join(",")}`);
  assert.ok(list.includes("themes") && list.includes("risk") && list.includes("events"), `环境读数要补齐：${list.join(",")}`);
  for (const t of shortlistTools("寒武纪最近资金在进还是出", 6)) assert.equal(t.enabled, true);
  assert.ok(shortlistTools("", 4).length >= 1, "空问题也要给出本地环境读数");
  assert.ok(shortlistTools("下单买入 600000.SH", 4).every((t) => !/order|buy|sell/.test(t.name)));
  assert.ok(shortlistTools("板块", 3).length <= 3, "limit 必须生效");
});

// ---------- 提示词目录文本 ----------

test("P6-D① §二十七 目录文本：可用段与不可执行段分开，不可执行段带原因", () => {
  const text = agentToolCatalogText();
  assert.match(text, /【可用工具】/);
  assert.match(text, /不写库、不下单、不改账户/);
  assert.match(text, /【明确不可由本 Agent 执行】/);
  assert.match(text, /不是「没有数据」|不要改写成「没有数据」/);
  const [onPart] = text.split("【明确不可由本 Agent 执行】");
  for (const t of enabledTools()) assert.ok(onPart.includes(`- ${t.name}（`), `可用段缺 ${t.name}`);
  for (const t of disabledTools()) {
    assert.ok(text.includes(`- ${t.name}（`), `不可执行段缺 ${t.name}`);
    assert.ok(text.includes(t.disabledReason ?? ""), `${t.name}：原因没进目录文本`);
  }
  assert.ok(!onPart.includes("- mcp_tools（"), "mutating 能力不得出现在可用段");
  assert.ok(!onPart.includes("- probability（"), "不可执行工具不得出现在可用段（snapshot_probability 是另一条，不能误判）");
  assert.ok(onPart.includes("- snapshot_probability（"), "可执行的同族工具不该被字符串匹配误伤");
});

test("P6-D① 口径声明：说清「工具在表里 ≠ 这次取到数据」与不可执行条数", () => {
  const basis = agentToolBasis();
  assert.match(basis, /派生自 P6-A 能力登记表/);
  assert.match(basis, /mutating=mcp_tools/);
  assert.match(basis, /工具在表里 ≠ 这次取到数据/);
  assert.ok(basis.includes(String(enabledTools().length)));
  assert.ok(enabledTools().length >= 30, `可执行工具太少跑不通 §三十八 的六个场景：${enabledTools().length}`);
  assert.equal(enabledTools().length + disabledTools().length, TOOL_DEFS.length);
});

// ---------- §六/§十六 执行器契约：观测构造器不允许把四态压平（P6-D③ 与执行层共用这一份） ----------

test("P6-D③ okObs：只有真取到东西才允许 value，real_zero 必须显式传（0 不是默认值）", () => {
  const ok = okObs({ summary: "上证指数 3894.4 点", source: "tdx 直连", as_of: "2026-09-18 15:00:00", data_status: "REAL" });
  assert.equal(ok.kind, "value");
  assert.equal(ok.data_status, "REAL");
  assert.equal(ok.degraded_from, null, "没兜底就是 null，不能填空话");
  assert.equal(ok.payload, null, "payload 不给就是 null：不允许造一个空数组冒充「读了 0 条」");
  const zero = okObs({ summary: "今日涨停 0 家（上游确实返回了空梯队）", kind: "real_zero", source: "东方财富涨停池", as_of: "2026-09-18", data_status: "REAL" });
  assert.equal(zero.kind, "real_zero", "真实 0 与「没取到」是两种观测，只能由执行器显式区分");
  assert.notEqual(zero.kind, ok.kind);
});

test("P6-D③ 三种「没拿到」的观测各归各位：no_data / request_failed / not_covered 互不冒充", () => {
  const empty = emptyObs("radar_finding 表在 2026-09-18 没有行 —— 那天从未扫描", "radar_finding 表（只读）");
  assert.equal(empty.kind, "no_data");
  assert.equal(empty.data_status, "MISSING", "空读数不得进任何分层台账");
  assert.equal(empty.summary, "", "空观测没有台账行：summary 必须是空串，recordCall 才不会把它编成证据");
  assert.equal(empty.as_of, "", "没有时刻就留空，由落库层写「未记录」");
  assert.equal(empty.payload, null);

  const failed = failedObs("tdx 网关 503：上游返回 null", "tdx 直连");
  assert.equal(failed.kind, "request_failed");
  assert.match(failed.reason ?? "", /503/, "原因原文要留得住（§三十一：能贴出来，不允许只剩「异常」）");
  assert.equal(failed.timed_out, undefined);

  const nc = notCoveredObs("能力登记表标注 no_reliable_source：没有可靠来源", "capability-core 登记表");
  assert.equal(nc.kind, "not_covered");
  assert.notEqual(nc.kind, failed.kind, "「这条路没有来源」不能写成「请求失败」，更不能写成「没有数据」");
  assert.notEqual(nc.kind, empty.kind);
});

test("P6-D③ 超时是「失败的一种附注」：timed_out 不改变 kind，交给内核分写成 timeout", () => {
  const t = failedObs("tdxKlines 超过 8000ms 超时上限：按取数失败处理（不猜值、不显示为 0）", "tdx 直连", { timed_out: true });
  assert.equal(t.kind, "request_failed");
  assert.equal(t.timed_out, true);
  assert.equal(logStatusOf(t.kind, !!t.timed_out), "timeout");
  assert.equal(logStatusOf(t.kind, false), "failed", "不给 timed_out 时才是普通失败：两者不得混为一谈");
});

test("P6-D③ 兜底成功的观测必须带 degraded_from，且分层由执行器写 DEGRADED", () => {
  const degraded = okObs({
    summary: "沿用兜底源读数", source: "腾讯行情", as_of: "2026-09-18 15:00:00",
    data_status: "DEGRADED", degraded_from: "eltdx 网关报价",
  });
  assert.equal(degraded.data_status, "DEGRADED");
  assert.equal(degraded.degraded_from, "eltdx 网关报价");
  assert.equal(logStatusOf(degraded.kind), "ok", "兜底成功仍是成功，但分层与来源都换成了实际那一路");
});

test("P6-D③ clipText/obsNotes：长度与空白受控，但截断要留痕、不静默丢内容", () => {
  assert.equal(clipText("  多   行\n空白  "), "多 行 空白");
  const long = clipText("字".repeat(SUMMARY_MAX_LEN + 50));
  assert.ok(long.endsWith("…（已截断）"), long.slice(-12));
  assert.equal(long.length, SUMMARY_MAX_LEN + 6, "截断标记本身要留在串里：丢掉标记就等于静默删内容");
  assert.equal(clipText(null), "");
  const notes = obsNotes(emptyObs("r", "s", ["引擎自报缺口：北向未覆盖", "", "  "]));
  assert.deepEqual(notes, ["引擎自报缺口：北向未覆盖"], "空 note 不进日志：留一行空串等于给页面造噪音");
  assert.deepEqual(obsNotes(okObs({ summary: "s", source: "x", as_of: "", data_status: "REAL" })), []);
});

test("P6-D③ reason 有上限：上游堆栈再长也不能把提示词撑爆", () => {
  const f = failedObs("E".repeat(500), "em");
  assert.ok((f.reason ?? "").length <= SUMMARY_MAX_LEN + 5, String(f.reason?.length));
  const e = emptyObs("N".repeat(500), "em");
  assert.ok((e.reason ?? "").length <= SUMMARY_MAX_LEN + 5);
});
