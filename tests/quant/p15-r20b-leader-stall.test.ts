import { test } from "node:test";
import assert from "node:assert/strict";
import {
  leaderStall, topTierOf, LEADER_MIN_READ, LEADER_STALL_PT, LEADER_LEAD_PT, type RosterRow,
} from "../../src/lib/quant/screener/limit-up-roster-core.ts";

// P15-R20b 龙头滞涨（见顶压力分第三个分量）：昨日梯队顶上那一小撮今天的表现 vs 全 A 中位。
// 这一条最容易犯的错是「样本只有一两只就下结论」和「没有基准就拿 0 当基准」，
// 所以钉的是它**什么时候不许说话**，其次才是三种判词的分界。

const row = (symbol: string, boards: number | null): RosterRow => ({
  symbol, name: symbol.slice(0, 6), industry: "半导体", boards, changePct: 10,
  firstSeal: "09:30:00", lastSeal: "14:00:00", breakCount: 0, sealFund: 1e8, floatCap: 5e9,
});

const pct = (pairs: [string, number | null][]): Map<string, number | null> => new Map(pairs);

test("R20b-龙① 龙头组：最高板只有一只时往下带一档凑样本；带到头还是一只就如实报一只", () => {
  // 往下带的是「≥ 这一档」而不是「= 这一档」：5 板 1 只 + 3 板 2 只时，≥3 板就是 3 只
  const down = topTierOf([row("600001.SH", 5), row("600002.SH", 3), row("600003.SH", 3)]);
  assert.equal(down.highest, 5);
  assert.equal(down.tier, 3, "5、4 两档都只有 1 只 → 放到 ≥3 板（最多往下两档）");
  assert.equal(down.rows.length, 3);

  const lone = topTierOf([row("600001.SH", 5), row("600002.SH", 1), row("600003.SH", 1)]);
  assert.equal(lone.tier, 5);
  assert.equal(lone.rows.length, 1, "往下两档仍凑不满 2 只：如实返回那一只，够不够出结论交给 leaderStall");

  const two = topTierOf([row("600001.SH", 5), row("600002.SH", 4), row("600003.SH", 2)]);
  assert.equal(two.tier, 4, "5 板 1 只 → 带一档后 ≥4 板有 2 只，够样本就停");
  assert.deepEqual(two.rows.map((r) => r.symbol), ["600001.SH", "600002.SH"]);

  const flat = topTierOf([row("600001.SH", 3), row("600002.SH", 3), row("600003.SH", 1)]);
  assert.equal(flat.tier, 3, "最高板自己就有 2 只：不外扩");

  const noBoards = topTierOf([row("600001.SH", null), row("600002.SH", null)]);
  assert.equal(noBoards.rows.length, 0, "整批缺连板数 → 取不出组（不是当成 1 板）");
  assert.equal(noBoards.highest, 0);
  assert.deepEqual(topTierOf([]), { tier: 0, highest: 0, rows: [] });
});

test("R20b-龙② 组里只读到一只今日涨幅：不出结论——一只高标股的当天涨跌是噪声", () => {
  const s = leaderStall("2026-09-24", [row("600001.SH", 5), row("600002.SH", 4)],
    pct([["600001.SH", -6.5], ["600002.SH", null]]), -2.0);
  assert.equal(s.available, false);
  assert.equal(s.read, 1, "null（停牌/没取到）不计入读数");
  assert.equal(s.gap, null, "不出结论就不给落差");
  assert.ok(s.reason.includes(`<${LEADER_MIN_READ} 只`), s.reason);
  assert.ok(s.reason.includes("不出结论"), s.reason);
});

test("R20b-龙③ 全组今日涨幅都没读到：read=0，绝不把「没数」说成「龙头跌 0%」", () => {
  const s = leaderStall("2026-09-24", [row("600001.SH", 5), row("600002.SH", 4)],
    pct([["600001.SH", null], ["600002.SH", null]]), -2.0);
  assert.equal(s.available, false);
  assert.equal(s.median, null, "中位数是 null，不是 0");
  assert.equal(s.avg, null);
});

test("R20b-龙④ 基准（全 A 中位涨跌幅）没读到就不判：不拿 0 当中位数", () => {
  const s = leaderStall("2026-09-24", [row("600001.SH", 5), row("600002.SH", 4)],
    pct([["600001.SH", -3.0], ["600002.SH", -2.0]]), null);
  assert.equal(s.available, false);
  assert.equal(s.verdict, "");
  assert.ok(s.reason.includes("不拿 0 当基准"), s.reason);
  assert.equal(s.benchmark, null);

  const nan = leaderStall("2026-09-24", [row("600001.SH", 5), row("600002.SH", 4)],
    pct([["600001.SH", -3.0], ["600002.SH", -2.0]]), Number.NaN);
  assert.equal(nan.available, false, "NaN 当基准比 0 更糟：同样不判");
});

test("R20b-龙⑤ 判词分界：跑输 ≤-1.5 滞涨、≥+1.5 领涨、中间同步（阈值是导出的，页面不另写一套）", () => {
  const rows = [row("600001.SH", 5), row("600002.SH", 4), row("600003.SH", 4)];
  const build = (lead: number, bench: number) =>
    leaderStall("2026-09-24", rows, pct([["600001.SH", lead], ["600002.SH", lead], ["600003.SH", lead]]), bench);

  const stall = build(-4.5, -2.0); // gap = -2.5
  assert.equal(stall.verdict, "滞涨");
  assert.equal(stall.available, true);
  assert.ok(stall.line.includes(`阈值 ≤-${LEADER_STALL_PT}`), stall.line);

  const lead2 = build(0.5, -2.0); // gap = +2.5
  assert.equal(lead2.verdict, "领涨");
  assert.ok(lead2.line.includes("不像见顶形状"), lead2.line);

  const mid = build(-2.0, -2.0); // gap = 0
  assert.equal(mid.verdict, "同步");
  assert.ok(mid.line.includes(`±${LEADER_LEAD_PT} 以内`), mid.line);

  // 边界含端点：正好 ±1.5 各归一边（刻度只在 core 一处）
  assert.equal(build(-3.5, -2.0).verdict, "滞涨", "gap 恰好 -1.5 → 滞涨");
  assert.equal(build(-0.5, -2.0).verdict, "领涨", "gap 恰好 +1.5 → 领涨（同一把刻度的另一端）");
  assert.equal(build(-0.9, -2.0).verdict, "同步", "gap +1.1：差 1.5 以内不出判词");
});

test("R20b-龙⑥ 中位数与 R20a 赚钱效应那条同一种取法（偶数只取上侧那一档），并且组里没有基准以外都不许缺", () => {
  const rows = [row("600001.SH", 5), row("600002.SH", 5), row("600003.SH", 5)];
  const s = leaderStall("2026-09-24", rows, pct([["600001.SH", 2], ["600002.SH", -4], ["600003.SH", 0]]), -1);
  assert.equal(s.median, 0, "奇数只：排序后中间那只");
  assert.equal(s.avg, -0.6666666666666666, "平均另算：line 里两个数都摆着，读者自己看得见分化");

  const even = leaderStall("2026-09-24", [row("600001.SH", 5), row("600002.SH", 5)],
    pct([["600001.SH", -4], ["600002.SH", 2]]), -1);
  assert.equal(even.median, 2, "偶数只取上侧中位——与 moneyEffect 同一条取法，两处不各写一套");
});

test("R20b-龙⑦ 名单日期不等于今天：日期跟着读数走，缺几只今日读数也写进 reason", () => {
  const rows = [row("600001.SH", 5), row("600002.SH", 4), row("600003.SH", 4), row("600004.SH", 2)];
  const s = leaderStall("2026-09-24", rows, pct([["600001.SH", 1], ["600002.SH", 0.5], ["600003.SH", null], ["600004.SH", 3]]), -1);
  assert.equal(s.available, true, "≥2 只就够出结论，缺的那只只报覆盖率");
  assert.equal(s.sample, 3, "4 板及以上 3 只（600004 是 2 板，不在组里）");
  assert.equal(s.read, 2, "其中一只今日没读到（停牌/接口缺）→ 读数 2 只，仍然够出结论");
  assert.ok(s.line.includes("2026-09-24"), `梯队所属日期必须写在结论里：${s.line}`);
  assert.ok(s.reason.includes("缺"), s.reason);
});

test("R20b-龙⑧ 取数层整批失败时把原因并进 reason（纯核不看 IO，但话要说全）", () => {
  const rows = [row("600001.SH", 5), row("600002.SH", 5)];
  const s = leaderStall("2026-09-24", rows, pct([["600001.SH", null], ["600002.SH", null]]), -1, "腾讯批量行情超时");
  assert.equal(s.available, false);
  assert.ok(s.reason.includes("取数：腾讯批量行情超时"), s.reason);
  assert.ok(s.reason.includes(`${LEADER_MIN_READ} 只`), "两条原因都在：既说读到几只，也说为什么读不到");
});

test("R20b-龙⑨ 昨日名单为空：一句「无从取组」，不返回一个 available 的空对象", () => {
  const empty = leaderStall(null, [], pct([]), -1);
  assert.equal(empty.available, false);
  assert.ok(empty.reason.includes("库里没有昨日涨停名单"), empty.reason);
  assert.equal(empty.sample, 0);
  assert.equal(empty.line, "");
});
