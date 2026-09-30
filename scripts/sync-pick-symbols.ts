// P36-C 补记具体票（可单独跑；正常由调度器 kind=picksym 在收盘后自动跑）
//
// 用法：
//   node --experimental-strip-types scripts/sync-pick-symbols.ts               # 补所有还没补的日子
//   node --experimental-strip-types scripts/sync-pick-symbols.ts --date 2026-09-30
//
// 跑在收盘后：数据已定死，补出来的名单改不了，这才是证据。盘中跑没有意义（行情未定）。

import { syncPickSymbols } from "../src/lib/quant/strategy/pick-symbol-collect.ts";

const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const date = argOf("date");
const limitRaw = argOf("limit");
const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;

const out = await syncPickSymbols({ ...(date ? { date } : {}), ...(limit ? { limit } : {}) });
console.log(`扫描 ${out.scanned} 行 → 补上具体票 ${out.results} 行 / 空或算不出 ${out.delta.unchanged} 行`);
for (const m of out.missing.slice(0, 20)) console.log(`  · ${m}`);
console.log(`口径：${out.source}`);
process.exit(0);
