// E2 钉测：主力净额「两页打架」的根因是各自算各自的口径。
// 修法：所有页面都走同一个纯核 main-net-core（单真理源），并且卡面必须把子集范围写清楚。
// 这里钉两件事：① 纯核永远带 label（不会冒出个裸数字让人误以为是全市场合计）；
// ② RiskPage / ResearchPage / ThemeOverviewPage 都从 main-net-core 取数（同源），
//    且 BoardPage 的资金去向榜明确写「板块」二字，不与全市场个股净额混为一谈。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mainNetDisplay, type SentimentMainNetLike } from "../../src/lib/desk/main-net-core.ts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

test("E2 纯核：两个源都能给出带子集标注的口径，不裸奔成全市场合计", () => {
  const tdx: SentimentMainNetLike = {
    main_net_sum_yi: 0,
    main_net_known: 0,
    main_net_tdx: { sum_yi: -50, known: 60, universe: 60, complete: 60, amount_yi: 8000, as_of: "2026-09-30", basis: "通达信当日逐笔自算", note: "自算子集" },
  };
  const d = mainNetDisplay(tdx);
  assert.ok(d, "通达信源应返回读数");
  assert.match(d!.label, /前 \d+ 只/, `应标明覆盖多少只（实际 label=${d!.label}）`);
  assert.equal(d!.selfComputed, true, "通达信自算应显式标 selfComputed");

  const snap: SentimentMainNetLike = { main_net_sum_yi: 57.5, main_net_known: 4000 };
  const d2 = mainNetDisplay(snap);
  assert.ok(d2, "全A快照应返回读数");
  assert.match(d2!.label, /全A \d+/, `全A快照应标覆盖家数（实际 label=${d2!.label}）`);
});

test("E2 纯核：两个源都没有可信读数时返回 null（页面显示「—」，绝不显示 0 亿冒充）", () => {
  assert.equal(mainNetDisplay({ main_net_sum_yi: 0, main_net_known: 0 }), null);
  assert.equal(mainNetDisplay(null), null);
});

test("E2 钉测：三页都从 main-net-core 取数（同源，不会各算各的）", () => {
  for (const f of [
    "src/components/desk/pages/RiskPage.tsx",
    "src/components/desk/pages/ResearchPage.tsx",
    "src/components/desk/pages/ThemeOverviewPage.tsx",
  ]) {
    const src = read(f);
    assert.match(
      src,
      /import \{ mainNetDisplay \} from "@\/lib\/desk\/main-net-core"/,
      `${f} 没走 main-net-core——主力净额就会再冒出第二套口径`,
    );
  }
});

test("E2 钉测：板块资金榜明确是「板块」口径，不与全市场个股净额混为一谈", () => {
  const board = read("src/components/desk/pages/BoardPage.tsx");
  assert.match(board, /主力净额前 \d+ 名/, "板块资金去向榜应写明是板块榜单（前 N 名），不是全市场合计");
  assert.match(board, /板块|资金去向/, "板块榜须带「板块」字样，避免被读成全市场主力净额");
  const risk = read("src/components/desk/pages/RiskPage.tsx");
  assert.match(risk, /全市场个股口径|与.*板块榜.*不是同一笔数/, "风险页须提示这个数和板块榜不是同一笔");
});
