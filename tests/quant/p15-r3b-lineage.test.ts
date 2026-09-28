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
  // 血缘卡页必须 import 统一组件；图表页（MarketPage 走 ChartCard）例外，但同样禁止 local 抄卡壳
  const ALL_PAGES = [
    MARKET, SECTORS, SCREENER,
    "src/components/desk/pages/FactorLabPage.tsx", "src/components/desk/pages/WatchlistPage.tsx",
    "src/components/desk/pages/ResearchPage.tsx", "src/components/desk/pages/AgentPage.tsx",
    "src/components/desk/pages/HistoryPage.tsx", "src/components/desk/pages/ProfilePage.tsx",
    "src/components/desk/pages/ThemeOverviewPage.tsx",
  ];
  const LINEAGE_PAGES = ALL_PAGES.filter((p) => p !== MARKET);
  for (const rel of ALL_PAGES) {
    const src = readSrc(rel);
    assert.ok(!/function (LineageCard|LineageSection|StatCard|Section)\s*\(/.test(src),
      `${rel} 里 local 重定义 = 组件开始漂移`);
  }
  for (const rel of LINEAGE_PAGES) {
    const src = readSrc(rel);
    assert.match(src, /from "\.\.\/ui\/LineageCard"/, `${rel} 应引用统一组件`);
  }
});

test("MarketPage：稳智同款图表页（ChartCard 多图 + 顶四卡），温度吃纯核、切行情不重取数", () => {
  const src = readSrc(MARKET);
  // 这是图表页（对齐稳智 /home），不是血缘卡页：五张图都走统一 ChartCard，不套 LineageCard
  assert.ok((src.match(/<ChartCard/g) || []).length >= 5, "成交额/5日线占比/涨跌停/连板梯队/指数 五张图都走统一 ChartCard");
  assert.match(src, /市场情绪分析/, "页头居中标题");
  // 温度吃同一份纯核、切行情只换权重不重取数
  assert.match(src, /import \{ computeTemperature, REGIMES, type MarketRegime \} from "@\/lib\/quant\/screener\/sentiment-temperature-core"/);
  assert.match(src, /useState<MarketRegime>\("range"\)/, "行情状态是纯前端态：切换只换权重、零重取数");
  assert.match(src, /title="行情状态只切换情绪温度的权重口径，不重新取数"/, "控件行写明切行情不重取数");
  // 五张图标题（稳智同款）
  for (const t of ["大盘成交额趋势", "大盘情绪（5日线占比）趋势", "涨跌停板分布对比", "连板梯队结构", "指数涨跌幅"]) {
    assert.match(src, new RegExp(`title="${t}"`), `图标题对齐稳智：${t}`);
  }
  // 宽度（5日线占比）独立链路：固定 30 天窗口、与成交额 90 天解耦
  assert.match(src, /fetchBreadth\(30\)/, "宽度走独立沉淀链路（30 天窗口）");
  // 诚实缺失：宽度攒不够就空置，不画假线
  assert.match(src, /breadthState: EChartState = breadthBusy && bMain\.length < 2 \? "loading" : bMain\.length >= 2 \? "ok" : "empty"/, "宽度不足 2 点就不画（loading/empty 不假线）");
});

test("SectorsPage：控制面板（Tab+排序+筛选）在标题行下方，卡内分节 统计→资金流向分布→数据", () => {
  const src = readSrc(SECTORS);
  assert.match(src, /actions=\{/, "标题行右侧动作区在（数据截至徽标）");
  // 2026-09-25：Tab 文案对齐稳智 /sectors「板块数据 / 概念数据」（行业→板块数据）
  assert.match(src, /\[\["industry", "板块数据"\], \["concept", "概念数据"\]\]/, "双 Tab 对齐稳智文案");
  // 2026-09-25（P47）：稳智同款控制面板——排序字段/方向 + 范围筛选 + 快速筛选 + 刷新/重置
  assert.match(src, /排序字段/, "排序字段下拉在控制面板里");
  assert.match(src, /快速筛选:/, "快速筛选（下跌/上涨/震荡）在控制面板里");
  assert.match(src, /重置筛选/, "重置筛选按钮在");
  assert.match(src, /<LineageSection title="统计" hint=\{`\$\{noun\}榜口径，缺读数显「—」不补 0`\}/);
  assert.match(src, /<LineageSection\s+title=\{`\$\{noun\}数据`\}/, "表格分节标题对齐稳智「板块数据/概念数据」");
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
