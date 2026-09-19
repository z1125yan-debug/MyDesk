// P6-B 结构约束测试（纯静态读源码，node --test 可直跑，不连库、不打上游）
//
// 为什么用「读源码断言」而不是只测内核：内核已经证明判定逻辑是对的，但 P6-B 的风险点在**接线**上——
// 三条最常见的回归是：① 有人图方便在页面里直接调模型并把结果当数据用（绕过服务端复校验）；
// ② 有人在 UI 文案里把 confidence 写成上涨概率；③ 生命周期清理被顺手扩到新表，把 P5 口径改了。
// 这三件事都只在源码层面可见，所以这里逐条钉住。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AI_FIELDS, AI_JOBS, DERIVED_FIELDS, FACT_FIELDS, NOT_RUN_STATUSES, REQUIRED_INTERPRET_FIELDS,
} from "../../src/lib/quant/screener/event-interpret-core.ts";
import { CAPABILITIES, capabilitiesForNeed, findCapability, readOnlyCapabilities } from "../../src/lib/quant/screener/capability-core.ts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const CORE = "src/lib/quant/screener/event-interpret-core.ts";
const SERVICE = "src/lib/quant/screener/event-interpret.ts";
const ROUTE = "src/app/api/events/interpret/route.ts";
const PROMPT_ROUTE = "src/app/api/events/interpret/prompt/route.ts";
const CLIENT = "src/lib/desk/event-interpret.ts";
const UI = "src/components/desk/EventInterpretation.tsx";
const PAGE = "src/components/desk/pages/EventsPage.tsx";

test("P6-B 内核不产概率：没有任何生成概率/预测的出口", () => {
  const src = read(CORE);
  // confidence 是「解释置信度」，代码里只能是归一化 0..1 的读取，不允许出现计算胜率的痕迹
  assert.doesNotMatch(src, /win_rate|winRate|probability\s*=/, "内核里出现了概率计算出口");
  assert.ok(src.includes("PROBABILITY_PLACEHOLDER"), "内核必须保留概率表述的占位文案（剥离后原文可见）");
  assert.match(src, /不是股票上涨概率|不是上涨概率/, "confidence 的语义必须写进代码原文");
});

test("P6-B §九 字段清单：17 项，且事实/AI/派生三分区不重不漏", () => {
  assert.equal(REQUIRED_INTERPRET_FIELDS.length, 17, "§九 要求至少 17 字段");
  const all = [...FACT_FIELDS, ...AI_FIELDS];
  assert.equal(new Set(all).size, all.length, "同一个字段不能既算事实又算 AI 解释");
  const derived = DERIVED_FIELDS as readonly string[];
  for (const f of REQUIRED_INTERPRET_FIELDS) {
    assert.ok(
      (FACT_FIELDS as readonly string[]).includes(f) || (AI_FIELDS as readonly string[]).includes(f) || derived.includes(f),
      `字段 ${f} 没有归属（§十 要求能看出哪些是事实、哪些是解释）`,
    );
  }
  // interpretation_status 是服务端算出来的结论：它可以在派生区，但绝不能同时被算成原始事实
  assert.ok(derived.includes("interpretation_status"), "状态属于派生层");
  // 派生字段是服务端算的，绝不能被归进事实区，否则 UI 会把「校验结论」当原始事实展示
  for (const f of DERIVED_FIELDS) assert.ok(!(FACT_FIELDS as readonly string[]).includes(f));
  assert.equal(AI_JOBS.length, 8, "§八 列了 8 项 AI 工作，少一项就是能力清单与实现对不上");
});

test("P6-B 落库与回看走服务端复校验：页面不得绕过路由自己解析模型输出", () => {
  const svc = read(SERVICE);
  assert.ok(svc.includes("parseEventInterpretations"), "服务层必须用内核复校验模型原文");
  assert.ok(svc.includes("loadEventFacts"), "服务层的事实字段必须从库里重取，不接受客户端构造");
  assert.ok(svc.includes("dedupeKey"), "解释必须挂在事件自然键上（全量重扫会让 cuid 变化）");
  const page = read(PAGE);
  assert.ok(page.includes("fetchInterpretations"), "页面通过只读接口取解释，不自己拼");
  assert.ok(!/parseEventInterpretations|extractJsonArray/.test(page + read(UI)), "页面/组件里不许出现模型解析逻辑（那是服务端的职责）");
});

test("P6-B 路由不用相对路径引内核（Node type-stripping 限制），值导入一律走 @/ 别名", () => {
  for (const rel of [ROUTE, PROMPT_ROUTE]) {
    const src = read(rel);
    assert.ok(!/from "\.\.?\//.test(src), `${rel} 出现了相对 import，生产模式下会加载失败`);
    assert.ok(src.includes("@/lib/quant/screener/"), `${rel} 未通过别名引用分层模块`);
  }
});

test("P6-B 客户端只负责调模型：不产概率、不编事件、AI 未配置时如实报告", () => {
  const src = read(CLIENT);
  assert.ok(src.includes("aiConfigured"), "必须先判断本机是否配置了模型凭据");
  assert.ok(src.includes(NOT_RUN_STATUSES.ai_unconfigured), "未配置时要返回 AI_NOT_CONFIGURED 而不是空列表");
  assert.ok(src.includes("NOT_RUN_STATUSES.no_events"), "没有真实事件时要区分 NO_EVENTS");
  assert.ok(!/random\(\)|Math\.random|生成一条|示例解释/.test(src), "客户端不得生成任何假解释内容");
  assert.ok(src.includes("storeInterpretationsApi"), "模型原文必须交回服务端校验落库");
});

test("P6-B UI 显示分层：徽章是 AI_INTERPRETATION，置信度文案带「不是上涨概率」", () => {
  const ui = read(UI);
  const page = read(PAGE);
  assert.ok(ui.includes("AI 理解"), "解释块必须显式标出这是 AI 产出");
  assert.ok(ui.includes("renderInterpretationTrace"), "§十 要求的回溯链必须在 UI 可达");
  assert.ok(ui.includes("layerSplitOf") || ui.includes("FACT_FIELDS"), "字段归属必须取自内核，页面不许自己判");
  assert.ok(/不是股票上涨概率/.test(ui), "confidence 文案必须写清不是上涨概率");
  assert.ok(page.includes("AI_INTERPRETATION"), "解释层徽章必须与事实层的 HISTORICAL 分开");
  assert.ok(page.includes("AI_NOT_CONFIGURED"), "AI 未配置时页面要显示未运行，而不是 0 条");
  // 事件列表主体仍走 global_event：徽章不得被升级成 LIVE（P2 已验收口径）
  assert.ok(page.includes('status="HISTORICAL"'), "事件事实的来源徽章口径不能改动");
});

test("P6-B 新表已登记为只读能力，且没有被塞进生命周期清理范围", () => {
  const cap = findCapability("event_interpret");
  assert.ok(cap, "event_interpret 必须进能力登记表，否则 Agent 不知道这层存在");
  assert.equal(cap!.data_status, "AI_INTERPRETATION");
  assert.equal(cap!.mutating, false, "读解释是只读能力");
  assert.ok(readOnlyCapabilities().some((c) => c.name === "event_interpret"), "只读白名单要包含它");
  assert.ok(CAPABILITIES.some((c) => c.name === "event_interpret"));
  assert.ok(capabilitiesForNeed("这条事件被 AI 解读成什么").some((h) => h.name === "event_interpret"), "需求词匹配不到这条能力，Agent 就找不到解释层");
  const lc = read("src/lib/quant/screener/lifecycle-core.ts");
  assert.ok(!lc.includes("event_interpretation"), "P5 生命周期口径不得被本阶段改动（新表不在清理范围）");
  assert.equal((lc.match(/"radar_finding" \| "global_event"/g) ?? []).length >= 1, true, "清理表清单仍是两张明细表");
});

test("P6-B schema 注释与列都在：eventKey 唯一、payload 存解释、且写明不属于 P5 清理", () => {
  const src = read("prisma/schema.prisma");
  const start = src.indexOf("// P6-B AI 事件理解");
  assert.ok(start >= 0, "缺少 EventInterpretation 的口径注释（新表必须在 schema 里写清它是解释层）");
  const m = /model EventInterpretation \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, "缺少 EventInterpretation 模型");
  const block = src.slice(start, start + (m!.index - start) + m![0].length);
  assert.match(block, /eventKey\s+String\s+@unique/, "自然键必须唯一：同一事件只能有一条当前解释");
  for (const col of ["eventHash", "status", "promptVersion", "violations", "payload", "asOf"]) {
    assert.ok(block.includes(col), `缺少列 ${col}`);
  }
  assert.match(block, /AI_INTERPRETATION/, "注释必须写明这一层的分层归属");
  assert.match(block, /不在 P5 生命周期/, "注释必须写明本表不在 P5 清理范围（口径未定前不删）");
});
