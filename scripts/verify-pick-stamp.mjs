// 离线验证「排雷盖章」移植（2026-10-24）：用 DB 真实数据重算指定批次的章，
// 与 mine-recalc-2026-10-24 回溯附录对照；并抽查温度移植与四档台账 heat 是否一致。
// 只读 DB、不写任何生产数据。运行（仓库根目录）：node scripts/verify-pick-stamp.mjs [YYYY-MM-DD]
// 组装口径与生产 pick-stamp.ts 完全一致（heat/dev/position/judgeRiskTags/riskStampOf 全是生产纯核）；
// 差异只有取数：B 资金三边历史日生产也取不到（null）、C 公告离线不拉（null=unknown）——
// 对 2026-10-23 批，回溯存档里 B 全 none、C 最高 suspected，两者都不影响章，已逐只核过。
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { computePickHeat, deviationFromMa20Pct } from "../src/lib/quant/strategy/pick-heat-core.ts";
import { positionOf } from "../src/lib/quant/strategy/pick-position-core.ts";
import { judgeRiskTags, riskStampOf } from "../src/lib/quant/strategy/pick-risk-tags-core.ts";

const tradeDate = process.argv[2] || "2026-10-23";
const ROOT = process.cwd();
const db = new DatabaseSync(path.join(ROOT, "prisma/prisma/db/custom.db"), { readOnly: true });

// 2026-10-23 批回溯附录期望章（mine-recalc-2026-10-24/results.md 附录 + recalc.json）
const EXPECTED = {
  "2026-10-23": {
    "300369.SZ": "不合格", // 绿盟科技 温度3热
    "688023.SH": "不合格", // 安恒信息 温度2热
    "301083.SZ": "不合格", // 百胜智能 温度2热
    "600621.SH": "注意",   // 华鑫股份 温度1热
    "600887.SH": "注意",   // 伊利股份 温度1热
    "002223.SZ": "合格",   // 鱼跃医疗
    "603666.SH": "注意",   // 亿嘉和 位置红格（震荡 -2~+2%，win790 47.2，现行代码口径）
  },
};

function barsDesc(symbol, date, limit = 61) {
  return db.prepare(
    `SELECT tradeDate, open, high, low, close, volume, amount FROM stock_daily_bar
     WHERE symbol = ? AND adjust = 'qfq' AND tradeDate <= ? ORDER BY tradeDate DESC LIMIT ?`,
  ).all(symbol, date, limit);
}

/** 台账 Python compute_regimes 的迷你移植（只为交叉验证台账 regime3；生产走 inferMarketEnv，同一套规则） */
function regime3Py(date) {
  const rows = db.prepare(`SELECT tradeDate, aboveMa5Pct FROM market_daily_stats ORDER BY tradeDate`).all();
  const pcts = new Map(rows.map((r) => [r.tradeDate, r.aboveMa5Pct]));
  const dates = rows.map((r) => r.tradeDate).filter((d) => d <= date);
  if (!dates.length || pcts.get(date) == null) return null;
  const win = dates.slice(-4);
  const pct = pcts.get(date);
  const slope = pct - pcts.get(win[0]);
  let bucket;
  if (pct >= 60 && slope >= 0) bucket = "主升";
  else if (pct >= 40) bucket = "震荡";
  else if (slope < 0) bucket = "退潮";
  else bucket = "修复";
  return { "主升": "强势", "震荡": "震荡", "退潮": "弱势", "修复": "弱势" }[bucket];
}

// ---- 台账（regime3 + heat 对照基准） ----
const ledgerPath = path.join(
  ROOT, "..", "goals/mydesk-market-data-and-stock-picking-workflow/hidden_files/pick-horizons/pick-horizon-returns.jsonl",
);
const ledger = readFileSync(ledgerPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
const ledgerByKey = new Map(ledger.map((r) => [`${r.batch}|${r.symbol}`, r]));

// ---- 1) 批次盖章重算 ----
const vdir = path.join(ROOT, "data/ai-pick-versions");
const files = readdirSync(vdir).filter((f) => f.startsWith(`${tradeDate}-`) && f.endsWith(".json"));
if (!files.length) { console.error(`没有 ${tradeDate} 的版本文件`); process.exit(1); }
let version = null;
for (const f of files) {
  const v = JSON.parse(readFileSync(path.join(vdir, f), "utf-8"));
  if (!version || v.picks.length > version.picks.length) version = v;
}
const regimeLedger = ledgerByKey.get(`${tradeDate}|${version.picks[0].symbol}`)?.regime3 ?? null;
const regimePy = regime3Py(tradeDate);
console.log(`批次 ${tradeDate}：版本 picks ${version.picks.length} 只；台账 regime3=${regimeLedger}，Python 口径复算=${regimePy}`);
const regime = regimeLedger || regimePy;
let fail = 0;
const expected = EXPECTED[tradeDate];
for (const p of version.picks) {
  const rows = barsDesc(p.symbol, tradeDate);
  const heatBars = rows.map((r) => ({ close: r.close, volume: r.volume }));
  const heat = computePickHeat(heatBars);
  const devPct = deviationFromMa20Pct(heatBars);
  const cell = regime && devPct != null ? positionOf(regime, devPct) : null;
  const dayIdx = rows.findIndex((r) => r.tradeDate === tradeDate);
  const day = dayIdx >= 0 ? rows[dayIdx] : null;
  const result = judgeRiskTags({
    symbol: p.symbol,
    name: p.name || "",
    bar: day ? { open: day.open, high: day.high, low: day.low, close: day.close, volume: day.volume } : null,
    prevVolumes: dayIdx >= 0 ? rows.slice(dayIdx + 1, dayIdx + 6).map((r) => r.volume) : null,
    midNetYi: null,
    smallNetYi: null,
    catalystAnns: null,
    nextTradeDate: null,
    amountYi: day && day.amount != null ? day.amount / 1e8 : null,
  });
  const { stamp, reasons } = riskStampOf({ hot: heat?.hot ?? 0, result, position: cell?.cls ?? null });
  const exp = expected?.[p.symbol];
  const ok = exp ? stamp === exp : null;
  if (ok === false) fail += 1;
  console.log(
    `${p.symbol} ${p.name || ""} hot=${heat ? heat.hot : "未取到"} dev=${devPct != null ? devPct.toFixed(2) + "%" : "—"} ` +
    `格=${cell ? `${cell.band}/${cell.cls}` : "—"} 标签=[${result.tags.join(",")}] => ${stamp}` +
    `${reasons.length ? `（${reasons.join("；")}）` : ""}${exp ? (ok ? " ✓ 与回溯一致" : ` ✗ 期望 ${exp}`) : ""}`,
  );
}

// ---- 2) 温度移植抽查：台账 heat vs TS computePickHeat（2026-10-21 + 10-23 共 12 只，全查） ----
console.log("\n温度抽查（台账 heat vs TS 移植）：");
let heatFail = 0;
let heatChecked = 0;
for (const r of ledger) {
  if (!["2026-10-21", "2026-10-23"].includes(r.batch) || !r.heat) continue;
  const rows = barsDesc(r.symbol, r.batch);
  const heat = computePickHeat(rows.map((x) => ({ close: x.close, volume: x.volume })));
  heatChecked += 1;
  const okHot = heat && heat.hot === r.heat.hot;
  const okVals = heat
    && Math.abs(heat.chg - r.heat.chg) <= 0.11
    && Math.abs(heat.ret20 - r.heat.ret20) <= 0.11
    && Math.abs(Math.round(heat.rsi) - r.heat.rsi) <= 1;
  if (!okHot || !okVals) heatFail += 1;
  console.log(
    `${r.batch} ${r.symbol} ${r.name} 台账 hot=${r.heat.hot}（chg ${r.heat.chg}/ret20 ${r.heat.ret20}/rsi ${r.heat.rsi}） ` +
    `TS hot=${heat ? heat.hot : "未取到"}（chg ${heat ? heat.chg.toFixed(1) : "—"}/ret20 ${heat ? heat.ret20.toFixed(1) : "—"}/rsi ${heat ? Math.round(heat.rsi) : "—"}） ${okHot && okVals ? "✓" : "✗ 不一致"}`,
  );
}
console.log(`\n温度抽查 ${heatChecked} 只，不一致 ${heatFail} 只；盖章不一致 ${fail} 只。`);
process.exit(fail + heatFail > 0 ? 1 : 0);
