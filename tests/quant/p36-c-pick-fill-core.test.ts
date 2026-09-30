// P36-C 战绩回填纯核单测：口径与 B 的事件回测是同一套，且「没买」绝不能被记成「买了没赚」。

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSymbols, symJsonOf, symFillOf, fillStatOf, benchNetOf, navSeriesOf, fillDecisionOf, basisTextOf,
  type PickSym, type SymQuoteRow,
} from "../../src/lib/quant/strategy/pick-fill-core.ts";
import { roundTripDragOf } from "../../src/lib/quant/backtest/event-core.ts";

const sym = (s: string, close: number | null = 10, name = ""): PickSym => ({ symbol: s, name, close });

test("symbols 序列化/反序列化可逆，脏数据不炸", () => {
  const xs: PickSym[] = [{ symbol: "600000.SH", name: "浦发银行", close: 8.12 }, { symbol: "300750.SZ", name: "", close: null }];
  assert.deepEqual(parseSymbols(symJsonOf(xs)), xs);
  assert.deepEqual(parseSymbols(null), []);
  assert.deepEqual(parseSymbols("不是 JSON"), []);
  assert.deepEqual(parseSymbols("{}"), []);
  assert.deepEqual(parseSymbols('[{"symbol":""},{"symbol":"000001.SZ","close":1}]').map((x) => x.symbol), ["000001.SZ"]);
});

test("正常票：T+1 开盘买 T+2 开盘卖，净收益=毛收益扣往返成本（乘性）", () => {
  const f = symFillOf(sym("600000.SH", 10), { symbol: "600000.SH", t1Open: 10, t2Open: 10.5 });
  assert.equal(f.tradable, true);
  const gross = 5; // (10.5/10 -1)*100
  assert.ok(Math.abs((f.gross as number) - gross) < 1e-9);
  // 净收益必须比毛收益低，且差额≈往返成本（5% 涨跌下乘性≈0.43 个百分点）
  const drag = (f.gross as number) - (f.net as number);
  assert.ok(drag > 0.4 && drag < 0.5, `扣费额应在 0.4~0.5 个百分点，实际 ${drag.toFixed(3)}`);
  assert.ok((f.net as number) > 0);
});

test("T+1 一字涨停 → 剔除，不记 0 收益（记 0 会把「没买」当「买了没赚」）", () => {
  // 昨收 10 元，主板涨停 11 元，T+1 开盘直接 11 → 买不进
  const f = symFillOf(sym("600000.SH", 10), { symbol: "600000.SH", t1Open: 11, t2Open: 11.5 });
  assert.equal(f.tradable, false);
  assert.equal(f.net, null);
  assert.match(f.reason ?? "", /一字涨停/);
});

test("停牌（无 T+1 开盘价）→ 剔除并给原因", () => {
  const f = symFillOf(sym("600000.SH", 10), { symbol: "600000.SH", t1Open: null, t2Open: 12 });
  assert.equal(f.tradable, false);
  assert.match(f.reason ?? "", /停牌/);
});

test("库里缺这两天的行情 → 单列为 missing，不混进 skipped", () => {
  const f = symFillOf(sym("600000.SH", 10), undefined);
  assert.equal(f.tradable, false);
  assert.equal(f.reason, "库里没有这两天的行情");
  const st = fillStatOf([
    f,
    symFillOf(sym("600001.SH", 10), { symbol: "600001.SH", t1Open: 10, t2Open: 10.3 }),
    symFillOf(sym("600002.SH", 10), { symbol: "600002.SH", t1Open: 11, t2Open: 11 }), // 一字涨停
  ]);
  assert.equal(st?.missing, 1);
  assert.equal(st?.skipped, 1, "缺行情与买不进必须分开记，混一起就没法判断是数据问题还是策略问题");
  assert.equal(st?.n, 1);
  // 整批都没有任何可算的票 → 没有成绩就是没有成绩，不许返回 0 分
  assert.equal(fillStatOf([f]), null);
});

test("汇总：只统计真买得进的票，一只都算不出来返回 null", () => {
  const fills = [
    symFillOf(sym("a", 10), { symbol: "a", t1Open: 10, t2Open: 11 }),   // +10% 毛
    symFillOf(sym("b", 10), { symbol: "b", t1Open: 10, t2Open: 9.5 }),  // −5% 毛
    symFillOf(sym("c", 10), { symbol: "c", t1Open: 11, t2Open: 11 }),   // 一字涨停剔除
  ];
  const st = fillStatOf(fills);
  assert.ok(st);
  assert.equal(st.n, 2);
  assert.equal(st.up, 1);
  assert.equal(st.skipped, 1);
  assert.ok(st.avgNet > 0 && st.avgNet < 3);
  assert.equal(fillStatOf([symFillOf(sym("c", 10), { symbol: "c", t1Open: 11, t2Open: 11 })]), null);
});

test("基准取中位数不是均值（个别票一天拉 20% 不能代表「随便买」）", () => {
  const nets = [-2, -1, 0.5, 1, 30];
  assert.equal(benchNetOf(nets), 0.5);
  const mean = nets.reduce((a, b) => a + b, 0) / nets.length;
  assert.ok(mean > 5, "均值被极值带跑，正是不能用均值当基准的实证");
  assert.equal(benchNetOf([]), null);
});

test("净值曲线：缺样本那天净值原地不动，两条线都从 1 出发", () => {
  const pts = navSeriesOf([
    { tradeDate: "2026-10-01", net: 1, bench: 0.5 },
    { tradeDate: "2026-10-02", net: null, bench: null },
    { tradeDate: "2026-10-03", net: -2, bench: 0 },
  ]);
  assert.equal(pts[0].nav, 1.01);
  assert.equal(pts[0].benchNav, 1.005);
  assert.equal(pts[1].nav, 1.01, "没样本的那天不该动净值");
  assert.equal(pts[1].hasSample, false);
  assert.ok(Math.abs(pts[2].nav - 1.01 * 0.98) < 1e-5);
  assert.equal(pts[2].benchNav, 1.005);
});

test("幂等闸门：已回填/没记票/后面两天没走完，都不许回填", () => {
  assert.deepEqual(fillDecisionOf({ symbols: symJsonOf([sym("a")]) }, null, null).fill, false);
  assert.match(fillDecisionOf({ symbols: symJsonOf([sym("a")]) }, "2026-10-02", null).reason ?? "", /还没走完/);
  assert.match(fillDecisionOf({ symbols: null }, "2026-10-02", "2026-10-03").reason ?? "", /没记具体票/);
  assert.match(
    fillDecisionOf({ symbols: symJsonOf([sym("a")]), symBackfilledAt: new Date() }, "2026-10-02", "2026-10-03").reason ?? "",
    /已经回填过/,
  );
  assert.deepEqual(fillDecisionOf({ symbols: symJsonOf([sym("a")]) }, "2026-10-02", "2026-10-03"), { fill: true, reason: null });
  assert.equal(fillDecisionOf({ symbols: symJsonOf([sym("a")]) }, "2026-10-05", "2026-10-03").fill, false);
});

test("口径说明说人话：不含黑话，且把交易日/成本/剔除/及格线都讲清楚", () => {
  const t = basisTextOf({ t1: "2026-10-02", t2: "2026-10-03", source: "本地日K粮仓", skipped: 2, benchN: 5200 });
  assert.match(t, /2026-10-02.*买入/);
  assert.match(t, /0\.41%/);
  assert.match(t, /2 只.*买不进/);
  assert.match(t, /5200 只票的中位/);
  for (const jargon of ["样本外", "截面", "IC", "净值曲线", "超额", "MA20"]) {
    assert.ok(!t.includes(jargon), `口径说明里不该出现黑话「${jargon}」`);
  }
});

test("涨停幅度按板块走（主板10% / 创业板科创板20% / ST 5%）", () => {
  // 昨收 10：主板 11 封板买不进；创业板 11 只是 +10% 能买进
  const main = symFillOf({ symbol: "600000.SH", name: "X", close: 10 }, { symbol: "600000.SH", t1Open: 11, t2Open: 11 });
  const gem = symFillOf({ symbol: "300750.SZ", name: "Y", close: 10 }, { symbol: "300750.SZ", t1Open: 11, t2Open: 11 });
  const st = symFillOf({ symbol: "000001.SZ", name: "ST某某", close: 10 }, { symbol: "000001.SZ", t1Open: 10.5, t2Open: 10.5 });
  assert.equal(main.tradable, false);
  assert.equal(gem.tradable, true);
  assert.equal(st.tradable, false, "ST 股 5% 就封板，10.5 元买不进");
});

test("重复运行不翻倍：第二次回填被闸门挡住（纯核层面）", () => {
  const row: { symbols: string; symBackfilledAt: Date | null } = { symbols: symJsonOf([sym("a", 10)]), symBackfilledAt: null };
  const q: SymQuoteRow[] = [{ symbol: "a", t1Open: 10, t2Open: 10.2 }];
  const first = fillDecisionOf(row, "2026-10-02", "2026-10-03");
  assert.equal(first.fill, true);
  const st = fillStatOf(q.map((r) => symFillOf(sym("a", 10), r)));
  assert.ok(st && st.n === 1);
  row.symBackfilledAt = new Date();
  assert.equal(fillDecisionOf(row, "2026-10-02", "2026-10-03").fill, false, "回填过一次后重跑必须被挡住");
});

// ---- 防回退：C 的调度与字段一旦被删，战绩链会静默断掉（页面照常显示、数据永远是空的）----

import { readFileSync } from "node:fs";
import path from "node:path";

// 从仓库根读（node --test 在项目根执行，cwd 即根）
const read = (p: string): string => readFileSync(path.join(process.cwd(), p), "utf8");

test("调度器已登记 dailybars → picksym → pickfill 三个收盘后任务（删了战绩就永远不涨）", () => {
  const src = read("src/lib/quant/scheduler/index.ts");
  for (const k of ["dailybars", "picksym", "pickfill"]) {
    assert.match(src, new RegExp(`"${k}"`), `调度器 KINDS 里应该有 ${k}`);
  }
  assert.match(read("src/lib/quant/scheduler/rules.ts"), /"dailybars" \| "picksym" \| "pickfill"/);
});

test("KINDS 里 dailybars 必须排在 picksym 之前（顺序反了当天票就补不出来）", () => {
  const src = read("src/lib/quant/scheduler/index.ts");
  const m = /const KINDS: TaskKind\[\] = \[([^\]]+)\]/.exec(src);
  assert.ok(m, "找不到 KINDS 定义");
  const kinds = m[1].split(",").map((s) => s.trim().replace(/"/g, ""));
  assert.ok(
    kinds.indexOf("dailybars") >= 0 && kinds.indexOf("dailybars") < kinds.indexOf("picksym"),
    `dailybars 必须排在 picksym 之前，实际顺序：${kinds.join(" → ")}`,
  );
});

test("台账表字段不许被删：具体票 + 回填结果 + 逐票明细", () => {
  const s = read("prisma/schema.prisma");
  const block = s.slice(s.indexOf("model StrategyPick"), s.indexOf("model StrategyPick") + 3000);
  const fieldNames = new Set(
    block
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
  for (const f of ["symbols", "symbolsNote", "nextDaySymWin", "nextDaySymUp", "nextDaySymCount", "nextDaySymSkip", "nextDayBenchNet", "nextDaySymDetail", "symBackfilledAt"]) {
    assert.ok(fieldNames.has(f), `StrategyPick 少了字段 ${f}`);
  }
});
