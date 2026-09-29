// 社区策略库清洗（P33 回测配套，可重复执行）：
//   1) 去重：条件集完全相同的条目只保留一条（保留赞数最高者；赞数同则保留最早 id）
//   2) 剔除 0 个已映射条件的策略（本站因子引擎跑不了，筛选/回测都无效）
//   3) 剔除纯快照条件策略（无任何 K 线口径条件 → 无法历史回测，预测件无法给它记账）
// 不做基于回测成绩的剔除（ poor performer ≠ invalid，交给排名去暴露）。
// 用法：node scripts/dedupe_strategies.mjs  （直接改写 data/strategies.json，git 为备份）
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(process.cwd(), "data", "strategies.json");
const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
const list = raw.data ?? [];
const before = list.length;

const sigOf = (s) =>
  JSON.stringify((s.conds ?? []).map((c) => [c.field, c.op, c.value, c.type ?? "single", c.window ?? 0, c.min_match_days ?? 0]));

// kline 口径判定（与 src/lib/quant/factors/fields.ts 的 FACTOR_FIELD_MAP 同口径，这里读生成物避免引 TS）
// 简化：本仓库因子 key 中 snapshot 类是固定白名单（fields.ts 头部口径），其余视为 kline。
// 更稳的做法：直接读 factors?catalog 接口的快照集合——脚本环境改读 fields.ts 编译产物太绕，
// 因此这里内嵌快照类 key 清单（fields.ts 59-68 行等，source:"snapshot"），新增快照字段时需同步。
const SNAPSHOT_KEYS = new Set([
  "pe_ttm", "pe", "pb", "market_cap_yi", "floatcap_yi", "change_pct", "turnover_rate",
  "volume_ratio", "amplitude", "amount_yi", "main_net_yi", "industry", "sector_concept",
]);
const isKlineCond = (c) => !SNAPSHOT_KEYS.has(c.field);

const groups = new Map();
let zeroMapped = 0, pureSnapshot = 0;
for (const s of list) {
  const conds = s.conds ?? [];
  if (!conds.length || (s.n_mapped ?? 0) === 0) { zeroMapped++; continue; }
  const kline = conds.filter(isKlineCond);
  if (!kline.length) { pureSnapshot++; continue; }
  const sig = sigOf(s);
  const g = groups.get(sig);
  if (!g) groups.set(sig, [s]);
  else g.push(s);
}

const kept = [];
let removedDup = 0;
for (const g of groups.values()) {
  g.sort((a, b) => (b.like ?? 0) - (a.like ?? 0) || a.id - b.id);
  kept.push(g[0]);
  removedDup += g.length - 1;
}

kept.sort((a, b) => a.id - b.id);
const out = { ...raw, count: kept.length, data: kept, dedupe: { ranAt: new Date().toISOString(), before, after: kept.length, removedDuplicates: removedDup, removedZeroMapped: zeroMapped, removedPureSnapshot: pureSnapshot } };
fs.writeFileSync(FILE, JSON.stringify(out, null, 1));
console.log(`策略库清洗完成：${before} → ${kept.length} 条（去重 ${removedDup}，零映射条件 ${zeroMapped}，纯快照不可回测 ${pureSnapshot}）`);
