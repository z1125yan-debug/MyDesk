// P15-R7 同花顺兜底推广到 sectors/board 两路钉测（R6 只收了主线发现，行业·概念资金流页
// 与数据看板还吊在东财咽喉点上——断源日整页空白/只剩涨幅占位）。
//
// 红线：
//  1. 触发口径与 R6 一致：东财没数、或榜上全是腾讯涨幅占位时才整榜换同花顺；东财正常零变化；
//  2. 同花顺净额是真数（main 可入统计/画流向），但净占比/超大单/大单无该拆分 →
//     行上 breakdownMissing，页面这些列必须显「—」，不画占位 0；
//  3. THS 前缀码非东财 BK：成分股展开、去选股递棒、资金明细联动自然禁用，不跨系错接；
//  4. 个股/地域榜没有同花顺对等榜——维持原样，缺就是缺；
//  5. 三源全断的 502 话术必须点名同花顺（不许谎称只试过两家）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { thsToRankRow, type ThsBoardRow } from "../../src/lib/desk/ths.ts";

const SEC = readFileSync(new URL("../../src/app/api/market/sectors/route.ts", import.meta.url), "utf8");
const BRD = readFileSync(new URL("../../src/app/api/market/board/route.ts", import.meta.url), "utf8");
const SPG = readFileSync(new URL("../../src/components/desk/pages/SectorsPage.tsx", import.meta.url), "utf8");
const BPG = readFileSync(new URL("../../src/components/desk/pages/BoardPage.tsx", import.meta.url), "utf8");

const sample: ThsBoardRow = {
  code: "THS881164", name: "文化传媒", changePct: 3.15, inflowYi: 162.54,
  outflowYi: 129.86, netYi: 32.68, count: 85, leader: "智度股份", leaderPct: 10.04,
};

test("thsToRankRow：main 用真净额、secid 留空、breakdownMissing 置位", () => {
  const r = thsToRankRow(sample);
  assert.equal(r.main, 32.68, "同花顺净额是真数，不是腾讯式占位 0");
  assert.equal(r.secid, "", "无东财 secid：资金明细联动自然断掉，不跨系错接");
  assert.equal(r.code, "THS881164", "THS 前缀码非 BK 口径，去选股/成分股递棒自然禁用");
  assert.equal(r.breakdownMissing, true, "净占比/超大单/大单无拆分，必须带标记");
  assert.equal(r.ratio, 0);
  assert.equal((r as { fundsMissing?: boolean }).fundsMissing, undefined, "同花顺行不是腾讯占位，fundsMissing 不置");
});

test("sectors 路由：整榜三级兜底收进救援层，东财没数才换同花顺；三源全断 502 点名同花顺+MCP", () => {
  assert.match(SEC, /fetchBoardRowsRescuedV2/, "整榜三级兜底（东财→同花顺→MCP）收进统一救援层，路由只编排不重抄");
  assert.match(SEC, /东财榜单、腾讯兜底、同花顺资金流榜、MCP 板块榜均无返回/, "502 话术点名三源 + MCP（不是只试过两家）");
  assert.match(SEC, /source: sourceLabel/, "响应自报出身（由 rescue 层给的 origin 推导）");
  assert.match(SEC, /origin === "ths" \? "ths"/, "同花顺兜底时 origin 如实标 ths");
});

test("sectors 路由：换同花顺时 missing/note 登记口径差异，不冒充东财主力拆分", () => {
  // R21：不再对用户播报「某家断源」，改成自报这份榜本身的口径
  assert.match(SEC, /本榜为同花顺行业资金流榜，净额=流入−流出口径/);
  assert.match(SEC, /按涨幅取前 N，深跌净流出的概念可能不在榜/, "概念榜取榜深度缺口要写明");
  assert.match(SEC, /净额=流入−流出/, "note 说破同花顺净额口径（非东财主力净额拆分）");
});

test("board 路由：只给行业/概念两榜接同花顺，流入/流出按净额定向截断", () => {
  assert.match(BRD, /const needThs = kind === "industry" \|\| kind === "concept"/, "个股/地域无对等榜，维持缺就是缺");
  assert.match(BRD, /r\.netYi > 0\)\.sort\(\(a, b\) => b\.netYi - a\.netYi/, "流入向=净额>0 降序");
  assert.match(BRD, /r\.netYi < 0\)\.sort\(\(a, b\) => a\.netYi - b\.netYi/, "流出向=净额<0 升序");
  assert.match(BRD, /\.slice\(0, 30\)/, "与原 fetchBoardReal 默认 30 条同深度");
});

test("SectorsPage：同花顺出身行自报口径；表已精简到稳智 10 列（拆分三列移除）", () => {
  assert.match(SPG, /r\.breakdownMissing && !r\.fundsMissing/, "同花顺分支与腾讯占位互斥判定");
  assert.match(SPG, /同花顺板块资金流榜（净额=流入−流出，无净占比\/超大单\/大单拆分）/);
  // P48：板块表精简到稳智 10 列 → 净占比/超大单/大单三列的「—」分支随列一起移除；
  // 剩下的资金流向列仍守「不画占位 0」纪律（fundsMissing 显「—」）。
  assert.match(SPG, /board\.fundsMissing \? <span className="text-muted-foreground">—<\/span>/, "资金流向列仍守不画占位 0 纪律");
  assert.doesNotMatch(SPG, /board\.fundsMissing \|\| board\.breakdownMissing \? <span className="text-muted-foreground">—<\/span>/, "拆分三列已随精简移除");
  assert.match(SPG, /该板块代码非东财 BK 口径，无法解析成分池/, "去选股缺席提示（收进展开面板）");
});

test("BoardPage：同花顺横幅、占比列断拆分、明细联动禁用（不落演示数据）", () => {
  assert.match(BPG, /当前为同花顺板块资金流榜：净额=流入−流出，无净占比\/超大单拆分/);
  // P15-R16 起占比列多一道「NaN 也遮」（通达信自算行拿不到当日成交额时占比是 NaN，不 toFixed 出 NaN 上屏）
  assert.match(BPG, /r\.fundsMissing \|\| r\.breakdownMissing \|\| !Number\.isFinite\(r\.ratio\) \? "—"/, "占比列不画占位 0、也不把 NaN 摆上屏");
  // R16 又加一棒：自算行只有推不出东财 secid 时才断开联动（有 secid 时东财近 14 日历史仍取真数）。
  // 条件从此是「兜底两类 + 自算无 secid」，任一条件被去掉 = 那类无源行会去拉明细。
  assert.match(BPG, /selected\.fundsMissing \|\| selected\.breakdownMissing \|\| \(selected\.mainSelfComputed && !selected\.secid\)\) \{ setDetail\(null\)/, "无东财 secid 就不拉明细，绝不落回演示数据");
  assert.match(BPG, /同花顺兜底榜（净额口径，无东财资金明细）/);
});

test("旧钉兼容：腾讯兜底两页话术原样活着（同花顺是新增分支不是替换）", () => {
  assert.match(SPG, /腾讯板块榜（涨幅口径，不含主力资金读数）/);
  assert.match(BPG, /当前为腾讯板块兜底榜：涨幅口径，无主力资金读数/);
});
