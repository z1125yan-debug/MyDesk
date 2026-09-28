// P15-R16 钉测：通达信逐笔主力净额自算（纯核 tdx-flow-core）+ 数据看板接实时（砍演示回退、补时间戳）。
// 一把尺子沿用 R7/R8/R11：口径行为钉在纯函数上，接线钉在源码形状上，node --test 直跑零 IO。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accumulateTicks, bandOf, emptyFlowAccum, mainFlowFromAccum, pickMainFlowSide,
  tickAmountYuan, formatTdxServerTime, latestServerTime,
  SUPER_BAND_YUAN, BIG_BAND_YUAN, TICK_PAGE, MAX_TICK_PAGES, MAIN_FLOW_UNIVERSE, MAIN_FLOW_BASIS,
  type FlowTickLike, type MainFlow,
} from "../../src/lib/quant/screener/tdx-flow-core.ts";
import { clockZh } from "../../src/lib/desk/plain-core.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// 一笔成交额 = 价(元) × 量(手) × 100。构造用「刚好某个档」的整数手，避免浮点边角。
const tick = (price: number, volume: number, over: Partial<FlowTickLike> = {}): FlowTickLike =>
  ({ price, volume, side: "buy", event_kind: "trade", ...over });
const yuan = (price: number, volume: number) => price * volume * 100;

// ---------- Dim 1/2：指标定义与计算逻辑 ----------

test("分档阈值就是东财那把尺子：特大≥100万、大单20–100万、中单小单不计入主力", () => {
  assert.equal(SUPER_BAND_YUAN, 1_000_000);
  assert.equal(BIG_BAND_YUAN, 200_000);
  assert.equal(bandOf(yuan(100, 200)), "super");     // 正好 200万
  assert.equal(bandOf(yuan(100, 100)), "super");     // 正好 100万：归特大不归大单
  assert.equal(bandOf(yuan(100, 99.9)), "big");      // 差一块钱也不是特大
  assert.equal(bandOf(yuan(100, 20)), "big");        // 正好 20万：进大单
  assert.equal(bandOf(yuan(100, 19.9)), null);       // 中单不算主力
  assert.equal(bandOf(NaN), null);
});

test("单笔金额换算：坏价坏量给 NaN，不静默当 0 笔（0 会被读成「没成交」）", () => {
  assert.equal(tickAmountYuan(10, 5), 5000);
  assert.ok(Number.isNaN(tickAmountYuan(0, 5)));
  assert.ok(Number.isNaN(tickAmountYuan(10, null)));
  assert.ok(Number.isNaN(tickAmountYuan(undefined, 3)));
});

test("恒等式钉死：主力净额 = 超大单净额 + 大单净额（与东财 f62=f66+f72 同构）", () => {
  // price=10 ⇒ 单笔成交额 = 手数 × 1000 元
  const acc = accumulateTicks([
    tick(10, 200_000, { absolute_index: 1 }),                    // 2亿 特大买
    tick(10, 100_000, { absolute_index: 2, side: "sell" }),      // 1亿 特大卖
    tick(10, 500, { absolute_index: 3 }),                        // 50万 大买
    tick(10, 200, { absolute_index: 4, side: "sell" }),          // 20万 大卖（正好踩线，进大单）
    tick(10, 100, { absolute_index: 5, side: "sell" }),          // 10万 中单：不进主力
  ]);
  const flow = mainFlowFromAccum(acc, { pages: 1, truncated: false, amountYuan: 1e9, expectedTicks: 5 });
  assert.equal(flow.superBigYi, 1);
  assert.equal(flow.bigYi, 0.003);
  assert.equal(flow.mainNetYi, flow.superBigYi + flow.bigYi);
  assert.equal(flow.buyYi, 2.005);
  assert.equal(flow.sellYi, 1.002);
  assert.equal(flow.sampleTicks, 5);
  assert.ok(flow.ratioPct !== null, "给了成交额就该有净占比");
  assert.equal(Number(flow.ratioPct.toFixed(2)), 10.03);         // 1.003亿 / 10亿
  assert.equal(flow.basis, MAIN_FLOW_BASIS, "口径自报：引用这批数必须带上这句");
});

test("中性笔与集合竞价撮合笔不计入金额，但必须计数——这是与东财拆单口径的系统性差异", () => {
  const acc = accumulateTicks([
    tick(10, 200_000, { absolute_index: 1 }),
    tick(10, 200_000, { absolute_index: 2, side: "neutral" }),
    tick(10, 200_000, { absolute_index: 3, side: null }),
    tick(10, 200_000, { absolute_index: 4, event_kind: "opening_match", side: "buy" }),
  ]);
  const flow = mainFlowFromAccum(acc, { pages: 1, truncated: false, amountYuan: 1e9, expectedTicks: 4 });
  assert.equal(flow.superBigYi, 2, "只有第一笔进账");
  assert.equal(flow.neutralTicks, 2, "side 判定不出来的两笔留在案上");
  assert.equal(flow.auctionTicks, 1, "开盘集合竞价撮合笔单独计数");
});

test("翻页重叠去重：同一 absolute_index 只算一次（重复计入会把净额放大）", () => {
  const dup = tick(10, 200_000, { absolute_index: 7 });           // 2亿 特大买
  const acc = accumulateTicks([dup, dup, tick(10, 200_000, { absolute_index: 8 })]);
  assert.equal(acc.ticksSeen, 2);
  assert.equal(acc.dupTicks, 1);
  // 去重生效 ⇒ 只算两笔（4亿）；若把翻页重叠那笔也算进去就是三笔 6亿
  assert.equal(mainFlowFromAccum(acc, { pages: 2, truncated: false, amountYuan: 1e9, expectedTicks: 2 }).superBigYi, 4);
});

test("缺价缺量的笔进 badTicks：不并进金额、也不当 0 笔消失", () => {
  const acc = accumulateTicks([tick(10, 200_000, { absolute_index: 1 }), tick(0, 500, { absolute_index: 2 }), { side: "buy", absolute_index: 3 } as FlowTickLike]);
  assert.equal(acc.badTicks, 2);
  assert.equal(acc.ticksSeen, 3);
  assert.equal(acc.buyTicks, 1);
});

// ---------- Dim 3：时间口径（榜上每个数都得能回答「是哪时的」） ----------

test("行情时刻：网关 server_time_raw ⇒ HH:MM:SS；认不出的形状给空串不猜时刻", () => {
  assert.equal(formatTdxServerTime(11294379), "11:29:43");
  assert.equal(formatTdxServerTime(9294379), "09:29:43", "7 位是早间时刻，补零后再拆");
  assert.equal(formatTdxServerTime(112943), "11:29:43", "6 位本身就是 HHMMSS");
  assert.equal(formatTdxServerTime(0), "");
  assert.equal(formatTdxServerTime(null), "");
  assert.equal(formatTdxServerTime("11:29"), "", "非数字不硬凑");
  assert.equal(formatTdxServerTime(99600001), "", "越界的时/分不显示成一个假时刻");
  // 实测形状：收盘集合竞价那一下网关不并进分，秒位会到 60~99（60 只里 9 只这样）——
  // 这类值必须归一化后照报，判成空串会让整榜「行情时刻」被一个越界值挡没
  assert.equal(formatTdxServerTime(11237001), "11:24:10", "11:23 + 70.01 秒 ⇒ 11:24:10");
  assert.equal(formatTdxServerTime(11296708), "11:30:07", "上午收盘那一下秒位 67 ⇒ 进分后照报");
  assert.equal(formatTdxServerTime(11596001), "12:00:00", "分位进位到 60 也要归一化");
  assert.equal(formatTdxServerTime(23595999), "23:59:59", "一天内最大合法时刻");
  assert.equal(formatTdxServerTime(23599999), "", "秒位进位后越过 23:59:59 ⇒ 认不出，不猜");
  assert.equal(formatTdxServerTime(24000000), "", "小时超界 ⇒ 认不出，不猜");
  assert.equal(latestServerTime([11237001, 11294379]), "11:29:43", "最新的那个是越界形状时也要能报出时刻");
  assert.equal(latestServerTime([11294379, 11300001, null]), "11:30:00", "榜级「数据截至」取一批快照里最新的那个");
  assert.equal(latestServerTime([null, undefined]), "");
  assert.equal(clockZh("2026-09-23T11:29:43"), "09-23 11:29:43", "ISO ⇒ 页面读法");
  assert.equal(clockZh(""), "", "坏值不显示 Invalid Date");
});

// ---------- Dim 4：边界 case ----------

test("净占比没有成交额可除时返回 null，不补一个 0 冒充「占比为 0」", () => {
  const acc = accumulateTicks([tick(10, 200_000, { absolute_index: 1 })]);
  assert.equal(mainFlowFromAccum(acc, { pages: 1, truncated: false, amountYuan: null, expectedTicks: 1 }).ratioPct, null);
  assert.equal(mainFlowFromAccum(acc, { pages: 1, truncated: false, amountYuan: 0, expectedTicks: 1 }).ratioPct, null);
});

test("样本完整性：翻页撞上限、或没取满快照全日笔数 ⇒ 不算完整；无 active1 时不冒充完整", () => {
  const acc = accumulateTicks([tick(10, 200_000, { absolute_index: 1 })]);
  const opts = { pages: MAX_TICK_PAGES, truncated: true, amountYuan: 1e9, expectedTicks: 1 };
  assert.equal(mainFlowFromAccum(acc, opts).sampleComplete, false, "截断的样本永远不算完整");
  assert.equal(mainFlowFromAccum(acc, { ...opts, truncated: false }).sampleComplete, true);
  assert.equal(mainFlowFromAccum(acc, { ...opts, truncated: false, expectedTicks: 5 }).sampleComplete, false, "少笔就是少笔");
  assert.equal(mainFlowFromAccum(acc, { ...opts, truncated: false, expectedTicks: null }).sampleComplete, false, "没有全日笔数可对照 ⇒ 不装完整");
  assert.equal(MAX_TICK_PAGES, 10, "单只翻页上限：超了就声明截断，不静默按半截算");
  assert.equal(TICK_PAGE, 1800, "网关单页实测上限");
});

test("取不到逐笔的那只票不进榜：flow=null 是「没读到」不是「净额 0」", () => {
  const rows = [
    { name: "甲", code: "600001.SH", changePct: 1, flow: null },
    { name: "乙", code: "600002.SH", changePct: 2, flow: null as MainFlow | null },
  ];
  assert.deepEqual(pickMainFlowSide(rows, "in"), []);
  assert.deepEqual(pickMainFlowSide(rows, "out"), []);
});

test("榜的取侧与截断：流入>0 降序、流出<0 升序，各按 size 截", () => {
  const mk = (v: number): MainFlow => ({
    ...mainFlowFromAccum(emptyFlowAccum(), { pages: 1, truncated: false, amountYuan: 1e9, expectedTicks: 1 }),
    mainNetYi: v,
  });
  const rows = [
    { name: "小正", code: "a", changePct: 1, flow: mk(1) },
    { name: "大正", code: "b", changePct: 2, flow: mk(9) },
    { name: "零", code: "c", changePct: 0, flow: mk(0) },
    { name: "小负", code: "d", changePct: -1, flow: mk(-1) },
    { name: "大负", code: "e", changePct: -2, flow: mk(-9) },
  ];
  assert.deepEqual(pickMainFlowSide(rows, "in").map((r) => r.name), ["大正", "小正"]);
  assert.deepEqual(pickMainFlowSide(rows, "out").map((r) => r.name), ["大负", "小负"]);
  assert.deepEqual(pickMainFlowSide(rows, "in", 1).map((r) => r.name), ["大正"]);
});

// ---------- Dim 5：接线与数据纪律（钉源码形状） ----------

test("自算只覆盖当日成交额前 N 只：榜口径必须说清是这个子集内排序", () => {
  assert.equal(MAIN_FLOW_UNIVERSE, 60, "实测 80 只/159 页/3.8s（并发 10），60 只约 2~3s——再大就不是刷一次榜的代价了");
  const tdx = read("src/lib/desk/tdx.ts");
  assert.match(tdx, /sort_by: "成交额", count: MAIN_FLOW_UNIVERSE/, "榜来源只有一条：网关成交额序");
  assert.match(tdx, /trades\.today/, "逐笔来自 trades.today，没有第二条数据管道");
  assert.match(tdx, /if \(pages >= MAX_TICK_PAGES\) \{ truncated = true; break; \}/, "翻页上限触发要标截断");
  assert.match(tdx, /flow: null,\s*\};?/, "单只没取到 ⇒ flow 留 null，不补 0");
  assert.match(tdx, /marketSession\(\)\.open \? 60_000 : 600_000/, "交易时段 60s 缓存、休市 10min：与 tdxDayBars 同一把尺子");
});

test("board 路由递棒顺序：东财优先 → 同花顺（行业/概念）→ 通达信自算（个股）→ 都没有就 null", () => {
  const route = read("src/app/api/market/board/route.ts");
  assert.match(route, /if \(rows\?\.length && !rows\.every\(\(r\) => r\.fundsMissing\)\) \{\s*return NextResponse\.json\(\{ rows, source: "em", asOf, tradeDate \}\)/, "东财有可用读数就原样走 em：正常链路零变化");
  assert.match(route, /if \(kind === "stock"\) \{[\s\S]*?tdxMainFlowUniverse\(\)/, "自算只接个股榜");
  assert.match(route, /mainSelfComputed: true/, "自算行必须挂出身，不冒充东财官方读数");
  assert.match(route, /flow\.sampleComplete \? \{\} : \{ flowSampleTruncated: true \}/, "样本没取满的行自己声明截断");
  assert.match(route, /ratio: flow\.ratioPct \?\? Number\.NaN/, "成交额缺失 ⇒ NaN ⇒ 页面显「—」");
  assert.match(route, /const needThs = kind === "industry" \|\| kind === "concept"/, "地域仍无对等榜——缺就是缺");
  assert.match(route, /return NextResponse\.json\(\{ rows: rows \?\? null, source: null, asOf, tradeDate \}\)/, "递棒到底没有可用来源：返回 null 交页面显式声明");
  assert.match(route, /asOf = new Date\(\)\.toISOString\(\)/, "每种出身都带回取数完成时刻");
  // 2026-09-26 用户实测「周六 22:34 看到 15:33 的行情时刻，以为是假数」：
  // 只有时分秒的行情时刻必须配一个交易日，否则休市日会被读成「今天下午还在交易」。
  assert.match(route, /const tradeDate = await latestTradeDate\(\)\.catch\(\(\) => null\)/, "每种出身都带回最近交易日（行情源给的，不靠本地日历猜节假日）");
  assert.match(route, /source: "tdx", asOf, tradeDate, quoteTime: univ\.asOf \|\| null/, "自算榜的交易日与行情时刻一起交给页面");
});

test("数据看板砍掉演示回退：market.ts 不再产 demo 榜、也不再把兜底行喂回 buildDetail", () => {
  const mk = read("src/lib/desk/market.ts");
  assert.doesNotMatch(mk, /buildRanking\(/, "演示榜生成调用必须断根");
  assert.doesNotMatch(mk, /buildDetail\(/, "演示明细生成调用必须断根");
  assert.match(mk, /rows: \[\], origin: null, asOf: "", tradeDate: null, quoteTime: null/, "取不到就是空榜 + 出身 null + 交易日 null");
  assert.match(mk, /source: "real" \| "missing"/, "明细只有真数与 missing 两档，没有 demo");
  assert.match(mk, /cache: "no-store"/, "看板每次真取，不吃浏览器缓存的旧时刻");
});

test("页面口径：时间戳上屏、自算徽标、没取到的话说清楚，且全站不再出现「演示数据」这一档", () => {
  const page = read("src/components/desk/pages/BoardPage.tsx");
  assert.match(page, /<LiveStamp poll=\{poll\} iso=\{asOf\} \/>/, "看板的时间戳与倒计时走共用组件");
  assert.match(page, /行情时刻 \{quoteStamp\}/, "行情时刻带上交易日一起上屏（只有时分秒会被读成今天的行情）");
  assert.match(page, /const quoteStamp = tradeDate && quoteTime \? `\$\{tradeDate\} \$\{quoteTime\}`/, "交易日 + 行情时刻拼成一个戳");
  assert.match(page, /自算/, "主力净额列头挂自算徽标");
  assert.match(page, /MAIN_FLOW_BASIS/, "口径整句原样上屏，不缩成「自算」两个字");
  assert.match(page, /没取到：\{TABS\.find\(\(t\) => t\.key === kind\)\?\.label\}榜当前无可用数据源（不显示演示数据）/, "空榜说清楚是没取到");
  assert.doesNotMatch(page, /"real" \| "demo"|source === "demo"|演示数据（数据源暂不可用）/, "出身枚举里不许再有 demo");
  assert.match(page, /selected\.mainSelfComputed && !selected\.secid/, "自算行只在推不出东财 secid 时才断开明细联动");
  assert.match(page, /当日净额=通达信逐笔自算 · 近 14 日=东财历史（两端不同源，口径不逐分不差）/, "自算行取到真明细时，两端口径分开标出身，不合成一句「真实资金数据」");
  assert.match(page, /!Number\.isFinite\(r\.ratio\)/, "NaN 占比显「—」");
  assert.match(page, /截断/, "样本截断在行上有标记");
});

test("R16c 轮询收口：一个钩子一个戳，凡摆着股票实时数字的页都接上（休市暂停、开盘自恢复）", () => {
  const hook = read("src/hooks/use-live-poll.ts");
  assert.match(hook, /if \(!open\) return; \/\/ 休市：不建计时器/, "休市不打接口：上游本来不会有新数");
  assert.match(hook, /setPoll\(\(p\) => \(p\.left > 1 \?/, "倒计时与轮次一次 setState 推进：纯 updater，不在 setLeft 里套 setTick");
  assert.equal(/useRef\(/.test(hook), false, "钩子不靠 render 期写 ref（那是各页老写法留下的 lint 债）");
  assert.match(hook, /useDesk\(\(s\) => s\.refreshInterval\)/, "周期仍读用户设置，不硬编码");
  const stamp = read("src/components/desk/LiveStamp.tsx");
  assert.match(stamp, /数据截至 \$\{stamp\}/, "每个接了轮询的页都自带时刻");
  assert.match(stamp, /本次未取到数据/, "没时刻就说没取到，不显示 Invalid Date");
  assert.match(stamp, /自动刷新已暂停/, "休市状态上屏");
  for (const [f, why] of [
    ["src/components/desk/pages/BoardPage.tsx", "数据看板"],
    ["src/components/desk/pages/WatchlistPage.tsx", "自选股"],
    ["src/components/desk/pages/AllStocksPage.tsx", "全A列表"],
    ["src/components/desk/pages/SectorsPage.tsx", "板块排行"],
    ["src/components/desk/pages/MarketPage.tsx", "大盘情绪"],
    ["src/components/desk/pages/ProfilePage.tsx", "个股画像"],
    // R17b 补的三页：这两页摆的就是板块当日涨幅/主力净额，原来只有手动刷新按钮，放着不动会挂一整天
    ["src/components/desk/pages/ThemesPage.tsx", "主线发现"],
    ["src/components/desk/pages/ThemeOverviewPage.tsx", "主题血缘总览"],
    ["src/components/desk/pages/OverviewPage.tsx", "总览自选卡片"],
  ] as const) {
    const src = read(f);
    assert.match(src, /useLivePoll\(\)/, `${why}必须接全站轮询钩子`);
    assert.match(src, /poll\.tick/, `${why}的取数 effect 要跟着轮次重取`);
    assert.match(src, /clockZh|LiveStamp/, `${why}必须把取数时刻摆上屏（用户：分不清是哪天的数）`);
  }
  // 画像页轮询不许把用户已经生成的 AI 解读一起刷掉：keep 分支只换数据
  const profile = read("src/components/desk/pages/ProfilePage.tsx");
  assert.match(profile, /const load = useCallback\(async \(sym: string, keep = false\)/);
  assert.match(profile, /if \(!keep\) \{ setBusy\(true\); setError\(""\); setAiText\(""\)/, "只有手动生成才清掉已产出的解读");
  assert.match(profile, /if \(symbol && poll\.tick > 0\) load\(symbol, true\)/);
});

test("全A列表叠自算榜：东财没读数的地方用通达信逐笔补，补不上的还是「—」不是 0", () => {
  const page = read("src/components/desk/pages/AllStocksPage.tsx");
  assert.match(page, /Promise\.all\(\[fetchBoardRows\("stock", "in"\), fetchBoardRows\("stock", "out"\)\]\)/, "流入/流出两向都取，缺的那一侧才不会只剩红榜");
  assert.match(page, /r\.mainSelfComputed && Number\.isFinite\(r\.main\)/, "只收自算且有真读数的行");
  assert.match(page, /r\.main_net_yi == null \? \(\(\) => \{/, "东财有读数时仍用东财，自算只补空缺");
  assert.match(page, /没覆盖到的显「—」不是 0/, "页头说清覆盖范围与口径");
  assert.match(page, /MAIN_FLOW_BASIS/, "整句口径上屏（悬停 title 里也有）");
  assert.match(page, /setFlowByCode\(new Map\(\)\)/, "榜取不到就退回整列「—」，不拿旧值装新数");
});

test("行形状与显示核：新字段进共享类型，clockZh 归 R15 显示核（只换读法不改判定）", () => {
  const types = read("src/lib/desk/types.ts");
  assert.match(types, /mainSelfComputed\?: boolean;/);
  assert.match(types, /flowSampleTruncated\?: boolean;/);
  const plain = read("src/lib/desk/plain-core.ts");
  assert.match(plain, /export function clockZh\(iso: string \| null \| undefined\): string/);
  assert.match(plain, /if \(Number\.isNaN\(d\.getTime\(\)\)\) return ""/, "坏时刻返回空串，不摆 Invalid Date 上屏");
});

test("tdx-flow-core 保持零依赖纯核：node --test 直跑、可被服务端与钉测共用", () => {
  const core = read("src/lib/quant/screener/tdx-flow-core.ts");
  assert.equal(/^import\s/m.test(core), false, "纯核不许 import 任何东西");
  assert.equal(/from "@\//.test(core), false, "纯核不吃 @/ 别名（node ESM 解析不了）");
});
