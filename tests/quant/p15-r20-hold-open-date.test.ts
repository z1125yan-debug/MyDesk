// P15-R20 持仓上下文（建仓日期）钉测。
//
// 钉的是四条最容易漂的东西：
//  1. 建仓日期只认 YYYY-MM-DD，认不出就判空——绝不替用户把「2026/9/1」修成「2026-09-01」；
//  2. 持有交易日数由真实交易日历算（左闭右开），日历取不到返回 null，不许拿 0 冒充；
//  3. 拼进提示词那一句：有啥说啥，没填的字段一个字都不出现；
//  4. 接线：composer 小窗 / 两张持仓卡 / 两条服务端链路都真的用了这一份（源码形状钉）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMPTY_HOLD, HOLD_USAGE_NOTE, hasHold, heldTradeDays, normalizeOpenDate, renderHoldLine, sanitizeHold,
} from "../../src/lib/desk/hold-core.ts";
import { buildCostPlan, buildHoldOrReduce, SUGGESTION_CARDS_CORE, EXTRA_SUGGESTION_CARDS, initialFormState } from "../../src/lib/desk/suggestion-cards-core.ts";

const SELF = readFileSync(new URL("../../src/lib/desk/hold-core.ts", import.meta.url), "utf8");
const CARDS = readFileSync(new URL("../../src/lib/desk/suggestion-cards-core.ts", import.meta.url), "utf8");
const NOTE = readFileSync(new URL("../../src/lib/desk/hold-note.ts", import.meta.url), "utf8");
const CHAT_ROUTE = readFileSync(new URL("../../src/app/api/ai/chat/route.ts", import.meta.url), "utf8");
const PROXY_ROUTE = readFileSync(new URL("../../src/app/api/ai/proxy/route.ts", import.meta.url), "utf8");
const PICKER = readFileSync(new URL("../../src/components/desk/ui/HoldPicker.tsx", import.meta.url), "utf8");
const DIALOG = readFileSync(new URL("../../src/components/desk/ui/SuggestionCardDialog.tsx", import.meta.url), "utf8");

test("建仓日期只认 YYYY-MM-DD，其它形状一律判空（不替用户修）", () => {
  assert.equal(normalizeOpenDate("2026-09-01"), "2026-09-01");
  for (const bad of ["2026/9/1", "2026-9-1", "昨天", "2026-13-01", "", "  2026-09-01 ", "2026-09-01T00:00:00"]) {
    // 两端空白要 trim 掉，其余一律不认
    assert.equal(normalizeOpenDate(bad), bad === "  2026-09-01 " ? "2026-09-01" : "", bad);
  }
});

test("sanitizeHold：空壳返回 null，乱值丢弃，不往请求体塞空对象", () => {
  assert.equal(sanitizeHold(null), null);
  assert.equal(sanitizeHold({}), null);
  assert.equal(sanitizeHold({ openDate: "昨天" }), null, "认不出的日期不该留下空壳以外的东西");
  const ok = sanitizeHold({ symbol: " 688698 ", cost: "2 3.80", position: "2 成", openDate: "2026-09-01" });
  assert.deepEqual(ok, { symbol: "688698", cost: "23.80", position: "2 成", openDate: "2026-09-01" });
  assert.equal(hasHold(EMPTY_HOLD), false);
  assert.equal(hasHold(ok), true);
});

test("heldTradeDays：左闭右开算真实交易日，日历缺失返回 null（不许 0 顶）", () => {
  const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-24"];
  assert.equal(heldTradeDays(days, "2026-09-01", "2026-09-24"), 3, "建仓当天不算已持有");
  assert.equal(heldTradeDays(null, "2026-09-01", "2026-09-24"), null, "日历没取到必须 null");
  assert.equal(heldTradeDays([], "2026-09-01", "2026-09-24"), null);
  assert.equal(heldTradeDays(days, "2026-09-24", "2026-09-24"), null, "当天建仓没有持有天数");
  assert.equal(heldTradeDays(days, "2026-10-01", "2026-09-24"), null, "建仓晚于交易日按未知处理");
});

test("renderHoldLine：有啥说啥，没填的字段一个字都不出现", () => {
  assert.equal(renderHoldLine({}), "");
  assert.equal(renderHoldLine({ symbol: "688698" }), "用户持仓：标的 688698。");
  const full = renderHoldLine(
    { symbol: "688698", cost: "23.80", position: "2 成", openDate: "2026-09-01" },
    { tradeDate: "2026-09-24", heldDays: 17 },
  );
  assert.match(full, /标的 688698/);
  assert.match(full, /成本价 23\.80/);
  assert.match(full, /仓位 2 成/);
  assert.match(full, /建仓日期 2026-09-01（到最近交易日 2026-09-24 已持有 17 个交易日）/);
  // 天数算不出来时只报日期，不许编天数
  const noDays = renderHoldLine({ openDate: "2026-09-01" }, { tradeDate: "2026-09-24", heldDays: null });
  assert.equal(noDays, "用户持仓：建仓日期 2026-09-01。");
  assert.doesNotMatch(noDays, /已持有/);
});

test("HOLD_USAGE_NOTE 明写「不以回本为依据」与「仓位未知不许默认满仓」", () => {
  assert.match(HOLD_USAGE_NOTE, /不要以回本作为判断依据/);
  assert.match(HOLD_USAGE_NOTE, /不许默认满仓/);
  assert.match(SELF, /HOLD_USAGE_NOTE/);
});

test("持仓卡：建仓日期进问句，没填时问句里不出现「建仓」二字", () => {
  const withDate = buildCostPlan("伟创电气", "23.80", "2 成", "2026-09-01");
  assert.match(withDate, /2026-09-01 建的仓/);
  assert.match(withDate, /已持有几个交易日/);
  const withoutDate = buildCostPlan("伟创电气", "23.80", "", "");
  assert.doesNotMatch(withoutDate, /建仓/);
  // 稳智原文那句「不要以回本作为判断依据」必须还在（改口径别把原话改没了）
  assert.match(withoutDate, /不要以回本作为判断依据/);
  // 乱填的日期不进句子
  assert.doesNotMatch(buildCostPlan("X", "1", "", "昨天"), /昨天/);

  const hold = buildHoldOrReduce("中控技术", "", "2026-09-01");
  assert.match(hold, /2026-09-01 建的仓/);
  assert.match(hold, /成本未提供/);
});

test("两张持仓卡都真的挂了 openDate 字段，且它是选填（required 未设）", () => {
  const cost = SUGGESTION_CARDS_CORE.find((c) => c.wzMode === "stock_cost_input");
  const reduce = EXTRA_SUGGESTION_CARDS.find((c) => c.wzMode === "stock_reduce_input");
  assert.ok(cost && reduce);
  for (const c of [cost, reduce]) {
    const f = c.fields.find((x) => x.key === "openDate");
    assert.ok(f, `${c.label} 缺 openDate 槽位`);
    assert.equal(f.required, undefined, "建仓日期是选填");
    assert.ok(f.label.includes("建仓日期"));
  }
  // 表单初始值里必须有 openDate，否则受控 input 会变非受控
  assert.equal(initialFormState(cost).openDate, "");
});

test("接线：弹窗渲染 date 控件、小窗接 store、两条服务端链路都吃 hold-note", () => {
  assert.match(DIALOG, /f\.key === "openDate"/);
  assert.match(DIALOG, /type="date"/);
  assert.match(PICKER, /setHoldCtx/);
  assert.match(PICKER, /normalizeOpenDate/);
  assert.match(NOTE, /workdays\.range|tdxTradingDaysBetween/, "持有天数必须来自真实交易日历");
  assert.match(CHAT_ROUTE, /holdNoteOf\(/);
  assert.match(CHAT_ROUTE, /HOLD_USAGE_NOTE/);
  assert.match(PROXY_ROUTE, /holdNoteOf\(/);
  assert.match(PROXY_ROUTE, /HOLD_USAGE_NOTE/);
  // 两条链路都不能自己拼一句「我持有」，必须走 hold-core 的 renderHoldLine
  assert.doesNotMatch(CHAT_ROUTE, /我持有\$\{/);
  assert.doesNotMatch(PROXY_ROUTE, /我持有\$\{/);
});

test("卡片派发带 hold：持仓卡填完写回 store 的是同一份（不是第二套字段）", () => {
  assert.match(CARDS, /hold: HoldCtx \| null/, "CardDispatch 要带 hold");
  assert.match(CARDS, /holdFromCardInput/);
});
