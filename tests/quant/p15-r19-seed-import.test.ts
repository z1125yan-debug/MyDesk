// P15-R19 稳智种子照抄进库（market_daily_stats）的钉测。
//
// 用户口径原话：「历史表 0 行这件事——之前从稳智扒来的种子如果有数据就核对一下照抄，
// 然后没有就在网上搜一下接进去」。这套钉要守的是「照抄」两个字不许抄歪：
//  1. 种子是无表头的 14 列位置数组 —— 列序写歪一格不会报错，只会把「跌停家数」画成「涨停家数」；
//  2. 抄之前必须先自查（日期/顺序/周末/梯队与最高板打架/占比越界/断档），毛病原样报出来不藏；
//  3. 出身要看得见：种子行的 basis 明标外部来源，且绝不被「自产让路」判定误认成自产行
//     （实测踩过：basis 写「非本地自产」→ 全文包含判定把种子自己认成自产 → 第二次导入一条都不写）；
//  4. 抄进库不许改动页面：读侧只把「种子终点之后」的库行续上图，这批 ≤ 终点的行不进合并。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SEED_COLUMNS, SEED_COLUMN_COUNT, SEED_IMPORT_BASIS, SELF_BASIS_PREFIX,
  auditSeedRows, isSelfProducedBasis, mapSeedRow, mapSeedRows, seedColumnWidths,
  type SeedStatRow,
} from "../../src/lib/quant/review/review-seed-core.ts";

const ROUTE = readFileSync(new URL("../../src/app/api/market/review-stats/route.ts", import.meta.url), "utf8");
const IMPORT = readFileSync(new URL("../../src/app/api/market/review-stats/import-seed/route.ts", import.meta.url), "utf8");
const COLLECT = readFileSync(new URL("../../src/lib/quant/screener/review-daily-collect.ts", import.meta.url), "utf8");
const SEED = JSON.parse(
  readFileSync(new URL("../../src/lib/quant/review/review-stats-seed.json", import.meta.url), "utf8"),
) as (string | number)[][];

/** 一行合格种子数据（默认取 06-01 周一，逐项置坏值测自查） */
const okRow = (over: Partial<SeedStatRow> = {}): SeedStatRow => ({
  date: "2026-06-01", limitUp: 51, limitDown: 13, t3: 1, t4: 3, t5: 1, maxBoards: 5,
  decliners: 3952, belowMa5: 3738, belowMa3: 4159,
  aboveMa5Pct: 27.56, microPct: 39.29, midPct: 21.9, largePct: 16.37, ...over,
});
const nextDay = (over: Partial<SeedStatRow> = {}): SeedStatRow => okRow({ date: "2026-06-02", ...over });

test("R19-① 列序映射：真种子的首行与末行逐字段钉死（抄歪一格就红）", () => {
  assert.equal(SEED_COLUMN_COUNT, 14);
  assert.deepEqual([...SEED_COLUMNS], [
    "date", "limitUp", "limitDown", "t3", "t4", "t5", "maxBoards",
    "decliners", "belowMa5", "belowMa3", "aboveMa5Pct", "microPct", "midPct", "largePct",
  ], "列序是种子的格式契约，改它必须同时改种子文件与这条钉");

  assert.deepEqual(mapSeedRow(SEED[0]), {
    date: "2026-04-20", limitUp: 90, limitDown: 15, t3: 3, t4: 0, t5: 1, maxBoards: 6,
    decliners: 1814, belowMa5: 1286, belowMa3: 1545,
    aboveMa5Pct: 75.16, microPct: 71.95, midPct: 75.59, largePct: 79.43,
  }, "首行 04-20：涨停 90 / 跌停 15 / 最高 6 板");

  assert.deepEqual(mapSeedRow(SEED[SEED.length - 1]), {
    date: "2026-09-24", limitUp: 51, limitDown: 13, t3: 1, t4: 3, t5: 1, maxBoards: 5,
    decliners: 3952, belowMa5: 3738, belowMa3: 4159,
    aboveMa5Pct: 27.56, microPct: 39.29, midPct: 21.9, largePct: 16.37,
  }, "末行 09-24：涨停 51 与东财涨停池当日实数 52 只差 1 只边界股——列序一歪就会变成跌停 51 家这种假事实");

  assert.deepEqual(seedColumnWidths(SEED), [14], "种子只该有一种列宽；出现第二种说明文件被改坏了");
});

test("R19-② 缺格记 null 不记 0：列数不足或格子不是数字时不许顶位", () => {
  const short = mapSeedRow(["2026-06-01", 60, 12]);
  assert.equal(short.limitUp, 60);
  assert.equal(short.limitDown, 12);
  assert.equal(short.t3, null, "第 4 列没给 → null，不是 0（0 家三板是一条假事实）");
  assert.equal(short.largePct, null);

  const junk = mapSeedRow(["2026-06-01", "51", "12", null, undefined, Number.NaN, 5]);
  assert.equal(junk.limitUp, null, "字符串数字不认：这一格没读到就是没读到");
  assert.equal(junk.t5, null, "NaN 不进字段");
  assert.equal(junk.maxBoards, 5, "同批里读得到的列照常进字段，不整行作废");
});

test("R19-③ 抄之前自查：真种子当前查不出毛病（毛病一旦出现必须拦在验收前）", () => {
  assert.deepEqual(auditSeedRows(mapSeedRows(SEED)), [],
    "110 行内部一致性应为零告警：日期格式/顺序/周末行/梯队与最高板/占比区间");
});

test("R19-④ 自查项逐个钉：坏数据要报得出、报得准", () => {
  assert.deepEqual(auditSeedRows([]), ["种子是空的：没有可抄的行"]);

  const badDate = auditSeedRows([okRow({ date: "2026-6-1" }), nextDay({ date: "" })]);
  assert.match(badDate[0], /2 行日期不合 YYYY-MM-DD/, "月/日不补零与空日期都不合格：要说清几行");

  const weekend = auditSeedRows([okRow({ date: "2026-09-26" }), nextDay({ date: "2026-09-27" })]);
  assert.match(weekend[0], /2 行落在周六日/, "A 股周末不交易：串到周六日的日期是来源错不是真数据");

  const order = auditSeedRows([okRow({ date: "2026-09-24" }), nextDay({ date: "2026-09-23" })]);
  assert.match(order[0], /1 行日期不比前一行晚/);

  const tier = auditSeedRows([okRow({ t3: 4, maxBoards: 2 }), nextDay({ t5: 2, maxBoards: 4 })]);
  assert.match(tier[0], /2 行「连板家数」与「最高板」对不上/, "有 3 板以上家数、最高板却不够高 = 两列打架");

  const pct = auditSeedRows([okRow({ aboveMa5Pct: 118 }), nextDay({ midPct: -3 })]);
  assert.match(pct[0], /2 个「站上5日线占比」类读数不在 0~100 区间/);

  const unusable = auditSeedRows([okRow({ limitUp: null }), nextDay({ maxBoards: null })]);
  assert.match(unusable[0], /2 行缺涨停\/跌停\/最高板任一项/, "缺读数整行不上图（与自产同一套可用性口径）");

  const gap = auditSeedRows([okRow({ date: "2026-06-01" }), nextDay({ date: "2026-06-22" })]);
  assert.match(gap[0], /超过一周的断档：2026-06-01→2026-06-22（21 天）/, "断档要报出来：那是漏采不是长假");
  assert.deepEqual(auditSeedRows([okRow({ date: "2026-04-30" }), nextDay({ date: "2026-05-06" })]), [],
    "五一休市 6 天不该当断档报警");
});

test("R19-⑤ 让路判定只认开头：种子 basis 不许被误认成自产行（实测踩过的坑）", () => {
  assert.equal(SEED_IMPORT_BASIS.includes(SELF_BASIS_PREFIX), false,
    "种子出身句里不能出现「本地自产」四个字（连「非本地自产」都不行：全文包含会把种子认成自产，第二次导入就一条都不写）");
  // 采集器那句 basis 现在拼了宽度三列的出身（P19c），写成 `const basis = "本地自产…" + "…"`；
  // 老形状是 upsert 里一行 `basis: "本地自产…"`。两种都认——intent 是「开头必须是本地自产」，不是它写在哪行。
  const collectorBasis = COLLECT.match(/basis: "([^"]+)"/)?.[1] ?? COLLECT.match(/const basis = "([^"]+)"/)?.[1] ?? "";
  assert.equal(isSelfProducedBasis(collectorBasis), true,
    "采集器写的那句 basis 必须被让路判定认出来（导入器不许倒灌自产结果）");
  assert.equal(isSelfProducedBasis(SEED_IMPORT_BASIS), false);
  assert.equal(isSelfProducedBasis(""), false, "空 basis 不是自产：让种子有机会补写出身");
});

test("R19-⑥ 导入接口口径：POST-only、只写这一张表、只增改不删、自查与 dry_run 都在", () => {
  assert.match(IMPORT, /export async function GET\(\)[\s\S]*status: 405/, "GET 必须 405：只读接口在 /api/market/review-stats，写库要显式 POST");
  assert.match(IMPORT, /dry_run/, "带 dry_run：先自查不写库");
  assert.match(IMPORT, /auditSeedRows\(mapped\)/, "抄之前先跑自查");
  assert.match(IMPORT, /isSelfProducedBasis\(e\.basis\)/, "自产日让路（只看 basis 开头）");
  assert.match(IMPORT, /basis: SEED_IMPORT_BASIS/, "写进去的出身固定一句");
  assert.equal(/marketDailyStats\.(delete|deleteMany)/.test(IMPORT), false, "只增改不删：这个接口没有删库能力");
  const dbUses = [...IMPORT.matchAll(/\bdb\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(dbUses)], ["marketDailyStats"], "只碰 market_daily_stats 一张表：接口里对 db 的用法只有它");
});

test("R19-⑦ 抄进库不改页面：读侧仍旧只取种子终点之后的库行，且映射与导入共用一份", () => {
  assert.match(ROUTE, /tradeDate: \{ gt: SEED_END \}/, "库行只在「晚于种子终点」时才上图：≤ 终点的种子行不进合并，图不会跳");
  assert.match(ROUTE, /mapSeedRows\(seed/, "读侧不再自己 map 一遍位置数组：列序映射全项目一份");
  assert.match(ROUTE, /export type ReviewRow = SeedStatRow/, "读侧行类型就是纯核那份字段形状（不再有第二套列序解释）");
});
