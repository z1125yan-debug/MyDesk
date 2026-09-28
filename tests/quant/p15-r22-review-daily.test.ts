// P15-R22 每日复盘统计「种子 + 本地自产续写」钉测。
//
// 用户反馈的原话：首页涨跌停/连板两张图「全压在一份不续写的种子上，明天还是 09-24」。
// 这套钉测把三件事钉死：
//  1. 连板梯队 t3/t4/t5 的拆法必须和种子口径一致（t5 = 5 板及以上，不单列 6/7 板）；
//  2. 自产行只补种子终点**之后**，同日绝不覆盖种子（否则同一天数字会跳：种子 51 家 vs 本地 55 家）；
//  3. 自产行缺涨跌停/最高板就整行不上图——用 0 顶替等于造「当日 0 家涨停」的假事实。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isUsableSelfRow, mergeReviewRows, reviewSourceLine, splitBoards,
  type ReviewSelfRow,
} from "../../src/lib/quant/review/review-daily-core.ts";

const COLLECT = readFileSync(new URL("../../src/lib/quant/screener/review-daily-collect.ts", import.meta.url), "utf8");
const ROUTE = readFileSync(new URL("../../src/app/api/market/review-stats/route.ts", import.meta.url), "utf8");
const SCHED = readFileSync(new URL("../../src/lib/quant/scheduler/index.ts", import.meta.url), "utf8");
const RULES = readFileSync(new URL("../../src/lib/quant/scheduler/rules.ts", import.meta.url), "utf8");
const RUN_ROUTE = readFileSync(new URL("../../src/app/api/tasks/run/route.ts", import.meta.url), "utf8");

/** 造一行自产行（默认全齐，可逐项置 null 测缺数） */
function row(date: string, over: Partial<ReviewSelfRow> = {}): ReviewSelfRow {
  return {
    date, limitUp: 55, limitDown: 22, t3: 1, t4: 3, t5: 1, maxBoards: 5,
    decliners: 4306, belowMa5: null, belowMa3: null,
    aboveMa5Pct: null, microPct: null, midPct: null, largePct: null,
    ...over,
  };
}

test("连板拆分：t5 是「5 板及以上」，不单列 6/7 板", () => {
  const r = splitBoards([5, 4, 4, 4, 3, 6, 7]);
  assert.deepEqual(r, { t3: 1, t4: 3, t5: 3 }, "5/6/7 板都进 t5，与种子口径一致");
});

test("连板拆分：null/undefined/NaN 不进任何桶", () => {
  assert.deepEqual(splitBoards([null, undefined, Number.NaN, 3]), { t3: 1, t4: 0, t5: 0 });
  assert.deepEqual(splitBoards([]), { t3: 0, t4: 0, t5: 0 });
});

test("自产行缺涨跌停或最高板就整行不上图（缺读数 ≠ 0）", () => {
  assert.equal(isUsableSelfRow(row("2026-09-28")), true);
  assert.equal(isUsableSelfRow(row("2026-09-28", { limitUp: null })), false, "涨停家数缺 = 整行不可用");
  assert.equal(isUsableSelfRow(row("2026-09-28", { limitDown: null })), false);
  assert.equal(isUsableSelfRow(row("2026-09-28", { maxBoards: null })), false);
  // 宽度那几列可以缺（当日还没沉淀），缺了不影响涨跌停那几列上图——但缺就是缺，不拿 0 顶替
  assert.equal(isUsableSelfRow(row("2026-09-28", { aboveMa5Pct: null, belowMa5: null })), true);
});

test("合并：自产只补种子终点之后，同日绝不覆盖种子", () => {
  const seed = [{ date: "2026-09-23" }, { date: "2026-09-24" }];
  const merged = mergeReviewRows(seed, [row("2026-09-24"), row("2026-09-28")], "2026-09-24");
  assert.deepEqual(merged.map((r) => r.date), ["2026-09-23", "2026-09-24", "2026-09-28"],
    "09-24 那天种子说了算（自产行只留档），09-28 才由自产补上");
});

test("合并：不可用的自产行被整行丢掉，不产生「0 家涨停」", () => {
  const seed = [{ date: "2026-09-24" }];
  const merged = mergeReviewRows(seed, [row("2026-09-28", { limitUp: null })], "2026-09-24");
  assert.deepEqual(merged.map((r) => r.date), ["2026-09-24"]);
});

test("合并：结果按日期升序（两条来源各自有序也要稳定归并）", () => {
  const seed = [{ date: "2026-09-01" }, { date: "2026-09-24" }];
  const merged = mergeReviewRows(seed, [row("2026-10-09"), row("2026-09-28")], "2026-09-24");
  assert.deepEqual(merged.map((r) => r.date), ["2026-09-01", "2026-09-24", "2026-09-28", "2026-10-09"]);
});

test("出身那行字：没有自产时要说清「等收盘后自动续写」", () => {
  assert.match(reviewSourceLine({ seedEnd: "2026-09-24", selfDays: 0 }), /kind=review/);
  assert.match(
    reviewSourceLine({ seedEnd: "2026-09-24", selfDays: 2, firstSelfDate: "2026-09-28" }),
    /本地自产续写 2 个交易日（2026-09-28 起）/,
  );
  // 读库失败不能把整页历史打没：那行字要说明「历史照常、只是不续写」
  assert.match(reviewSourceLine({ seedEnd: "2026-09-24", selfDays: 0, selfError: "no such table" }), /暂不可用（no such table）/);
});

test("采集器：三道闸与字段口径都写死了", () => {
  assert.match(COLLECT, /weekdayOf/, "周末拒跑");
  assert.match(COLLECT, /CLOSE_MINUTE/, "收盘前拒跑");
  assert.match(COLLECT, /15 \* 60 \+ 5/, "收盘下限是北京 15:05");
  assert.match(COLLECT, /splitBoards/, "连板拆分走纯核，不自己再写一套");
  assert.match(COLLECT, /upsert/, "按交易日唯一键 upsert（同日重跑以最后一次为准）");
  // P15-R19c：宽度三列不再一律 null——库里 2026-04-20 起有逐票真实收盘价，收盘后就该自产。
  // intent 不变（缺读数不许编），只是形状从「写死 null」变成「算不出来才 null」。
  assert.match(COLLECT, /widthColsForDate/, "宽度三列走 breadth-core 同一份纯核，不自己再写一套 MA 判定");
  assert.match(COLLECT, /aboveMa5Pct: width\.cols\?\.aboveMa5Pct \?\? null/, "取不到才落 null（缺就是缺，不拿昨天顶）");
  assert.match(COLLECT, /microPct: null, midPct: null, largePct: null/, "微/中/大盘分组自产不了（库里没有市值分层），继续留空并说明原因");
  assert.equal(/需逐票收盘价攒满 5 个交易日后自产，当前记 null/.test(COLLECT), false,
    "「一直留 null 等攒够」已经不是事实，留着就是假口径");
});

test("路由：自产只查种子终点之后，异常不能吃掉历史", () => {
  assert.match(ROUTE, /SEED_END/, "要有明确的种子终点");
  assert.match(ROUTE, /tradeDate: \{ gt: SEED_END \}/, "只查种子终点之后的新交易日");
  assert.match(ROUTE, /mergeReviewRows/, "合并走纯核");
  assert.match(ROUTE, /catch \(e\)/, "读库失败要吃掉异常、历史照常返回");
  assert.match(ROUTE, /rows,\n/, "异常分支仍然返回种子 rows（不能返回空数组）");
});

test("调度：review 已注册为新任务种类", () => {
  assert.match(RULES, /"radar" \| "events" \| "breadth" \| "review"/);
  assert.match(SCHED, /\["radar", "events", "breadth", "review"\]/);
  assert.match(SCHED, /kind === "review" \? await archiveReviewScan\(\)/);
  assert.match(RUN_ROUTE, /body\.kind === "review" \? "review"/, "手动补跑入口也要认 review");
  assert.match(RUN_ROUTE, /radar、events、breadth 或 review/);
});
