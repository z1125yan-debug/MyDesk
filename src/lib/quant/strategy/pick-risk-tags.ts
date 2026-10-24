// AI 优选「风险观察标签」取数层（服务端）：DB 日 K（A）+ 富化资金三边（B）+ 巨潮公告历史（C）。
// 判定全在 pick-risk-tags-core.ts（纯函数）；本层只负责把真实数据喂进去、把命中写进观察台账。
// 纪律：任一数据源失败 → 该项按“没取到”处理（A 无 K 线不判、B 资金 null 不触发、C 抓取失败
// 记 unknown），绝不编；本层任何失败都不许阻塞优选主流程（调用方整体 catch）。

import "server-only";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { db } from "../../db.ts";
import { fetchCninfoStockHistory } from "../../desk/cninfo.ts";
import { nthTradingDayAfter } from "../../desk/trade-calendar.ts";
import {
  RISK_TAG_CATALYST_ON_BUYDAY,
  RISK_TAG_RETAIL_CATCH,
  judgeRiskTags,
  type RiskTagAnn,
  type RiskTagResult,
} from "./pick-risk-tags-core.ts";
import type { AiPickCandidate } from "./ai-pick-core.ts";

const ADJUST = "qfq";

/** 观察台账（goal hidden_files；一行一条命中，攒样本用，不进仓库数据目录） */
const LEDGER_FILE = path.join(
  homedir(),
  "workspace/goals/mydesk-market-data-and-stock-picking-workflow/hidden_files/pick-risk-tags.jsonl",
);

/** "YYYY-MM-DD" 往前推 n 个自然日（UTC 计算，不受本地时区影响） */
function minusDays(dateStr: string, n: number): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(ms)) return dateStr;
  return new Date(ms - n * 86_400_000).toISOString().slice(0, 10);
}

interface BarRow {
  symbol: string;
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 批量取优选票在决策日及之前的 K 线（每只最多 6 根：当日 + 前 5 个交易日）。DB 失败 → 空 Map。 */
async function fetchBarsForTags(
  tradeDate: string,
  symbols: string[],
): Promise<Map<string, { bar: BarRow | null; prevVolumes: number[] }>> {
  const out = new Map<string, { bar: BarRow | null; prevVolumes: number[] }>();
  if (!symbols.length) return out;
  try {
    const inList = symbols.map(() => "?").join(",");
    const rows = await db.$queryRawUnsafe<BarRow[]>(
      `SELECT symbol, tradeDate, open, high, low, close, volume FROM stock_daily_bar
       WHERE adjust = ? AND tradeDate <= ? AND symbol IN (${inList})
       ORDER BY symbol ASC, tradeDate DESC`,
      ADJUST, tradeDate, ...symbols,
    );
    const grouped = new Map<string, BarRow[]>();
    for (const r of rows) {
      const key = String(r.symbol).toUpperCase();
      const arr = grouped.get(key) ?? [];
      if (arr.length < 6) arr.push(r);
      grouped.set(key, arr);
    }
    for (const [key, arr] of grouped) {
      const dayBar = arr.length && arr[0].tradeDate === tradeDate ? arr[0] : null;
      const prevVolumes = arr
        .filter((r) => r.tradeDate < tradeDate)
        .slice(0, 5)
        .map((r) => Number(r.volume));
      out.set(key, { bar: dayBar, prevVolumes });
    }
  } catch {
    // DB 失败：返回空 Map，A 项全部按没取到处理
  }
  return out;
}

/**
 * 给一批已定稿的优选票逐只算风险观察标签（只标注，不改变任何选股结果）。
 * A 用 DB 决策日日 K + 前 5 交易日量；B 用富化时已取到的资金三边（历史日为 null，不触发）；
 * C 用巨潮历史公告扫决策日前 20 日（2026-10-21 由 10 日放宽：舒华说明会公告发于决策日前 16 天），买入日 = 决策日后第 1 个交易日（交易日历，取不到为 null）。
 */
export async function computePickRiskTags(
  tradeDate: string,
  picked: readonly AiPickCandidate[],
): Promise<RiskTagResult[]> {
  if (!picked.length) return [];
  const symbols = picked.map((p) => p.symbol);
  const barMap = await fetchBarsForTags(tradeDate, symbols);
  const nextTradeDate = nthTradingDayAfter(tradeDate, 1);
  const startDate = minusDays(tradeDate, 20);

  // C：逐只拉巨潮历史公告（并发；单只失败 → null = unknown，不阻塞其它只）
  const annMap = new Map<string, RiskTagAnn[] | null>();
  await Promise.all(picked.map(async (p) => {
    const key = p.symbol.toUpperCase();
    try {
      const anns = await fetchCninfoStockHistory(p.symbol, startDate, tradeDate);
      annMap.set(key, anns.map((a) => ({ title: a.title, date: a.date })));
    } catch {
      annMap.set(key, null);
    }
  }));

  return picked.map((p) => {
    const key = p.symbol.toUpperCase();
    const bars = barMap.get(key);
    return judgeRiskTags({
      symbol: p.symbol,
      name: p.name || "",
      bar: bars?.bar
        ? {
            open: Number(bars.bar.open),
            high: Number(bars.bar.high),
            low: Number(bars.bar.low),
            close: Number(bars.bar.close),
            volume: Number(bars.bar.volume),
          }
        : null,
      prevVolumes: bars?.prevVolumes ?? null,
      midNetYi: p.midNetYi ?? null,
      smallNetYi: p.smallNetYi ?? null,
      catalystAnns: annMap.get(key) ?? null,
      nextTradeDate,
      amountYi: p.amountYi ?? null,
    });
  });
}

/** 把命中（含 C 疑似）逐条追加进观察台账 jsonl（一行一条）。无命中不写。失败由调用方 catch，不阻塞主流程。 */
export async function appendRiskTagLedger(
  tradeDate: string,
  results: readonly RiskTagResult[],
  runAt: string,
): Promise<void> {
  const lines: string[] = [];
  for (const r of results) {
    for (const h of r.hits) {
      const evidence: Record<string, number | string | null> = {};
      if (h.pullbackPct != null) evidence.pullbackPct = h.pullbackPct;
      if (h.shadowShare != null) evidence.shadowShare = h.shadowShare;
      if (h.volRatio != null) evidence.volRatio = h.volRatio;
      if (h.midNetYi != null) evidence.midNetYi = h.midNetYi;
      if (h.smallNetYi != null) evidence.smallNetYi = h.smallNetYi;
      if (h.midSharePct != null) evidence.midSharePct = h.midSharePct;
      if (h.amountYi != null) evidence.amountYi = h.amountYi;
      if (h.tag === RISK_TAG_RETAIL_CATCH) {
        // B 的量级不足是 suspected（备忘），台账必须把 status 记下来，别冒充确认命中
        evidence.status = h.status ?? "confirmed";
      }
      if (h.tag === RISK_TAG_CATALYST_ON_BUYDAY) {
        evidence.status = h.status ?? "confirmed";
        evidence.eventDate = h.eventDate ?? null;
        evidence.annTitle = h.annTitle ?? null;
        evidence.annDate = h.annDate ?? null;
      }
      lines.push(JSON.stringify({
        tradeDate,
        symbol: r.symbol,
        name: r.name,
        tag: h.tag,
        evidence,
        source: "auto",
        runAt,
      }));
    }
  }
  if (!lines.length) return;
  await fs.mkdir(path.dirname(LEDGER_FILE), { recursive: true });
  await fs.appendFile(LEDGER_FILE, `${lines.join("\n")}\n`, "utf-8");
}
