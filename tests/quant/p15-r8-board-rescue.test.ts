// P15-R8 钉测：板块榜兜底收口纯核（board-rescue-core）+ 五处消费方接线口径。
// 与 R6/R7 同一把尺子：触发条件、不串源、出身换标签、占位 0 不装真数——全部钉在源码形状上，
// node --test 直跑，零 IO。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  thsToBoardRow, needsThsRescue, pickThsSide, rescuableKind,
  boardRescueSourceNote, boardRowsFromThs,
} from "../../src/lib/quant/screener/board-rescue-core.ts";
import type { ThsBoardRow } from "../../src/lib/desk/ths.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const thsRow = (over: Partial<ThsBoardRow> = {}): ThsBoardRow => ({
  code: "THS881164", name: "文化传媒", changePct: 3.15, inflowYi: 52.1, outflowYi: 19.42,
  netYi: 32.68, count: 86, leader: "智度股份", leaderPct: 9.98, ...over,
});

test("同花顺行 → 榜行形状：main 是真净额，secid 留空 + THS 前缀码 + breakdownMissing（不串东财明细）", () => {
  const r = thsToBoardRow(thsRow());
  assert.equal(r.main, 32.68);
  assert.equal(r.secid, "", "secid 留空：东财资金明细/日K按空 secid 自然落无数据分支");
  assert.match(r.code, /^THS/, "代码必须带 THS 前缀，与东财 BK 码物理隔离");
  assert.equal(r.breakdownMissing, true);
  assert.equal(r.fundsMissing, undefined, "同花顺 main 是真数，不打腾讯那种 fundsMissing");
});

test("触发口径与 R6/R7 一致：null/空榜/整榜腾讯占位才换源；混榜不误伤，东财正常零改动", () => {
  assert.equal(needsThsRescue(null), true);
  assert.equal(needsThsRescue([]), true);
  assert.equal(needsThsRescue([{ fundsMissing: true }, { fundsMissing: true }]), true, "整榜占位 0 ⇒ 换");
  assert.equal(needsThsRescue([{ fundsMissing: true }, {}]), false, "混进一条东财真数行 ⇒ 不换（半真半假的嫁接才会对错账）");
  assert.equal(needsThsRescue([{ main: 1 } as never]), false, "东财正常：一行都不碰");
});

test("只救行业/概念两榜：个股/地域无同花顺对等榜，缺就是缺", () => {
  assert.equal(rescuableKind("industry"), true);
  assert.equal(rescuableKind("concept"), true);
  assert.equal(rescuableKind("stock"), false);
  assert.equal(rescuableKind("region"), false);
});

test("in/out 按净额正负拆分侧：0 行是真没有，排序按净额大小，深度受 size 截断", () => {
  const rows = [
    thsRow({ code: "THSA", name: "A", netYi: 10 }),
    thsRow({ code: "THSB", name: "B", netYi: -30 }),
    thsRow({ code: "THSC", name: "C", netYi: 50 }),
    thsRow({ code: "THSD", name: "D", netYi: 0 }),
  ];
  const inRows = pickThsSide(rows, "in", 30);
  assert.deepEqual(inRows.map((r) => r.code), ["THSC", "THSA"], "流入向按净额降序，0 与负数不入");
  assert.deepEqual(pickThsSide(rows, "out", 30).map((r) => r.code), ["THSB"]);
  assert.equal(pickThsSide(rows, "in", 1).length, 1, "size 截断与原 fetchBoardReal 深度对齐");
});

test("出身文案自报口径差异：净额=流入−流出、无拆分、按涨幅取榜的取数偏差都在话术里", () => {
  const note = boardRescueSourceNote("industry");
  assert.match(note, /同花顺行业资金流榜/);
  assert.match(note, /净额=流入−流出/);
  assert.match(note, /无净占比\/超大单\/大单拆分/);
  assert.match(note, /榜按涨幅排序取，深跌净流出的板块可能不在榜/);
  assert.match(boardRescueSourceNote("concept"), /同花顺概念资金流榜/);
});

test("整榜出身判定只看代码前缀：有一行 THS 就不是纯东财数，引用方必须换 source", () => {
  assert.equal(boardRowsFromThs([{ code: "THS881164" }, { code: "BK0448" }]), true);
  assert.equal(boardRowsFromThs([{ code: "BK0448" }]), false);
  assert.equal(boardRowsFromThs(null), false);
});

test("薄壳单点入口：五处消费方全部改走 fetchBoardRowsRescued，不再各自裸调 fetchBoardReal", () => {
  const shell = read("src/lib/desk/board-rescue.ts");
  assert.match(shell, /needsThsRescue\(rows\)/, "触发判定调纯核，不在壳里重写第二套");
  assert.match(shell, /rescuableKind\(kind\)/, "个股/地域在壳里就被挡回原样");
  for (const f of [
    "src/lib/desk/chat-tools.ts",
    "src/lib/quant/screener/agent-tools.ts",
    "src/lib/quant/screener/events.ts",
    "src/lib/quant/screener/research.ts",
    "src/app/api/stock/profile/route.ts",
  ]) {
    assert.match(read(f), /fetchBoardRowsRescued/, `${f} 必须走收口入口`);
    assert.doesNotMatch(read(f), /fetchBoardReal\(/, `${f} 不许再留裸 fetchBoardReal 调用（页面两路 R7 已各自收口）`);
  }
});

test("占位 0 不装真数：对话工具腾讯行报 null、台账资金排序剔除占位行、画像 mainYi 可 null", () => {
  assert.match(read("src/lib/desk/chat-tools.ts"), /主力净额亿: r\.fundsMissing \? null : r\.main/);
  const res = read("src/lib/quant/screener/research.ts");
  assert.match(res, /main: r\.fundsMissing \? null : r\.main/, "占位 0 进 merged 前就剔除，不冒充「主力 0.0 亿」参与排序");
  assert.match(res, /资金读数缺（兜底榜无主力资金）/);
  assert.match(read("src/app/api/stock/profile/route.ts"), /mainYi: row\.fundsMissing \? null : row\.main/);
});

test("出身标签跟着真实来源走：同花顺批次不写东财 source（对话/台账/画像/事件四处）", () => {
  assert.match(read("src/lib/desk/chat-tools.ts"), /同花顺板块资金流榜（东财断源兜底：净额=流入−流出，非东财主力拆分口径）/);
  assert.match(read("src/lib/quant/screener/agent-tools.ts"), /同花顺板块资金流榜（东财断源兜底，本机直连；净额=流入−流出）/);
  assert.match(read("src/app/api/stock/profile/route.ts"), /同花顺行业资金流榜（东财断源兜底，净额口径）/);
  // 事件链路：换源信息经 fetchBoardContext 的 missing 自报（验证台按同花顺净额口径核对）
  assert.match(read("src/lib/quant/screener/events.ts"), /板块资金为同花顺净额榜（流入−流出）/);
});

test("Agent 台账同花顺批次降格 DEGRADED 且无拆分口径的净占比不报 0.0%", () => {
  const src = read("src/lib/quant/screener/agent-tools.ts");
  assert.match(src, /data_status: fromThs \? "DEGRADED" : "REAL"/, "兜底批次不能顶着东财 REAL 头名");
  assert.match(src, /无该口径读数/, "净占比列：同花顺/腾讯行如实说没有，不印 0.0%");
});

test("研究采集 sector_rank：两侧都断时的空态话术包含同花顺兜底亦无返回", () => {
  const res = read("src/lib/quant/screener/research.ts");
  assert.match(res, /in\/out 两侧都为 null，同花顺兜底亦无返回/);
  assert.match(res, /榜单口径：\$\{fromThs \? "同花顺行业资金流榜（净额=流入−流出），非证监会分类" : "东财行业板块，非证监会分类"\}/,
    "统计行里的口径括号跟着真实来源走");
});

test("em.ts 不动清单：breakdownMissing 以纯核扩展表达，BoardRow 本体一字未改", () => {
  // \r?\n：autocrlf=true 的机器上 checkout 出来就是 CRLF，形状断言不依赖行尾写法（同 p8 钉的教训）
  assert.match(read("src/lib/desk/em.ts"), /fundsMissing\?: boolean;\r?\n\}/, "BoardRow 末尾仍是 fundsMissing 即止（未加 R8 字段）");
  assert.match(read("src/lib/quant/screener/board-rescue-core.ts"), /interface RescueRow extends BoardRow/);
});
