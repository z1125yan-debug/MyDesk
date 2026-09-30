// P36-D：把 factor_test 表（219 条因子检验）落成界面能直接读的 data/factor-truth.json。
//
// 为什么落静态文件而不是每次查库：跟 data/strategy-regime.json 一个套路——
// 检验结果是慢变量（跑一轮要几分钟），页面读 JSON 就行，也方便 diff 和复核。
//
// 用法：node --experimental-strip-types scripts/build-factor-truth.ts
//
// 口径：
// - 同一 factorKey 被跑过多次（表里 219 行 / 去重后 108 个 key），**取最新一条**（createdAt 最大）；
//   重复次数一并记进 counts，免得别人误以为 219 个因子。
// - direction 由 rankIc 符号定（factor-truth-core.directionOfRankIc），不是拍脑袋。
// - 不删不改原始检验结果，只做搬运 + 翻译。

import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db.ts";
import { directionOfRankIc, type FactorTruth, type FactorTruthFile } from "../src/lib/quant/factors/factor-truth-core.ts";

const OUT = path.join(process.cwd(), "data", "factor-truth.json");

type Row = {
  factorKey: string;
  horizon: number;
  dataRange: string;
  sampleStocks: number;
  sampleDates: number;
  rankIc: number;
  icIr: number;
  passed: boolean;
  createdAt: Date;
};

async function main(): Promise<void> {
  const rows = await db.factorTest.findMany({
    orderBy: { createdAt: "asc" }, // asc + 后写覆盖 = 取到最新的那条
    select: {
      factorKey: true, horizon: true, dataRange: true, sampleStocks: true,
      sampleDates: true, rankIc: true, icIr: true, passed: true, createdAt: true,
    },
  });
  if (!rows.length) {
    console.error("factor_test 表是空的，先跑因子检验再来建这份文件");
    process.exit(1);
  }

  const dupes: Record<string, number> = {};
  const factors: Record<string, FactorTruth> = {};
  for (const r of rows as Row[]) {
    dupes[r.factorKey] = (dupes[r.factorKey] ?? 0) + 1;
    // asc 排序下后写覆盖前写 → 留下的就是最新一次检验
    factors[r.factorKey] = {
      key: r.factorKey,
      direction: directionOfRankIc(r.rankIc),
      rankIc: r.rankIc,
      icIr: r.icIr,
      passed: r.passed,
      samples: { stocks: r.sampleStocks, dates: r.sampleDates },
      dataRange: r.dataRange || null,
    };
  }

  const list = Object.values(factors);
  const file: FactorTruthFile & { counts: { duplicatedKeys: number } } = {
    generatedAt: new Date().toISOString(),
    source: "factor_test 表（同 key 取最新一条）；方向由 rankIc 符号定",
    counts: {
      rows: rows.length,
      keys: list.length,
      passed: list.filter((f) => f.passed).length,
      negative: list.filter((f) => f.direction === "negative").length,
      positive: list.filter((f) => f.direction === "positive").length,
      unknown: list.filter((f) => f.direction === "unknown").length,
      duplicatedKeys: Object.values(dupes).filter((n) => n > 1).length,
    },
    factors,
  };

  fs.writeFileSync(OUT, JSON.stringify(file, null, 2));
  const c = file.counts;
  console.log(`写入 ${OUT}`);
  console.log(`  原始 ${c.rows} 条 → 去重 ${c.keys} 个因子（${c.duplicatedKeys} 个 key 跑过多轮，取最新）`);
  console.log(`  通过检验 ${c.passed} / 反着走 ${c.negative} / 正向 ${c.positive} / 方向不明 ${c.unknown}`);
  const worst = list.filter((f) => f.direction === "negative").sort((a, b) => (a.rankIc ?? 0) - (b.rankIc ?? 0)).slice(0, 5);
  console.log("  反向最狠的 5 个：");
  for (const f of worst) console.log(`    ${f.key}  rankIc=${(f.rankIc ?? 0).toFixed(4)}`);
}

main().catch((e) => { console.error("崩了：", e); process.exit(1); });
