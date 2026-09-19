// P6-A 数据状态口径 + 数据能力登记表测试。
//
// 这一层为什么值得单独立一个测试文件：任务书 §三/§六 禁的是同一类错误——「HTTP 200 但 data=[]，
// UI 显示 0」「不披露写成 0」「请求失败写成今天没数据」。这类 bug 一旦出现在页面里，测试必须能挡住，
// 所以核心断言全部围绕「四种不可用情形互不合并」与「显示层永远拿不到 0」来写。
//
// 除显式标注「结构约束」的读源码断言外，全部是纯内核断言（内存里跑，不碰网络、不碰库），
// 符合本仓库「*-core.ts 可直跑」的分层纪律。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DATA_STATUSES, FRESHNESS_LIMITS_S, OBSERVATION_KINDS, SOURCE_TYPES, VERIFY_STATUSES,
  displayOf, envelopeOf, isUsable, layeringNote, observeValue, stillFresh, freshnessNote, freshnessChip,
  freshWithinDailyFromDateOnly, type EnvelopeInput,
} from "../../src/lib/quant/screener/datastatus-core.ts";
import {
  CAPABILITIES, CAPABILITY_NAMES, GROUP_ORDER, capabilitiesAnswer, capabilitiesForNeed,
  fallbackChain, findCapability, needHints, readOnlyCapabilities, registryBasis,
  unavailableNote, unavailableNoteWith,
} from "../../src/lib/quant/screener/capability-core.ts";

const AS_OF = "2026-09-19 21:00:00";

/** 构造一次观测：默认「成功且覆盖」，各用例只改自己关心的那个开关 */
function obs(o: Partial<{ requested: boolean; ok: boolean; covered: boolean; value: unknown; reason: string }> = {}) {
  return observeValue({
    requested: o.requested ?? true,
    ok: o.ok ?? true,
    covered: o.covered ?? true,
    value: o.value ?? null,
    reason: o.reason,
  });
}

// ---------- 一、四态互不合并 ----------

test("P6-A 四态：真 0 / 没有数据 / 请求失败 / 未覆盖 必须给出四种不同的 kind", () => {
  const zero = obs({ value: 0 });
  const empty = obs({ value: [] });
  const failed = obs({ ok: false, value: 0 });
  const uncovered = obs({ covered: false, value: 0 });
  assert.equal(zero.kind, "real_zero");
  assert.equal(empty.kind, "no_data");
  assert.equal(failed.kind, "request_failed");
  assert.equal(uncovered.kind, "not_covered");
  // 四个 kind 两两不同（写成集合更直观）
  assert.equal(new Set([zero.kind, empty.kind, failed.kind, uncovered.kind]).size, 4);
  assert.equal(OBSERVATION_KINDS.length, 4 + 1, "观测类型应为 value + 四种不可用情形");
});

test("P6-A 请求失败优先于「空」：超时不能伪装成今天没数据（失败时 value 不参与判定）", () => {
  const r = obs({ ok: false, value: null, reason: "connect ETIMEDOUT 82.push2.eastmoney.com:443" });
  assert.equal(r.kind, "request_failed");
  assert.equal(r.value, null);
  assert.match(r.reason, /ETIMEDOUT/, "失败原因必须原文带出来，不能只剩「异常」");
  // 即使上游回了 0（很多接口失败时字段就是 0），也不能被判成 real_zero
  assert.notEqual(obs({ ok: false, value: 0 }).kind, "real_zero");
  // 未覆盖同理优先于「空」：北向不披露 ≠ 净流入 0
  assert.equal(obs({ covered: false, value: 0 }).kind, "not_covered");
});

test("P6-A 真 0 与 false 都不算空值；NaN/Infinity 算空", () => {
  assert.equal(obs({ value: 0 }).kind, "real_zero");
  assert.equal(obs({ value: false }).kind, "value", "false 是有意义的真实值（如「未涨停」），不能当缺失");
  assert.equal(obs({ value: NaN }).kind, "no_data");
  assert.equal(obs({ value: Infinity }).kind, "no_data");
  assert.equal(obs({ value: "   " }).kind, "no_data");
  assert.equal(obs({ value: 0.0 }).kind, "real_zero");
});

test("P6-A 只有 value / real_zero 可用；其余一律不可用", () => {
  for (const k of OBSERVATION_KINDS) {
    assert.equal(isUsable(k), k === "value" || k === "real_zero", `${k} 的可用性判断错位`);
  }
});

// ---------- 二、显示层永远拿不到「补出来的 0」 ----------

test("P6-A displayOf：三种缺失一律「暂无数据」，全字符串里不出现 0", () => {
  for (const k of ["no_data", "request_failed", "not_covered"] as const) {
    const s = displayOf(k, 0, { digits: 2, suffix: " 亿元" });
    assert.equal(s, "暂无数据", `${k} 被渲染成了具体数值`);
    assert.ok(!/0/.test(s), `${k} 的文案里出现了 0`);
  }
  // 真 0 与有值才允许出现数字
  assert.equal(displayOf("real_zero", 0, { suffix: " 亿元" }), "0 亿元");
  assert.equal(displayOf("value", -612.345, { digits: 1, suffix: " 亿" }), "-612.3 亿");
  assert.equal(displayOf("value", "偏高"), "偏高");
});

// ---------- 三、信封强制自洽 ----------

function env(o: Partial<EnvelopeInput<number>> & { observed: EnvelopeInput<number>["observed"] }): ReturnType<typeof envelopeOf<number>> {
  return envelopeOf({
    status: o.status ?? "REAL",
    source: o.source ?? "东财 clist",
    source_type: o.source_type ?? "http_direct",
    as_of: o.as_of ?? AS_OF,
    observed: o.observed,
    ...(o.degraded_from !== undefined ? { degraded_from: o.degraded_from } : {}),
    ...(o.trade_date !== undefined ? { trade_date: o.trade_date } : {}),
    ...(o.verify !== undefined ? { verify: o.verify } : {}),
    ...(o.freshness_s !== undefined ? { freshness_s: o.freshness_s } : {}),
  });
}

test("P6-A 信封：kind 不可用时 status 被强制改成 MISSING，value 归 null（不允许「失败但 status:REAL」）", () => {
  const e = env({ observed: { kind: "request_failed", value: null, reason: "上游 502" }, status: "REAL" });
  assert.equal(e.status, "MISSING");
  assert.equal(e.value, null);
  assert.match(e.note ?? "", /502/);
  const e2 = env({ observed: { kind: "no_data", value: 77, reason: "" }, status: "DERIVED" });
  assert.equal(e2.status, "MISSING");
  assert.equal(e2.value, null, "不可用时不能把残留值带出去");
});

test("P6-A 信封：主源降级到兜底源 ⇒ 即使有值也是 DEGRADED（DEGRADED ≠ NORMAL）", () => {
  const okDegraded = env({ observed: { kind: "value", value: 3021.5, reason: "" }, status: "REAL", degraded_from: "eltdx 网关" });
  assert.equal(okDegraded.status, "DEGRADED");
  assert.equal(okDegraded.value, 3021.5, "降级不抹掉值，只改状态");
  assert.equal(okDegraded.degraded_from, "eltdx 网关");
  // 主源失败且兜底也没拿到 ⇒ MISSING（不是 DEGRADED 的「正常」）
  const bothDown = env({ observed: { kind: "request_failed", value: null, reason: "两条路都失败" }, status: "REAL", degraded_from: "eltdx 网关" });
  assert.equal(bothDown.status, "DEGRADED", "带降级来源却失败 ⇒ 明确标 DEGRADED，不冒充 REAL");
  assert.equal(bothDown.value, null);
});

test("P6-A 信封：verify 与 status 正交，默认 NOT_APPLICABLE，UNVERIFIED 不会自动变成 VERIFIED", () => {
  assert.equal(env({ observed: { kind: "value", value: 1, reason: "" } }).verify, "NOT_APPLICABLE");
  const u = env({ observed: { kind: "value", value: 1, reason: "" }, verify: "UNVERIFIED" });
  assert.equal(u.verify, "UNVERIFIED");
  assert.notEqual(u.verify, "VERIFIED");
  assert.ok(VERIFY_STATUSES.includes("UNVERIFIED"));
  assert.ok(!DATA_STATUSES.includes("UNVERIFIED" as never), "UNVERIFIED 属于验证状态，不该混进数据状态枚举");
});

// ---------- 四、新鲜度 ----------

test("P6-A 新鲜度：超过 live 上限就不算实时，未知时刻不猜", () => {
  assert.equal(stillFresh(10, "live"), true);
  assert.equal(stillFresh(FRESHNESS_LIMITS_S.live + 1, "live"), false);
  assert.equal(stillFresh(null, "live"), false, "新鲜度未知时不允许默认「还是新的」");
  assert.match(freshnessNote(undefined, "live"), /新鲜度未知/);
  assert.match(freshnessNote(99999, "live"), /已超出 live 口径的新鲜度上限/);
  assert.match(freshnessNote(5, "intraday"), /在 intraday 口径的 300 秒内/);
});

test("P6-A freshnessChip：未知时刻只说「未知」，绝不显示「超出上限（? 秒）」", () => {
  assert.equal(freshnessChip(true, "live"), "", "口径内不打徽标");
  assert.equal(freshnessChip(null, "static"), "", "static 口径不按实时新鲜度判，不占位置");
  const unknown = freshnessChip(null, "daily");
  assert.match(unknown, /新鲜度未知/);
  assert.ok(!unknown.includes("?"), "未知口径里不能出现问号占位");
  assert.ok(!unknown.includes("超出"), "没拿到时刻就不能说「超出上限」");
  const stale = freshnessChip(false, "daily", FRESHNESS_LIMITS_S.daily + 1);
  assert.match(stale, /超出 daily 口径上限（86401 秒 > 86400 秒）：不再算实时/);
  assert.match(freshnessChip(false, "live"), /不再算实时/);
});

test("P6-A 只到日期的 as_of：同一天可证在 daily 限内，跨天只能判未知", () => {
  assert.equal(freshWithinDailyFromDateOnly("2026-09-19", "2026-09-19"), true);
  assert.equal(freshWithinDailyFromDateOnly("2026-09-18", "2026-09-19"), false, "跨天算不出秒数，不能猜还新不新");
  assert.equal(freshWithinDailyFromDateOnly("2026-09-19 21:00:00", "2026-09-19"), false, "带时刻的不该走日期分支（该由 freshness_s 判）");
  assert.equal(freshWithinDailyFromDateOnly(null, "2026-09-19"), false);
  assert.equal(freshWithinDailyFromDateOnly("", "2026-09-19"), false);
});

test("P6-A 探测层文案：未探测只加一次前缀，面板新鲜度走同一内核函数（结构约束）", () => {
  const svc = fs.readFileSync(path.join(process.cwd(), "src/lib/quant/screener/capability-service.ts"), "utf8");
  const code = svc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!code.includes("未探测——"), "note 前缀与 reason 自叠，会出现「未探测——未探测：…」");
  // 未探测分支的 reason 不得自带「未探测」（前缀由 toProbe 统一加）
  const reasons = code.match(/^\s*reason: [`'"][^`'"]*[`'"]/gm) ?? [];
  assert.ok(reasons.length >= 3, `应能定位到裸 reason 行，实际 ${reasons.length}`);
  for (const r of reasons) {
    assert.ok(!/reason:\s*[`'"]未探测/.test(r), `reason 自带「未探测」前缀：${r}`);
  }
  assert.match(code, /fresh: freshOf\(sig, cap, freshness_s\)/, "新鲜度必须走三态判定");
  assert.match(code, /if \(freshness_s !== null\) return stillFresh/, "拿到时刻才允许判超上限");
  assert.match(code, /unavailableNoteWith\(cap, sig\.kind, sig\.reason\)/, "不可用行必须带上本次具体原因");
  const panel = fs.readFileSync(path.join(process.cwd(), "src/components/desk/CapabilityPanel.tsx"), "utf8");
  assert.ok(panel.includes("freshnessChip(p.fresh"), "面板未使用内核的新鲜度文案");
  assert.ok(!panel.includes('?? "?"'), "面板仍在使用「? 秒」占位");
});

// ---------- 五、分层计数文案 ----------

test("P6-A layeringNote：MISSING 单独成项，不并入 0；无数据时先说取数", () => {
  const s = layeringNote({ REAL: 3, HISTORICAL: 2, AI_INTERPRETATION: 1, MISSING: 4 });
  assert.match(s, /REAL 3/);
  assert.match(s, /MISSING 4/);
  assert.match(s, /AI_INTERPRETATION 不构成事实/);
  assert.equal(s.includes("0 项"), false);
  assert.match(layeringNote({}), /没有任何一层数据被取到/);
});

// ---------- 六、登记表结构完整性 ----------

test("P6-A 登记表：结构字段齐全、命名唯一、枚举合法", () => {
  assert.ok(CAPABILITIES.length >= 30, `登记表条目过少（${CAPABILITIES.length}）`);
  assert.equal(new Set(CAPABILITY_NAMES).size, CAPABILITY_NAMES.length, "能力名重复，Agent 会调错工具");
  for (const c of CAPABILITIES) {
    for (const [k, v] of Object.entries({ title: c.title, description: c.description, input: c.input, output: c.output, source: c.source })) {
      assert.ok(String(v ?? "").trim().length > 1, `${c.name}.${k} 不能为空`);
    }
    assert.ok(GROUP_ORDER.includes(c.group), `${c.name}.group=${c.group} 非法`);
    assert.ok(SOURCE_TYPES.includes(c.source_type), `${c.name}.source_type=${c.source_type} 非法`);
    assert.ok(DATA_STATUSES.includes(c.data_status), `${c.name}.data_status=${c.data_status} 非法`);
    assert.ok(["live", "db", "engine", "not_covered"].includes(c.availability), `${c.name}.availability 非法`);
    assert.ok(["live", "intraday", "daily", "static"].includes(c.freshness), `${c.name}.freshness=${c.freshness} 非法`);
    assert.ok(Array.isArray(c.limitations) && c.limitations.length > 0, `${c.name} 必须写已知局限（Agent 要知道坑）`);
    assert.ok(c.limitations.every((l) => l.trim().length > 4), `${c.name} 局限文案过短`);
    assert.ok(Array.isArray(c.examples) && c.examples.length > 0, `${c.name} 需要示例问题`);
    assert.ok(Array.isArray(c.fallbacks), `${c.name}.fallbacks 必须是数组`);
    assert.equal(typeof c.mutating, "boolean");
    assert.equal(findCapability(c.name), c, `${c.name} 反查不到自己`);
  }
});

test("P6-A 登记表：fallback / need 映射指向的能力必须真实存在（防止静默空链）", () => {
  const dangling: string[] = [];
  for (const c of CAPABILITIES) {
    for (const f of c.fallbacks) if (!findCapability(f)) dangling.push(`${c.name} → ${f}`);
  }
  assert.deepEqual(dangling, [], "兜底链指向了未登记的能力名，Agent 会以为没有兜底源");
  // 兜底链必须真的能解析出目标（不是被 mutating 过滤后才为空）
  for (const c of CAPABILITIES) {
    if (!c.fallbacks.length) continue;
    const resolved = fallbackChain(c.name);
    assert.equal(resolved.length, c.fallbacks.filter((f) => !findCapability(f)!.mutating).length, `${c.name} 兜底链解析数量不一致`);
  }
  for (const need of ["行情", "资金", "板块", "风险", "因子", "回测", "留档", "历史", "情绪", "事件", "胜率", "信号", "健康", "能力", "来源"]) {
    const hits = capabilitiesForNeed(need);
    assert.ok(hits.length > 0, `需求「${need}」映射为空，Agent 无法把缺口翻译成工具`);
    for (const h of hits) {
      assert.ok(findCapability(h.name), `映射到了不存在的 ${h.name}`);
      assert.ok(h.matched.includes(need), `${h.name} 的命中词里没写 ${need}`);
    }
  }
});

test("P6-A 未覆盖能力：availability=not_covered 必然 data_status=MISSING，且第一条局限写出「为什么没有」", () => {
  const nc = CAPABILITIES.filter((c) => c.availability === "not_covered");
  assert.ok(nc.length >= 3, "至少登记北向 / 公告 / 板块日K连续强势 三条无可靠来源");
  for (const c of nc) {
    assert.equal(c.data_status, "MISSING", `${c.name} 无来源却标了 ${c.data_status}`);
    assert.match(unavailableNote(c, "not_covered"), /没有可靠数据源/);
    assert.match(unavailableNote(c, "not_covered"), /0|估算/, "文案必须明确不用 0 或估算顶替");
  }
  // 北向这条是已确认口径：不披露 ⇒ missing + explanation
  const nb = findCapability("northbound_flow");
  assert.ok(nb);
  assert.equal(nb!.availability, "not_covered");
  assert.match(nb!.limitations.join("|"), /2024-08-19/);
  // 反过来：有来源的能力不该被标成 MISSING
  for (const c of CAPABILITIES.filter((x) => x.availability !== "not_covered")) {
    assert.notEqual(c.data_status, "MISSING", `${c.name} 声称可得却状态 MISSING`);
  }
});

test("P6-A 只读白名单：写库/删库/外部执行能力不在 Agent 可用集合里", () => {
  const ro = readOnlyCapabilities();
  assert.ok(ro.length < CAPABILITIES.length, "一个 mutating 都没有，白名单形同虚设");
  for (const c of ro) assert.equal(c.mutating, false);
  const mutating = CAPABILITIES.filter((c) => c.mutating).map((c) => c.name);
  assert.ok(mutating.includes("mcp_tools"), "MCP 外部执行必须标 mutating，Agent 不得自主调用");
  for (const m of mutating) assert.equal(findCapability(m)!.mutating, true);
  // 清理执行 / 留档写入这类真写库操作，登记表里只能以「只读预览」形式出现
  assert.ok(!ro.some((c) => /purge|delete/i.test(c.name)), "只读集合里出现了删除类能力");
  const life = findCapability("lifecycle_preview");
  assert.ok(life);
  assert.equal(life!.mutating, false);
  assert.match(life!.limitations.join("|"), /mutating=true/);
});

test("P6-A verified 账本保护：factor_verified 是只读能力，局限里写明 AI/Agent 不得改", () => {
  const v = findCapability("factor_verified");
  assert.ok(v, "必须登记因子验证账本能力");
  assert.equal(v!.mutating, false);
  assert.match(v!.limitations.join("|"), /不得写这个账本/);
  assert.match(v!.limitations.join("|"), /UNVERIFIED/);
  // 需求「因子」必须能同时找到目录、账本与测试记录
  const hits = capabilitiesForNeed("这个因子靠谱吗，验证过没有").map((h) => h.name);
  assert.ok(hits.includes("factor_catalog") && hits.includes("factor_verified") && hits.includes("factor_test"));
});

test("P6-A 历史 ≠ 当前：概率/回测/IC 的能力必须标 HISTORICAL，行情快照标 REAL", () => {
  for (const n of ["probability", "backtest", "factor_test", "history_radar", "history_events"]) {
    const c = findCapability(n);
    assert.ok(c, `${n} 未登记`);
    assert.equal(c!.data_status, "HISTORICAL", `${n} 是历史统计，不能标成 ${c!.data_status}`);
  }
  for (const n of ["snapshot_risk", "snapshot_themes", "snapshot_probability"]) {
    assert.equal(findCapability(n)!.data_status, "SNAPSHOT", `${n} 是某一刻留档`);
  }
  assert.equal(findCapability("stock_quote")!.data_status, "REAL");
  assert.equal(findCapability("market_snapshot")!.data_status, "REAL");
  assert.equal(findCapability("risk")!.data_status, "DERIVED");
  assert.match(findCapability("probability")!.limitations.join("|"), /历史统计与当前预测必须分开表述/);
  assert.match(findCapability("risk")!.limitations.join("|"), /不能表述为今天的概率/);
});

test("P6-A 「我现在能查什么」：清单只列真实登记项，并自带口径说明", () => {
  const a = capabilitiesAnswer();
  assert.ok(a.可用.length > 0 && a.无可靠来源.length > 0);
  for (const n of [...a.可用, ...a.无可靠来源]) assert.ok(CAPABILITY_NAMES.includes(n), `清单里的 ${n} 不在登记表`);
  assert.equal(a.可用.some((n) => n === "mcp_tools"), true, "MCP 属于可用能力，但不在 Agent 只读集合（另一条测试覆盖）");
  assert.match(a.说明, /能力存在 ≠ 此刻取得数据/);
  assert.match(registryBasis(), /mutating=true 的能力不在 Agent 可用范围内/);
  assert.match(registryBasis(), new RegExp(String(CAPABILITIES.length)));
});

test("P6-A 兜底链：主源失败时确实给出下一个只读候选，死路则明确为空", () => {
  const qf = fallbackChain("stock_quote").map((c) => c.name);
  assert.ok(qf.includes("market_snapshot"), "eltdx 报价失败时应有全 A 快照兜底");
  assert.deepEqual(fallbackChain("northbound_flow"), [], "北向没有兜底源：必须明确为空，不能让 Agent 反复试");
  assert.deepEqual(fallbackChain("not_a_capability"), []);
  // 兜底链不允许把 mutating 能力作为下一个候选递给 Agent
  for (const c of CAPABILITIES) {
    assert.ok(fallbackChain(c.name).every((x) => !x.mutating), `${c.name} 的兜底链含写操作`);
  }
  // 不可用文案区分「没跑起来」和「本来就没有」
  assert.match(unavailableNote(findCapability("stock_depth")!, "request_failed"), /本次取数失败/);
  assert.match(unavailableNote(findCapability("stock_depth")!, "no_data"), /请求成功但本次没有内容/);
});

test("P6-A 不可用措辞必须带上本次的具体原因（泛化文案不能冒充原因，也不重复标题/自身）", () => {
  const mcp = findCapability("mcp_tools")!;
  const withReason = unavailableNoteWith(mcp, "no_data", "MCP unavailable：已配置 1 个服务器，没有一个 ready");
  assert.match(withReason, /请求成功但本次没有内容/);
  assert.match(withReason, /具体原因：MCP unavailable：已配置 1 个服务器，没有一个 ready/);
  assert.ok(!withReason.includes(mcp.title), "note 里不得重复能力标题（标题由 UI/missing 行各加一次）");
  // 无原因 / 无覆盖 / 原因已含在标准文案里 ⇒ 不加多余的「具体原因：」
  assert.equal(unavailableNoteWith(mcp, "no_data", ""), unavailableNote(mcp, "no_data"));
  assert.equal(unavailableNoteWith(mcp, "no_data", "   "), unavailableNote(mcp, "no_data"));
  assert.equal(unavailableNoteWith(mcp, "not_covered", "某个原因"), unavailableNote(mcp, "not_covered"));
  const nc = findCapability("northbound_flow")!;
  assert.ok(!unavailableNoteWith(nc, "not_covered", nc.limitations[0]).includes("具体原因："));
  const dup = unavailableNote(findCapability("stock_depth")!, "request_failed");
  assert.equal(unavailableNoteWith(findCapability("stock_depth")!, "request_failed", dup), dup, "原因与标准文案相同就不重复");
});

test("P6-A 需求匹配带命中词与排序：多词命中的能力排在前面，写操作能力永不进候选", () => {
  const hits = capabilitiesForNeed("板块资金");
  const names = hits.map((h) => h.name);
  assert.equal(names[0], "sector_rank", "同时命中「板块」+「资金」的能力必须排第一");
  assert.equal(hits[0].matched.length, 2, "命中词必须随结果返回，供 Agent 说明为什么选它");
  assert.ok(hits.every((h) => h.matched.length >= 1));
  // 排序稳定：命中数相同则按名字，不随注册顺序抖动
  const sorted = [...hits].sort((a, b) => b.matched.length - a.matched.length || a.name.localeCompare(b.name));
  assert.deepEqual(hits.map((h) => h.name), sorted.map((h) => h.name));
  // mutating 能力（mcp_tools 会执行外部调用）不因关键词相似被推荐
  assert.ok(!capabilitiesForNeed("工具 可用 能力").map((h) => h.name).includes("mcp_tools"));
  assert.deepEqual(capabilitiesForNeed("   "), []);
  assert.deepEqual(capabilitiesForNeed("完全无关的乱码qqq"), []);
});

test("P6-A 缺口承认：need 匹配不到时只给登记过的分组方向，不猜不存在的能力", () => {
  const q = "今天的天气怎么样";
  assert.deepEqual(capabilitiesForNeed(q), []);
  assert.deepEqual(needHints(q), [], "天气没有对应分组：宁可空，也不指一个不相干的能力");
  // 有相近分组时只报分组名（供人继续找），不返回具体能力
  assert.ok(needHints("板块 涨幅").length > 0);
  for (const g of needHints("板块 涨幅")) assert.ok(GROUP_ORDER.includes(g as typeof GROUP_ORDER[number]), `hints 出现了非法分组 ${g}`);
});

test("P6-A 登记表自身也是能力：登记表 / 探测 / AI 上下文分层三条都在案", () => {
  for (const n of ["capability_registry", "capability_probe", "ai_context_layering"]) {
    const c = findCapability(n);
    assert.ok(c, `${n} 必须登记，否则 Agent 不知道自己有哪些元能力可用`);
    assert.equal(c!.mutating, false, `${n} 是只读元能力`);
    assert.ok(c!.limitations.length >= 2, `${n} 必须写清局限`);
  }
  // 「探测能力」不能只靠文档宣称：登记表与探测两条互相兜底，形成可核对的闭环
  assert.deepEqual(fallbackChain("capability_registry").map((c) => c.name), ["capability_probe"]);
  assert.deepEqual(fallbackChain("capability_probe").map((c) => c.name), ["provider_health"]);
  // AI 上下文分层的局限里必须写明「AI 输出仍属解释」与「演示价不参与校验」
  const ai = findCapability("ai_context_layering")!;
  assert.equal(ai.data_status, "AI_INTERPRETATION", "这一层产出的是解释口径，不是行情事实");
  assert.match(ai.limitations.join("|"), /不是行情事实/);
  assert.match(ai.limitations.join("|"), /演示价\/缺失价一律不参与校验/);
});
