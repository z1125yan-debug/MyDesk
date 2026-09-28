// P15-R4 主题血缘总览页·回归钉。
//
// 这一轮是 R3d 纠偏后真正落地的东西：用户指着稳智「主题热点」那张图说——
// 「我们基本上都有，但都是分散开的……把各个分散的菜单放到一张菜单里的总览去看，按血缘顺序。」
// 于是新建「主题血缘总览」页：左选主题，右按血缘读完整一条故事。
// 本页红线（用户拍板「能真算的真算，算不出显暂无数据不造」）：
//  - 只吃既有真实接口（fetchThemes/fetchRisk/fetchEvents），不为凑图新建纯核、不造后端；
//  - 无数据源的参考维度（3日资金/3日涨跌/MA20占比/人气集中度）显式标缺，不拿相近字段冒充；
//    （R5 之后：热度/置信/次日风险/追-避 已用 theme-rules 透明规则读数「自主模仿」出来，见 p15-r5 钉）；
//  - 不做行业/概念 Tab、不做日期选择器（数据口径不支持，摆了就是假控件）；
//  - 「去选股」递棒沿用板块页 BKxxxx「宁缺不假」闸，代码/归属不可用就不出按钮。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const PAGE = "src/components/desk/pages/ThemeOverviewPage.tsx";
const TYPES = "src/lib/desk/types.ts";
const NAV = "src/lib/desk/nav-core.ts";
const SHELL = "src/components/desk/AppShell.tsx";
const RULES = "src/lib/quant/screener/theme-rules.ts";
const THEMES = "src/lib/quant/screener/themes.ts";
const API = "src/lib/desk/quant-api.ts";

test("路由接线：themeoverview 进 PageKey 全集 + 标题 + 渲染分支 + 隐藏页一处登记", () => {
  const types = readSrc(TYPES);
  assert.match(types, /"themeoverview"/, "PageKey 要有 themeoverview");
  assert.match(types, /themeoverview:\s*"主题血缘总览"/, "PAGE_TITLES 要有中文标题");
  const shell = readSrc(SHELL);
  assert.match(shell, /import ThemeOverviewPage from "\.\/pages\/ThemeOverviewPage"/, "AppShell 要 import 本页");
  assert.match(shell, /page === "themeoverview" && <ThemeOverviewPage \/>/, "AppShell 要有渲染分支");
  // 2026-09-25 用户拍板：稳智把「主题热点」放在 LLM分析 的 Tab 里（不是独立菜单项），
  // 本页也从菜单移除、只留 hash 直达——登记在 HIDDEN_PAGES 里（防漏页对账），不再占菜单位。
  const nav = readSrc(NAV);
  assert.match(nav, /HIDDEN_PAGES[\s\S]*?"themeoverview"/, "nav-core 把 themeoverview 登记为隐藏页（从菜单移除、只留 hash 直达）");
});

test("kind 透传：纯核输入带 kind、装配处填 _kind、客户端类型对齐（去选股递棒才递得动）", () => {
  assert.match(readSrc(RULES), /kind\?:\s*"industry" \| "concept"/, "ThemeScoreInput 要有可选 kind（additive，评分不读它）");
  assert.match(readSrc(THEMES), /streakInflow: streakIn,\s*kind: r\._kind,/, "装配 ThemeScoreInput 时把 _kind 填进 kind");
  assert.match(readSrc(API), /kind\?:\s*"industry" \| "concept"/, "ThemeRowClient 要有可选 kind 与服务端对齐");
});

test("只吃既有接口、三路并进；主角挂了配角仍显示（不新造数据源）", () => {
  const src = readSrc(PAGE);
  assert.match(src, /Promise\.allSettled\(\[fetchThemes\(force\), fetchRisk\(\), fetchEvents\(\)\]\)/,
    "三路并进：主题榜=主角，环境/新闻=配角");
  assert.match(src, /import \{[^}]*fetchThemes[^}]*fetchRisk[^}]*fetchEvents[^}]*\} from "@\/lib\/desk\/quant-api"/,
    "三个接口都从 quant-api 现读，不在本页另发 fetch");
});

test("血缘顺序钉死：市场环境→关键数字→全字段→判定理由→新闻证据→分层与策略结论（主题+入口在卡头）", () => {
  const src = readSrc(PAGE);
  const order = [...src.matchAll(/<LineageSection title="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["市场环境", "关键数字", "全字段展开", "判定理由", "新闻证据", "分层与策略结论"],
    "小节必须按这条血缘顺序排，且只有一张卡的骨架");
  // 「主题 + 入口」= 卡头标题 + 「查看该主题个股」动作，不单列小节
  assert.match(src, /查看该主题个股/, "入口按钮在卡头 actions");
  assert.equal(src.match(/<LineageCard/g)?.length, 1, "整页只有一张血缘大卡");
});

test("诚实缺失：无数据源维度显式标缺、不冒充；AI 综述暂无、次日风险非概率（R5 后口径）", () => {
  const src = readSrc(PAGE);
  assert.match(src, /不臆测、不拿相近字段顶替/, "缺数说明在页面上");
  // R5 之后：置信度/次日风险已改为「自主模仿的透明规则读数」，无源清单里只留真正没源的维度
  assert.match(src, /3日资金 · 3日涨跌 · 站上MA20占比（主题口径）· 人气集中度/, "逐条列出仍无源的维度");
  assert.doesNotMatch(src, /人气集中度 · 置信度/, "置信度已实现为规则读数，不该再挂在无源清单里");
  assert.match(src, /AI 综述：暂无/, "无存档研究就不写 AI 综述");
  assert.match(src, /不等于/, "规则版读数 ≠ 稳智原版 rising/avoid/次日风险分");
  assert.match(src, /rising\/avoid/, "点名仿的是稳智那套标签");
  assert.match(src, /不是?明日涨跌概率|不等于\s*<\/span>\s*稳智|更不是明日涨跌概率/, "次日风险必须声明非涨跌概率");
  // 缺数兜底走显式「暂无数据」，不补 0、不画横杠蒙人
  assert.match(src, /return v === null \|\| v === undefined \|\| !isFinite\(v\) \? "暂无数据"/);
});

test("不做假控件：无日期选择器、无行业/概念 Tab（fetchThemes 是合并榜且不吃日期）", () => {
  const src = readSrc(PAGE);
  assert.doesNotMatch(src, /type="date"/, "不摆日期选择器——主线发现按当下快照重算，点了没反应就是假控件");
  assert.doesNotMatch(src, /\[\["industry", "行业"\], \["concept", "概念"\]\]/, "不摆行业/概念双 Tab——榜是合并的");
});

test("去选股递棒：BKxxxx + 带 kind 才出按钮，否则「宁缺不假」不出", () => {
  const src = readSrc(PAGE);
  assert.match(src, /\^BK\\d\{4\}\$\/i\.test\(selected\.code\)/, "沿用板块页同一 BK 代码闸");
  assert.match(src, /!!selected\?\.kind/, "归属缺失也不出按钮");
  assert.match(src, /setScanBoard\(\{ code: selected\.code, name: selected\.name, kind: selected\.kind! \}\)/, "递棒带上行业/概念归属");
  assert.match(src, /go\("aiscan"\)/, "递到 AI 选股（store.go 会收口到 quant 门户）");
  assert.match(src, /暂不可去选股/, "不可用时给的是说明态不是坏按钮");
});

test("断源诚实：腾讯兜底榜占位 0 主力不当实数（走查正逢东财 push2 断源逼出的这条）", () => {
  const src = readSrc(PAGE);
  assert.match(src, /data\.missing\.some\(\(m\) => m\.includes\("主力净额"\)\)/, "从发现接口的缺失登记判资金不可信");
  assert.match(src, /\/腾讯板块兜底\/\.test\(data\.source\.provider\)/, "来源串兜底命中也算断源");
  assert.match(src, /value=\{fundsMissing \? null : t\.mainYi\}/, "左榜主力断源显「—」不是 0.0");
  assert.match(src, /今日主力净额" value=\{fundsMissing \? "暂无数据"/, "关键数字主力断源显暂无");
  // R21：不再对用户播报「某家断源」，改成说清这份榜本身不含资金读数
  assert.match(src, /\["今日主力净额", fundsMissing \? "暂无数据（该榜不含资金读数）"/, "全字段展开同样不画占位 0");
});

test("本页只 import 血缘组件，不 local 重定义（与 R3b 单源纪律一致）", () => {
  const src = readSrc(PAGE);
  assert.match(src, /from "\.\.\/ui\/LineageCard"/);
  assert.ok(!/function (LineageCard|LineageSection|StatCard|Section)\s*\(/.test(src), "local 重定义 = 漂移");
});
