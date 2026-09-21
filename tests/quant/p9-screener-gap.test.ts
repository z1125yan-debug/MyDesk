// P9-经验轮：选股「字段缺失 ≠ 没有符合」显式化 回归测试。
//
// 背景（对应用户所见）：东财资金数据断源兜底期，mainNet 全市场无读数；
// 「主力净流入>0」这类条件进粗筛会把 5565 只全判不符合，页面只显示「无命中结果/
// 没有符合条件的股票」——把数据缺口伪装成筛不出来，用户无从知道哪里出了问题。
// 本轮口径：
//  - 快照条件先过字段可得性预检（纯核 snapshot-avail-core）：整池无读数的条件剔除并登记；
//  - 剔除后没有任何条件可评 → 结果空 + 「未评」告警，绝不把整池未筛名单当命中结果；
//  - 缺口以 unavailable_fields 机器可读随响应返回，前端（ScreenerPage/AiScanPage）强提示，
//    工具环（factor_screener）带转述要求——模型不许把缺口说成「没有股票符合该条件」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { partitionUnavailableSnapConds } from "../../src/lib/quant/screener/snapshot-avail-core.ts";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

type Meta = { mainNet?: number | null; changePct?: number | null };
const valueOf = (m: Meta, field: string): number | null =>
  field === "main_net_yi" ? m.mainNet ?? null : field === "change_pct" ? m.changePct ?? null : null;

test("纯核：整池无读数的字段条件被剔除并登记缺口（含池大小），可评条件保持原顺序", () => {
  const metas: Meta[] = [{ changePct: 3 }, { changePct: -1 }, { changePct: 0 }]; // mainNet 全缺
  const conds = [
    { field: "main_net_yi" }, { field: "change_pct" }, { field: "main_net_yi" }, // 同字段多条件
  ];
  const r = partitionUnavailableSnapConds(conds, metas, valueOf);
  assert.deepEqual(r.usable, [{ field: "change_pct" }]);
  assert.deepEqual(r.unavailable, [{ field: "main_net_yi", total: 3 }]); // 按字段聚合只登记一次
});

test("纯核：只要有一只取到读数就按「字段可得」处理（个别缺失仍由粗筛逐只判，不整体剔除）", () => {
  const metas: Meta[] = [{ mainNet: null, changePct: 1 }, { mainNet: 0.5, changePct: 2 }];
  const r = partitionUnavailableSnapConds([{ field: "main_net_yi" }], metas, valueOf);
  assert.equal(r.usable.length, 1);
  assert.equal(r.unavailable.length, 0);
});

test("纯核：全可得时零扰动；空池不炸（池空由上层另行报错）", () => {
  const metas: Meta[] = [{ mainNet: 2, changePct: 5 }];
  const r = partitionUnavailableSnapConds([{ field: "main_net_yi" }, { field: "change_pct" }], metas, valueOf);
  assert.equal(r.usable.length, 2);
  assert.equal(r.unavailable.length, 0);
  assert.deepEqual(partitionUnavailableSnapConds([{ field: "main_net_yi" }], [], valueOf).unavailable, [{ field: "main_net_yi", total: 0 }]);
});

test("接线：runScreener 消费纯核、响应带 unavailable_fields、条件被忽略光时空结果标「未评」不出整池", () => {
  const src = readSrc("src/lib/quant/screener/run.ts");
  assert.match(src, /partitionUnavailableSnapConds\(snapConds, metas, snapshotValue\)/);
  assert.match(src, /unavailable_fields: unavailableFields/);
  // nothingEvaluated：全部条件被忽略 → 粗筛强制空池（不把 5000+ 只未筛名单冒充命中）并显式「未评」
  assert.match(src, /const nothingEvaluated = conditions\.length > 0 && snapCondsUsable\.length === 0 && klineConds\.length === 0/);
  assert.match(src, /const snapshotPass = nothingEvaluated \? \[\] : metas\.filter/);
  assert.match(src, /结果为空是「未评」，不是「无标的符合」/);
  // 告警文案必须拆穿「缺失 vs 为 0」的伪装
  assert.match(src, /不是「值为 0」/);
});

test("工具环：factor_screener 把缺口与转述要求原样交给模型（禁止转述成「没有股票符合」）", () => {
  const src = readSrc("src/lib/desk/chat-tools.ts");
  assert.match(src, /result\.unavailable_fields\.length/);
  assert.match(src, /本轮被忽略的条件字段/);
  assert.match(src, /禁止把这说成「没有股票符合该条件」/);
});

test("前端：ScreenerPage 空结果不再甩锅「放宽条件」，缺口单独醒目提示", () => {
  const src = readSrc("src/components/desk/pages/ScreenerPage.tsx");
  assert.match(src, /result\.unavailable_fields\?\.length/);
  assert.match(src, /因数据缺口被忽略/);
  assert.match(src, /这不是「没有股票符合条件」/);
  // 无缺口的正常空结果文案原样保住（两态可分才说明本轮不是把提示一刀切）
  assert.match(src, /没有符合条件的股票，试试放宽条件。/);
});

test("前端：AiScanPage 缺口醒目块 + 重复告警不双刷（callout 覆盖的字段不再走行级 warning）", () => {
  const src = readSrc("src/components/desk/pages/AiScanPage.tsx");
  assert.match(src, /以下条件在当前数据源没有任何真实读数/);
  assert.match(src, /w\.includes\(`「\$\{g\.zh\}」`\)/);
});

test("出身诚实：兜底期选股响应 provider 不冒充东财口径（universeSource 三元，与 sentiment/limitup 同纪律）", () => {
  const src = readSrc("src/lib/quant/screener/run.ts");
  assert.match(src, /universeSource\(\) === "tc"/);
  assert.match(src, /腾讯批量快照兜底（东财 clist 断源；K线走 eltdx\/腾讯日K）/);
});
