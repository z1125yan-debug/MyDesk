// B0 日K落库纯核单测（toSymbol / toTdxCode / barRowOf / barRowsOf / batchIdOf）。
// 不依赖 DB / 网关；可直接 `node --test --experimental-strip-types tests/quant/p36-b0-daily-bar-core.test.ts` 运行。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toSymbol, toTdxCode, barRowOf, barRowsOf, batchIdOf,
} from "../../src/lib/quant/data/daily-bar-core.ts";

test("toSymbol：网关全码 → MyDesk 符号（沪深北三市）", () => {
  assert.equal(toSymbol("sz300308"), "300308.SZ");
  assert.equal(toSymbol("sh600519"), "600519.SH");
  assert.equal(toSymbol("bj920002"), "920002.BJ");
  assert.equal(toSymbol("SH600519"), "600519.SH"); // 大小写不敏感
});

test("toSymbol：认不出返回 null，不许猜", () => {
  assert.equal(toSymbol(""), null);
  assert.equal(toSymbol("600519"), null); // 缺市场前缀
  assert.equal(toSymbol("hk00700"), null); // 非 A 股市场
  assert.equal(toSymbol("sh60051"), null); // 代码不足 6 位
});

test("toTdxCode：与 toSymbol 互逆", () => {
  for (const s of ["300308.SZ", "600519.SH", "688256.SH", "920002.BJ"]) {
    assert.equal(toSymbol(toTdxCode(s)!), s);
  }
  assert.equal(toTdxCode("600519"), null);
});

const good = {
  time: "2026-09-30T15:00:00+08:00",
  open: 11.36, high: 11.65, low: 11.33, close: 11.57,
  volume_lots: 1045357.44, amount: 1205814912,
};

test("barRowOf：正常行 → 六字段齐全，volume 手×100=股", () => {
  const r = barRowOf(good, "000001.SZ", "b1");
  assert.ok(r);
  assert.equal(r!.tradeDate, "2026-09-30");
  assert.equal(r!.open, 11.36);
  assert.equal(r!.high, 11.65);
  assert.equal(r!.low, 11.33);
  assert.equal(r!.close, 11.57);
  assert.equal(r!.volume, 104535744); // 1045357.44 手 × 100
  assert.equal(r!.amount, 1205814912);
  assert.equal(r!.adjust, "qfq");
  assert.equal(r!.batch, "b1");
});

test("barRowOf：volume_lots 缺失时退 volume_wire_value/100", () => {
  const r = barRowOf({ ...good, volume_lots: undefined, volume_wire_value: 104535744 }, "000001.SZ", "b1");
  assert.equal(r!.volume, 104535744);
});

test("barRowOf：价格任一非法 → 整行丢弃（不补 0、不拿前一日顶替）", () => {
  assert.equal(barRowOf({ ...good, close: NaN }, "000001.SZ", "b1"), null);
  assert.equal(barRowOf({ ...good, open: undefined }, "000001.SZ", "b1"), null);
  assert.equal(barRowOf({ ...good, high: Infinity }, "000001.SZ", "b1"), null);
  assert.equal(barRowOf({ ...good, close: 0 }, "000001.SZ", "b1"), null); // 收盘 ≤ 0 是坏行
  assert.equal(barRowOf({ ...good, close: -1 }, "000001.SZ", "b1"), null);
});

test("barRowOf：日期非法 / 缺失时间 → 丢弃", () => {
  assert.equal(barRowOf({ ...good, time: undefined }, "000001.SZ", "b1"), null);
  assert.equal(barRowOf({ ...good, time: "2026-13-45T15:00:00" }, "000001.SZ", "b1"), null);
  assert.equal(barRowOf({ ...good, time: "not-a-date" }, "000001.SZ", "b1"), null);
});

test("barRowOf：停牌日量额为 0 是真实值，不是缺失（不丢行）", () => {
  const r = barRowOf({ ...good, volume_lots: 0, amount: 0 }, "000001.SZ", "b1");
  assert.ok(r);
  assert.equal(r!.volume, 0);
  assert.equal(r!.amount, 0);
});

test("barRowsOf：坏行剔除后按日期升序，且同日去重（可复现）", () => {
  const bars = [
    { ...good, time: "2026-09-30T15:00:00+08:00", close: 11.57 },
    { ...good, time: "2026-09-29T15:00:00+08:00", close: 11.36 },
    { ...good, time: "2026-09-28T15:00:00+08:00", close: NaN }, // 坏行
    { ...good, time: "2026-09-30T15:00:00+08:00", close: 11.60 }, // 同日重复，后者胜
  ];
  const rows = barRowsOf(bars, "000001.SZ", "b1");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.tradeDate), ["2026-09-29", "2026-09-30"]);
  assert.equal(rows[1].close, 11.60);
});

test("barRowsOf：非数组 / 空 → 空数组（不抛）", () => {
  assert.deepEqual(barRowsOf(null, "000001.SZ", "b1"), []);
  assert.deepEqual(barRowsOf([], "000001.SZ", "b1"), []);
});

test("batchIdOf：批次号含日期时间+复权+根数（出身可追溯）", () => {
  const b = batchIdOf(new Date(2026, 8, 30, 16, 25), "qfq", 800);
  assert.equal(b, "20260930-1625-qfq800");
  assert.match(b, /^\d{8}-\d{4}-qfq\d+$/);
});
