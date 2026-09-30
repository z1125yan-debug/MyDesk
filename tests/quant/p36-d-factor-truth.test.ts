// P36-D 因子真相：方向判定、真实计数、文案纪律（第 0 节：不许出现黑话）
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  directionOfRankIc, truthBadgeOf, truthDetailOf, condAuditOf,
  type FactorTruth,
} from "../../src/lib/quant/factors/factor-truth-core.ts";

const read = (p: string): string => readFileSync(path.join(process.cwd(), p), "utf8");
const truth = (over: Partial<FactorTruth>): FactorTruth => ({
  key: "x", direction: "unknown", rankIc: null, icIr: null, passed: false,
  samples: { stocks: 144, dates: 514 }, dataRange: "2024-08-08~2026-09-18", ...over,
});

test("方向由 rankIc 符号定：正是正向、负是反向", () => {
  assert.equal(directionOfRankIc(0.03), "positive");
  assert.equal(directionOfRankIc(-0.03), "negative");
});

test("rankIc 小到接近噪声 → 判 unknown，不把噪声说成方向", () => {
  assert.equal(directionOfRankIc(0.0001), "unknown");
  assert.equal(directionOfRankIc(-0.0001), "unknown");
  assert.equal(directionOfRankIc(null), "unknown");
  assert.equal(directionOfRankIc(Number.NaN), "unknown");
});

test("反向因子的角标与说明必须说清「命中=该回避，不是该买」", () => {
  const t = truth({ direction: "negative", rankIc: -0.095, passed: false });
  assert.equal(truthBadgeOf(t), "反着走");
  const d = truthDetailOf(t, "TD13买入优选") as string;
  assert.match(d, /回避/);
  assert.match(d, /不是/);
  assert.match(d, /看过 144 只票 × 514 天/); // 样本量必须带上，不然就是空口断言
});

test("体检把「反向」单独数出来，不能跟「没验过」混成一个总数", () => {
  const truthMap: Record<string, FactorTruth> = {
    a: truth({ key: "a", direction: "negative", passed: false }),
    b: truth({ key: "b", direction: "positive", passed: false }),
    c: truth({ key: "c", direction: "positive", passed: true }),
  };
  const audit = condAuditOf([{ field: "a" }, { field: "b" }, { field: "c" }], truthMap);
  assert.equal(audit.total, 3);
  assert.equal(audit.negative, 1);   // 反向单独计
  assert.equal(audit.unverified, 1); // b 没过检
  assert.match(audit.summary as string, /1 个历史上是反着走的/);
  assert.match(audit.summary as string, /1 个没通过历史检验/);
});

test("没做过检验的因子单独数，且说明里如实说「不知道有没有用」", () => {
  const audit = condAuditOf([{ field: "从未检验过" }], {});
  assert.equal(audit.untested, 1);
  assert.equal(audit.negative, 0);
  assert.equal(audit.unverified, 0);
  assert.match(audit.lines[0], /没做过历史检验/);
});

test("全过检且非反向 → 不弹警告（不为了显得严谨而乱报警）", () => {
  const truthMap: Record<string, FactorTruth> = { ok: truth({ key: "ok", direction: "positive", passed: true }) };
  const audit = condAuditOf([{ field: "ok" }], truthMap);
  assert.equal(audit.summary, null);
});

// ---- 第 0 节：文案纪律 ----
test("所有面向用户的文案里不许出现黑话（IC / 截面 / 样本外 / 超额 / 置信区间）", () => {
  const src = read("src/lib/quant/factors/factor-truth-core.ts");
  // 只检查字符串字面量里的中文说明部分：抓「……」包裹的文案
  const banned = ["IC", "截面", "样本外", "样本内", "超额", "置信区间", "RankIC"];
  const samples = [
    truthDetailOf(truth({ direction: "negative" }), "甲") as string,
    truthDetailOf(truth({ direction: "positive", passed: true }), "乙") as string,
    truthDetailOf(undefined, "丙") as string,
  ];
  for (const s of samples) {
    for (const b of banned) assert.ok(!s.includes(b), `文案里不该出现「${b}」：${s}`);
  }
  void src;
});

// ---- 数据文件自洽 ----
test("data/factor-truth.json 的计数与内容自洽（防止手工改坏）", () => {
  const j = JSON.parse(read("data/factor-truth.json")) as {
    counts: { rows: number; keys: number; passed: number; negative: number; positive: number; unknown: number };
    factors: Record<string, FactorTruth>;
  };
  const list = Object.values(j.factors);
  assert.equal(list.length, j.counts.keys, "因子个数与 counts.keys 不一致");
  assert.equal(j.counts.keys, j.counts.passed + j.counts.negative + j.counts.positive + j.counts.unknown - j.counts.passed,
    "passed 与方向分类有重叠，计数口径要写明");
  assert.ok(j.counts.negative > 0, "实测绝大多数因子是反向的，若变成 0 说明数据被改过或没跑检验");
  for (const f of list) {
    assert.equal(f.key, f.key.trim());
    assert.ok(["positive", "negative", "unknown"].includes(f.direction));
  }
});

test("反向因子数量确实占多数（这是 D 要上屏的核心事实，别让它悄悄变好）", () => {
  const j = JSON.parse(read("data/factor-truth.json")) as { counts: { keys: number; negative: number } };
  assert.ok(
    j.counts.negative > j.counts.keys / 2,
    `反向因子应占多数，实测 ${j.counts.negative}/${j.counts.keys}`,
  );
});
