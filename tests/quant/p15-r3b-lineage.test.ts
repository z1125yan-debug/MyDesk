// P15-R3b 页面血缘卡制·回归钉。
//
// 背景（对应用户所见）：页面上一块一块散着摆小卡，看不出谁跟谁是一回事。
// 稳智的结构是「一件事一张卡，卡内按血缘分小节」（analysis-layout → analysis-heading + analysis-section*）。
// 本轮口径：
//  - 卡结构抽成唯一组件源 ui/LineageCard.tsx（LineageCard / LineageSection / StatCard），
//    页面里再 local 定义同名组件 = 从这一刻起会漂，测试直接钉死；
//  - MarketPage / SectorsPage / ScreenerPage 把散卡按血缘归组——只换壳不动数据逻辑，
//    原有页面钉（p8/p9/p12 的口径字符串）必须原样活过重构，这里做双保险复钉；
//  - tone 色点用真实状态（出错=danger、提醒=warning、正常=info/success），不是装饰。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const LC = "src/components/desk/ui/LineageCard.tsx";
const MARKET = "src/components/desk/pages/MarketPage.tsx";
const SECTORS = "src/components/desk/pages/SectorsPage.tsx";
const SCREENER = "src/components/desk/pages/ScreenerPage.tsx";

test("组件唯一源：LineageCard/LineageSection/StatCard 都在 ui/LineageCard.tsx 里导出", () => {
  const src = readSrc(LC);
  for (const name of ["LineageCard", "LineageSection", "StatCard"]) {
    assert.match(src, new RegExp(`export function ${name}\\(`));
  }
  // tone 四色 + 渐变细线 + 折叠文案：结构同稳智 analysis-section，色点承载真实状态
  assert.match(src, /TONE_DOT: Record<SectionTone, string>/);
  assert.match(src, /danger: "bg-red-400\/70"/);
  assert.match(src, /bg-gradient-to-r from-transparent via-border to-transparent/);
  assert.match(src, /open \? "收起" : "展开"/);
  // StatCard 口径进 tooltip 不占版面（L2 说明收声的组件化）
  assert.match(src, /title=\{props\.title\}/);
});

test("页面不许再 local 定义同名卡组件：全仓库只认 ui/LineageCard 这一份实现", () => {
  // R3c 起清单加进 FactorLabPage（local Metric 小卡已退役换 StatCard）与 WatchlistPage；
  // R3d 再收进 Research/Agent/History/Profile 四页——Profile 原本 local `function Section` 是卡的重定义，
  // 从这一刻起禁止名单加了 Section，任何页面再抄一张壳 = 漂移。
  // R4：主题血缘总览页同样只准 import，不许 local 重定义。
  for (const rel of [
    MARKET, SECTORS, SCREENER,
    "src/components/desk/pages/FactorLabPage.tsx", "src/components/desk/pages/WatchlistPage.tsx",
    "src/components/desk/pages/ResearchPage.tsx", "src/components/desk/pages/AgentPage.tsx",
    "src/components/desk/pages/HistoryPage.tsx", "src/components/desk/pages/ProfilePage.tsx",
    "src/components/desk/pages/ThemeOverviewPage.tsx",
  ]) {
    const src = readSrc(rel);
    assert.match(src, /from "\.\.\/ui\/LineageCard"/, `${rel} 应引用统一组件`);
    assert.ok(!/function (LineageCard|LineageSection|StatCard|Section)\s*\(/.test(src),
      `${rel} 里 local 重定义 = 组件开始漂移`);
  }
});

test("MarketPage：五块散卡收成一张「盘面详情」，节标题齐、口径行原样在", () => {
  const src = readSrc(MARKET);
  assert.match(src, /title="盘面详情（逐项口径）"/);
  // 温度/梯队/资金榜三套口径互不冒充，写死在卡头 note 里
  assert.match(src, /温度是快照推导、梯队是收盘实数、资金榜是板块口径/);
  assert.match(src, /<LineageSection title="涨跌结构" divided=\{false\}/);
  assert.match(src, /<LineageSection title="情绪温度 · 分量加权" hint="与顶部监控卡同一份读数，切三态两边同步"/);
  assert.match(src, /<LineageSection title=\{`市场风险：\$\{sent\.risk\.level\}`\} tone=\{riskTone\(sent\.risk\.level\)\}/);
  assert.match(src, /<LineageSection title="涨停梯队" tone="warning"/);
  // （这节 title/actions 分行写，钉 `title="行业资金流入榜"` 本体即可）
  assert.match(src, /title="行业资金流入榜"/);
  // 风险色点是状态映射不是字符串比较残留（高风险=danger）
  assert.match(src, /const riskTone = \(level: string\)/);
  assert.match(src, /"高风险" \? "danger"/);
  // 顶部监控四卡是「3 秒看懂」层，没收进详情卡——两盘各管各的，重构不许把它们吞了
  assert.equal(src.match(/<LineageCard/g)?.length, 1, "情绪页只有一张详情大卡");
});

test("SectorsPage：标题行=控制面板（Tab+刷新进 actions），卡内分节 提醒→统计→排行", () => {
  const src = readSrc(SECTORS);
  assert.match(src, /actions=\{/);
  assert.match(src, /\[\["industry", "行业"\], \["concept", "概念"\]\]/, "双 Tab 原样在，只是搬进标题行");
  assert.match(src, /<LineageSection title="数据提醒" tone=\{error \? "danger" : "warning"\}/, "出错红、提醒橙，不是恒灰");
  assert.match(src, /<LineageSection title="统计" hint=\{`\$\{noun\}榜口径，缺读数显「—」不补 0`\}/);
  assert.match(src, /<LineageSection title=\{`\$\{noun\}排行`\}/);
  // 五张聚合卡走统一 StatCard（一焦点数字 + 口径进 tooltip）
  assert.equal(src.match(/<StatCard/g)?.length, 1, "统计卡由 StatCard 一处渲染");
  assert.match(src, /cards\.map\(\(c, i\) => \(\s*<StatCard key=\{i\}/);
  // p12 核心口径复钉：缺读数显「—」不抄聚合、空态跟 Tab 走
  assert.match(src, /st\.mainSumYi === null \? "—"/);
  assert.match(src, /暂无\{noun\}数据/);
});

test("ScreenerPage：加条件/当前条件两张散卡合成一条决策链，p9 缺口口径原样活过重构", () => {
  const src = readSrc(SCREENER);
  assert.match(src, /title="AI 选股 · 条件与执行"/);
  assert.match(src, /<LineageSection title="加条件"/);
  assert.match(src, /<LineageSection title="当前条件"/);
  // p9-screener-gap 的四条钉复钉——重构只动条件区两张卡，结果区醒目提示一个字不许碰
  assert.match(src, /result\.unavailable_fields\?\.length/);
  assert.match(src, /因数据缺口被忽略/);
  assert.match(src, /这不是「没有股票符合条件」/);
  assert.match(src, /没有符合条件的股票，试试放宽条件。/);
});
