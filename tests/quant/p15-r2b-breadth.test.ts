import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeBreadthSeries, storedTradingDays, type StockBar } from "../../src/lib/quant/screener/breadth-core.ts";

// P15-R2b 逐日宽度统计（站上5日线占比/创5日·3日新低）：纯核行为测 + 沉淀/接线钉。
// 红线：攒不满根数不进分母（缺就是缺）、不随全局日历给停牌票补价、脏行不统计、同日重复取首条。

const readSrc = (p: string) => readFileSync(new URL(p, new URL("../../", import.meta.url)), "utf8");
const bars = (symbol: string, ...pc: [string, number][]): StockBar[] => pc.map(([date, close]) => ({ symbol, date, close }));

test("R2b-① MA5 口径：满 5 根才进分母；站上=收盘>5根均值（含当日），不满 5 根 pct 是 null", () => {
  const s = computeBreadthSeries(bars("A.SH",
    ["2026-09-15", 10], ["2026-09-16", 11], ["2026-09-17", 12], ["2026-09-18", 13], ["2026-09-22", 14]));
  assert.equal(s.length, 5, "每个沉淀日都有一行（universe 计数照记）");
  for (const d of s.slice(0, 4)) {
    assert.equal(d.ma5_eligible, 0, "第 1~4 天没人满 5 根：分母 0");
    assert.equal(d.above_ma5_pct, null, "分母 0 → null，不是 0%（缺读数≠0 纪律）");
  }
  const d5 = s[4];
  assert.equal(d5.universe, 1);
  assert.equal(d5.ma5_eligible, 1);
  assert.equal(d5.above_ma5, 1, "14 > mean(10..14)=12");
  assert.equal(d5.above_ma5_pct, 100);
  assert.equal(d5.new_low_5, 0, "单调上行的最后一天不可能创5日新低");
  // 3 日口径早两天生效：第 3 天起就有分母
  assert.equal(s[1].ma3_eligible, 0);
  assert.equal(s[2].ma3_eligible, 1);
});

test("R2b-② 新低判定：并列最低算新低；MA5 站上不含等于（贴线不算站上）", () => {
  const s = computeBreadthSeries(bars("B.SZ",
    ["d1", 10], ["d2", 12], ["d3", 11], ["d4", 12], ["d5", 10]));
  const d5 = s[4];
  assert.equal(d5.new_low_5, 1, "10 = 前4根最低（d1 的 10）：并列最低也是「跌到近5日最低」");
  assert.equal(d5.above_ma5, 0, "10 < mean=11 不站上");
  assert.equal(d5.new_low_3, 1, "3 日窗口同样成立（prior2=[12,10]）");
  // 贴线：close 恰等于 MA5 → 不算站上
  const t = computeBreadthSeries(bars("C.SH", ["d1", 10], ["d2", 10], ["d3", 10], ["d4", 10], ["d5", 10]));
  assert.equal(t[4].above_ma5, 0, "10 > 10 不成立：站上不含等于");
  assert.equal(t[4].new_low_5, 1, "全平的票天天是「近5日最低」——并列口径两边一致");
});

test("R2b-③ 停牌票按自己已沉淀的行滚动：日历过了 5 天但只有 3 行 → 只进 3 日口径", () => {
  const s = computeBreadthSeries(bars("D.SZ",
    ["2026-09-15", 5], ["2026-09-17", 4], ["2026-09-22", 3])); // 中间缺两天（停牌/未沉淀）
  const last = s[s.length - 1];
  assert.equal(last.ma5_eligible, 0, "只有 3 根就装不出 5 根的窗口——不拿全局日历平移冒充满仓");
  assert.equal(last.above_ma5_pct, null);
  assert.equal(last.ma3_eligible, 1);
  assert.equal(last.new_low_3, 1, "3 ≤ min(5,4)：按自身序列算新低");
});

test("R2b-④ 禁造史与脏行：只攒 4 天时整条序列 pct 全 null；无效价/空日期/同日重复不进统计", () => {
  const s4 = computeBreadthSeries([
    ...bars("E.SH", ["d1", 10], ["d2", 9], ["d3", 8], ["d4", 7]),
    ...bars("F.SH", ["d1", 10], ["d2", 9], ["d3", 8], ["d4", 7]),
  ]);
  assert.equal(s4.length, 4);
  assert.ok(s4.every((d) => d.above_ma5_pct === null && d.ma5_eligible === 0), "4 个交易日：MA5 口径一天都不出数，页面只能报进度");
  assert.ok(s4.every((d) => d.universe === 2));
  const dirty = computeBreadthSeries([
    { symbol: "G.SH", date: "d1", close: Number.NaN },
    { symbol: "G.SH", date: "d2", close: -1 },
    { symbol: "G.SH", date: "", close: 5 },
    ...bars("H.SH", ["d1", 3], ["d1", 99]), // 同日重复：取首条 3
  ]);
  assert.deepEqual(dirty.map((d) => ({ date: d.date, universe: d.universe })), [{ date: "d1", universe: 1 }],
    "无效价/空日期全被挡，同日重复不重复计票：只剩 H 的 d1 一行");
  assert.equal(storedTradingDays([...bars("K", ["x", 1], ["y", 2]), { symbol: "K", date: "", close: 3 }]), 2, "进度按真实不同日期数，空日期不算一天");
});

test("R2b-⑤ 沉淀层红线：收盘前/周末拒跑、唯一键不重写、无价不写行", () => {
  const collect = readSrc("src/lib/quant/screener/breadth-collect.ts");
  assert.ok(collect.includes("15:05") && collect.includes("拒绝在收盘前执行"), "盘中快照价不是收盘价——收盘前触发直接拒");
  assert.ok(collect.includes("拒绝在周末执行"), "周六的快照是周五收盘价，按周六入库就是造交易日");
  assert.ok(collect.includes("!existing.has(r.symbol)"), "先查当日已有键再纯插（SQLite 方言无 skipDuplicates）：同日重跑只补新票不重写");
  assert.ok(collect.includes("m.price <= 0"), "停牌/无有效价格不写行：分母只数当日真有行的票");
  assert.ok(collect.includes("一条都不写"), "全A快照为空/全无价 → 抛错留痕，不产出空存档冒充已沉淀");
  const schema = readSrc("prisma/schema.prisma");
  assert.ok(schema.includes("model StockDailyClose") && schema.includes('@@unique([symbol, tradeDate])') && schema.includes('@@map("stock_daily_close")'),
    "schema 模型与唯一键钉住");
});

test("R2b-⑥ 调度与读侧接线：breadth 进 KINDS 白名单，端点只算不存，页面吃进度与点集", () => {
  const rules = readSrc("src/lib/quant/scheduler/rules.ts");
  const idx = readSrc("src/lib/quant/scheduler/index.ts");
  assert.ok(/TaskKind = "radar" \| "events" \| "breadth"/.test(rules), "任务类型三值化");
  assert.ok(idx.includes('KINDS: TaskKind[] = ["radar", "events", "breadth"]'), "收盘后窗口自动跑宽度沉淀");
  assert.ok(idx.includes("archiveBreadthScan()"), "执行分支接上沉淀器（mode/force 不参与其口径）");
  const run = readSrc("src/app/api/tasks/run/route.ts");
  assert.ok(run.includes('body.kind === "breadth"'), "手动接口白名单含 breadth（收盘前跑会被沉淀器拒并如实报错）");
  const route = readSrc("src/app/api/market/breadth/route.ts");
  assert.ok(route.includes("computeBreadthSeries") && route.includes("findMany") && !route.includes("createMany"), "读侧只算不写");
  assert.ok(route.includes("只沉淀了"), "攒不够天数时 missing 说清「满 5 天才出数」");
  const api = readSrc("src/lib/desk/quant-api.ts");
  assert.ok(api.includes("/api/market/breadth"), "客户端一条口 fetchBreadth");
  const mk = readSrc("src/components/desk/pages/MarketPage.tsx");
  assert.ok(mk.includes("void loadBreadth()"), "首屏自动带宽度进度");
  assert.ok(mk.includes("<BreadthPctLine points={bPoints} />"), "图只吃 pct 非 null 的真实统计日");
  assert.ok(mk.includes("v / 100"), "占比图 y 轴固定 0–100%，不自动缩放夸大波动");
  assert.ok(mk.includes("不画「一条横线冒充趋势」"), "只攒出 1 个点时不画线");
});
