/**
 * DSA 分数 × 持仓周期表现 对照台账（2026-10-21 Z 定：只记录，不调整策略）
 *
 * 用法：node scripts/dsa-score-track.mjs [--sell-date YYYY-MM-DD]
 * - 默认卖出日 = 今天（Asia/Shanghai）。
 * - 找决策日 D：版本文件 data/ai-pick-versions/<D>-*.json 中，D 的后第 2 个
 *   交易日（按 MyDesk 日K日期序列）== 卖出日的批次；同日多版本取最早一版。
 * - 每只票记一行到台账 jsonl（去重：同 decision_date+code 只记一次）：
 *   DSA 原始分/最终分/是否被钳制/分析日期 + D+1 开盘买入价 +
 *   卖出日 10:30/11:30/收盘三档净收益（扣 0.41% 成本）+ 收盘胜负（跑赢上证=胜）。
 * - stdout 打印按原始分从高到低的对照表，供结账汇报直接引用。
 * - quality 标记：决策日 < 2026-10-21 的批次是资金流压分修复前的分数，记
 *   pre_fix；之后记 fixed。检验分数区分度时两组分开看，不混。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = process.env.HOME;
const DESK_DB = path.join(HOME, "workspace/kairotrend-p1/prisma/prisma/db/custom.db");
const DSA_DB = path.join(HOME, "workspace/daily_stock_analysis/data/stock_analysis.db");
const VERSIONS_DIR = path.join(HOME, "workspace/kairotrend-p1/data/ai-pick-versions");
const GOAL_HIDDEN = path.join(
  HOME,
  "workspace/goals/mydesk-market-data-and-stock-picking-workflow/hidden_files"
);
const LEDGER = path.join(GOAL_HIDDEN, "dsa-score-track.jsonl");
const COST = 0.0041;
const FIX_BOUNDARY = "2026-10-21";

function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

const args = process.argv.slice(2);
const sellDateArg = args.includes("--sell-date")
  ? args[args.indexOf("--sell-date") + 1]
  : shanghaiToday();

const desk = new DatabaseSync(DESK_DB, { readOnly: true });
const dsa = new DatabaseSync(DSA_DB, { readOnly: true });

// 交易日序列（全市场日K日期并集，升序）
const tradeDates = desk
  .prepare("SELECT DISTINCT tradeDate FROM stock_daily_bar ORDER BY tradeDate")
  .all()
  .map((r) => r.tradeDate);
const tdIndex = new Map(tradeDates.map((d, i) => [d, i]));
function nthTradeDateAfter(date, n) {
  const i = tdIndex.get(date);
  if (i === undefined) return null;
  return tradeDates[i + n] ?? null;
}

// 候选批次：同决策日取最早版本
const byDecision = new Map();
for (const file of fs.readdirSync(VERSIONS_DIR).filter((f) => f.endsWith(".json"))) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(VERSIONS_DIR, file), "utf8"));
  } catch {
    continue;
  }
  const d = data.tradeDate;
  if (!d || !Array.isArray(data.picks)) continue;
  const prev = byDecision.get(d);
  if (!prev || String(data.runAt) < String(prev.data.runAt)) {
    byDecision.set(d, { file, data });
  }
}
const batches = [...byDecision.entries()]
  .filter(([,]) => true)
  .map(([decisionDate, v]) => ({ decisionDate, ...v }))
  .filter((b) => nthTradeDateAfter(b.decisionDate, 2) === sellDateArg);

if (batches.length === 0) {
  console.log(`NO_BATCH sell_date=${sellDateArg}（今日无卖出批次，不落账）`);
  process.exit(0);
}

function readSnapshot(slot) {
  const file = path.join(GOAL_HIDDEN, `snapshot-${slot}-${sellDateArg}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
const snap1030 = readSnapshot("1030");
const snap1130 = readSnapshot("1130");
const snapClose = readSnapshot("close");
function snapPrice(snap, symbol) {
  if (!snap || !Array.isArray(snap.rows)) return null;
  const row = snap.rows.find((r) => r.symbol === symbol);
  return row && typeof row.price === "number" ? row.price : null;
}
const indexRow =
  snapClose && Array.isArray(snapClose.rows)
    ? snapClose.rows.find((r) => r.symbol === "000001.SH")
    : null;
const indexChangePct =
  indexRow && typeof indexRow.changePct === "number" ? indexRow.changePct : null;

function dsaScore(bareCode, decisionDate, sellDate) {
  const rows = dsa
    .prepare(
      `SELECT id, sentiment_score AS score, raw_result, created_at FROM analysis_history
       WHERE code = ? AND report_type IN ('detailed', 'full')
         AND date(created_at) >= date(?) AND date(created_at) <= date(?)
       ORDER BY created_at DESC LIMIT 1`
    )
    .all(bareCode, decisionDate, sellDate);
  if (rows.length === 0) return null;
  const row = rows[0];
  let rawScore = row.score;
  let clamped = false;
  try {
    const parsed = JSON.parse(row.raw_result || "{}");
    const cal = parsed?.dashboard?.decision_score_calibration;
    if (cal && typeof cal.raw_score === "number") {
      rawScore = cal.raw_score;
      clamped = cal.clamped === true || rawScore !== row.score;
    }
  } catch {
    /* 解析失败按未钳制处理，raw=final */
  }
  return {
    analysis_id: row.id,
    analysis_date: String(row.created_at).slice(0, 10),
    score_raw: rawScore,
    score_final: row.score,
    clamped,
  };
}

const existing = new Set();
if (fs.existsSync(LEDGER)) {
  for (const line of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      existing.add(`${j.decision_date}|${j.code}`);
    } catch {
      /* 坏行忽略 */
    }
  }
}

const pct = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
let appended = 0;
const report = [];

for (const batch of batches) {
  const decisionDate = batch.decisionDate;
  const buyDate = nthTradeDateAfter(decisionDate, 1);
  const quality = decisionDate < FIX_BOUNDARY ? "pre_fix" : "fixed";
  const lines = [];
  for (const pick of batch.data.picks) {
    const symbol = pick.symbol;
    const bare = symbol.split(".")[0];
    const barBuy = desk
      .prepare(
        "SELECT open FROM stock_daily_bar WHERE symbol = ? AND tradeDate = ? AND adjust = 'qfq'"
      )
      .get(symbol, buyDate);
    const buyOpen = barBuy ? barBuy.open : null;
    const net = (sellPrice) =>
      buyOpen && sellPrice ? pct((sellPrice / buyOpen - 1 - COST) * 100) : null;
    const closePrice = snapPrice(snapClose, symbol);
    const netClose = net(closePrice);
    const score = dsaScore(bare, decisionDate, sellDateArg);
    const entry = {
      decision_date: decisionDate,
      buy_date: buyDate,
      sell_date: sellDateArg,
      code: bare,
      symbol,
      name: pick.name,
      version_file: batch.file,
      quality,
      dsa: score,
      buy_open: buyOpen,
      net_1030_pct: net(snapPrice(snap1030, symbol)),
      net_1130_pct: net(snapPrice(snap1130, symbol)),
      net_close_pct: netClose,
      index_change_pct: indexChangePct,
      win_close:
        netClose !== null && indexChangePct !== null ? netClose > indexChangePct : null,
      recorded_at: new Date().toISOString(),
    };
    lines.push(entry);
    const key = `${decisionDate}|${bare}`;
    if (!existing.has(key)) {
      fs.appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
      existing.add(key);
      appended += 1;
    }
  }
  report.push({ decisionDate, buyDate, quality, lines });
}

// ---- 打印对照表 ----
function spearman(pairs) {
  const n = pairs.length;
  if (n < 4) return null;
  const rank = (vals) => {
    const sorted = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(n);
    sorted.forEach(([v, i], r) => (ranks[i] = r + 1));
    return ranks;
  };
  const rx = rank(pairs.map((p) => p[0]));
  const ry = rank(pairs.map((p) => p[1]));
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? Math.round((num / Math.sqrt(dx * dy)) * 100) / 100 : null;
}

for (const { decisionDate, buyDate, quality, lines } of report) {
  const scored = lines
    .filter((l) => l.dsa && typeof l.dsa.score_raw === "number")
    .sort((a, b) => b.dsa.score_raw - a.dsa.score_raw);
  const unscored = lines.filter((l) => !l.dsa);
  console.log(
    `\n## DSA 分数对照 · 决策日 ${decisionDate} 批（买入 ${buyDate} → 卖出 ${sellDateArg}，分数质量=${quality}）`
  );
  console.log("| 名次 | 代码 | 名称 | DSA原始分 | 最终分 | 10:30净% | 11:30净% | 收盘净% | 胜负 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  scored.forEach((l, i) => {
    const f = (v) => (v === null || v === undefined ? "没取到" : v.toFixed(2));
    console.log(
      `| ${i + 1} | ${l.code} | ${l.name} | ${l.dsa.score_raw} | ${l.dsa.score_final} | ${f(l.net_1030_pct)} | ${f(l.net_1130_pct)} | ${f(l.net_close_pct)} | ${l.win_close === null ? "—" : l.win_close ? "胜" : "负"} |`
    );
  });
  for (const l of unscored) {
    console.log(`| - | ${l.code} | ${l.name} | 无DSA分析 | - | - | - | ${l.net_close_pct ?? "没取到"} | - |`);
  }
  const valid = scored.filter((l) => typeof l.net_close_pct === "number");
  if (valid.length) {
    const avg = valid.reduce((a, l) => a + l.net_close_pct, 0) / valid.length;
    let extra = `有分数样本 ${valid.length} 只，收盘平均净收益 ${avg.toFixed(2)}%`;
    if (valid.length >= 4) {
      const half = Math.floor(valid.length / 2);
      const hi = valid.slice(0, half);
      const lo = valid.slice(valid.length - half);
      const avgOf = (arr) => arr.reduce((a, l) => a + l.net_close_pct, 0) / arr.length;
      const rho = spearman(valid.map((l) => [l.dsa.score_raw, l.net_close_pct]));
      extra += `；高分半区均值 ${avgOf(hi).toFixed(2)}% vs 低分半区 ${avgOf(lo).toFixed(2)}%`;
      if (rho !== null) extra += `；分数-收益秩相关 ${rho}`;
    }
    console.log(extra + "。（只记录，不据此调整策略）");
  }
}
console.log(`\n台账新增 ${appended} 行 → ${LEDGER}`);
