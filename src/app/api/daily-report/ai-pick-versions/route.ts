// AI 优选分版胜率接口（与晚报“AI 优选分版胜率”一节用同一份 compute 结果，两处呈现同一份对比）。
//
// GET /api/daily-report/ai-pick-versions?decisionDate=YYYY-MM-DD[&evalDate=YYYY-MM-DD]
//   → 该决策日各版本 + 在卖出日三个时刻（10:30 / 11:30 休盘 / 15:00 收盘）的
//     每版平均涨跌 + 胜率（跑赢上证算赢）+ 晚报文案。
//   evalDate 不传时取卖出日（决策日之后第 2 个交易日，D+2）；evalDate 不是卖出日时
//   拒绝评估（买入日/选股日的快照不能当卖点用）。
// GET /api/daily-report/ai-pick-versions?tradeDate=YYYY-MM-DD
//   → 只列该决策日的版本（不算胜率）。
//
// 缺数据返回“没取到”，不编数据。

import { NextResponse } from "next/server";
import {
  buildAiPickVersionWinRateSection,
  computeAiPickVersionStats,
  sellDayOfDecision,
} from "@/lib/desk/ai-pick-version-stats";
import { listAiPickVersions } from "@/lib/quant/strategy/ai-pick-versions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const decisionDate = sp.get("decisionDate") ?? sp.get("tradeDate") ?? "";
  if (!DATE_RE.test(decisionDate)) {
    return NextResponse.json(
      { ok: false, error: `decisionDate 非法：${decisionDate}，格式 YYYY-MM-DD` },
      { status: 400 },
    );
  }
  const evalDateRaw = sp.get("evalDate") ?? "";
  if (evalDateRaw && !DATE_RE.test(evalDateRaw)) {
    return NextResponse.json(
      { ok: false, error: `evalDate 非法：${evalDateRaw}，格式 YYYY-MM-DD` },
      { status: 400 },
    );
  }
  try {
    // 只列版本（tradeDate 口径）：不算胜率
    if (sp.has("tradeDate") && !sp.has("decisionDate") && !sp.has("evalDate")) {
      const versions = await listAiPickVersions(decisionDate);
      return NextResponse.json({ ok: true, decisionDate, versions });
    }
    const evalDate = evalDateRaw || sellDayOfDecision(decisionDate) || "";
    if (!evalDate) {
      const versions = await listAiPickVersions(decisionDate);
      return NextResponse.json({
        ok: true,
        decisionDate,
        evalDate: null,
        versions,
        stats: [],
        section: `AI 优选分版胜率：${decisionDate} 的卖出日算不出（交易日历覆盖不到），算不出验证结果。`,
      });
    }
    const stats = await computeAiPickVersionStats(decisionDate, evalDate);
    return NextResponse.json({
      ok: true,
      decisionDate,
      evalDate,
      versions: stats.versions.map((v) => v.version),
      stats: stats.versions,
      missing: stats.missing,
      section: buildAiPickVersionWinRateSection(decisionDate, evalDate, stats.versions, stats.missing),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `分版胜率读取失败：${(e as Error).message}` },
      { status: 502 },
    );
  }
}
