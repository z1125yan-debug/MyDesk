// P34 历史回测验证：用 data/strategy-regime.json（461 条策略 × 强/震/弱三档 × 约 14 个月）
// 回答三个问题：
//   ① 每个档位历史上该看哪几条（Top5 完整榜）
//   ② 分档到底有没有信息量——同一条策略在「它最好的那档」比全期平均好多少（分档增益）
//   ③ 恒空对照：社区门槛（≥50）在档位分口径下的可达性说明
// 纯读本地数据、不发请求、不写盘。用法：node --experimental-strip-types scripts/validate-regime.ts

import fs from "node:fs";
import path from "node:path";
import { regimeRankOf, fmtPct, type Regime, type RegimeRow } from "../src/lib/quant/strategy/regime-core.ts";

const FILE = path.join(process.cwd(), "data", "strategy-regime.json");
if (!fs.existsSync(FILE)) {
  console.error("缺少 data/strategy-regime.json，先跑 scripts/build-strategy-regime.ts");
  process.exit(1);
}
const lib = JSON.parse(fs.readFileSync(FILE, "utf8"));
const rows: RegimeRow[] = lib.rows ?? [];
const REGIMES: Regime[] = ["强势", "震荡", "弱势"];

console.log("=".repeat(72));
console.log("分档回测验证 ·", lib.window ? `${lib.window.universe} 只 × 约 ${lib.window.bars} 根日K` : "", "· rows =", rows.length);
console.log("档位法：", lib.regimeMethod);
console.log("门槛：", lib.thresholds?.note);
console.log("=".repeat(72));

// ① 各档 Top5
for (const g of REGIMES) {
  const top = regimeRankOf(rows, g, { minHits: 20, minTotal: 30, limit: 5 }).items;
  console.log(`\n【${g}期】该档次日均益 Top5`);
  top.forEach((it, i) => {
    console.log(
      `  ${i + 1}. ${it.name.padEnd(12)} 命中 ${String(it.stat.n).padStart(5)} 次 | 次日胜率 ${it.stat.win.toFixed(0)}%` +
      ` | 次日均益 ${fmtPct(it.stat.avg)} | 5日均益 ${fmtPct(it.stat.avg5)} | 全期 ${it.n1} 次`,
    );
  });
}

// ② 分档增益：同一策略在最好的那档 vs 全期平均
let gains: number[] = [];
let better = 0;
let counted = 0;
const byGain: { name: string; best: Regime; bestAvg: number; allAvg: number; gain: number }[] = [];
for (const r of rows) {
  const stats = REGIMES.map((g) => ({ g, st: r[g] })).filter((x) => x.st && x.st.n >= 20);
  if (!stats.length || !(r.n1 >= 30)) continue;
  counted++;
  const best = stats.reduce((a, b) => ((b.st!.avg > a.st!.avg) ? b : a));
  const gain = best.st!.avg - r.avg1;
  gains.push(gain);
  if (gain > 0) better++;
  byGain.push({ name: r.name, best: best.g, bestAvg: best.st!.avg, allAvg: r.avg1, gain });
}
gains.sort((a, b) => a - b);
const mean = gains.reduce((a, b) => a + b, 0) / (gains.length || 1);
const median = gains.length ? gains[Math.floor(gains.length / 2)] : 0;
console.log("\n" + "=".repeat(72));
console.log("② 分档增益（策略在「它最好的档位」的次日均益 − 它自己的全期次日均益）");
console.log(`   样本 ${counted} 条（该档≥20 且全期≥30）`);
console.log(`   平均增益 ${fmtPct(mean)} | 中位增益 ${fmtPct(median)} | 有正增益的占比 ${((better / (counted || 1)) * 100).toFixed(0)}%`);
console.log("   解读：增益为正说明「挑档位挑策略」优于「不看档位照单全收」；");
console.log("   但这只是历史拟合，未扣除选择偏差（同一份数据既挑档又评收益），不能当未来预期。");
console.log("\n   增益最大的 5 条：");
byGain.sort((a, b) => b.gain - a.gain).slice(0, 5).forEach((x) =>
  console.log(`     ${x.name.padEnd(12)} 最好档=${x.best} ${fmtPct(x.bestAvg)} vs 全期 ${fmtPct(x.allAvg)} → 增益 ${fmtPct(x.gain)}`));
console.log("   增益最小（可能为负）的 3 条：");
byGain.slice(-3).forEach((x) =>
  console.log(`     ${x.name.padEnd(12)} 最好档=${x.best} ${fmtPct(x.bestAvg)} vs 全期 ${fmtPct(x.allAvg)} → 增益 ${fmtPct(x.gain)}`));

// ③ 恒空对照说明
console.log("\n" + "=".repeat(72));
console.log("③ 恒空对照：为什么原「过闸推荐」在非高风险日给不出东西");
console.log("   社区策略的 sentiment_threshold 分布最低 50，而档位分是 0–100 见顶压力分（越高越危险）；");
console.log("   市场越正常分越低（实测正常档 28.2 分）→ 99 条带门槛策略全部被挡 → 推荐列表为空。");
console.log("   分档回测这条线不依赖那些门槛：任何档位都能给该档历史最好的几条（见上表）。");
console.log("=".repeat(72));
