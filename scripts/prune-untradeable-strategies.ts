// A 任务：把「买了也买不进」和「永远选不出票」的策略从策略库里删掉。
//
// 判据（纯核 src/lib/quant/strategy/tradeable-core.ts）：
//   untradeable = 条件要求「今日涨停=1」→ T 日收盘价就是涨停价，封板买不进。
//                 实测：收盘价口径 +1.562%，真实可成交（次日开盘买）−0.173%，
//                 相对基线超额 −0.228%，三档无一为正 → 成绩是虚的。
//   dead        = 条件恒假（>1 / >=2 / =2）→ 永远 0 命中的死策略，纯噪音。
//   保留 vacuous（恒真废条件，策略本身可能有效）与 ok（排除涨停，合法）。
//
// 同时同步清理 data/strategy-regime.json（rows + 三档 rank），
// 否则推荐榜会展示已经不存在的策略。
//
// 用法：node --experimental-strip-types scripts/prune-untradeable-strategies.ts [--dry]

import fs from "node:fs";
import path from "node:path";
import { verdictOfStrategy, verdictOfCond, shouldDrop } from "../src/lib/quant/strategy/tradeable-core.ts";

const ROOT = process.cwd();
const DRY = process.argv.includes("--dry");
const STRAT = path.join(ROOT, "data", "strategies.json");
const REGIME = path.join(ROOT, "data", "strategy-regime.json");

const stratRaw = JSON.parse(fs.readFileSync(STRAT, "utf8"));
const all = (Array.isArray(stratRaw) ? stratRaw : stratRaw.data) as {
  id: number; name: string; conds: { op: string; field: string; value: unknown }[];
}[];
const before = all.length;

// 先判当前策略库。注意：本脚本**必须可重复跑**——第一次跑完 strategies.json 就已经不含
// 待删策略了，若只按 strategies.json 判定，第二次跑 dropIds 会是空集，
// 而 strategy-regime.json 若被 build 脚本重建过（它会从 _probe 恢复全部 461 条），
// 就再也清不掉。所以历史删除清单要并入。
const PRUNED_LOG = path.join(ROOT, "data", "pruned-strategies.json");
const dropIds = new Set<number>();
if (fs.existsSync(PRUNED_LOG)) {
  try {
    const log = JSON.parse(fs.readFileSync(PRUNED_LOG, "utf8"));
    for (const r of log?.dropped ?? []) dropIds.add(Number(r.id));
  } catch { /* 坏日志忽略，按策略库重新判定 */ }
}
const droppedBefore = dropIds.size;
const kept: typeof all = [];
const rows: { id: number; name: string; verdict: string; summary: string; onBoard: string[] }[] = [];

// 榜单信息（用于报告"删掉会影响哪些推荐位"）
const regimeRaw = JSON.parse(fs.readFileSync(REGIME, "utf8"));
const board = new Map<number, string[]>();
for (const g of ["强势", "震荡", "弱势"]) {
  const list = (regimeRaw.rank?.[g] ?? []) as { id: number }[];
  list.forEach((it, i) => {
    const arr = board.get(Number(it.id)) ?? [];
    arr.push(`${g}第${i + 1}`);
    board.set(Number(it.id), arr);
  });
}

for (const s of all) {
  const v = verdictOfStrategy(s.conds);
  if (shouldDrop(v)) {
    dropIds.add(Number(s.id));
    rows.push({ id: Number(s.id), name: String(s.name ?? ""), verdict: v.verdict, summary: v.summary, onBoard: board.get(Number(s.id)) ?? [] });
  } else {
    kept.push(s);
  }
}

console.log(`策略库 ${before} 条（历史已删 ${droppedBefore} 条）→ 本轮新判 ${rows.length} 条 → 累计删除 ${dropIds.size} 条 → 保留 ${kept.length} 条${DRY ? "（DRY 未写盘）" : ""}`);
const byVerdict = { untradeable: 0, dead: 0 };
for (const r of rows) byVerdict[r.verdict as keyof typeof byVerdict]++;
console.log(`  untradeable（买了买不进）${byVerdict.untradeable} 条 · dead（永远选不出票）${byVerdict.dead} 条`);

const affected = rows.filter((r) => r.onBoard.length);
console.log(`\n=== 会影响推荐榜的 ${affected.length} 条（删后榜单重排）===`);
for (const r of affected.sort((a, b) => b.onBoard.length - a.onBoard.length)) {
  console.log(`  #${String(r.id).padStart(4)} ${String(r.name).slice(0, 12).padEnd(12)} 【${r.onBoard.join(", ")}】 ${r.verdict}`);
}
console.log(`\n=== 不在榜上的 ${rows.length - affected.length} 条 ===`);
console.log(rows.filter((r) => !r.onBoard.length).map((r) => `#${r.id}(${r.name})`).join(" | "));

// ---- 1.5) 恒真废条件剥离（2026-10-01 补，A 尾巴）----
// 为什么敢删：**恒真 = 没过滤任何票**，命中集与原来完全一致 → 已跑出来的分档成绩**不受影响**，
// 不用重跑回测。留着它只会让人以为「这条策略排除了涨停」，那是误导（任务书 A 验收记过这一条）。
// 幂等：剥完就没有了，再跑一遍改动数为 0。
const vacuousLog: { id: number; name: string; removed: string[] }[] = [];
for (const s of kept) {
  const before = s.conds.length;
  const keepC: typeof s.conds = [];
  const gone: string[] = [];
  for (const c of s.conds) {
    const v = verdictOfCond(c);
    if (v?.verdict === "vacuous") gone.push(`${c.field} ${c.op} ${String(c.value)}`);
    else keepC.push(c);
  }
  // 一条都不剩的策略不剥（那会让它变成「无条件=全市场」，语义变了），留着人工判断
  if (gone.length && keepC.length) {
    s.conds = keepC;
    vacuousLog.push({ id: Number(s.id), name: String(s.name ?? ""), removed: gone });
    void before;
  }
}
console.log(`\n恒真废条件：剥离 ${vacuousLog.length} 条策略上的 ${vacuousLog.reduce((n, r) => n + r.removed.length, 0)} 个废条件${DRY ? "（DRY 未写盘）" : ""}`);
for (const r of vacuousLog) console.log(`  #${r.id} ${r.name.slice(0, 14)} 去掉：${r.removed.join(" / ")}`);

if (!DRY) {
  // ---- 1) 策略库 ----
  if (Array.isArray(stratRaw)) fs.writeFileSync(STRAT, JSON.stringify(kept, null, 2));
  else { stratRaw.data = kept; fs.writeFileSync(STRAT, JSON.stringify(stratRaw, null, 2)); }

  // 恒真剥离留痕（可回滚、可核对：写明「为什么成绩不受影响」）
  if (vacuousLog.length) {
    fs.writeFileSync(
      path.join(ROOT, "data", "vacuous-conds-removed.json"),
      JSON.stringify({
        at: new Date().toISOString(),
        reason: "恒真废条件（如 is_limit_up <= 1，值域只有 0/1 所以永远成立）：等于没过滤，命中集不变 → 已跑出来的分档成绩不受影响，无需重跑回测",
        items: vacuousLog,
      }, null, 2),
    );
  }

  // ---- 2) 分档榜单：rows 与三档 rank 同步剔除（不动成绩数字，只删已删 id）----
  let removedRows = 0, removedRank = 0;
  if (Array.isArray(regimeRaw.rows)) {
    const n = regimeRaw.rows.length;
    regimeRaw.rows = regimeRaw.rows.filter((r: { id: number }) => !dropIds.has(Number(r.id)));
    removedRows = n - regimeRaw.rows.length;
  }
  for (const g of ["强势", "震荡", "弱势"]) {
    if (!Array.isArray(regimeRaw.rank?.[g])) continue;
    const n = regimeRaw.rank[g].length;
    regimeRaw.rank[g] = regimeRaw.rank[g].filter((r: { id: number }) => !dropIds.has(Number(r.id)));
    removedRank += n - regimeRaw.rank[g].length;
  }
  regimeRaw.pruned = {
    at: new Date().toISOString(),
    dropped: [...dropIds],
    reason: "A 任务可成交性闸：要求涨停(买不进)或条件恒假(死策略)",
  };
  fs.writeFileSync(REGIME, JSON.stringify(regimeRaw, null, 2));
  console.log(`\n已写盘：strategies.json（${kept.length} 条）；strategy-regime.json 剔除 rows ${removedRows} 条 / 榜单 ${removedRank} 位`);

  // ---- 3) 留痕：删了什么、为什么，可回滚 ----
  const logPath = path.join(ROOT, "data", "pruned-strategies.json");
  // 幂等保护：本轮没判出新的待删项时，不许用空数组覆盖历史清单
  // （踩过：重复跑会把 dropped 写成 []，之后 strategy-regime.json 若被 build 重建就再也清不掉）
  if (rows.length) {
    fs.writeFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), reason: "可成交性闸", dropped: rows, backup: "data/strategies.json.bak-20260930-1720" }, null, 2));
    console.log(`删除清单 → ${logPath}`);
  } else {
    console.log(`删除清单未变动（本轮无新增），沿用 ${logPath} 里的 ${dropIds.size} 条`);
  }
}
