// 定时价格快照 API。
//
// GET  /api/daily-report/snapshots?date=YYYY-MM-DD&slot=1030|1130|close
//   → 读某日某张快照（没有落档返回 404，不现抓、不编）。
// GET  /api/daily-report/snapshots?date=YYYY-MM-DD&compare=1
//   → 读某日卖点对比（成本 = 卖出日之前最近一个交易日收盘价；卖点 = 卖出日 10:30 / 11:30 休盘 / 15:00 收盘，
//     带“什么时候卖最合适”结论）。
// POST /api/daily-report/snapshots?slot=1030|1130|close[&symbols=000001.SZ,600519.SH]
//   → 抓一张快照并落档（调度器在对应时刻调用：
//     10:30 → slot=1030（必须当时现抓）；11:30 → slot=1130（必须当时现抓）；
//     16:00 → slot=close（收盘价定稿）。
//     symbols 不传时用默认票池：卖出日 = 今天的 AI 优选版本票 + 上证/深证/创业板/沪深300。
//     没有任何版本在今天卖出时返回 { skipped: true, message: "今日无卖出快照" }，
//     不落档、不抓买入日/选股日的价格。symbols 显式传入时是操作员手动指定，不受门禁限制。
//     10:30 / 11:30 快照若在对应时刻之后才抓，抓到的是抓取时刻的价，capturedAt 照实写，
//     不要把它当对应时刻的价。成本（卖出日之前最近一个交易日收盘价）不随快照落档，日报生成时从 DB 现取。）
//
// 缺数据返回“没取到”，不编数据。

import { NextResponse } from "next/server";
import {
  capturePriceSnapshot,
  hasSellDayVersions,
  normalizeSnapshotSymbol,
  readPriceSnapshot,
  readSellComparisons,
} from "@/lib/desk/price-snapshots";
import { isSnapshotSlot } from "@/lib/desk/price-snapshots-core";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseSymbols(raw: string | null): { symbol: string; name: string }[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return undefined;
  return list.map((s) => {
    const symbol = normalizeSnapshotSymbol(s);
    return { symbol, name: symbol };
  });
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const date = sp.get("date") ?? shanghaiDate(new Date());
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ ok: false, error: `date 非法：${date}，格式 YYYY-MM-DD` }, { status: 400 });
  }
  if (sp.get("compare") === "1") {
    try {
      const { comparisons, snapshotsFound, sellDecisionDate } = await readSellComparisons(date);
      return NextResponse.json({ ok: true, date, snapshotsFound, sellDecisionDate, comparisons });
    } catch (e) {
      return NextResponse.json({ ok: false, error: `卖点对比读取失败：${(e as Error).message}` }, { status: 502 });
    }
  }
  const slot = sp.get("slot");
  if (!isSnapshotSlot(slot)) {
    return NextResponse.json(
      { ok: false, error: `slot 非法：${slot}，可选：1030、1130、close（或带 compare=1 读卖点对比）` },
      { status: 400 },
    );
  }
  const snap = await readPriceSnapshot(date, slot);
  if (!snap) {
    return NextResponse.json(
      { ok: false, error: `${date} 的${slot}快照没有落档（对应时刻没触发抓取，或抓取失败）` },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, ...snap });
}

export async function POST(req: Request) {
  const sp = new URL(req.url).searchParams;
  const slot = sp.get("slot");
  if (!isSnapshotSlot(slot)) {
    return NextResponse.json({ ok: false, error: `slot 非法：${slot}，可选：1030、1130、close` }, { status: 400 });
  }
  try {
    const symbols = parseSymbols(sp.get("symbols"));
    if (!symbols) {
      // 默认票池门禁：没有任何版本在今天卖出时不抓、不落档，写“今日无卖出快照”。
      // 买入日/选股日的价格不是卖点，绝不拿来顶替。
      const today = shanghaiDate(new Date());
      if (!(await hasSellDayVersions(today))) {
        return NextResponse.json({
          ok: true,
          skipped: true,
          date: today,
          slot,
          message: "今日无卖出快照：没有任何 AI 优选版本的卖出日是今天（卖出日 = 决策日之后第 2 个交易日），不抓买入日/选股日的价格。",
        });
      }
    }
    const snap = await capturePriceSnapshot(slot, symbols, new Date());
    return NextResponse.json({ ok: true, ...snap });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `快照抓取失败：${(e as Error).message}` }, { status: 502 });
  }
}
