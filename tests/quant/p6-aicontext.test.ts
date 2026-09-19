// P6-A②：AI 上下文来源分层的回归测试（纯内核 + 提示词文本，全部内存里跑，不 fetch、不碰库）。
//
// 挡的是哪一个真实 bug：修复前 assistantSystemPrompt 里写死「来自本机直连的真实行情接口，视为当前事实」，
// 而同一段上下文里混着三类东西——真实报价、buildQuote 合成的演示数据、按真实价锚出来的假分时序列。
// 结果模型把演示数字当行情说给用户，priceBandOk 又拿演示价当锚点判模型「幻觉」：
// 一次失真被放大成「用假数据校验真回答」。所以断言围绕三件事：
// 1) 分层必须逐条出现在注入文本里；2) 只有 REAL 能当数量级锚点；3) 提示词不得再宣称整段为事实。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CONTEXT_DISCIPLINE, PROVENANCE_TEXT, contextHeader, guardPriceOf, provenanceBadgeText,
  provenanceOfQuote, provenanceOfTechSnapshot, renderMarketContext, type CtxRow, type Provenance,
} from "../../src/lib/desk/ai-context-core.ts";
import { assistantSystemPrompt, priceBandOk } from "../../src/lib/desk/ai.ts";

const ALL_PROVENANCE: Provenance[] = ["REAL", "DERIVED", "DEMO", "MISSING", "DERIVED_ON_DEMO"];

/** 真实取到的报价卡（fetchQuoteCards 对 A 股直连成功时的形状） */
const REAL_CARD = { price: 1234.56, changePct: 2.13, name: "寒武纪", data_status: "REAL", series_synthetic: true };
/** 非 A 股品种走 buildQuote 合成展示的卡片 */
const DEMO_CARD = { price: 88.88, changePct: 1.5, name: "NVDA", data_status: "DEMO", series_synthetic: true };
/** 直连失败/停牌行 */
const MISSING_CARD = { price: 0, changePct: 0, name: "某股", missing: true, data_status: "MISSING" };

// ---------- 逐条来源判定 ----------

/** 旧代码路径：断源行只有 missing，没有 data_status */
const LEGACY_MISSING = { price: 0, changePct: 0, missing: true };
/** 修复前 fetchQuoteCards 的真实行形状：完全没有来源标注（新代码必须补上，这里验证未知来源的兜底判定） */
const UNKNOWN_SOURCE = { price: 1234.56, changePct: 2.1 };

test("报价卡来源判定：missing / MISSING / DEMO / 演示品种 / REAL 各归各位", () => {
  assert.equal(provenanceOfQuote(REAL_CARD, false), "REAL");
  assert.equal(provenanceOfQuote(MISSING_CARD, false), "MISSING");
  assert.equal(provenanceOfQuote(LEGACY_MISSING, false), "MISSING");
  assert.equal(provenanceOfQuote(DEMO_CARD, false), "DEMO");
  // 卡片没标 DEMO 但品种本身是演示口径 —— 也只能判 DEMO
  const unlabeledDemo = { ...REAL_CARD, data_status: undefined };
  assert.equal(provenanceOfQuote(unlabeledDemo, true), "DEMO");
});

test("报价卡缺来源标注时保守判 MISSING，不默认成真实", () => {
  // 这是 REAL_DATA_ONLY 的关键一条：未知来源不得自称事实
  assert.equal(provenanceOfQuote(UNKNOWN_SOURCE, false), "MISSING");
  assert.equal(provenanceOfQuote(undefined, false), "MISSING");
  assert.equal(provenanceOfQuote(null, true), "MISSING");
});

test("引擎快照来源：real→DERIVED，demo→DERIVED_ON_DEMO，没拿到→MISSING", () => {
  assert.equal(provenanceOfTechSnapshot("real"), "DERIVED");
  assert.equal(provenanceOfTechSnapshot("demo"), "DERIVED_ON_DEMO");
  assert.equal(provenanceOfTechSnapshot(null), "MISSING");
  assert.equal(provenanceOfTechSnapshot(undefined), "MISSING");
});

test("每个来源层级都有中文口径说明，且说明里就写明能不能当事实", () => {
  for (const p of ALL_PROVENANCE) {
    const text = PROVENANCE_TEXT[p];
    assert.ok(text && text.length > 4, `${p} 缺口径说明`);
  }
  assert.match(PROVENANCE_TEXT.DEMO, /禁止当事实/);
  assert.match(PROVENANCE_TEXT.MISSING, /不允许用 0/);
  assert.match(PROVENANCE_TEXT.DERIVED_ON_DEMO, /只能当演示/);
  assert.match(PROVENANCE_TEXT.REAL, /可当事实/);
});

// ---------- 数量级锚点：假价不得参与幻觉校验 ----------

test("只有 REAL 的现价能当数量级锚点", () => {
  assert.equal(guardPriceOf("REAL", REAL_CARD.price), REAL_CARD.price);
  assert.equal(guardPriceOf("DEMO", DEMO_CARD.price), null);
  assert.equal(guardPriceOf("MISSING", 0), null);
  assert.equal(guardPriceOf("DERIVED", 100), null);
  assert.equal(guardPriceOf("DERIVED_ON_DEMO", 100), null);
});

test("锚点本身还得是有效正数：NaN / 0 / 负数 / null 一律不锚", () => {
  for (const bad of [0, -1, NaN, Infinity, null, undefined]) {
    assert.equal(guardPriceOf("REAL", bad as number | null | undefined), null, `REAL + ${String(bad)} 不应产生锚点`);
  }
});

test("演示价当锚点会误判幻觉：非 REAL 时校验必须整体放行", () => {
  // 修复前：DEMO 卡片里的 88.88 会被当锚点，模型引用快照里真正的 1234 反而被判「幻觉」并强制重试
  const reply = "最新价 1234.56 元，支撑 1180 元";
  assert.equal(priceBandOk(reply, guardPriceOf("DEMO", DEMO_CARD.price)), true);
  assert.equal(priceBandOk(reply, guardPriceOf("DEMO", DEMO_CARD.price)), priceBandOk(reply, null));
  // 真实现价做锚点时校验仍然有效（没被削弱）
  assert.equal(priceBandOk("这股票现在 3 块钱", guardPriceOf("REAL", REAL_CARD.price)), false);
  assert.equal(priceBandOk(reply, guardPriceOf("REAL", REAL_CARD.price)), true);
});

// ---------- 上下文渲染 ----------

const ROWS: CtxRow[] = [
  { label: "688256.SH（寒武纪）报价", provenance: "REAL", lines: ["最新价 1234.56（+2.13%）"], note: "分时缩略序列按现价合成，只用于绘图" },
  { label: "688256.SH K线与本机算法识别结果", provenance: "DERIVED", lines: ["算法识别支撑: 1180.00"] },
  { label: "NVDA.US 报价", provenance: "DEMO", lines: ["展示值 88.88：本机演示数据，不是行情"] },
  { label: "300000.SZ 报价", provenance: "MISSING", lines: ["本次未取到报价"] },
];

test("renderMarketContext 逐条带上层级标签与口径说明", () => {
  const out = renderMarketContext(ROWS);
  for (const p of ["REAL", "DERIVED", "DEMO", "MISSING"] as Provenance[]) {
    assert.ok(out.includes(`｜${p}｜`), `上下文里缺 ${p} 标签`);
    assert.ok(out.includes(PROVENANCE_TEXT[p]), `${p} 的口径原文未随标签输出`);
  }
  assert.ok(out.includes("分时缩略序列按现价合成"), "note 口径丢失");
  assert.ok(out.includes("最新价 1234.56"), "数据行丢失");
});

test("上下文头部按层级计数，演示条数被显式标为不可当事实", () => {
  const header = contextHeader(ROWS);
  assert.match(header, /真实 1 条/);
  assert.match(header, /派生 1 条/);
  assert.match(header, /演示 1 条（不可当事实）/);
  assert.match(header, /缺失 1 条/);
});

test("派生自演示数据要单独成层，不并入 DERIVED", () => {
  const out = renderMarketContext([{ label: "演示K线的算法识别", provenance: "DERIVED_ON_DEMO", lines: ["支撑 10"] }]);
  assert.match(out, /派生自演示 1 条/);
  assert.match(out, /输入是假数据/);
});

test("一行数据都没有时输出 MISSING 且要求先说缺什么，而不是留个空上下文", () => {
  const out = renderMarketContext([]);
  assert.match(out, /状态：MISSING/);
  assert.match(out, /不要凭记忆或猜测给出价格/);
  const out2 = renderMarketContext([{ label: "", provenance: "REAL", lines: ["x"] }]);
  assert.equal(out2, out, "空 label 的行应被丢弃");
});

test("数据纪律默认随上下文一起注入", () => {
  const out = renderMarketContext(ROWS);
  assert.ok(out.includes("【数据纪律】"));
  CONTEXT_DISCIPLINE.forEach((d, i) => assert.ok(out.includes(`${i + 1}. ${d}`), `纪律第 ${i + 1} 条丢失`));
  assert.ok(!renderMarketContext(ROWS, { discipline: false }).includes("【数据纪律】"));
  assert.ok(renderMarketContext(ROWS, { takenAt: "2026-09-19 21:00:00" }).includes("取数时刻（本机）：2026-09-19 21:00:00"));
});

test("面板徽标文案与注入文案同源（避免两处两种说法）", () => {
  assert.equal(provenanceBadgeText("DEMO"), "演示数据·非行情");
  assert.equal(provenanceBadgeText("MISSING"), "本次未取到");
  assert.equal(provenanceBadgeText("DERIVED_ON_DEMO"), "演示数据上的派生计算");
  assert.equal(provenanceBadgeText("REAL"), "真实数据");
  assert.equal(provenanceBadgeText("DERIVED"), "派生计算");
});

// ---------- 提示词层面的口径修复 ----------

test("assistantSystemPrompt 不再宣称整段上下文为当前事实", () => {
  const out = assistantSystemPrompt("");
  assert.ok(!out.includes("视为当前事实"), "提示词里又出现了无条件「视为当前事实」");
  assert.ok(!out.includes("真实行情数据"), "提示词不得替上下文整体宣称真实");
});

test("上下文为空时提示词写明 MISSING，并要求先说缺什么", () => {
  const out = assistantSystemPrompt("");
  assert.match(out, /状态 MISSING/);
  assert.match(out, /不要凭记忆或印象给出价格/);
});

test("上下文原文逐字注入，提示词要求按四类内容分别措辞", () => {
  const ctx = renderMarketContext(ROWS);
  const out = assistantSystemPrompt(ctx);
  assert.ok(out.includes(ctx), "上下文被改写或截断");
  assert.match(out, /DEMO\/MISSING 不得引用为价格或资金事实/);
  assert.match(out, /历史回测（说明是过去样本，不等于今天会怎样）/);
  assert.match(out, /你的解读（写成「我认为\/可能的解读」，不要写成市场事实）/);
});

test("全仓不再出现「整段上下文即事实」的写法（只允许审计注释里引用旧口径）", () => {
  const files = [
    "src/lib/desk/ai.ts",
    "src/components/desk/pages/AssistantPage.tsx",
    "src/components/desk/pages/AnalysisPage.tsx",
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    assert.ok(!code.some((l) => l.includes("视为当前事实")), `${rel} 的代码里仍有「视为当前事实」`);
  }
});

// ---------- 取数层与页面必须走同一套分层（结构约束，防止「内核有了、页面没用」） ----------

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

test("fetchQuoteCards 每一条卡片都自带 data_status（REAL/DEMO/MISSING 都不许漏标）", () => {
  const src = readSrc("src/lib/desk/market.ts");
  const body = src.slice(src.indexOf("export async function fetchQuoteCards"));
  const fn = body.slice(0, body.indexOf("\n}\n") + 3);
  const pushes = fn.match(/cards\.push\(\{[\s\S]*?\}\);/g) ?? [];
  assert.ok(pushes.length >= 3, `应至少能定位到真实/演示/缺失三处 push，实际 ${pushes.length}`);
  for (const p of pushes) assert.ok(p.includes("data_status"), `未标来源的卡片：${p.replace(/\s+/g, " ").slice(0, 60)}…`);
  assert.match(fn, /data_status: "REAL"[\s\S]{0,40}series_synthetic: !spark/);
  assert.match(fn, /data_status: "DEMO", series_synthetic: true/);
  assert.match(fn, /missing: true, data_status: "MISSING"/);
});

test("助理页与分析页的上下文都经 renderMarketContext 组装，锚点都走 guardPriceOf", () => {
  const assistant = readSrc("src/components/desk/pages/AssistantPage.tsx");
  assert.ok(assistant.includes("renderMarketContext"), "助理页未走统一上下文渲染");
  assert.ok(assistant.includes("guardPriceOf"), "助理页数量级锚点未过滤来源");
  assert.ok(assistant.includes("provenanceOfQuote") && assistant.includes("provenanceOfTechSnapshot"));
  const analysis = readSrc("src/components/desk/pages/AnalysisPage.tsx");
  assert.ok(analysis.includes("renderMarketContext"), "分析页未走统一上下文渲染");
  assert.ok(analysis.includes("provenanceOfTechSnapshot(kSource)"), "分析页 K 线来源未分层");
});

