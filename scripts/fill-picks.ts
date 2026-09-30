// P36-C 战绩回填（可单独跑；正常由调度器 kind=pickfill 在收盘后自动跑，不许手工补数）
//
// 用法：
//   node --experimental-strip-types scripts/fill-picks.ts              # 回填所有待处理行
//   node --experimental-strip-types scripts/fill-picks.ts --only 2026-09-30
//   node --experimental-strip-types scripts/fill-picks.ts --limit 50
//
// 纪律：只回填「T+1、T+2 两个交易日都已在本地粮仓沉淀完」的行；已回填过的行不再改写。
// 所以重复跑 = 无副作用，跑第二次应当 results=0。

import { fillPicks } from "../src/lib/quant/strategy/pick-fill-collect.ts";

const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const limitRaw = argOf("limit");
const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
const only = argOf("only");

const out = await fillPicks({ ...(limit ? { limit } : {}), ...(only ? { only } : {}) });
console.log(`扫描 ${out.scanned} 行 → 回填 ${out.results} 行 / 跳过 ${out.delta.unchanged} 行`);
for (const m of out.missing.slice(0, 20)) console.log(`  · ${m}`);
if (out.missing.length > 20) console.log(`  · …… 另有 ${out.missing.length - 20} 条`);
console.log(`口径：${out.source}`);
process.exit(0);
