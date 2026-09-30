// P34-1：把一次性回测产物 data/_probe-strategy-regime.json 转为可入库的 data/strategy-regime.json，
// 并用纯核 regime-core 的三档排名与快照「情绪分类策略选择.txt」交叉验证。
//
// 为什么不在脚本里自己 sort：排名口径必须只有一处（regime-core），
// 否则线上弹卡和这份快照迟早各说一套（R20b 宽度那格的前车之鉴）。
//
// 用法：node --experimental-strip-types scripts/build-strategy-regime.ts [--check]
//   --check：只校验不写盘

import fs from "node:fs";
import path from "node:path";
import { regimeRankOf, type RegimeRow, type Regime } from "../src/lib/quant/strategy/regime-core.ts";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "data", "_probe-strategy-regime.json");
const OUT = path.join(ROOT, "data", "strategy-regime.json");
const SNAP = path.join(ROOT, "情绪分类策略选择.txt");
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(SRC)) {
  console.error("缺少源回测数据 data/_probe-strategy-regime.json（被 .gitignore 排除的一次性产物）");
  process.exit(1);
}

const probe = JSON.parse(fs.readFileSync(SRC, "utf8"));
const rawRows = Array.isArray(probe?.rows) ? probe.rows : [];
if (!rawRows.length) {
  console.error("源数据 rows 为空，拒绝产出空榜");
  process.exit(1);
}

// 规范化：三档缺失补 null（「没成绩」≠「0 次」，不许用 0 占位）
const rows: RegimeRow[] = rawRows.map((r: any) => ({
  id: Number(r.id),
  name: String(r.name ?? ""),
  condsText: String(r.condsText ?? ""),
  n1: Number(r.n1 ?? 0),
  win1: Number(r.win1 ?? 0),
  avg1: Number(r.avg1 ?? 0),
  avg5: Number(r.avg5 ?? 0),
  n110: Number(r.n110 ?? 0),
  win110: Number(r.win110 ?? 0),
  强势: r.强势 ? { n: Number(r.强势.n), win: Number(r.强势.win), avg: Number(r.强势.avg), avg5: Number(r.强势.avg5) } : null,
  震荡: r.震荡 ? { n: Number(r.震荡.n), win: Number(r.震荡.win), avg: Number(r.震荡.avg), avg5: Number(r.震荡.avg5) } : null,
  弱势: r.弱势 ? { n: Number(r.弱势.n), win: Number(r.弱势.win), avg: Number(r.弱势.avg), avg5: Number(r.弱势.avg5) } : null,
}));

const REGIMES: Regime[] = ["强势", "震荡", "弱势"];
const rank: Record<string, { id: number; name: string; stat: { n: number; win: number; avg: number; avg5: number }; win1: number; n1: number }[]> = {};
for (const g of REGIMES) {
  // 门槛只在 regime-core 里定义一处（2026-09-30 提到该档≥100 / 全期≥150）；
  // 这里不许再写死 20/30——写过一次，删掉涨停策略后让 n=22 的噪音占了榜首。
  rank[g] = regimeRankOf(rows, g, { limit: 15 }).items;
}

// ---- 交叉验证：与快照 txt 的三档第一名比对（口径一致性，不是回归测试） ----
const snapExists = fs.existsSync(SNAP);
const snapTop: Record<string, string | null> = {};
if (snapExists) {
  const txt = fs.readFileSync(SNAP, "utf8");
  let cur: string | null = null;
  for (const line of txt.split(/\r?\n/)) {
    const h = /【(强势|震荡|弱势)期/.exec(line);
    if (h) { cur = h[1]; snapTop[cur] = null; continue; }
    const m = /^\s*1\.\s*(\S+)\s*［/.exec(line);
    if (m && cur && snapTop[cur] == null) snapTop[cur] = m[1];
  }
}
console.log("=== 三档 Top3（纯核算出）===");
let mismatch = 0;
for (const g of REGIMES) {
  const top3 = (rank[g] || []).slice(0, 3);
  console.log(
    `${g}: ` + top3.map((i) => `${i.name}(n=${i.stat.n} win=${i.stat.win.toFixed(0)}% avg=${i.stat.avg.toFixed(2)}%)`).join(" | "),
  );
  if (snapTop[g] && top3[0] && top3[0].name !== snapTop[g]) {
    console.warn(`  ⚠ 与快照 txt 第一名不一致：纯核=${top3[0].name} 快照=${snapTop[g]}`);
    mismatch++;
  }
}
console.log(`快照比对：${snapExists ? (mismatch ? `${mismatch} 处不一致` : "三档第一名全部一致 ✓") : "快照不存在，跳过"}`);

if (checkOnly) {
  console.log("--check：只校验不写盘");
  process.exit(mismatch ? 1 : 0);
}

const out = {
  // 数据窗口来自回测口径：全A ~5369 只 × 约 300 个交易日（前复权日K）
  generatedAt: probe.generatedAt ?? null,
  builtAt: new Date().toISOString(),
  source: "data/_probe-strategy-regime.json（一次性回测产物，.gitignore 排除）",
  window: { universe: 5369, bars: 300, note: "全A前复权日K，约 14 个月；量能因子口径已修正（eltdx 键 volume_wire_value）" },
  regimeMethod: "上证指数 MA20 趋势法：收盘在 MA20 上且 MA20 向上=强势；之下且向下=弱势；其余=震荡",
  thresholds: { minHits: 100, minTotal: 150, note: "该档命中≥100 且全期≥150 才进榜（门槛在 regime-core，此处只作留痕）" },
  counts: {
    rows: rows.length,
    强势: (rank.强势 || []).length,
    震荡: (rank.震荡 || []).length,
    弱势: (rank.弱势 || []).length,
  },
  rank,
  rows,
};

fs.writeFileSync(OUT, JSON.stringify(out));
const stat = fs.statSync(OUT);
console.log(`\n已写出 ${OUT}（${(stat.size / 1024).toFixed(0)}KB）：rows=${rows.length}，三档榜单 ${out.counts.强势}/${out.counts.震荡}/${out.counts.弱势} 条`);
