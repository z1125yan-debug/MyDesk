// 影子版 CLI（2026-10-24）：生成当日影子名单 + 回填到期分档。
// 用法：
//   node --experimental-strip-types scripts/shadow-pick.ts [--date 2026-10-23] [--fill-only]
// 正常由 cron 调 POST /api/quant/shadow；这个脚本是同口径的直跑兜底（服务没起时也能落库）。

import { generateShadowPick, fillShadowHorizons } from "../src/lib/quant/strategy/shadow-collect.ts";
import { db } from "../src/lib/db.ts";

const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (!argv.includes("--fill-only")) {
  let date = argOf("date");
  if (!date) {
    const rows = await db.$queryRawUnsafe<{ tradeDate: string }[]>(
      `SELECT tradeDate FROM stock_daily_bar WHERE adjust = 'qfq'
       GROUP BY tradeDate HAVING COUNT(*) >= 1000 ORDER BY tradeDate DESC LIMIT 1`,
    );
    date = rows[0]?.tradeDate;
  }
  if (!date) { console.log("本地粮仓没有任何已沉淀交易日，无法生成"); process.exit(1); }
  const gen = await generateShadowPick(date);
  console.log(`生成 ${date}：ok=${gen.ok} 档位=${gen.regime ?? "—"} 策略=${gen.strategyName ?? "—"} 票数=${gen.pickCount}`);
  console.log(`  ${gen.note}`);
}
const fill = await fillShadowHorizons();
console.log(`回填：扫描 ${fill.scanned} 行 → 更新 ${fill.updated} 行`);
for (const m of fill.missing) console.log(`  · ${m}`);
process.exit(0);
