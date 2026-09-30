// A 任务「进榜钉测」（A 验收最后一条，2026-10-01 补）
//
// 前面 10 条单测只验了「单条条件怎么判」。真正要防的回退是：有人往 data/strategies.json 里
// 加回一条「今日涨停=1」的策略、或留着恒真废条件（如 is_limit_up <= 1，值域只有 0/1 所以
// 永远成立），界面又把它当可用策略推荐出去——那是 A 要治的根子。
//
// 所以这里直接钉**数据文件**：库里不许有不可成交/死策略/恒真废条件，
// 分档榜（rows + 三档 rank）里也不许出现已删 id。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { verdictOfCond, verdictOfStrategy, shouldDrop, type CondLike } from "../../src/lib/quant/strategy/tradeable-core.ts";

type LibStrategy = { id: number; name: string; conds: CondLike[] };
const j = <T>(p: string): T => JSON.parse(readFileSync(path.join(process.cwd(), p), "utf8")) as T;

const lib = (): LibStrategy[] => {
  const raw = j<LibStrategy[] | { data: LibStrategy[] }>("data/strategies.json");
  return Array.isArray(raw) ? raw : raw.data;
};

test("进榜钉测：策略库里不许残留任何「买了买不进 / 永远选不出票」的策略", () => {
  const bad = lib().map((s) => ({ s, v: verdictOfStrategy(s.conds) })).filter((x) => shouldDrop(x.v));
  const list = bad.map((b) => `#${b.s.id}(${b.v.verdict})`).join(", ");
  assert.equal(bad.length, 0, `这几条必须已被删除（跑 scripts/prune-untradeable-strategies.ts）：${list}`);
});

test("进榜钉测：库里不许有恒真废条件占位（is_limit_up <= 1 这种等于没写，属误导）", () => {
  for (const s of lib()) {
    for (const c of s.conds) {
      const d = verdictOfCond(c);
      if (!d) continue; // 非封板字段不判定
      assert.notEqual(d.verdict, "vacuous", `#${s.id}「${s.name}」还留着恒真废条件 ${c.field} ${c.op} ${String(c.value)}`);
      assert.notEqual(d.verdict, "untradeable", `#${s.id}「${s.name}」要求涨停，买不进`);
      assert.notEqual(d.verdict, "dead", `#${s.id}「${s.name}」条件恒假，永远选不出票`);
    }
  }
});

test("进榜钉测：分档榜里不许出现已删策略（rows 与三档 rank 都要干净）", () => {
  const pruned = j<{ dropped: { id: number }[] }>("data/pruned-strategies.json");
  const dropped = new Set((pruned.dropped ?? []).map((d) => Number(d.id)));
  assert.ok(dropped.size > 0, "删除清单不该是空的——空了说明被重复跑覆盖过，榜单就再也清不掉");
  const regime = j<{ rows: { id: number }[]; rank: Record<string, { id: number }[]> }>("data/strategy-regime.json");
  for (const r of regime.rows ?? []) {
    assert.ok(!dropped.has(Number(r.id)), `分档榜 rows 里还有已删策略 #${r.id}`);
  }
  for (const g of ["强势", "震荡", "弱势"]) {
    for (const it of regime.rank?.[g] ?? []) {
      assert.ok(!dropped.has(Number(it.id)), `${g}档榜单里还有已删策略 #${it.id}`);
    }
  }
});

test("剥恒真废条件不会改变命中集（这是敢删的前提：恒真=没过滤，成绩不用重跑）", () => {
  // 布尔字段值域 {0,1}：`<=1` 对 0 和 1 都成立 → 去掉它，命中集一模一样
  for (const [op, value] of [["<=", 1], ["<", 3], [">=", 0], ["<", 2]] as [string, number][]) {
    assert.equal(verdictOfCond({ field: "is_limit_up", op, value })?.verdict, "vacuous");
  }
  // 反例：排除涨停（!=1）会真的过滤掉一批票，不能删
  assert.equal(verdictOfCond({ field: "is_limit_up", op: "!=", value: 1 })?.verdict, "ok");
});
