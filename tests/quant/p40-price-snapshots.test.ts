// 定时快照纯核单测：午报门禁 / 三个卖点比价格 / 两点对比（午报）/ 涨跌幅基数
//   / 卖出日（D+2）/ 卖出日票池 / 评估日门禁
// 口径（用户 2026-10-16 最新口径，2026-10-17 修正卖出日）：
//   D 选股（收盘后）→ D+1 开盘买 → D+2 卖。三个快照是卖出日 D+2 的三个候选卖点。
//   买入日（D+1）/ 选股日（D）的价格不是卖点，不抓、不当卖点用。
// 成本 = 卖出日之前最近一个交易日（D+1）收盘价（不参与比，只当基数）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changePctOf,
  compareSellPair,
  compareSellWindows,
  fmtPct,
  isSellDayEval,
  isSnapshotSlot,
  sellDayOfDecision,
  snapshotDefOf,
  versionsSellingOnDate,
  VERSION_SELL_OFFSET,
} from "../../src/lib/desk/price-snapshots-core.ts";
import { tradingDaysAfter } from "../../src/lib/desk/trade-calendar.ts";
import {
  noonGate,
  NOON_EARLIEST_MINUTE,
} from "../../src/lib/desk/three-daily-reports-core.ts";

test("午报门禁：12:00 之前不发，12:00 之后发（09:56 是盘中快照，不是午报）", () => {
  assert.equal(NOON_EARLIEST_MINUTE, 720);
  // 北京时间 09:56 = UTC 01:56 → 不发
  const early = noonGate(new Date("2026-10-16T01:56:00Z"));
  assert.equal(early.allowed, false);
  if (!early.allowed) assert.ok(early.reason.includes("盘中快照"));
  // 北京时间 11:59 = UTC 03:59 → 还不发（必须 12:00 之后）
  assert.equal(noonGate(new Date("2026-10-16T03:59:00Z")).allowed, false);
  // 北京时间 12:00 = UTC 04:00 → 发
  assert.equal(noonGate(new Date("2026-10-16T04:00:00Z")).allowed, true);
  // 北京时间 12:01 → 发
  assert.equal(noonGate(new Date("2026-10-16T04:01:00Z")).allowed, true);
});

test("快照 slot 只有三个卖点：1030 / 1130 / close，没有 last-night（昨晚不是卖点，是成本）", () => {
  assert.equal(isSnapshotSlot("1030"), true);
  assert.equal(isSnapshotSlot("1130"), true);
  assert.equal(isSnapshotSlot("close"), true);
  assert.equal(isSnapshotSlot("last-night"), false);
  assert.equal(snapshotDefOf("1030").label, "10:30");
  assert.equal(snapshotDefOf("1130").label, "11:30 休盘");
  assert.equal(snapshotDefOf("close").label, "15:00 收盘");
});

test("涨跌幅：基数缺失返回 null，不编；价格相等涨跌 0", () => {
  assert.equal(changePctOf(null, 10), null);
  assert.equal(changePctOf(10, null), null);
  assert.equal(changePctOf(10, 0), null);
  assert.equal(changePctOf(10, 10), 0);
  assert.equal(changePctOf(11, 10), 10);
  assert.equal(fmtPct(null), "涨跌没取到");
  assert.ok(fmtPct(2.1).includes("涨 2.10%"));
  assert.ok(fmtPct(-1.5).includes("跌 1.50%"));
});

test("三个卖点比价格：10:30 最高 → 10:30 卖最好，比收盘多赚多少（带当时时间，成本是昨天收盘）", () => {
  // 成本昨天收盘 1300；10:30 1326（涨 2.00%）；11:30 休盘 1320（涨 1.54%）；收盘 1313（涨 1.00%）
  const c = compareSellWindows("600519.SH", "茅台", 1300, {
    "1030": { price: 1326, changePct: 2.0 },
    "1130": { price: 1320, changePct: 1.54 },
    close: { price: 1313, changePct: 1.0 },
  });
  assert.equal(c.bestSlot, "1030");
  assert.equal(c.bestLabel, "10:30");
  assert.equal(c.cost, 1300);
  // (1326-1313)/1313 = 0.99%
  assert.ok(Math.abs((c.advantageVsClosePct ?? 0) - 0.99) < 0.01);
  assert.ok(c.plain.includes("昨天收盘价（成本）1300"));
  assert.ok(c.plain.includes("今天 10:30时"));
  assert.ok(c.plain.includes("今天 11:30 休盘时"));
  assert.ok(c.plain.includes("今天 15:00 收盘时"));
  assert.ok(c.plain.includes("今天 10:30 卖最好"));
  // 昨晚不该是卖点：文案里不能出现“昨晚卖”“昨天收盘前卖最好”
  assert.ok(!c.plain.includes("昨晚卖"));
  assert.ok(!c.plain.includes("昨天收盘前卖最好"));
});

test("三个卖点比价格：11:30 休盘最高 → 11:30 休盘卖最好；收盘最高 → 拿到收盘卖最好", () => {
  const to1130 = compareSellWindows("000001.SZ", "平安", 11.0, {
    "1030": { price: 11.2, changePct: 1.82 },
    "1130": { price: 11.6, changePct: 5.45 },
    close: { price: 11.5, changePct: 4.55 },
  });
  assert.equal(to1130.bestSlot, "1130");
  assert.ok(to1130.plain.includes("今天 11:30 休盘卖最好"));

  const toClose = compareSellWindows("000001.SZ", "平安", 11.0, {
    "1030": { price: 11.2, changePct: 1.82 },
    "1130": { price: 11.4, changePct: 3.64 },
    close: { price: 11.5, changePct: 4.55 },
  });
  assert.equal(toClose.bestSlot, "close");
  assert.ok(toClose.plain.includes("拿到收盘卖最好"));
  assert.ok(toClose.plain.includes("早卖就卖早了"));
});

test("三个卖点比价格：任一缺失 → 比不出，不编结论；三价相等 → 怎么卖都一样", () => {
  const missing = compareSellWindows("000001.SZ", "平安", 11.0, {
    "1030": { price: 11.2, changePct: 1.82 },
    "1130": { price: null, changePct: null },
    close: { price: 11.5, changePct: 4.55 },
  });
  assert.equal(missing.bestSlot, null);
  assert.equal(missing.advantageVsClosePct, null);
  assert.ok(missing.plain.includes("11:30 休盘"));
  assert.ok(missing.plain.includes("比不出"));

  const equal = compareSellWindows("000001.SZ", "平安", 11.0, {
    "1030": { price: 11.0, changePct: 0 },
    "1130": { price: 11.0, changePct: 0 },
    close: { price: 11.0, changePct: 0 },
  });
  assert.equal(equal.bestSlot, null);
  assert.ok(equal.plain.includes("怎么卖都一样"));
});

test("两点对比（午报）：只比 10:30 vs 11:30 休盘，成本是昨天收盘价，缺一不编", () => {
  const pair = compareSellPair("000001.SZ", "平安", 11.0,
    { label: "10:30", price: 11.33, changePct: 3 },
    { label: "11:30 休盘", price: 11.0, changePct: 0 },
  );
  assert.ok(pair.includes("昨天收盘价（成本）11"));
  assert.ok(pair.includes("今天 10:30时"));
  assert.ok(pair.includes("今天 11:30 休盘时"));
  assert.ok(pair.includes("今天 10:30卖最好"));

  const missingPair = compareSellPair("000001.SZ", "平安", 11.0,
    { label: "10:30", price: 11.33, changePct: 3 },
    { label: "11:30 休盘", price: null, changePct: null },
  );
  assert.ok(missingPair.includes("比不出"));
});

// ── 卖出日（2026-10-17 修正：D+2，不是 D+1） ──

test("卖出日 = 决策日之后第 2 个交易日：10-15 → 10-19（周一），10-16（周五）→ 10-20（周二）", () => {
  assert.equal(VERSION_SELL_OFFSET, 2);
  // 10-15（周四）之后：10-16（周五，D+1 买入日）、10-19（周一，D+2 卖出日）
  assert.equal(sellDayOfDecision("2026-10-15", ["2026-10-16", "2026-10-19", "2026-10-20"]), "2026-10-19");
  // 10-16（周五）之后：10-19（周一，D+1）、10-20（周二，D+2）
  assert.equal(sellDayOfDecision("2026-10-16", ["2026-10-19", "2026-10-20"]), "2026-10-20");
  // 买入日（第 1 个）绝不是卖出日
  assert.notEqual(sellDayOfDecision("2026-10-15", ["2026-10-16", "2026-10-19"]), "2026-10-16");
});

test("卖出日跳休市：9-30（周三）→ 10-09（周五），国庆 10/1–10/7 不算交易日", () => {
  // 9-30 之后：10-08（周四，D+1）、10-09（周五，D+2）；10/1–10/7 国庆休市跳过
  assert.equal(sellDayOfDecision("2026-09-30", ["2026-10-08", "2026-10-09"]), "2026-10-09");
});

test("卖出日算不出：之后不足 2 个交易日 → null，不猜", () => {
  assert.equal(sellDayOfDecision("2026-10-15", ["2026-10-16"]), null);
  assert.equal(sellDayOfDecision("2026-10-15", []), null);
});

test("交易日历：10-15 之后 2 个交易日是 10-16、10-19；9-30 之后是 10-08、10-09（跳国庆）", () => {
  assert.deepEqual(tradingDaysAfter("2026-10-15", 2), ["2026-10-16", "2026-10-19"]);
  assert.deepEqual(tradingDaysAfter("2026-09-30", 2), ["2026-10-08", "2026-10-09"]);
  assert.deepEqual(tradingDaysAfter("2026-10-16", 2), ["2026-10-19", "2026-10-20"]);
  assert.deepEqual(tradingDaysAfter("not-a-date", 2), []);
});

test("卖出日票池：只在卖出日抓，买入日/选股日不抓", () => {
  const versions = [
    { tradeDate: "2026-10-15", picks: [{ symbol: "600276.SH", name: "恒瑞医药" }, { symbol: "603919.SH", name: "金徽酒" }] },
    { tradeDate: "2026-10-15", picks: [{ symbol: "603919.SH", name: "金徽酒" }, { symbol: "603198.SH", name: "迎驾贡酒" }] },
    { tradeDate: "2026-10-16", picks: [{ symbol: "600519.SH", name: "茅台" }] },
  ];
  const sellDays = new Map<string, string | null>([
    ["2026-10-15", "2026-10-19"],
    ["2026-10-16", "2026-10-20"],
  ]);
  // 10-19 是 10-15 版本的卖出日 → 抓 10-15 两版的并集（去重）
  const onSell = versionsSellingOnDate(versions, "2026-10-19", sellDays);
  assert.equal(onSell.decisionDate, "2026-10-15");
  assert.equal(onSell.versions.length, 2);
  assert.deepEqual(onSell.picks.map((p) => p.symbol), ["600276.SH", "603919.SH", "603198.SH"]);
  // 10-20 是 10-16 版本的卖出日 → 只抓 10-16 版，不含 10-15 的票
  const onNext = versionsSellingOnDate(versions, "2026-10-20", sellDays);
  assert.equal(onNext.decisionDate, "2026-10-16");
  assert.deepEqual(onNext.picks.map((p) => p.symbol), ["600519.SH"]);
  // 10-16 是 10-15 版的买入日、10-16 版的选股日 → 两个版本都不卖，不抓
  const onBuy = versionsSellingOnDate(versions, "2026-10-16", sellDays);
  assert.equal(onBuy.decisionDate, null);
  assert.deepEqual(onBuy.versions, []);
  assert.deepEqual(onBuy.picks, []);
  // 10-15 是选股日本身 → 不抓
  const onPick = versionsSellingOnDate(versions, "2026-10-15", sellDays);
  assert.equal(onPick.decisionDate, null);
  assert.deepEqual(onPick.picks, []);
  // 卖出日算不出（null）→ 不匹配
  const unknown = versionsSellingOnDate(versions, "2026-10-19", new Map([["2026-10-15", null], ["2026-10-16", "2026-10-20"]]));
  assert.equal(unknown.decisionDate, null);
});

test("评估日门禁：卖出日算得出时 evalDate 必须等于卖出日；算不出时放行显式 evalDate", () => {
  // 10-15 版：卖出日 10-19，eval 10-19 放行，eval 10-16（买入日）拒绝
  assert.equal(isSellDayEval("2026-10-19", "2026-10-19"), true);
  assert.equal(isSellDayEval("2026-10-16", "2026-10-19"), false);
  // 卖出日算不出 → 放行（由调用方负责）
  assert.equal(isSellDayEval("2026-10-16", null), true);
});
