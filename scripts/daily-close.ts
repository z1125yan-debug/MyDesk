// P36-C 收盘后一键跑完战绩链三步。
//
// 为什么要有这个文件：调度器只在「服务进程一直开着」时才自动跑（instrumentation 里 startScheduler，
// 交易日北京 15:20 触发）。你要是每天用完就关服务，那 15:20 那一刻进程不在，什么都不会发生。
// 这种情况就手工跑这一条，效果和自动完全一样。
//
// 用法：
//   node --experimental-strip-types scripts/daily-close.ts          # 三步全跑（约 1 分钟）
//   node --experimental-strip-types scripts/daily-close.ts --skip-bars   # 粮仓已更新过，跳过第一步
//
// 三步的顺序不能换：
//   1) dailybars  粮仓更新到当天（没有当天K线，后面两步全是空转）
//   2) picksym    补出「今天这个策略命中了哪几只票」
//   3) pickfill   回填「更早那些还没结账的日子」到底赚没赚
// 三步都幂等，重复跑不会翻倍；失败会停在那一步并如实打印，不会假装成功。

import { ingestDailyBars } from "../src/lib/quant/data/daily-bar-collect.ts";
import { syncPickSymbols } from "../src/lib/quant/strategy/pick-symbol-collect.ts";
import { fillPicks } from "../src/lib/quant/strategy/pick-fill-collect.ts";

const SKIP_BARS = process.argv.includes("--skip-bars");

function step(n: number, title: string): void {
  console.log(`\n[${n}/3] ${title}`);
}

// ---- 1) 粮仓增量 ----
if (SKIP_BARS) {
  console.log("[1/3] 粮仓增量：已跳过（--skip-bars）");
} else {
  step(1, "粮仓增量：把全A日K更新到今天");
  const bars = await ingestDailyBars({ bars: 3 });
  console.log(`  ${bars.status}：覆盖 ${bars.results} 只 · ${bars.note ?? ""}`);
  if (bars.status === "failed") {
    console.error("\n粮仓没更新成功，后面两步跑也是空转，到此为止。");
    console.error(`原因：${bars.note ?? bars.reason}`);
    process.exit(1);
  }
}

// ---- 2) 补当天命中的票 ----
step(2, "补票：今天推的那些策略，各自命中了哪几只");
const sym = await syncPickSymbols({});
console.log(`  扫描 ${sym.scanned} 行 → 补上 ${sym.results} 行 / 算不出 ${sym.delta.unchanged} 行`);
for (const m of sym.missing.slice(0, 10)) console.log(`    · ${m}`);

// ---- 3) 回填战绩 ----
step(3, "回填：更早那些还没结账的日子，到底赚没赚");
const fill = await fillPicks({});
console.log(`  扫描 ${fill.scanned} 行 → 回填 ${fill.results} 行 / 跳过 ${fill.delta.unchanged} 行`);
for (const m of fill.missing.slice(0, 10)) console.log(`    · ${m}`);

console.log("\n完成。战绩页 #/trackrecord 看进度，够 20 个交易日才给结论。");
process.exit(0);
