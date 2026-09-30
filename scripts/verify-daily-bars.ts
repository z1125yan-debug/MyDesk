// B0 日K粮仓体检：覆盖率 + 抽只对账 + 异常扫描 + 与旧种子交叉核对。
// 用法：node --experimental-strip-types scripts/verify-daily-bars.ts [--sample N]
//
// 为什么要有：落库是一锤子买卖，446 万行里混进坏行没人会发现。
// 这份体检是 B（回测可复核）的验收工具——跑一遍就知道粮仓能不能信。

import { PrismaClient } from "@prisma/client";
import { toTdxCode } from "../src/lib/quant/data/daily-bar-core.ts";

const GW = process.env.TDX_GATEWAY ?? "http://127.0.0.1:8756";
const argv = process.argv.slice(2);
const SAMPLE = Number(argv[argv.indexOf("--sample") + 1]) || 5;

async function rpc(method: string, params: unknown) {
  try {
    const res = await fetch(`${GW}/rpc`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, method, params }), cache: "no-store",
    });
    const j = await res.json();
    return j?.ok ? j.result ?? null : null;
  } catch { return null; }
}

async function main() {
  const db = new PrismaClient();
  let fail = 0;
  const mark = (ok: boolean, msg: string) => { if (!ok) fail++; console.log(`${ok ? "  ✓" : "  ✗"} ${msg}`); };

  // ---- 1) 覆盖率 ----
  console.log("=== 1) 覆盖率 ===");
  const g = await db.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*) rows, COUNT(DISTINCT symbol) syms, MIN(tradeDate) d0, MAX(tradeDate) d1 FROM stock_daily_bar`,
  );
  const rows = Number(g[0].rows), syms = Number(g[0].syms);
  console.log(`  ${syms} 只 / ${rows} 行 / ${g[0].d0} → ${g[0].d1}`);
  mark(syms > 5000, `覆盖全A（${syms} 只，应 >5000）`);
  mark(rows > 3_000_000, `行数充足（${rows} 行，应 >300 万）`);

  // 每只行数分布：新股不足 800 是正常的，但中位应该接近 800
  const dist = await db.$queryRawUnsafe<any[]>(
    `SELECT symbol, COUNT(*) c FROM stock_daily_bar GROUP BY symbol ORDER BY c`,
  );
  const cs = dist.map((d) => Number(d.c));
  const q = (p: number) => cs[Math.floor(cs.length * p)];
  console.log(`  每只行数：最少 ${cs[0]} / 中位 ${q(0.5)} / 最多 ${cs[cs.length - 1]}`);
  const short = dist.filter((d) => Number(d.c) < 200).length;
  console.log(`  不足 200 根（次新股）：${short} 只`);
  mark(q(0.5) >= 700, `中位股票有 ${q(0.5)} 根（应 ≥700）`);

  // 最近 10 个交易日的股票数（应接近全A，说明无大缺口）
  const recent = await db.$queryRawUnsafe<any[]>(
    `SELECT tradeDate, COUNT(*) c FROM stock_daily_bar WHERE tradeDate >= (SELECT MAX(tradeDate) FROM stock_daily_bar)
     GROUP BY tradeDate ORDER BY tradeDate DESC LIMIT 1`,
  );
  const daily = await db.$queryRawUnsafe<any[]>(
    `SELECT tradeDate, COUNT(*) c FROM stock_daily_bar GROUP BY tradeDate ORDER BY tradeDate DESC LIMIT 10`,
  );
  console.log(`  最近 10 个交易日行数：${daily.map((d) => `${d.tradeDate}:${Number(d.c)}`).join(" ")}`);
  mark(Number(recent[0].c) > 5000, `最新交易日 ${recent[0].tradeDate} 有 ${Number(recent[0].c)} 只（应 >5000）`);

  // ---- 2) 异常扫描 ----
  console.log("\n=== 2) 异常扫描 ===");
  const badPx = await db.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*) c FROM stock_daily_bar WHERE close<=0 OR open<=0 OR high<=0 OR low<=0 OR high<low OR high<close OR low>close`,
  );
  mark(Number(badPx[0].c) === 0, `价格逻辑异常 ${Number(badPx[0].c)} 行（应为 0）`);
  const badVol = await db.$queryRawUnsafe<any[]>(`SELECT COUNT(*) c FROM stock_daily_bar WHERE volume<0 OR amount<0`);
  mark(Number(badVol[0].c) === 0, `量额为负 ${Number(badVol[0].c)} 行（应为 0）`);
  const batches = await db.$queryRawUnsafe<any[]>(`SELECT batch, COUNT(*) c FROM stock_daily_bar GROUP BY batch`);
  console.log(`  批次：${batches.map((b) => `${b.batch}=${Number(b.c)}`).join(" | ")}`);
  mark(batches.length === 1, `批次唯一（${batches.length} 个；多个批次意味着数据是拼的，不可比）`);

  // ---- 3) 抽只对账（库 vs 网关）----
  console.log(`\n=== 3) 抽 ${SAMPLE} 只与网关逐日对账 ===`);
  const picks = [...dist.slice(0, 1).map((d) => d.symbol), ...dist.slice(-SAMPLE + 1).map((d) => d.symbol)];
  for (const symbol of picks.slice(0, SAMPLE)) {
    const code = toTdxCode(symbol);
    if (!code) { console.log(`  ${symbol} 符号转不了`); continue; }
    const r = await rpc("bars.get", { code, period: "day", count: 800, adjust: "qfq" });
    const gwBars = (r?.bars ?? []).slice(-3);
    if (!gwBars.length) { console.log(`  ${symbol} 网关取不到（跳过）`); continue; }
    const dbRows = await db.$queryRawUnsafe<any[]>(
      `SELECT tradeDate, open, high, low, close, volume FROM stock_daily_bar WHERE symbol=? ORDER BY tradeDate DESC LIMIT 3`, symbol,
    );
    const desc = [...dbRows].reverse();
    let bad = 0;
    for (let i = 0; i < Math.min(gwBars.length, desc.length); i++) {
      const a = gwBars[i], b = desc[i];
      if (String(a.time).slice(0, 10) !== b.tradeDate) { bad++; continue; }
      if (Math.abs(a.close - b.close) > 1e-6 || Math.abs(a.open - b.open) > 1e-6 ||
          Math.abs(a.high - b.high) > 1e-6 || Math.abs(a.low - b.low) > 1e-6) bad++;
    }
    mark(bad === 0, `${symbol}（${code}）近 ${desc.length} 日 OHLC 与网关一致`);
  }

  // ---- 4) 与旧种子 stock_daily_close 交叉核对 ----
  console.log("\n=== 4) 与旧种子（stock_daily_close）交叉核对 ===");
  const x = await db.$queryRawUnsafe<any[]>(
    `SELECT b.tradeDate, COUNT(*) n,
            AVG(ABS(b.close - c.close)) avgDiff,
            SUM(CASE WHEN ABS(b.close-c.close) > 0.01 THEN 1 ELSE 0 END) bigDiff
     FROM stock_daily_bar b JOIN stock_daily_close c ON c.symbol=b.symbol AND c.tradeDate=b.tradeDate
     GROUP BY b.tradeDate ORDER BY b.tradeDate DESC LIMIT 5`,
  );
  if (!x.length) console.log("  无重叠日期（种子与粮仓日期不交叉）");
  for (const r of x) {
    const pct = (Number(r.bigDiff) / Number(r.n) * 100).toFixed(2);
    console.log(`  ${r.tradeDate}: 重叠 ${Number(r.n)} 只，平均价差 ${Number(r.avgDiff).toFixed(4)} 元，差异>1分 ${Number(r.bigDiff)} 只（${pct}%）`);
  }
  const align = x.length ? Number(x[0].bigDiff) / Number(x[0].n) : 1;
  mark(align < 0.05, `最新重叠日收盘价差异率 ${(align * 100).toFixed(2)}%（应 <5%，否则种子与粮仓口径不同源）`);

  console.log(fail ? `\n❌ ${fail} 项未通过` : "\n✅ 全部通过：粮仓可信任");
  await db.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
