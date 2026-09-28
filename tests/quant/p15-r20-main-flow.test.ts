// P15-R20 主力净额（通达信逐笔自算）钉测。
//
// 钉的是四条最容易漂的东西：
//  1. 纯核恒等式与「一次取全量」的完整性判定——`complete=true` 时即便没有 active1 对账
//     也认样本完整（这是本次从分页换成 all_today 换来的真收益）；
//  2. 页面该显示哪个数：全 A 快照真有数就用它，否则退回自算子集，**都没读到显示 — 不显示 0 亿**；
//  3. 自算的纪律：挂出身说明、不造历史序列（逐笔只有当日）、算不出返回 null；
//  4. 接线逐笔取数改成 `trades.all_today` 优先、并发降到 4（8 路实测会漏票）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  accumulateTicks, emptyFlowAccum, mainFlowFromAccum, MAIN_FLOW_BASIS,
  SUPER_BAND_YUAN, BIG_BAND_YUAN, type FlowTickLike,
} from "../../src/lib/quant/screener/tdx-flow-core.ts";
import { mainNetDisplay } from "../../src/lib/desk/main-net-core.ts";

const TDX = readFileSync(new URL("../../src/lib/desk/tdx.ts", import.meta.url), "utf8");
const FLOW = readFileSync(new URL("../../src/lib/desk/fund-flow.ts", import.meta.url), "utf8");
const TOOLS = readFileSync(new URL("../../src/lib/desk/chat-tools.ts", import.meta.url), "utf8");
const PROFILE = readFileSync(new URL("../../src/app/api/stock/profile/route.ts", import.meta.url), "utf8");
const SENT = readFileSync(new URL("../../src/app/api/market/sentiment/route.ts", import.meta.url), "utf8");
const RISK = readFileSync(new URL("../../src/app/api/market/risk/route.ts", import.meta.url), "utf8");

const tick = (price: number, volume: number, side: string): FlowTickLike => ({ price, volume, side, event_kind: "trade" });

test("分档恒等式：主力净额 = 超大单 + 大单，中单小单不计入", () => {
  const acc = accumulateTicks([
    tick(10, 2000, "buy"),   // 10*2000*100 = 200万 → 特大
    tick(10, 50, "sell"),    // 5万 → 不计入
    tick(10, 300, "buy"),    // 30万 → 大单
    tick(10, 300, "sell"),   // 30万 → 大单（负）
  ]);
  const f = mainFlowFromAccum(acc, { pages: 1, truncated: false });
  assert.ok(Math.abs(f.superBigYi - 0.02) < 1e-9, `超大单净额应为 0.02 亿，实际 ${f.superBigYi}`);
  assert.ok(Math.abs(f.bigYi) < 1e-9, "大单买卖相抵应为 0");
  assert.ok(Math.abs(f.mainNetYi - (f.superBigYi + f.bigYi)) < 1e-12, "main = superBig + big 必须成立");
});

test("一次取全量：没有 active1 对账时，complete=true 仍认样本完整", () => {
  const acc = accumulateTicks([tick(10, 2000, "buy")]);
  // 旧口径：expectedTicks 缺失 ⇒ sampleComplete=false（分页时代的保守写法）
  assert.equal(mainFlowFromAccum(acc, { pages: 1, truncated: false, expectedTicks: null }).sampleComplete, false);
  // R20：all_today 一次给全当天逐笔，无翻页无截断 ⇒ 认完整
  assert.equal(mainFlowFromAccum(acc, { pages: 1, truncated: false, expectedTicks: null, complete: true }).sampleComplete, true);
  // 但截断仍然一票否决：半截样本不许冒充完整
  assert.equal(mainFlowFromAccum(acc, { pages: 10, truncated: true, complete: true }).sampleComplete, false);
});

test("成交额未知时净占比是 null，不补 0（占比为 0 是结论，不是缺失）", () => {
  const acc = accumulateTicks([tick(10, 2000, "buy")]);
  assert.equal(mainFlowFromAccum(acc, { pages: 1, truncated: false }).ratioPct, null);
  assert.ok(mainFlowFromAccum(acc, { pages: 1, truncated: false, amountYuan: 1e10 }).ratioPct !== null);
});

test("空累加不产数：一只都没算出来时 totals 必须是 null，不是 0", () => {
  const f = mainFlowFromAccum(emptyFlowAccum(), { pages: 0, truncated: false });
  assert.equal(f.mainNetYi, 0, "空样本净额算出来是 0 没问题");
  assert.equal(f.sampleTicks, 0, "但笔数是 0，消费方据此判断「没取到」");
  assert.match(FLOW, /if \(!t\) return \{\}/, "算不出合计时返回空块，不返回 0 亿");
});

test("展示取舍：全 A 快照真有数就用它；否则用自算子集；都没有就 null（不显示 0 亿）", () => {
  const fullA = mainNetDisplay({ main_net_sum_yi: -120, main_net_known: 3000 });
  assert.equal(fullA?.value, -120);
  assert.equal(fullA?.selfComputed, false);
  assert.match(fullA?.label ?? "", /全A 3000 家/);

  // 全 A 一家都没读到（main_net_known=0）⇒ 那个 0 是「没读到」，必须退回自算
  const selfOnly = mainNetDisplay({
    main_net_sum_yi: 0, main_net_known: 0,
    main_net_tdx: { sum_yi: -12.5, known: 59, universe: 60, complete: 58, amount_yi: 3200, as_of: "15:00:00", basis: MAIN_FLOW_BASIS, note: "成交额前 60 只的自算合计" },
  });
  assert.equal(selfOnly?.value, -12.5);
  assert.equal(selfOnly?.selfComputed, true, "自算值必须能被页面标出来");
  assert.match(selfOnly?.hint ?? "", /前 60 只/);

  // 两个源都没有 ⇒ null ⇒ 页面显示「—」
  assert.equal(mainNetDisplay({ main_net_sum_yi: 0, main_net_known: 0 }), null);
  assert.equal(mainNetDisplay({ main_net_sum_yi: 0, main_net_known: 0, main_net_tdx: null }), null);
  assert.equal(mainNetDisplay(null), null);
});

test("自算口径常量：特大 ≥100万、大单 20–100万，出身说明必须逐字带上", () => {
  assert.equal(SUPER_BAND_YUAN, 1_000_000);
  assert.equal(BIG_BAND_YUAN, 200_000);
  assert.match(MAIN_FLOW_BASIS, /特大单\(≥100万\)/);
  assert.match(MAIN_FLOW_BASIS, /主动买−主动卖/);
  assert.match(MAIN_FLOW_BASIS, /自算/, "必须写明是自算，不能冒充官方读数");
});

test("自算纪律：只给当日、不造历史序列；算不出返回 null 不补 0", () => {
  assert.match(FLOW, /不产生「近 14 日」序列/, "fund-flow 的纪律注释要写清不造历史");
  assert.match(TOOLS, /近14日: null/, "自算那一路不许拿当日值去填历史序列");
  assert.match(TOOLS, /自算只覆盖当日逐笔，历史序列无法自造/, "工具返回里要向模型说明为什么没有历史");
  assert.match(FLOW, /if \(!flow \|\| !isFinite\(flow\.mainNetYi\)\) return null/, "算不出返回 null");
});

test("接线：逐笔优先一次取全量（trades.all_today），取不到才回落分页", () => {
  assert.match(TDX, /"trades\.all_today"/, "没用一次取全量的接口");
  const iAll = TDX.indexOf('"trades.all_today"');
  const iPage = TDX.indexOf('"trades.today"');
  assert.ok(iAll > 0 && iPage > iAll, "all_today 必须在分页之前先试");
  // 并发从 8 降到 4：8 路实测 6/60 只取空
  assert.match(TDX, /const TICK_CONCURRENCY = 4/);
  assert.match(TDX, /mapPool\(list, TICK_CONCURRENCY/, "榜单那一路要用同一个并发上限");
});

test("接线：个股画像 / AI 取数 / 两个市场端点都挂了主力净额这条线", () => {
  // 个股画像：东财+新浪都没通时第三档自算，且不再往 missing 里塞「两条源都没通」
  assert.match(PROFILE, /tdxMainNetOf/, "个股画像没接自算备胎");
  assert.doesNotMatch(PROFILE, /东财主力资金明细与新浪备胎两条源都没通/, "备胎已扩到三条源，提示文案要跟着改");
  // R21：主力净额定源为通达信（不再把东财/新浪当主源，也不再对用户播报「某家断源」）
  assert.match(PROFILE, /通达信当日逐笔自算（主力净额主源）/, "自算那一档要标出身，且已是主源口径");
  // AI 取数工具：stock_snapshot 的「主力净额亿」不再常年 null；stock_fund_flow 有第三档
  assert.match(TOOLS, /tdxMainNetOf/, "chat-tools 没接自算备胎");
  assert.match(TOOLS, /主力净额口径/, "快照里要带口径说明，不能只丢一个数字给模型");
  // 市场端点：sentiment 与 risk 都挂 main_net_tdx
  for (const [name, src] of [["sentiment", SENT], ["risk", RISK]] as const) {
    assert.match(src, /marketMainNetTdx\(\)/, `${name} 端点没挂自算合计`);
  }
});

test("接线：市场层的自算合计带覆盖率，不许被当成全 A 合计", () => {
  assert.match(FLOW, /不是全 A 合计/, "note 里必须直说这是子集");
  assert.match(FLOW, /known: t\.known/);
  assert.match(FLOW, /universe: t\.universe/);
});
