// P36-B 分档榜口径钉测：排序键是样本外、口径标签说人话、老数据不冒充样本外
//
// 钉的三件事：
//  1) 排序必须优先用「没参与挑选的那段行情」的成绩——拿挑它的那段历史排，等于拿运气当本事；
//  2) 口径标签里不许出现黑话（第 0 节硬约束，界面上出现「样本外」直接红）；
//  3) 老数据（没有 oos 字段）回退到全期排，但标签必须如实说「用同一段历史算的」，不许冒充。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  regimeRankOf,
  basisLabelOf,
  type RegimeRow,
  type RegimeStat,
} from "../../src/lib/quant/strategy/regime-core.ts";

const BLACKLIST = ["MA20", "样本外", "样本内", "置信区间", "截面", "超额", "净值曲线", "反向因子", "IC", "RankIC", "牛市", "熊市"];

function rowOf(id: number, n1: number, stat: Partial<RegimeStat> & { n: number; win: number; avg: number }): RegimeRow {
  return {
    id, name: `S${id}`, condsText: "", n1, win1: 50, avg1: stat.avg, avg5: 0, n110: 0, win110: 0,
    强势: { avg5: 0, ...stat } as RegimeStat,
    震荡: null,
    弱势: null,
  };
}

test("有样本外成绩时按样本外净收益排（不是按全期）", () => {
  const rows = [
    rowOf(1, 900, { n: 600, win: 50, avg: 1.5, oos: { n: 120, win: 50, net1: -0.4, net5: null, winCi: "" } }),
    rowOf(2, 900, { n: 600, win: 50, avg: 0.2, oos: { n: 120, win: 50, net1: 0.9, net5: null, winCi: "" } }),
  ];
  const r = regimeRankOf(rows, "强势", { limit: 5 });
  assert.equal(r.items[0].id, 2, "样本外 +0.9% 应排在全期 +1.5% 但样本外 -0.4% 的前面");
  assert.equal(r.basis, "样本外");
});

test("样本外样本不够（<50）的不进榜", () => {
  const rows = [
    rowOf(1, 900, { n: 600, win: 50, avg: 0.2, oos: { n: 30, win: 60, net1: 5, net5: null, winCi: "" } }),
    rowOf(2, 900, { n: 600, win: 50, avg: 0.1, oos: { n: 80, win: 50, net1: 0.2, net5: null, winCi: "" } }),
  ];
  const r = regimeRankOf(rows, "强势", { limit: 5 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 2, "n=30 的样本外再好看也不该上榜");
});

test("全榜都没有样本外 → 回退按全期排，basis 如实写全期", () => {
  const rows = [
    rowOf(1, 900, { n: 600, win: 50, avg: 0.2 }),
    rowOf(2, 900, { n: 600, win: 50, avg: 1.1 }),
  ];
  const r = regimeRankOf(rows, "强势", { limit: 5 });
  assert.equal(r.items[0].id, 2, "无 oos 时按全期平均排");
  assert.equal(r.basis, "全期");
});

test("口径标签说人话：不许出现黑话（第 0 节硬约束）", () => {
  const withOos = regimeRankOf([rowOf(1, 900, { n: 600, win: 50, avg: 0.5, oos: { n: 120, win: 50, net1: 0.3, net5: null, winCi: "" } })], "强势");
  const noOos = regimeRankOf([rowOf(2, 900, { n: 600, win: 50, avg: 0.5 })], "强势");
  const labels = [
    ...withOos.items.map((i) => i.basis),
    ...noOos.items.map((i) => i.basis),
    basisLabelOf(rowOf(1, 900, { n: 600, win: 50, avg: 0.5, oos: { n: 120, win: 50, net1: 0.3, net5: null, winCi: "" } }).强势),
    basisLabelOf(rowOf(2, 900, { n: 600, win: 50, avg: 0.5 }).强势),
  ];
  for (const l of labels) {
    for (const bad of BLACKLIST) {
      assert.ok(!l.includes(bad), `口径标签「${l}」含黑话「${bad}」`);
    }
  }
});

test("钉：分档回测推荐卡片（界面文案）不含黑话", () => {
  // 只扫这一块卡片：整份文件里还有选股条件名（「站上MA20」）属于另一摊待办，
  // 但 P36-B 新增/改动的这块必须干净。
  const src = readFileSync(new URL("../../src/components/desk/pages/ScreenerWorkbench.tsx", import.meta.url), "utf8");
  const start = src.indexOf("{/* P34-2 分档回测推荐");
  assert.ok(start > 0, "找不到分档回测推荐卡片，钉测位置失效");
  const end = src.indexOf("{/* 推荐列表：组合在前", start);
  const block = src.slice(start, end > start ? end : start + 3000);
  for (const bad of BLACKLIST) {
    assert.ok(!block.includes(bad), `分档回测卡片文案含黑话「${bad}」`);
  }
});
