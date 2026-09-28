// P15-R21 主题「理由 + 新闻证据」钉测（LLM 分析 · 主题热点 Tab）。
//
// 用户两轮反馈合成的要求：
//  1. 理由不能只是把数字重念一遍（旧实现就是一句话念四个数）——每条必须是「读数 → 说明什么」；
//  2. 新闻不能只扫「抓取那一刻的 12 条」——走「近 3 个交易日」全量快讯窗口（稳智同款 3 日口径），
//     窗口哪三天由服务端定死（复盘种子 ≤ 请求日的最近 3 个交易日），前端不算日历；
//  3. 资金口径不许混：种子热度里的 f 是 3 日资金、实时热度的 f 是当日主力净额——理由里分开说；
//  4. 缺哪个维度整条不生成，不拿大盘的数硬凑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THEME_REASON_EMPTY, THEME_REASON_PERIOD_NOTE, themeReasonLines } from "../../src/lib/quant/review/theme-reason-core.ts";
import { newsWindowLabel, themeKeywords, themeNewsEmptyNote, themeNewsHits } from "../../src/lib/quant/review/theme-news-core.ts";

const ROUTE = readFileSync(new URL("../../src/app/api/market/theme-heat/route.ts", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../src/components/desk/LlmAnalysisPage.tsx", import.meta.url), "utf8");
const CHAT_ROUTE = readFileSync(new URL("../../src/app/api/ai/chat/route.ts", import.meta.url), "utf8");
const MODES = readFileSync(new URL("../../src/lib/desk/modes.ts", import.meta.url), "utf8");

const FULL = {
  name: "半导体",
  heat: 94, trend: "new",
  fund3Yi: 80.3, mainTodayYi: -13.2,
  changePct: -2.2, upCount: 20, downCount: 168, limitUpCount: 1,
  leader: "盛景微", rps: 11.2,
  marketPhase: "退潮反抽", marketBucket: "退潮",
};

test("理由：全量输入按稳智骨架给满六段，顺序固定", () => {
  const lines = themeReasonLines(FULL);
  assert.deepEqual(lines.map((l) => l.key), ["position", "fund", "strength", "heat", "env", "counter"]);
  // 每条都是「读数 → 说明什么」，不是把数字重念一遍：冒号后面必须有解释性文字
  for (const l of lines) assert.ok(l.text.includes("：") || l.text.includes("——"), `${l.key} 缺「说明什么」半句`);
});

test("理由：位置段带板内涨跌与领涨股，普跌时直说在被卖", () => {
  const l = themeReasonLines(FULL).find((x) => x.key === "position")!;
  assert.ok(l.text.includes("20 涨 / 168 跌"), l.text);
  assert.ok(l.text.includes("领涨 盛景微"), l.text);
  assert.ok(l.text.includes("普跌"), l.text);
});

test("理由：资金段分「3 日 + 当日」并按组合给不同解读（不混口径）", () => {
  const t = (f3: number, d: number) => themeReasonLines({ ...FULL, fund3Yi: f3, mainTodayYi: d }).find((x) => x.key === "fund")!.text;
  assert.ok(t(80.3, 5).includes("持续往里走"), t(80.3, 5));
  assert.ok(t(80.3, -13.2).includes("获利了结"), t(80.3, -13.2));
  assert.ok(t(-20, 3).includes("回头试"), t(-20, 3));
  assert.ok(t(-20, -3).includes("按出货对待"), t(-20, -3));
});

test("理由：实时热度（f=当日主力）不得冒充 3 日资金——fund3Yi 不给就只说当天", () => {
  const l = themeReasonLines({ ...FULL, fund3Yi: null, mainTodayYi: -13.2 }).find((x) => x.key === "fund")!;
  assert.ok(l.text.includes("当日主力净额"), l.text);
  assert.ok(!l.text.includes("近 3 个交易日主力净额"), l.text);
});

test("理由：缺哪段跳哪段，全缺就一句如实说明（不拿大盘数字硬凑）", () => {
  assert.equal(themeReasonLines({ name: "x", heat: null, fund3Yi: null, mainTodayYi: null, changePct: null, upCount: null, downCount: null, rps: null, marketPhase: null }).length, 0);
  const onlyHeat = themeReasonLines({ ...FULL, fund3Yi: null, mainTodayYi: null, changePct: null, upCount: null, downCount: null, rps: null, marketPhase: null });
  assert.deepEqual(onlyHeat.map((l) => l.key), ["heat"]);
  assert.equal(THEME_REASON_EMPTY.length > 10, true);
  assert.ok(THEME_REASON_PERIOD_NOTE.includes("3 个交易日"));
});

test("理由：反证钉住「价涨钱跑」与热度冰点", () => {
  const c = themeReasonLines({ ...FULL, changePct: 3.1, mainTodayYi: -5, heat: 21 }).find((x) => x.key === "counter")!;
  assert.ok(c.text.includes("价涨钱跑"), c.text);
  assert.ok(c.text.includes("低于 30"), c.text);
});

test("新闻：主题名带斜杠要拆词，两个词都能命中", () => {
  assert.deepEqual(themeKeywords("东数西算/算力"), ["东数西算/算力", "东数西算", "算力"]);
  const pool = [
    { date: "2026-09-24", time: "11:51", title: "奥尼电子：子公司签订算力卡采购合同" },
    { date: "2026-09-23", time: "09:00", title: "东数西算工程新增枢纽节点" },
    { date: "2026-09-22", time: "08:00", title: "无关新闻一条" },
  ];
  const hits = themeNewsHits(pool, "东数西算/算力", 8);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].kw, "算力");
  assert.equal(hits[1].kw, "东数西算");
});

test("新闻：单字候选词丢弃、同标题去重、limit 生效、顺序保持最新在前", () => {
  assert.deepEqual(themeKeywords("力"), []);
  const pool = [
    { date: "2026-09-24", time: "12:00", title: "半导体设备出口增加" },
    { date: "2026-09-24", time: "11:00", title: "半导体设备出口增加" },
    { date: "2026-09-23", time: "10:00", title: "半导体材料涨价" },
    { date: "2026-09-22", time: "09:00", title: "半导体封测扩产" },
    { date: "2026-09-21", time: "08:00", title: "半导体第五条" },
  ];
  const hits = themeNewsHits(pool, "半导体", 3);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].date, "2026-09-24");
  assert.ok(!hits.some((h) => h.date === "2026-09-21"));
});

test("新闻：窗口文案与空命中说明都如实交代（不装作没查过）", () => {
  assert.equal(newsWindowLabel(["2026-09-24", "2026-09-22", "2026-09-23"]), "近 3 个交易日（09-22 ~ 09-24）");
  assert.equal(newsWindowLabel(["2026-09-24"]), "09-24 单日");
  assert.equal(newsWindowLabel([]), "");
  const note = themeNewsEmptyNote("光伏", 2298, "近 3 个交易日（09-22 ~ 09-24）");
  assert.ok(note.includes("近 3 个交易日") && note.includes("2298") && note.includes("光伏"), note);
});

test("接线：服务端定窗口（复盘种子 ≤ 请求日的最近 3 天），前端不算日历", () => {
  assert.ok(ROUTE.includes("newsWindowDates"), "路由必须导出 newsWindowDates");
  assert.ok(ROUTE.includes('pool.slice(-3)'), "窗口必须是最近 3 个交易日");
  assert.ok(ROUTE.includes("news_window: newsWindow"), "三路响应都要带 news_window");
  assert.ok(PAGE.includes("newsPoolUrl(winDates)"), "页面必须按窗口日期取全量快讯池");
  assert.ok(PAGE.includes("themeNewsHits(newsPool"), "页面命中逻辑必须走纯核");
});

test("接线：理由口径跟着热度出身走（种子=3 日 / 实时=当日），页面不自己造句", () => {
  assert.ok(PAGE.includes('fund3Yi: heatKind === "seed" ? f : null'), "种子热度才准说 3 日资金");
  assert.ok(PAGE.includes('mainTodayYi: heatKind === "seed" ? numOf(b.main) : heatKind === "live" ? f : null'), "实时热度把 f 当当日主力");
  assert.ok(PAGE.includes("THEME_REASON_EMPTY"), "一条理由都没有时要用如实说明");
});

test("R21 用户口径：AI 分析不再逐句挂「（来源：xx）」，但数字必须真实", () => {
  assert.ok(!CHAT_ROUTE.includes("关键事实后面用（来源：xx）标注"), "旧的逐句标注要求要删干净");
  assert.ok(CHAT_ROUTE.includes("禁止用「（来源：xx）」这种括号尾巴刷屏"), "要有反向禁令");
  assert.ok(CHAT_ROUTE.includes("数字必须带单位和时间"), "数字仍要带单位与时间");
  assert.ok(MODES.includes("出处不用逐句挂括号"), "实时搜索模式的骨架同步放宽");
  assert.ok(!MODES.includes("每条挂时间与出处"), "下拉副文案同步放宽");
});
