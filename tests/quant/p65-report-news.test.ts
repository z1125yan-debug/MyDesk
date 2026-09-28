// P65 研报「关联新闻」的取数与口径（2026-09-27）
//
// 触发点：用户拿稳智研报的截图问「人家的新闻是当日快讯吗？还是三天左右、或者根据产业进度来的？」
// 取证（不是猜）：把东财 7x24 按 realSort 游标翻了 80 页 / 去重 8000 条（覆盖 09-14~09-27），
// 再拿稳智那条「涨价链与周期出清反内卷」的关联新闻逐条回查：
//   · 「快递单票价格同比+4%」→ 归档 0 命中；09-20 11:28 原帖是
//     「快递“反内卷”引发新一轮涨价 多家公司今起安徽区域单票最低上调0.15元」（数字与口径都被换过）；
//   · 「制冷剂淡季不跌反涨」「钽精矿100→250美元」「钢铁三重底部」「粮食库销比历史低位」→ 全部 0 命中；
//   · 「玻纤电子布连续5个月提价」→ 电子布涨价原帖在 09-15 07:30 / 09-17 11:17（比研报日早 7~9 天）。
// 结论：稳智那栏**不是当日快讯**，是跨多日按主线聚合、再被模型改写成证据短句的东西。
//
// 我们据此只借「多日窗口」这一层口径（当日快讯确实挂不住主线：单日约 760 条里对得上的常常只有个位数），
// 不借它改写标题的写法 —— 交给模型的永远是带完整日期的原标题，正文只许逐字照抄。
// 顺带修掉两个真 bug：① 抓取日冒充研报日；② 单日窗口用 `=== 目标日` 判停，
// 目标日早于抓取日时第一页末行还是新日子 → 一页就空手而归（日内实时扫描不受影响，故老函数行为不变）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const page = () => read("src/components/desk/LlmAnalysisPage.tsx");
const emSrc = () => read("src/lib/desk/em.ts");
const routeSrc = () => read("src/app/api/market/news/route.ts");
const winCoreSrc = () => read("src/lib/quant/screener/news-window-core.ts");

const news = await import("../../src/lib/desk/report-news-core.ts");
const {
  themeNewsKeywords, matchedKeyword, groupNewsByTheme, newsQuoteZh,
  groupedNewsZh, unmatchedThemesZh, newsPoolLabelZh,
} = news;
const win = await import("../../src/lib/quant/screener/news-window-core.ts");
const { shouldFetchMoreUntil, pickNewsDays, pickNewsWindow, NEWS_PAGE_SIZE, NEWS_MAX_PAGES_MULTI } = win;

const row = (i: number, date: string, hhmm: string, title: string) => ({
  code: `c${i}`,
  showTime: `${date} ${hhmm}:00`,
  realSort: String(1000 - i),
  title,
});
/** 造一整页（100 条）满页行，日期从 dayStart 往后按 idx 摊 */
function fullPage(n: number, date: string, idx0 = 0) {
  return Array.from({ length: n }, (_, k) => row(idx0 + k, date, "09:00", `标题${idx0 + k}`));
}

/* ---------------- 关键词：从主题名到「新闻里真会用的说法」 ---------------- */

test("主题名 → 关键词：全名优先，去尾巴、别名、前缀依次排后", () => {
  const kws = themeNewsKeywords("半导体设备");
  assert.equal(kws[0], "半导体设备", "最具体的写法必须排第一（排序按可信度用得上）");
  assert.ok(kws.includes("半导体"), "去掉「设备」尾巴才能挂上「半导体行业…」这类标题");
  assert.ok(kws.indexOf("半导体设备") < kws.indexOf("半导体"), "可信度顺序不能反");
});

test("主题名 → 关键词：概念/板块/指数这类尾巴要剥掉", () => {
  for (const [name, want] of [["国产芯片概念", "国产芯片"], ["光模块板块", "光模块"], ["创新药指数", "创新药"]] as [string, string][]) {
    assert.ok(themeNewsKeywords(name).includes(want), `${name} 应该带出去尾巴的 ${want}`);
  }
});

test("主题名 → 关键词：内置别名只收同一件事的两种写法", () => {
  assert.ok(themeNewsKeywords("内存").includes("存储"), "A股说「存储涨价」，主题名叫「内存」");
  assert.ok(themeNewsKeywords("光通信").includes("CPO"));
  assert.ok(themeNewsKeywords("玻璃基").includes("玻璃基板"));
  assert.ok(themeNewsKeywords("人工智能").includes("AI"));
});

test("主题名 → 关键词：不足 3 字的前缀一律不要（假命中比空着更糟）", () => {
  const kws = themeNewsKeywords("人工智能");
  assert.ok(!kws.includes("人工"), "「人工」会挂上「人工关节」，这种误匹配不如不挂");
  assert.ok(kws.every((k) => k.length >= 2));
  assert.deepEqual(themeNewsKeywords("电池"), ["电池"], "本身就短的主题名不再拆前缀");
  assert.deepEqual(themeNewsKeywords(""), []);
  assert.deepEqual(themeNewsKeywords("   "), []);
});

test("matchedKeyword：ASCII 大小写不敏感，命中返回最可信的那个词", () => {
  assert.equal(matchedKeyword("AI算力需求爆发", themeNewsKeywords("人工智能")), "AI");
  assert.equal(matchedKeyword("半导体行业供需趋紧", themeNewsKeywords("半导体设备")), "半导体");
  assert.equal(matchedKeyword("无关标题", themeNewsKeywords("半导体设备")), "");
});

test("复合主题名：斜杠/括号要拆段，否则整串在新闻里一次都不出现", () => {
  assert.ok(themeNewsKeywords("东数西算/算力").includes("算力"), "「东数西算/算力」这种名字必须两段都算");
  assert.ok(themeNewsKeywords("光模块(CPO)").includes("CPO"));
  assert.ok(themeNewsKeywords("光电共封装CPO").includes("CPO"), "新闻正文写 CPO，主题名叫光电共封装CPO");
});

test("两字母缩写按原文大小写比：「AI」不许挂上英文词里的 ai", () => {
  const kws = ["AI"];
  assert.equal(matchedKeyword("this is a detail page about email", kws), "", "小写 ai 出现在英文词里不算命中");
  assert.equal(matchedKeyword("AI眼镜出货翻倍", kws), "AI");
});

/* ---------------- 分组：谁挂得上、挂几条、挂不上怎么办 ---------------- */

const POOL = [
  { date: "2026-09-24", time: "08:30", title: "算力数据中心产业链供需两旺" },
  { date: "2026-09-23", time: "10:00", title: "半导体设备招标量创年内新高" },
  { date: "2026-09-22", time: "09:10", title: "半导体12英寸硅片供需趋紧" },
  { date: "2026-09-22", time: "14:00", title: "某公司发布半年报" },
];

test("groupNewsByTheme：命中的按「关键词可信度 → 池子新到旧」排，条数按 perTheme 截", () => {
  const g = groupNewsByTheme(["半导体"], POOL, { perTheme: 2 });
  assert.equal(g.length, 1);
  assert.equal(g[0].hits.length, 2);
  assert.equal(g[0].hits[0].title, "半导体设备招标量创年内新高", "同可信度时保持池子原序（新在前）");
  assert.equal(g[0].hits[0].date, "2026-09-23", "日期必须跟着标题走，不许只剩时分");
});

test("groupNewsByTheme：挂不上的主线照样留在结果里（空数组＝要如实写「没有相关快讯」）", () => {
  const g = groupNewsByTheme(["半导体", "氢能源"], POOL);
  assert.deepEqual(g[1].hits, [], "抹掉主线 = 模型看不出哪条主线无据可依");
});

test("groupNewsByTheme：空主线名/空池子不炸", () => {
  assert.deepEqual(groupNewsByTheme([""], []).map((x) => x.hits), [[]]);
  assert.deepEqual(groupNewsByTheme(["半导体"], []), [{ name: "半导体", hits: [] }]);
});

test("引用写法与分组文案：标题逐字 + 带（月-日 时:分），空组不进这段", () => {
  assert.equal(newsQuoteZh({ date: "2026-09-22", time: "09:10", title: "半导体12英寸硅片供需趋紧" }),
    "“半导体12英寸硅片供需趋紧”（09-22 09:10）");
  const g = groupNewsByTheme(["半导体", "氢能源"], POOL);
  const zh = groupedNewsZh(g);
  assert.ok(zh.startsWith("半导体："), zh);
  assert.ok(!zh.includes("氢能源"), "没命中的主线不该出现在「已分组」那段里");
  assert.equal(unmatchedThemesZh(g), "以下主线在本快讯池里没有直接相关题目：氢能源");
  assert.equal(unmatchedThemesZh(groupNewsByTheme(["半导体"], POOL)), "");
});

/* ---------------- 口径说明：把「区间 / 条数 / 抓取日 / 有没有翻完」一次说清 ---------------- */

test("newsPoolLabelZh：多日说「N 个交易日」，跨度按新→旧的两端写", () => {
  const zh = newsPoolLabelZh({ dates: ["2026-09-24", "2026-09-23", "2026-09-22"], total: 2317, fetchedOn: "2026-09-27", source: "东财7x24" });
  assert.ok(zh.includes("研报区间 2026-09-22~2026-09-24"), zh);
  assert.ok(zh.includes("3 个交易日"), zh);
  assert.ok(zh.includes("共 2317 条") && zh.includes("抓取于 2026-09-27"), zh);
  assert.ok(zh.includes("源：东财7x24"), zh);
  assert.ok(!zh.includes("窗口可能不完整"), "没翻完才要说没翻完");
});

test("newsPoolLabelZh：单日说「当日」；翻页预算用尽要如实标窗口可能不完整", () => {
  assert.ok(newsPoolLabelZh({ dates: ["2026-09-24"], total: 761, fetchedOn: "2026-09-27" }).includes("当日"));
  assert.ok(newsPoolLabelZh({ dates: [], total: 0, fetchedOn: "2026-09-27" }).includes("2026-09-27"));
  assert.ok(newsPoolLabelZh({ dates: ["2026-09-24"], total: 1, fetchedOn: "2026-09-27", capped: true }).includes("窗口可能不完整"));
});

/* ---------------- 翻页判据（多日窗口的真 bug 所在） ---------------- */

test("shouldFetchMoreUntil：末行仍在区间内就继续，早于最早一天才停", () => {
  assert.equal(shouldFetchMoreUntil(fullPage(NEWS_PAGE_SIZE, "2026-09-26"), "2026-09-22"), true, "比区间还新的日子必须继续翻（旧判据在这儿会一页就停）");
  assert.equal(shouldFetchMoreUntil(fullPage(NEWS_PAGE_SIZE, "2026-09-22"), "2026-09-22"), true, "正好翻到最早一天：还要收完当天");
  assert.equal(shouldFetchMoreUntil(fullPage(NEWS_PAGE_SIZE, "2026-09-21"), "2026-09-22"), false);
  assert.equal(shouldFetchMoreUntil(fullPage(NEWS_PAGE_SIZE - 1, "2026-09-23"), "2026-09-22"), false, "不满一页=上游到底");
  assert.equal(shouldFetchMoreUntil([], "2026-09-22"), false);
  assert.equal(shouldFetchMoreUntil([{ code: "x", showTime: "坏时间", realSort: "1", title: "t" }], "2026-09-22"), false, "认不出的日期不猜，直接停");
});

test("多日窗口要留够页数预算：实测单日 300~840 条，8 页根本不够", () => {
  assert.ok(NEWS_MAX_PAGES_MULTI >= 30, "三个交易日≈24~29 页，上限必须留余量");
  assert.ok(NEWS_MAX_PAGES_MULTI > win.NEWS_MAX_PAGES, "单日版沿用 8 页（日内扫描从当天往回翻），不能被多日版带跑");
});

test("pickNewsDays：每个目标日都有桶（没翻到是空数组），区间外计数不吞", () => {
  const pages = [
    [row(1, "2026-09-25", "10:00", "非目标日"), row(2, "2026-09-24", "10:00", "A"), row(3, "2026-09-23", "10:00", "B")],
    [row(2, "2026-09-24", "10:00", "A"), row(4, "2026-09-21", "10:00", "更早")],
  ];
  const r = pickNewsDays(pages, ["2026-09-24", "2026-09-23", "2026-09-22"]);
  assert.deepEqual(Object.keys(r.perDay), ["2026-09-24", "2026-09-23", "2026-09-22"]);
  assert.deepEqual(r.perDay["2026-09-22"], [], "没翻到的那天要留空桶，不能整个键消失");
  assert.deepEqual(r.perDay["2026-09-24"].map((x) => x.title), ["A"]);
  assert.equal(r.duplicated, 1, "跨页撞 code 合并并计数");
  assert.equal(r.offDay, 2, "09-25 与 09-21 都不在区间内");
  assert.equal(r.fetchedRows, 5);
});

test("pickNewsWindow 就是 pickNewsDays 的单日包装（同一套判定不留两份实现）", () => {
  const src = winCoreSrc();
  assert.equal((src.match(/fetchedRows\+\+/g) ?? []).length, 1, "过滤/去重/丢弃的计数逻辑只许有一处");
  const single = pickNewsWindow([[row(1, "2026-09-24", "10:00", "A"), row(2, "2026-09-23", "10:00", "旧")]], "2026-09-24");
  assert.deepEqual(single.items.map((x) => x.title), ["A"]);
  assert.equal(single.offDay, 1);
});

/* ---------------- 取数层与接口 ---------------- */

test("em.ts：多日窗口走 Until 判据 + 分桶收口，并且自带缓存键", () => {
  const src = emSrc();
  assert.match(src, /async function pageThroughUntil\([\s\S]*?shouldFetchMoreUntil\(rows, oldestDate\)/);
  assert.match(src, /pickNewsDays\(pages, tradeDates\)/);
  assert.match(src, /cached\("news", `days:\$\{dates\.join\(","\)}`/, "同一区间重复生成研报不该再翻 30 页");
  assert.match(src, /export async function fetchNewsWindowForDates/);
  assert.match(src, /buildNewsDaysWindow\(dates, sinaNewsPage/, "东财断了换新浪，不静默给空池子");
});

test("em.ts：单日窗口（事件雷达在用）的调用链一行没动", () => {
  const src = emSrc();
  assert.match(src, /pageLoop\(NEWS_MAX_PAGES, \(rows\) => shouldFetchMore\(rows, tradeDate\), getPage\)/);
  assert.match(src, /buildNewsWindow\(tradeDate, emNewsPage, "东财7x24"\)/);
});

test("接口：带 dates 走全量窗口并回显日期；不带参数维持「最新一屏」老行为", () => {
  const src = routeSrc();
  assert.match(src, /fetchNewsWindowForDates\(dates\)/);
  assert.match(src, /fetchNewsReal\(\)/, "首页快讯栏还在用无参形态，不能被研报改动带崩");
  assert.match(src, /\{ \.\.\.it, date: p\.date \}/, "每条都要带日期：只给 HH:MM 就是当年那个冒充当日 bug 的根");
  assert.match(src, /capped: win\.capped/);
  assert.match(src, /status: 502/, "取不到窗口要报错，不许返回空数组冒充「这几天没有新闻」");
  assert.match(src, /MAX_DAYS = 5/, "一次最多五天：翻页成本要封顶");
});

test("接口：日期参数容错——非法值丢掉、重复去掉、超过 5 天截断", () => {
  const src = routeSrc();
  assert.match(src, /\.filter\(\(s\) => DATE_RE\.test\(s\)\)/);
  assert.match(src, /\[\.\.\.new Set\(raw\)\]\.sort\(\(a, b\) => \(a < b \? 1 : -1\)\)\.slice\(0, MAX_DAYS\)/);
});

/* ---------------- 组件接线 ---------------- */

test("组件：快讯池在 review-stats 之后取（要先知道研报区间是哪三个交易日）", () => {
  const src = page();
  assert.match(src, /const poolDates = rows\.map\(\(r\) => String\(r\.date \?\? ""\)\.slice\(0, 10\)\)\.filter\(Boolean\)\.reverse\(\)/);
  assert.match(src, /await getJson<NewsPoolResp>\(newsPoolUrl\(poolDates\)\)/);
  const at = src.indexOf("const [rv, tj, shK, szK, cybK] = await Promise.all([");
  const block = src.slice(at, src.indexOf("]);", at));
  assert.ok(!block.includes('getJson<{ news') && !block.includes('"/api/market/news"'),
    "并发批次里不许再有快讯请求：那时还没算出区间日期，只能拿抓取日的头条糊");
});

test("组件：分组/措辞全部走 report-news-core，不再自己写 slice(0,4) 匹配", () => {
  const src = page();
  assert.match(src, /groupNewsByTheme\(hotThemes, pool, \{ perTheme: 6 \}\)/);
  assert.match(src, /groupedNewsZh\(newsGroups\)/);
  assert.match(src, /unmatchedThemesZh\(newsGroups\)/);
  assert.ok(!src.includes("const kw = name.slice(0, 4)"), "旧的 4 字包含匹配只留在主题热点面板，研报这条路换核");
});

test("组件：取不到快讯时 prompt 明写「一律写数据不足」，而不是留个空位让模型自由发挥", () => {
  const src = page();
  assert.match(src, /正文里所有「关联新闻」一律写「数据不足」，不许自己编题目/);
});

test("组件：关联新闻要连日期标注一起抄（读者能看出不是当天的）", () => {
  const src = page();
  assert.match(src, /> \*\*关联新闻\*\*：“新闻标题1”（09-20 11:28）/);
  assert.match(src, /本区间快讯池里没有与该主线直接相关的题目/);
  assert.match(src, /写成「快递单票价格同比\+4%」就是编造/, "把这次取证到的改写手法写成反例钉住");
});
