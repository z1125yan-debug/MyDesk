// P12 板块打通轮：行业/概念双 Tab + 「去选股」出口 + 统计行 — 2026-09-22
// 背景：稳智《行业板块页》逆向的核心结论——「板块是选股的入口，不是看板的终点」。
// 本轮打通三件事：①板块页一键切行业/概念（换数据源换文案）；②每行「去选股」把股票池
// 切到该板块成分并自动跑一轮（store 一次性交接，与 focusSector 同手法）；③顶部统计行 5 卡。
// 统计行是聚合口径不是新读数：广度用「上涨/下跌板块数」替代稳智的个股家数（数据源不含
// 板块广度字段，missing 早就列明），主力资金遇腾讯兜底占位 0 混榜则合计整体显「—」。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aggregateSectors, type SectorAggRow } from "../../src/lib/quant/screener/sector-stats-core.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------------- 纯核：aggregateSectors ---------------- */

const row = (changePct: number, main: number, fundsMissing = false): SectorAggRow => ({ changePct, main, fundsMissing });

test("空榜不硬造：全 null + 说明，不出现 0.0% 的平均涨跌幅", () => {
  const st = aggregateSectors([]);
  assert.equal(st.count, 0);
  assert.equal(st.avgChangePct, null);
  assert.equal(st.mainSumYi, null);
  assert.match(st.mainMissingNote, /榜单为空/);
});

test("正常聚合：均值一位小数、涨跌按符号计数、平盘两边都不算", () => {
  const st = aggregateSectors([row(2, 3), row(-1, -2), row(0, 0), row(3, 1)]);
  assert.equal(st.count, 4);
  assert.equal(st.avgChangePct, 1); // (2-1+0+3)/4 = 1
  assert.equal(st.upBoards, 2);
  assert.equal(st.downBoards, 1);
  assert.equal(st.mainSumYi, 2);
  assert.equal(st.mainMissingNote, "");
});

test("占位 0 不可入合计：混进一条腾讯兜底行，主力合计整体 null 并点名条数", () => {
  const st = aggregateSectors([row(1, 5), row(2, 0, true), row(-1, 3)]);
  assert.equal(st.mainSumYi, null, "半真半假的合计比没有合计更坏——整体不出数");
  assert.match(st.mainMissingNote, /1\/3 条来自腾讯兜底榜/, "缺口说明要能指认污染面");
  // 涨幅列不受资金断源影响，照常聚合
  assert.equal(st.avgChangePct, 0.7);
});

test("舍入口径：均值与合计都是 r1（一位小数），不漂出假精度", () => {
  const st = aggregateSectors([row(1.25, 0.14), row(1.24, 0.14)]);
  assert.equal(st.avgChangePct, 1.2); // 1.245 → r1 = 1.2（half-up 于 1.245 的浮点表示）
  assert.equal(st.mainSumYi, 0.3);
});

/* ---------------- 接线钉：选股侧承接 ---------------- */

const runSrc = read("../../src/lib/quant/screener/run.ts");
const quantApi = read("../../src/lib/desk/quant-api.ts");
const storeSrc = read("../../src/lib/desk/store.ts");
const scanPage = read("../../src/components/desk/pages/AiScanPage.tsx");
const secPage = read("../../src/components/desk/pages/SectorsPage.tsx");

test("screener 后端认得概念板：UniverseSpec 扩 concept 且 kind 透传给数据源（不再写死 industry）", () => {
  assert.match(runSrc, /\{ kind: "industry" \| "concept"; boardCode: string \}/, "股票池形状与 em-provider listUniverse 对口");
  assert.match(runSrc, /provider\.listUniverse\(\{ kind: spec\.kind, boardCode: spec\.boardCode \}/,
    "kind 必须透传——写死 industry 会把概念板静默按行业解析");
  assert.match(quantApi, /universe\?: "all_a" \| "hs_a" \| \{ kind: "watchlist"; symbols: string\[\] \} \| \{ kind: "industry" \| "concept"; boardCode: string \}/,
    "客户端请求体同一形状");
});

test("store 交接一次性：scanBoard 读完即清、不持久化（与 focusSector 同纪律）", () => {
  assert.match(storeSrc, /takeScanBoard: \(\) => \{\s*const b = get\(\)\.scanBoard;\s*if \(b\) set\(\{ scanBoard: null \}\);\s*return b;\s*\}/);
  // 交接态不进 partialize：刷新后还自动开一轮板块选股是行为诡异，不是功能
  const part = storeSrc.slice(storeSrc.indexOf("partialize:"));
  assert.ok(!part.slice(0, 2000).includes("scanBoard"), "partialize 白名单里不能有 scanBoard");
});

test("AiScanPage 接棒：拿棒即清、微任务延后再跑（effect 体不同步 setState）、池形态带 kind+boardCode", () => {
  assert.match(scanPage, /const b = takeScanBoard\(\);\s*if \(b\) void scan\(\{ kind: b\.kind, boardCode: b\.code \}, boardLabel\(b\.kind, b\.name\)\);/,
    "带票进场自动跑一轮「池=板块成分」的空条件筛选（不替用户猜量价条件）");
  assert.match(scanPage, /type UniSpec = "all_a" \| "hs_a" \| \{ kind: "watchlist"; symbols: string\[\] \} \| \{ kind: "industry" \| "concept"; boardCode: string \}/);
  assert.match(scanPage, /boardTakeOnce\.current = true/, "双挂载只真跑一次");
  assert.match(scanPage, /当前股票池：\{universeLabel\} 板块成分/, "池被换过必须明示，不能让用户以为筛的是全A");
  assert.match(scanPage, /=> void scan\("all_a", "全A"\)/, "给出回全A的出口");
});

/* ---------------- 接线钉：板块页侧 ---------------- */

test("双 Tab 换榜：数据源带 kind、成分股带 kind、文案随 Tab 切换", () => {
  assert.match(secPage, /const \[kind, setKind\] = useState<BoardKind>\("industry"\)/);
  assert.match(secPage, /fetch\(`\/api\/market\/sectors\?kind=\$\{kind\}`\)/, "榜单按 Tab 取");
  assert.match(secPage, /fetch\(`\/api\/market\/sectors\/\$\{encodeURIComponent\(code\)\}\?kind=\$\{kind\}`\)/,
    "成分股也要带 kind——概念板展开不走行业口径");
  assert.match(secPage, /\{kind === "concept" \? "概念板块排行" : "行业板块排行"\}/);
  assert.match(secPage, /暂无\{noun\}数据/, "空态文案跟着换（稳智同款一字之差）");
  assert.match(secPage, /if \(k === kind\) return;[\s\S]*?setKind\(k\); closeBoard\(\); setJump\(null\); setList\(null\);/,
    "切 Tab 清上一张榜的展开/跳转/榜单态，不把 A 榜成分挂到 B 榜行下");
});

test("统计行走纯核聚合：页面不抄聚合逻辑、缺读数显「—」不显 0", () => {
  assert.match(secPage, /import \{ aggregateSectors \} from "@\/lib\/quant\/screener\/sector-stats-core"/);
  assert.match(secPage, /st\.mainSumYi === null \? "—"/, "主力合计不可信时显「—」");
  assert.match(secPage, /上涨\{noun\}数|`上涨\$\{noun\}数`/, "广度卡是板块口径（数据源无个股家数，不冒充稳智原口径）");
  assert.ok(!/sum\(.*up_count|upCount/.test(secPage), "不许凭空引入不存在的板块广度字段");
});

test("「去选股」出口：BK 码才给按钮、点击 stopPropagation、递棒切页", () => {
  assert.ok(secPage.includes("const canScreen = (code: string) => /^BK\\d{4}$/i.test(code)"),
    "腾讯兜底榜代码非东财 BK 口径——按钮如实缺席，不是点了再炸一句「板块代码非法」");
  assert.match(secPage, /e\.stopPropagation\(\); onScreen\(\)/, "去选股不该顺手展开成分股面板");
  assert.match(secPage, /setScanBoard\(\{ code: b\.code, name: b\.name, kind \}\);\s*go\("aiscan"\)/, "棒子带 kind，收口在 store 一处");
});
