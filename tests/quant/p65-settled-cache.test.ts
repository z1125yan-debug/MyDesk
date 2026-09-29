// P65：两件「别把用户晾着 / 别把用户骗了」的事。
//
// ① 大盘情绪页下方那些**收盘后才沉淀**的历史口径（成交额趋势/5日线占比/涨跌停分布/连板梯队/指数），
//    用户 2026-09-29 指示：「像下面这些需要收盘后的就固定，确保每天第一次打开刷新之后，
//    再点击除了首页四个卡片实时更新，而不是得等待」——当天取过一次就不许再回源（秒开），
//    且**收盘后必须换掉盘中取的那份**，否则一整天定在盘中。
//
// ② 因子缓存的「口径」：盘中预热写进去的是盘中价，收盘后再筛若命中同一份，
//    用户看到的就一直是上午 10 点的数（用户原话「防止定在盘中」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  decideSettled, beijingDayTime, settledKey, readSettled, writeSettled, type MinimalStorage, type SettledEntry,
} from "../../src/lib/desk/settled-cache-core.ts";
import {
  warmPhaseOf, decideRewarm, warmPhaseLabel,
} from "../../src/lib/quant/screener/warm-phase-core.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

function memStorage(): MinimalStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

function entry(at: string, day = "2026-09-29", data: unknown = { x: 1 }): SettledEntry<unknown> {
  return { v: 1, day, at, ts: `${day}T${at}:00.000+08:00`, data };
}

/* ---------------- ① 当日沉淀缓存 ---------------- */

test("当天已取过 → 命中缓存，不回源（这就是「不用等待」的那条路）", () => {
  const d = decideSettled(entry("09:35"), { day: "2026-09-29", hm: "14:50" });
  assert.deepEqual(d, { use: true, refetch: false, reason: "hit" });
});

test("换了一天 → 回源（「每天第一次打开刷新」的时机）", () => {
  const d = decideSettled(entry("09:35", "2026-09-28"), { day: "2026-09-29", hm: "09:40" });
  assert.equal(d.reason, "new_day");
  assert.equal(d.use, false);
  assert.equal(d.refetch, true);
});

test("盘中取的那份，收盘后必须换掉（防止一整天定在盘中）", () => {
  const d = decideSettled(entry("10:32"), { day: "2026-09-29", hm: "15:30" });
  assert.equal(d.reason, "closed_after_intraday");
  assert.equal(d.refetch, true);
  assert.equal(d.use, false);
});

test("收盘后取的那份当天一直有效（15:00 之后不再回源）", () => {
  const d = decideSettled(entry("15:05"), { day: "2026-09-29", hm: "22:00" });
  assert.equal(d.use, true);
});

test("没有缓存/坏缓存 → 回源，且原因可分辨", () => {
  assert.equal(decideSettled(null, { day: "2026-09-29", hm: "10:00" }).reason, "missing");
  assert.equal(decideSettled({ v: 1, day: "2026-09-29" } as unknown as SettledEntry<unknown>, { day: "2026-09-29", hm: "10:00" }).reason, "corrupt");
  assert.equal(decideSettled(entry("09:00", "2026-09-29") && { ...entry("09:00"), v: 99 } as SettledEntry<unknown>, { day: "2026-09-29", hm: "10:00" }).reason, "corrupt");
});

test("落盘再读回来：键带版本、data 原样、时刻可读（供页面标注「当日沉淀 HH:mm」）", () => {
  const s = memStorage();
  const at = new Date("2026-09-29T02:35:00.000Z"); // 北京 10:35
  const written = writeSettled("market-breadth:30", { rows: [1, 2, 3] }, at, s);
  assert.equal(written.day, "2026-09-29");
  assert.equal(written.at, "10:35");
  assert.match(settledKey("market-breadth:30"), /^mydesk-settled:v1:market-breadth:30$/);
  const back = readSettled<{ rows: number[] }>("market-breadth:30", s);
  assert.deepEqual(back?.data.rows, [1, 2, 3]);
  assert.equal(readSettled("never-written", s), null);
});

test("beijingDayTime 用北京时区（UTC 深夜不许退回前一天）", () => {
  const t = beijingDayTime(new Date("2026-09-28T16:30:00.000Z")); // 北京 09-29 00:30
  assert.equal(t.day, "2026-09-29");
  assert.equal(t.hm, "00:30");
});

test("成交额卡＝实时口径、图＝只画已完成交易日（用户实测：刷新后卡片还停在 0.48 万亿）", () => {
  const ui = read("src/components/desk/pages/MarketPage.tsx");
  // 用户 2026-09-29 10:19 实测：页面刷新后成交额仍是 0.48 万亿（真实已 0.62）。
  // 根因是这张卡读了「当日沉淀」的趋势序列最后一根 —— 沉淀把它定在了第一次打开那一刻。
  assert.match(ui, /const turnoverLiveYi = sent && \(sent\.amount_known \?\? 0\) > 0 \? sent\.amount_total_yi : null/,
    "成交额卡必须读实时快照（sentiment 轮询源），且过 amount_known 闸");
  assert.ok(!/\{tLatest \?/.test(ui), "卡片不许再读被定住的趋势序列");
  assert.ok(!/const tLatest = trend \?/.test(ui), "被定住的那条读数路径要删干净");
  assert.match(ui, /const completedThrough = useMemo/, "图要按「已完成交易日」切一刀");
  assert.match(ui, /option=\{turnoverOption\(trendDaysDone/, "成交额图画的是已完成交易日序列（不含今天那根半截柱）");
  assert.match(ui, /盘中累计/, "盘中要标明这是当日累计口径");
});

test("接线：只有「收盘后沉淀」的两条链路走当日缓存；连板梯队与四卡走实时轮询", () => {
  const ui = read("src/components/desk/pages/MarketPage.tsx");
  assert.match(ui, /const KEY = "market-breadth:30";/);
  assert.match(ui, /readSettled<BreadthClient>\(KEY\)/);
  assert.match(ui, /market-trend:\$\{from\}:\$\{to\}/);
  assert.match(ui, /writeSettled\(/, "取回后必须写回缓存");
  // 连板梯队＝当日实时结构（用户拍板「盘中和盘后能一样吗」）→ 不许进当日沉淀缓存
  assert.ok(!/readSettled<LimitUpClient>/.test(ui), "连板梯队必须实时，不能走当日沉淀缓存");
  assert.match(ui, /if \(poll\.tick > 0\) \{ load\(\); void loadTiers\(\); \}/, "四卡与连板梯队都按轮询实时刷新");
  assert.match(ui, /当日沉淀/);
});

/* ---------------- ② 因子缓存口径 ---------------- */

test("口径判定：数据属于上一交易日 = 收盘口径；当天盘中 = 盘中口径", () => {
  assert.equal(warmPhaseOf({ quoteDate: "2026-09-28", asOf: "2026-09-29", sessionPhase: "auction" }), "closed");
  assert.equal(warmPhaseOf({ quoteDate: "2026-09-29", asOf: "2026-09-29", sessionPhase: "trading" }), "intraday");
  assert.equal(warmPhaseOf({ quoteDate: "2026-09-29", asOf: "2026-09-29", sessionPhase: "break" }), "intraday");
  assert.equal(warmPhaseOf({ quoteDate: "2026-09-29", asOf: "2026-09-29", sessionPhase: "closed" }), "closed");
});

test("重算判定：没缓存要算；盘中那份到了收盘口径要算；已收盘口径不再算", () => {
  assert.deepEqual(decideRewarm(null, { date: "2026-09-29", phase: "intraday" }), { rewarm: true, reason: "no_cache" });
  assert.deepEqual(decideRewarm({ trade_date: "2026-09-26", phase: "closed" }, { date: "2026-09-29", phase: "intraday" }),
    { rewarm: true, reason: "date_mismatch" });
  assert.deepEqual(decideRewarm({ trade_date: "2026-09-29", phase: "intraday" }, { date: "2026-09-29", phase: "closed" }),
    { rewarm: true, reason: "stale_intraday" });
  assert.deepEqual(decideRewarm({ trade_date: "2026-09-29", phase: "closed" }, { date: "2026-09-29", phase: "closed" }),
    { rewarm: false, reason: "none" });
  // 盘中口径 + 现在还是盘中：不重算（不能每次进页面都重跑 5 分钟）
  assert.deepEqual(decideRewarm({ trade_date: "2026-09-29", phase: "intraday" }, { date: "2026-09-29", phase: "intraday" }),
    { rewarm: false, reason: "none" });
});

test("口径标签：按北京时间显示，盘中口径必须写明「收盘后会自动重算」", () => {
  // 02:32Z = 北京 10:32；07:05Z 已是北京 15:05 —— 文案给北京用户看，不能直接截 ISO 的 UTC 时分
  assert.match(warmPhaseLabel("intraday", "2026-09-29T02:32:11.000Z"), /盘中口径 10:32/);
  assert.match(warmPhaseLabel("intraday", "2026-09-29T02:32:11.000Z"), /收盘后会自动重算/);
  assert.equal(warmPhaseLabel("closed", "2026-09-29T07:05:00.000Z"), "收盘口径 15:05");
  assert.equal(warmPhaseLabel("closed", ""), "收盘口径");
});

test("接线：预热路由带 ensure=1 自动判定，选股页进页面调它并在收盘重算后自动重筛", () => {
  const warm = read("src/app/api/quant/factor-warm/route.ts");
  assert.match(warm, /decideRewarm\(/, "ensure 模式必须走纯核判定");
  assert.match(warm, /warmPhaseOf\(/, "口径必须由纯核判定");
  assert.match(warm, /saveFactorCache\(cacheDate, rows, phase\)/, "口径要落盘（否则判不出「定在盘中」）");
  assert.match(warm, /ensure_close_refresh/);

  const ui = read("src/components/desk/pages/ScreenerWorkbench.tsx");
  assert.match(ui, /\/api\/quant\/factor-warm\?ensure=1/, "进页面要自动确保当天有缓存");
  assert.match(ui, /void runScreener\(1\)/, "收盘口径重算完成后自动重筛一次");
  assert.match(ui, /cachePhaseShort/, "页面要标出因子值口径");
});
