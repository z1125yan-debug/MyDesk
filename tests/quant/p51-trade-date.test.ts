// P51 「最近交易日」钉测（2026-09-26 用户实测后新增）
//
// 背景（用户原话）：「这个实时的是不是假的，今天都没开盘」。
// 实测：2026-09-25 是中秋节、09-26 是周六，连着两天休市，最后一个交易日是 **09-24**。
// 页面上「行情时刻 15:32:49」只有时分秒，周六晚上看到会被读成「今天下午还在交易」——
// 所以给行情时刻补一个交易日。
//
// 口径（数据驱动，不硬编码节假日表）：
//   ① 先问行情源：通达信上证指数日K的最后一根日期 = 最近交易日（节假日它自己知道）；
//   ② 行情源拿不到才退到「周末感知」的日历兜底（周末回退到上一个周五），法定节假日认不出。
//
// 一把尺子：纯函数行为钉在 `prevWeekday` 上，接线钉在源码形状上，node --test 直跑零 IO。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// 动态 import 纯函数（零 IO，不碰 fetch）
const { prevWeekday } = await import("../../src/lib/desk/session.ts");

// ─── ① 日历兜底：只认周末 ─────────────────────────────────────────────────

test("prevWeekday：周六回退到周五、周日回退到周五、工作日原样", () => {
  assert.equal(prevWeekday("2026-09-26"), "2026-09-25", "周六 → 上一个周五");
  assert.equal(prevWeekday("2026-09-27"), "2026-09-25", "周日 → 上一个周五");
  assert.equal(prevWeekday("2026-09-24"), "2026-09-24", "周四（交易日）原样返回");
  assert.equal(prevWeekday("2026-09-21"), "2026-09-21", "周一原样返回");
});

test("prevWeekday：形状不对原样透传，不猜一个日期出来", () => {
  assert.equal(prevWeekday("2026/09/26"), "2026/09/26", "斜杠形状不认，原样回");
  assert.equal(prevWeekday(""), "", "空串原样回");
  assert.equal(prevWeekday("20260926"), "20260926", "无分隔符不认，原样回");
});

test("prevWeekday 只认周末、不认法定节假日——这条限制必须写死在测试里，别当它能算中秋", () => {
  // 2026-09-25 是中秋节（休市），但日历兜底不知道 → 它只会把周六退到周五
  assert.equal(prevWeekday("2026-09-26"), "2026-09-25", "兜底给的是「上一个工作日」，不是「上一个交易日」");
});

// ─── ② 优先问行情源：交易日由行情源给，不靠本地日历 ────────────────────────

test("trade-date：先问通达信 → 再问腾讯日K → 最后才退日历兜底（P63 补第二源）", () => {
  const src = read("src/lib/desk/trade-date.ts");
  assert.match(src, /const fromTdx = await read\(tdxLatestTradeDate\(\)\);/, "第一顺位仍是通达信行情源");
  assert.match(src, /if \(fromTdx\) return \{ date: fromTdx, source: "tdx", fromMarketData: true \};/, "通达信给了就用它，不拿本地日历覆盖");
  // P63 新增：2026-09-27 实测网关没起时只走日历兜底，把 09-25（中秋休市）算成了"最近交易日"。
  // 补一条不受网关影响的腾讯日K源，顺序必须排在日历兜底之前。
  assert.match(src, /fetchKlinesReal\("000001\.SH", "日线", 8, "none"\)/, "第二顺位是上证指数日K（腾讯源）");
  assert.match(src, /const fromKline = await read\(klineLatestTradeDate\(\)\);/, "第二源排在日历之前");
  assert.match(src, /return \{ date: prevWeekday\(today\), source: "calendar", fromMarketData: false \};/, "两源都拿不到才退周末感知的日历兜底");
  assert.match(src, /return d && d <= today \? d : null;/, "行情源给出晚于今天的日期一律不认");
});

test("resolveTradeDate 带来源：日历推算值标 fromMarketData=false，前端不得拿它宣称「最新交易日」", () => {
  const src = read("src/lib/desk/trade-date.ts");
  assert.match(src, /export interface TradeDateInfo \{/, "对外暴露带来源的解析结果");
  assert.match(src, /fromMarketData: boolean;/, "有「日期来自行情源还是日历」这个位");
  assert.match(src, /export async function latestTradeDate\(now = new Date\(\)\): Promise<string> \{\n  return \(await resolveTradeDate\(now\)\)\.date;\n\}/, "老的 latestTradeDate 契约不变，只是薄封装");
  assert.match(read("src/app/api/market/trade-date/route.ts"), /fromMarketData: info\?\.fromMarketData \?\? false,/, "接口把来源一起给前端");
});

test("tdxLatestTradeDate：用上证指数日K最后一根当交易日，认不出返回旧值/null 不猜", () => {
  const src = read("src/lib/desk/tdx.ts");
  assert.match(src, /code: "sh000001", period: "day", count: 3/, "上证指数日K——它每个交易日都有K线，是最好的日历真值");
  assert.match(src, /if \(!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(last\)\) return tradeDateCache\?\.date \?\? null;/, "认不出形状就回旧值/ null，不猜");
  assert.match(src, /const ttl = marketSession\(\)\.open \? 60_000 : 600_000;/, "交易时段缓存 60s、休市 600s（跟日K同一把尺子）");
});

// ─── ③ 接线：接口带回交易日、页面上屏 ────────────────────────────────────

test("board 路由与 market.ts 都把 tradeDate 一路带到页面", () => {
  assert.match(read("src/app/api/market/board/route.ts"), /tradeDate/, "路由返回 tradeDate");
  assert.match(read("src/lib/desk/market.ts"), /tradeDate: string \| null;/, "BoardFetch 契约里有 tradeDate");
  assert.match(read("src/components/desk/pages/BoardPage.tsx"), /行情时刻 \{quoteStamp\}/, "页面把交易日和行情时刻拼在一起上屏");
});

test("大盘情绪的 trade_date 也用最近交易日（周六不该报成 09-26）", () => {
  const src = read("src/lib/quant/screener/sentiment.ts");
  assert.match(src, /const tradeDate = await latestTradeDate\(now\);/, "情绪快照的交易日同样由行情源给");
  assert.equal(/const tradeDate = shanghaiDate\(now\);/.test(src), false, "不再拿本机今天当交易日");
});
