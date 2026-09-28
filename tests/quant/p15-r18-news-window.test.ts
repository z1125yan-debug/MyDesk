// P15-R18 钉测：全球事件雷达「找出来塞进去」两件事。
// R18a 菜单：events 从 AI 对话的 legacyPages 挖回一级项（p7-ui-nav 里改钉 + 本文件补一条联动钉）。
// R18b 数据：快讯窗口从「最新 24 条」改成「按 realSort 游标翻到跨出目标交易日为止」——
//   判定全在 news-window-core（零依赖纯核，node --test 直跑零 IO），翻页/同日过滤/去重/坏行丢弃逐条钉；
//   接线（em.ts 取数、events.ts 抛错口径、persist.ts 把窗口自报写进 source）钉在源码形状上。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NEWS_MAX_PAGES, NEWS_PAGE_SIZE, lastCursor, newsClockOf, newsDateOf, pickNewsWindow, shouldFetchMore,
  type NewsRawRow,
} from "../../src/lib/quant/screener/news-window-core.ts";
import { MENU, isLegacyPage } from "../../src/lib/desk/nav-core.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// 造一条上游原样快讯：code 稳定、showTime 是东财给的北京时间、realSort 是翻页游标。
const row = (n: number, showTime: string, over: Partial<NewsRawRow> = {}): NewsRawRow => ({
  code: `c${n}`, showTime, realSort: `s${n}`, title: `快讯标题 ${n}`, ...over,
});
/** 造一整页（realSort 递增、时间从新到旧），用于测「满一页才继续翻」 */
const page = (from: number, count: number, day = "2026-09-23"): NewsRawRow[] =>
  Array.from({ length: count }, (_, i) => {
    const n = from + i;
    const hh = String(15 - Math.floor(n / 60)).padStart(2, "0");
    const mm = String(59 - (n % 60)).padStart(2, "0");
    return row(n, `${day} ${hh}:${mm}:00`);
  });

// ---------- Dim 1：指标定义 —— 「当日窗口」到底是什么 ----------

test("时间戳认得出就取日期/时分位，认不出给空串（不猜它是哪天的）", () => {
  assert.equal(newsDateOf("2026-09-23 13:34:41"), "2026-09-23");
  assert.equal(newsClockOf("2026-09-23 13:34:41"), "13:34");
  assert.equal(newsDateOf("13:34:41"), ""); // 没日期的行不敢算进当天
  assert.equal(newsDateOf(""), "");
  assert.equal(newsClockOf("2026-09-23"), "");
});

test("窗口大小单点定义：一页 100 条、最多翻 8 页（一天 7x24 实测约 400~500 条，够跨日）", () => {
  assert.equal(NEWS_PAGE_SIZE, 100);
  assert.equal(NEWS_MAX_PAGES, 8);
});

// ---------- Dim 2：计算逻辑 —— 翻页停在哪、怎么合、坏行怎么算 ----------

test("游标就是末行的 realSort；空页没有游标（调用方据此停，不拿空串再打一次）", () => {
  assert.equal(lastCursor(page(0, 3)), "s2");
  assert.equal(lastCursor([]), "");
  assert.equal(lastCursor([row(1, "2026-09-23 10:00:00", { realSort: "  " })]), "", "游标是空白也算没有");
});

test("该继续翻的只有一种：整页、且末行仍在目标交易日", () => {
  assert.equal(shouldFetchMore(page(0, NEWS_PAGE_SIZE), "2026-09-23"), true, "满页且末行仍是当天 → 继续往前翻");
  assert.equal(shouldFetchMore(page(0, NEWS_PAGE_SIZE - 1), "2026-09-23"), false, "不满一页=上游到底");
  assert.equal(shouldFetchMore(page(0, 60), "2026-09-23"), false, "日内就取完的短页不再多打一次请求");
  assert.equal(
    shouldFetchMore([...page(0, NEWS_PAGE_SIZE - 1), row(999, "2026-09-22 14:00:00")], "2026-09-23"),
    false, "末行已经跨到昨天 → 当日窗口翻完了",
  );
  assert.equal(shouldFetchMore([], "2026-09-23"), false, "空页不翻");
});

test("同日过滤 + 跨页去重 + 坏行丢弃各记各的数，不混成一锅", () => {
  const p1 = [
    row(1, "2026-09-23 15:00:00"),
    row(2, "2026-09-23 14:59:00", { title: "  " }), // 没标题：映射不了，丢弃并计数
    row(3, "2026-09-22 14:58:00"), // 昨日：跨日剔除
    row(4, "乱码时间", { title: "日期认不出" }),
  ];
  const p2 = [row(1, "2026-09-23 15:00:00"), row(5, "2026-09-23 09:30:00", { code: "" })]; // 翻页重叠 + 上游没给 code
  const w = pickNewsWindow([p1, p2], "2026-09-23");
  assert.deepEqual(w.items.map((i) => i.time), ["15:00", "09:30"], "同一天的按上游顺序（新→旧）留下，撞 code 的第二次不重复进");
  assert.equal(w.fetchedRows, 6, "原始行数如实报（含被丢的）");
  assert.equal(w.offDay, 1);
  assert.equal(w.duplicated, 1);
  assert.equal(w.dropped, 2, "没标题 1 条 + 日期认不出 1 条");
});

test("没给 code 的行退回「同日同时刻同标题」原文键：仍能合并，但不会把不同新闻吃掉", () => {
  const same = { code: "", title: "同一条新闻" };
  const w = pickNewsWindow([[
    row(1, "2026-09-23 10:00:00", same),
    row(2, "2026-09-23 10:00:00", same), // 同日同时刻同标题 → 合并
    row(3, "2026-09-23 10:00:00", { code: "", title: "另一条新闻" }), // 标题不同 → 各自保留
  ]], "2026-09-23");
  assert.equal(w.items.length, 2);
  assert.equal(w.duplicated, 1);
});

test("目标交易日不是「今天」也照办：回看某天时只留那一天", () => {
  const w = pickNewsWindow([[row(1, "2026-09-21 10:00:00"), row(2, "2026-09-23 10:00:00")]], "2026-09-21");
  assert.deepEqual(w.items.map((i) => i.title), ["快讯标题 1"]);
  assert.equal(w.offDay, 1);
});

// ---------- Dim 4/5：边界与来源接线（钉源码形状，不发请求） ----------

test("取数层按游标翻页、按天缓存，且窗口自报口径写在 em.ts 里", () => {
  const src = read("src/lib/desk/em.ts");
  assert.match(src, /sortEnd=\$\{cursor\}/, "翻页必须把游标带进 sortEnd");
  assert.match(src, /cached\("news", `day:\$\{tradeDate\}`/, "整窗按日缓存，避免盘中轮询反复打下游");
  assert.match(src, /if \(!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(tradeDate\)\) return null/, "日期形状不对直接 null，不拿脏日期去翻");
  assert.match(src, /新浪直播/, "东财失败要换新浪兜底（窗口口径同源）");
  assert.match(src, /next && next === cursor\) break/, "游标不前进就停：上游回同一页不许无限翻");
});

test("collectNews 换日窗口，取不到仍抛错；旧常量 24 不再参与取数", () => {
  const src = read("src/lib/quant/screener/events.ts");
  assert.match(src, /export async function collectNewsWindow\(tradeDate: string\)/, "窗口口径单点在这里");
  assert.match(src, /throw new Error\("新闻源暂不可用（东财7x24\/新浪均无返回）"\)/, "两源都空必须抛错，不能静默当「今天没有事件」");
  assert.equal(/fetchNewsReal\(NEWS_WINDOW\)/.test(src), false, "旧的「最新 24 条」链路已断根");
  assert.equal(/export const NEWS_WINDOW = 24/.test(src), false, "假旋钮不留：没有代码再吃这个数");
  assert.match(src, /当日快讯全量窗口/, "source 自报要用人话，不写函数名黑话");
});

test("扫描结果把窗口自报摆进 source；翻到上限仍未跨日时挂一条如实说明", () => {
  const src = read("src/lib/quant/screener/persist.ts");
  assert.match(src, /await collectNewsWindow\(tradeDate\)/, "事件扫描走日窗口，且目标日=交易日历口径");
  assert.match(src, /快讯窗口：\$\{windowDetail\}/, "看了多少条、跨度多长，随结果自报");
  assert.match(src, /翻到页数上限仍未跨出交易日/, "窗口不完整时要明说，不装作取全了");
});

// ---------- R18a：菜单联动 ----------

test("P15-R18a：全球事件雷达在一级菜单里，且不再是 legacy 兼容页", () => {
  assert.equal(isLegacyPage("events"), false);
  assert.deepEqual(
    MENU.map((e) => e.id),
    ["market", "quant", "sectors", "quotes", "watch", "events", "assistant", "sectortop", "ai"],
    "一级顺序：大盘情绪·量化因子选股·行业·行情·自选·事件雷达·LLM分析·板块风险·AI分析（2026-09-29 起「板块风险」顶替「奇门遁甲」位；事件雷达是本地特色项）",
  );
  assert.ok(!MENU.find((e) => e.id === "ai")!.legacyPages?.includes("events"), "AI 对话组不再代收 events");
});
