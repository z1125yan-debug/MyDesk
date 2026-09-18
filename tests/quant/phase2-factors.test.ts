// Phase 2 测试：面板 / 表达式DSL / 未来函数审计 / IC 族指标 / 挖掘漏斗
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoProvider } from "../../src/lib/quant/data/demo-provider.ts";
import { buildPanel, dailyReturns, forwardReturns } from "../../src/lib/quant/factors/panel.ts";
import {
  parseExpression, serializeExpression, auditExpression, evaluateAst,
  csRank, csZscore, pearson,
} from "../../src/lib/quant/factors/expression.ts";
import { evaluateFactorMetrics, factorCorrelation, summarizeIc } from "../../src/lib/quant/factors/metrics.ts";
import { expandTemplates, combineFactors, FACTOR_TEMPLATES } from "../../src/lib/quant/factors/templates.ts";
import { runMiningFunnel, DEFAULT_MINING_CONFIG, type MiningConfig } from "../../src/lib/quant/factors/mining.ts";

const AS_OF = "2025-06-30";

async function demoPanel(lookback = 320, maxSymbols = 60) {
  return buildPanel(demoProvider, { universe: { kind: "all" }, asOf: AS_OF, lookback, maxSymbols });
}

// ---------- 表达式 DSL ----------

test("DSL: 解析与序列化往返", () => {
  const cases = [
    "roc(c, 20)",
    "div(sub(c, ma(c, 20)), std(c, 20))",
    "zscore(rank(mul(v, 2)))",
    "corr(c, v, 10)",
    "neg(pe)",
  ];
  for (const src of cases) {
    const ast = parseExpression(src);
    assert.equal(serializeExpression(ast), src, `往返失败：${src}`);
  }
});

test("DSL: 中缀写法解析", () => {
  assert.equal(serializeExpression(parseExpression("(c - ma(c,20)) / std(c,20)")), "div(sub(c, ma(c, 20)), std(c, 20))");
});

test("DSL: 危险内容被拒绝", () => {
  for (const bad of ["process.exit(1)", "eval('1')", "c; drop table", "foo(c, 1)"]) {
    assert.throws(() => parseExpression(bad), `${bad} 应被拒绝`);
  }
});

test("审计: 未来函数（负窗口 ref）被检出", () => {
  const bad = auditExpression(parseExpression("ref(c, -1)"));
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes("未来函数")));
  const good = auditExpression(parseExpression("roc(c, 20)"));
  assert.equal(good.ok, true);
  assert.equal(good.maxLookback, 21);
});

test("审计: 未知函数在解析期即被拒绝（白名单强制前移）", () => {
  assert.throws(() => parseExpression("foo(c, 1)"), /白名单外函数/);
  // 即便绕过解析直接构造 AST，audit 也应拒绝未知函数
  const r = auditExpression({ kind: "call", fn: "foo", args: [{ kind: "field", name: "c" }, { kind: "num", v: 1 }] });
  assert.equal(r.ok, false);
});

// ---------- 面板 ----------

test("面板: 日期轴升序且不超 asOf；字段矩阵对齐", async () => {
  const panel = await demoPanel(200);
  assert.ok(panel.dates.every((d, i) => i === 0 || d > panel.dates[i - 1]));
  assert.ok(panel.dates[panel.dates.length - 1] <= AS_OF);
  const c = panel.fields.get("c")!;
  assert.equal(c.length, panel.symbols.length);
  assert.equal(c[0].length, panel.dates.length);
  // 681059.SH 2025-06-10 上市：面板起始日期在 320 天前（约2024年中）→ 前段为 null
  const idx = panel.symbols.indexOf("681059.SH");
  if (idx >= 0) {
    assert.equal(c[idx][0], null, "上市前应为 null");
  }
});

test("面板: 日收益率与前向收益不引入未来数据", async () => {
  const panel = await demoPanel(60);
  const ret = dailyReturns(panel);
  const fwd = forwardReturns(panel, 5);
  const c = panel.fields.get("c")!;
  const si = 0;
  const t = 10;
  if (c[si][t] !== null && c[si][t + 1] !== null) {
    assert.ok(Math.abs(ret[si][t]! - (c[si][t + 1]! / c[si][t]! - 1)) < 1e-12);
  }
  if (c[si][t + 5] !== null) {
    assert.ok(Math.abs(fwd[si][t]! - (c[si][t + 5]! / c[si][t]! - 1)) < 1e-12);
  }
});

// ---------- 算子 ----------

test("算子: ref/ma/delta 已知值", async () => {
  const panel = await demoPanel(30, 20);
  const c = panel.fields.get("c")!;
  const si = 0;
  // 构造已知序列：直接用 1..N
  const n = panel.dates.length;
  const fake: (number | null)[][] = [Array.from({ length: n }, (_, t) => t + 1)];
  const fakePanel = { dates: panel.dates, symbols: ["FAKE"], fields: new Map([["c", fake]]) };
  const ref1 = evaluateAst(parseExpression("ref(c, 1)"), fakePanel as never);
  assert.equal(ref1[0][5], 5);
  const ma5 = evaluateAst(parseExpression("ma(c, 5)"), fakePanel as never);
  assert.ok(Math.abs(ma5[0][9]! - 8) < 1e-9, `ma5@t9 应为 (6+7+8+9+10)/5=8，实际 ${ma5[0][9]}`);
  const d3 = evaluateAst(parseExpression("delta(c, 3)"), fakePanel as never);
  assert.equal(d3[0][9], 3);
  assert.equal(ref1[0][0], null); // 越界为 null
  assert.equal(c.length > 0, true);
});

test("算子: 截面 rank/zscore", () => {
  const ranked = csRank([10, 30, 20, null, 40]);
  assert.equal(ranked[0], 0);
  assert.ok(Math.abs(ranked[1]! - 2 / 3) < 1e-9, `30 应排第2/3位，实际 ${ranked[1]}`);
  assert.equal(ranked[3], null);
  const z = csZscore([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const nums = z.filter((v): v is number => v !== null);
  const m = nums.reduce((s, v) => s + v, 0) / nums.length;
  assert.ok(Math.abs(m) < 1e-9); // z-score 均值为 0
});

// ---------- 指标 ----------

test("指标: 完美单调因子 → RankIC≈1", async () => {
  const panel = await demoPanel(160, 40);
  const c = panel.fields.get("c")!;
  // 构造"未来收益的反向已知因子"来验证 IC 数学：直接用 t 日收益排序当因子
  // 更公平的做法：因子 = 下一期收益本身（标签泄露的理想相关），RankIC 应≈1
  const label = c.map((series) =>
    series.map((v, t) => (v !== null && series[t + 5] !== null ? series[t + 5]! / v - 1 : null)),
  );
  const m = evaluateFactorMetrics(label, panel, { horizon: 5, minStocks: 8 });
  assert.ok((m.rankIc ?? 0) > 0.95, `泄露因子 RankIC 应≈1，实际 ${m.rankIc}`);
  assert.equal(m.icSeries.length > 30, true);
});

test("指标: 随机因子 → RankIC≈0", async () => {
  const panel = await demoPanel(160, 40);
  const rnd = (() => {
    let a = 12345;
    return () => {
      a = (a * 1103515245 + 12345) % 2147483648;
      return a / 2147483648;
    };
  })();
  const noise = panel.symbols.map(() => panel.dates.map(() => (rnd() > 0.02 ? rnd() : null)));
  const m = evaluateFactorMetrics(noise, panel, { horizon: 5, minStocks: 8 });
  assert.ok(Math.abs(m.rankIc ?? 0) < 0.15, `随机因子 RankIC 应≈0，实际 ${m.rankIc}`);
});

test("指标: 分组分析输出单调性与多空", async () => {
  const panel = await demoPanel(160, 40);
  const c = panel.fields.get("c")!;
  const label = c.map((series) =>
    series.map((v, t) => (v !== null && series[t + 5] !== null ? series[t + 5]! / v - 1 : null)),
  );
  const m = evaluateFactorMetrics(label, panel, { horizon: 5 });
  assert.equal(m.groupReturn!.length, 5);
  assert.ok(m.longShortReturn! > 0, "多空价差应为正");
  assert.ok((m.monotonicity ?? 0) > 0.8);
});

test("指标: 因子相关性检测", async () => {
  const panel = await demoPanel(120, 30);
  const c = panel.fields.get("c")!;
  const a = evaluateAst(parseExpression("roc(c, 20)"), panel);
  const b = evaluateAst(parseExpression("roc(c, 20)"), panel); // 完全相同
  const d = evaluateAst(parseExpression("neg(roc(c, 20))"), panel); // 完全相反
  const corrAB = factorCorrelation(a, b);
  const corrAD = factorCorrelation(a, d);
  assert.ok(corrAB > 0.999);
  assert.ok(Math.abs(corrAD + 1) < 0.001 || corrAD < -0.9);
  assert.ok(Array.isArray(c));
});

// ---------- 模板与漏斗 ----------

test("模板: 展开参数网格并生成合法表达式", () => {
  const candidates = expandTemplates();
  assert.ok(candidates.length >= 30, `候选应≥30，实际 ${candidates.length}`);
  for (const cand of candidates) {
    const ast = parseExpression(cand.expression); // 不抛错
    const audit = auditExpression(ast);
    assert.equal(audit.ok, true, `${cand.factorKey} 审计失败：${audit.problems.join("；")}`);
    assert.ok(!cand.factorKey.includes("{"), "factorKey 不应残留占位符");
  }
});

test("模板: 组合候选生成", () => {
  const combos = combineFactors([
    { expression: "roc(c, 20)", factorKey: "roc_c_20" },
    { expression: "neg(pe)", factorKey: "neg_pe" },
  ]);
  assert.ok(combos.length >= 2);
  for (const combo of combos) assert.equal(auditExpression(parseExpression(combo.expression)).ok, true);
});

test("漏斗: 演示数据完整跑通且逐级收敛", async () => {
  const panel = await demoPanel(320, 60);
  const candidates = expandTemplates();
  const config: MiningConfig = {
    ...DEFAULT_MINING_CONFIG,
    preliminary: { minAbsRankIc: 0.015, minIcIr: 0.15, keep: 24 },
    fine: { minStability: 0.34, maxTurnover: 0.9, keep: 10, redundancyThreshold: 0.9 },
  };
  const outcome = runMiningFunnel(candidates, panel, config);
  const { funnel } = outcome;
  assert.equal(funnel.generated, candidates.length);
  // 漏斗逐级收敛
  assert.ok(funnel.preliminaryPassed <= funnel.generated);
  assert.ok(funnel.finePassed <= funnel.preliminaryPassed);
  assert.ok(outcome.accepted.length <= config.save);
  // 每个结果都有明确理由
  for (const r of outcome.results) assert.ok(r.reason.length > 0, `${r.candidate.factorKey} 缺 reason`);
  // 通过的因子指标齐全且合理性
  for (const a of outcome.accepted) {
    assert.ok(a.metrics!.sample.validPairs > 0);
    assert.ok(isFinite(a.metrics!.rankIc));
    assert.ok(Math.abs(a.metrics!.rankIc) >= config.preliminary.minAbsRankIc - 1e-9);
    assert.ok(a.metrics!.stability >= config.fine.minStability - 1e-9);
    assert.equal(a.metrics!.redundancyWith, null);
  }
  // 输出漏斗信息供人工核对（不影响断言）
  console.log("  [漏斗]", JSON.stringify(funnel));
  console.log("  [通过]", outcome.accepted.map((a) => `${a.candidate.factorKey}(RankIC=${a.metrics!.rankIc.toFixed(3)})`).join(", "));
});

test("汇总: summarizeIc 空序列不崩溃", () => {
  const s = summarizeIc([]);
  assert.equal(s.ic, 0);
  assert.equal(s.icIr, 0);
});
