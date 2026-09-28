// P15-R19 逐票收盘价回填纯核 + 路由口径的钉测。
//
// 用户口径原话：「历史表 0 行这件事——种子有数据就核对一下照抄，然后没有就在网上搜一下接进去」。
// 宽度占比种子有（照抄进 market_daily_stats 了），但**逐票收盘价**种子没有 —— 这一段只能接真实日线源。
// 这套钉要守的是回填过程的三条纪律：只写真实读到的格子、只写已收盘的日期、库里已有的键一律不重写。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BACKFILL_CALIBER, rowsFromBars, splitFreshRows, type BarEntry, type BackfillRow,
} from "../../src/lib/quant/screener/breadth-backfill-core.ts";

const ROUTE = readFileSync(new URL("../../src/app/api/market/breadth/backfill/route.ts", import.meta.url), "utf8");
const READ = readFileSync(new URL("../../src/app/api/market/breadth/route.ts", import.meta.url), "utf8");

const bar = (date: string, c: number) => ({ date, o: c, h: c, l: c, c, v: 100 });
const entry = (symbol: string, bars: ReturnType<typeof bar>[] | null, name = ""): BarEntry => ({ symbol, name, bars });

test("R19-B① 只写窗口内的真实格子：日期裁剪、升序、计数分得清", () => {
  const o = rowsFromBars([
    entry("600000.SH", [bar("2026-04-17", 9.1), bar("2026-04-20", 9.2), bar("2026-04-21", 9.3), bar("2026-04-30T15:00:00", 9.9)]),
  ], "2026-04-20", "2026-04-21");
  assert.equal(o.symbols, 1);
  assert.equal(o.hadBars, 1);
  assert.equal(o.noBars, 0);
  assert.deepEqual(o.rows, [
    { symbol: "600000.SH", tradeDate: "2026-04-20", close: 9.2, name: "" },
    { symbol: "600000.SH", tradeDate: "2026-04-21", close: 9.3, name: "" },
  ], "窗口外的 04-17 不进；带时刻的格子只取日期部分");
  assert.equal(o.outOfRange, 2, "首尾两根越界要如实计数，不能悄悄丢");
  assert.deepEqual(o.dates, ["2026-04-20", "2026-04-21"]);
});

test("R19-B② 坏价不写行：NaN / 0 / 负数 / 缺日期都算「没读到」，不是读到 0", () => {
  const o = rowsFromBars([entry("000001.SZ", [
    bar("2026-04-20", Number.NaN), bar("2026-04-21", 0), bar("2026-04-22", -3.5),
    { date: "", o: 1, h: 1, l: 1, c: 8.8, v: 1 }, bar("2026-04-23", 8.9),
  ])], "2026-04-20", "2026-04-30");
  assert.deepEqual(o.rows.map((r) => r.tradeDate), ["2026-04-23"], "四个坏格子一个都不写");
  assert.equal(o.dirty, 4);
  assert.equal(o.hadBars, 1, "这只票整体算「取到了」：只是个别格子坏");
});

test("R19-B③ 取数失败与「取到但窗口内一根没有」都按没覆盖计，不冒充分母", () => {
  const o = rowsFromBars([
    entry("688256.SH", null),
    entry("920706.BJ", []),
    entry("300750.SZ", [bar("2026-09-24", 200)]),
  ], "2026-04-20", "2026-04-24");
  assert.equal(o.symbols, 3);
  assert.equal(o.rows.length, 0);
  assert.equal(o.noBars, 3, "失败/空返回/只有窗口外价：三只都不算覆盖");
  assert.equal(o.noBars, 3, "失败/空返回/只有窗口外价：三只都不算覆盖");
  assert.deepEqual(o.dates, []);
  assert.equal(o.hadBars, 1, "只有「响应里真给了K线」的那只算 hadBars；空数组按没取到处理");
});

test("R19-B④ 同票同日重复格子取首条；脏窗口一条都不写", () => {
  const dup = rowsFromBars([entry("600000.SH", [bar("2026-04-20", 9.2), bar("2026-04-20", 9.75)])],
    "2026-04-20", "2026-04-20");
  assert.deepEqual(dup.rows.map((r) => r.close), [9.2], "重复取首条（与库里 unique 键同目的）");
  assert.equal(dup.duplicate, 1);

  assert.equal(rowsFromBars([entry("600000.SH", [bar("2026-04-20", 9.2)])], "2026-04-20", "不对").rows.length, 0);
  assert.equal(rowsFromBars([entry("600000.SH", [bar("2026-04-20", 9.2)])], "2026-04-25", "2026-04-20").rows.length, 0,
    "from>to 是脏参数：不猜、不写");
});

test("R19-B⑤ 已有键不重写：自产行优先；价差超过半分钱只报不改", () => {
  const rows: BackfillRow[] = [
    { symbol: "600000.SH", tradeDate: "2026-04-20", close: 9.2, name: "浦发银行" }, // 库里同价
    { symbol: "600519.SH", tradeDate: "2026-04-20", close: 1400.25, name: "贵州茅台" }, // 库里 1400.00：打架
    { symbol: "601318.SH", tradeDate: "2026-04-20", close: 55.5, name: "中国平安" }, // 库里 55.504：小数位差，不算打架
    { symbol: "601398.SH", tradeDate: "2026-04-20", close: 6.1, name: "工商银行" }, // 库里没有：该写
  ];
  const existing = [
    { symbol: "600000.SH", tradeDate: "2026-04-20", close: 9.2 },
    { symbol: "600519.SH", tradeDate: "2026-04-20", close: 1400.0 },
    { symbol: "601318.SH", tradeDate: "2026-04-20", close: 55.504 },
  ];
  const r = splitFreshRows(rows, existing);
  assert.deepEqual(r.fresh.map((x) => x.symbol), ["601398.SH"], "库里已有的键一条都不重写");
  assert.equal(r.existingKeys, 3);
  assert.deepEqual(r.priceMismatch, [{ symbol: "600519.SH", tradeDate: "2026-04-20", stored: 1400.0, incoming: 1400.25 }],
    "同键不同价要报出来给人看，绝不做静默覆盖");
});

test("R19-B⑥ 口径句写清「不复权 + 不覆盖自产」——一列两种价格基准就是自算错", () => {
  assert.match(BACKFILL_CALIBER, /不复权原始价/);
  assert.match(BACKFILL_CALIBER, /只补库里没有的键/);
  assert.match(BACKFILL_CALIBER, /回填不覆盖它/);
});

test("R19-B⑦ 回填接口口径：POST-only、to 夹到昨日、只用不复权源、只碰一张表、只增不删", () => {
  assert.match(ROUTE, /export async function GET\(\)[\s\S]*status: 405/, "GET 必须 405：写库要显式 POST");
  assert.match(ROUTE, /import \{ sinaDayBars \} from "@\/lib\/quant\/data\/sina-kline"/, "取数走新浪日K（不复权原始价）");
  assert.equal(/from "@\/lib\/quant\/data\/em-provider"/.test(ROUTE), false,
    "不许接 em-provider 的日K：那一路是 qfq 前复权，混进这一列就是两种口径谁也不认谁");
  assert.match(ROUTE, /addBeijingDays\(today, -1\)/, "当日行归收盘后自产，回填最多写到昨天");
  assert.match(ROUTE, /requestedTo > cap \? cap : requestedTo/, "to 越界要夹回昨日（夹了会在 missing 里明说）");
  assert.match(ROUTE, /splitFreshRows\(outcome\.rows, existing\)/, "写之前先跟库里已有的键对一遍");
  assert.match(ROUTE, /dry_run/, "带 dry_run：只取数不写库");
  assert.equal(/stockDailyClose\.(delete|deleteMany|update|upsert)/.test(ROUTE), false, "只 createMany：不删不改，回填不该有覆盖能力");
  const dbUses = [...ROUTE.matchAll(/\bdb\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(dbUses)], ["stockDailyClose"], "只碰 stock_daily_close 一张表");
  assert.match(ROUTE, /metas\.slice\(offset, offset \+ limit\)/, "按切片续跑：一次不吃下全A");
});

test("R19-B⑧ 读侧口径跟着改：不再说「无回填」，且历史序列按日更数据缓存", () => {
  assert.match(READ, /BREADTH_TTL_MS = 10 \* 60_000/, "60 万行的表现在 30 秒重算一次没道理：改成 10 分钟");
  assert.match(READ, /真实日K回填/, "source 句要说明历史从哪来");
  assert.equal(/无回填/.test(READ), false, "旧文案「不回填/无回填」与实际已不一致：留着就是假口径");
  assert.match(READ, /getHandler\(req\)/, "缓存只包 GET，不改计算逻辑本身");
});
