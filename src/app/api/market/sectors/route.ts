// GET /api/market/sectors — 行业板块排行（P1-2）
// 复用既有封装 fetchBoardReal（东财板块榜，流入+流出两侧合并）；
// RPS 为本榜单内涨幅截面百分位（派生指标，口径随榜单范围变化，前端已警示）。
// 现有数据源封装不含成交额/上涨家数/涨停家数/持续天数 → 显式列入 missing，不做演示兜底。
// P15-R7：东财断源、腾讯兜底只剩涨幅占位（或概念线整条没数）时，整榜换同花顺资金流榜
// （独立上游）——净额是真数，但同花顺无净占比/超大单/大单拆分，行上带 breakdownMissing，
// 页面该列显「—」；THS 前缀码非东财 BK 口径，成分股/去选股递棒自然禁用（宁缺不假）。
import { NextResponse } from "next/server";
import { fetchBoardReal } from "@/lib/desk/em";
import { fetchThsBoards, thsToRankRow } from "@/lib/desk/ths";
import { shanghaiStamp } from "@/lib/desk/session";

export const dynamic = "force-dynamic";

interface RankRow {
  code: string; secid: string; name: string;
  changePct: number; main: number; ratio: number; superBig: number; big: number; leader: string;
  fundsMissing?: boolean; breakdownMissing?: boolean; rps?: number;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") === "concept" ? "concept" : "industry";
  const size = Math.max(20, Math.min(500, Number(url.searchParams.get("size") ?? 200)));

  const [inRows, outRows] = await Promise.all([
    fetchBoardReal(kind, "in", size),
    fetchBoardReal(kind, "out", size),
  ]);

  const merged = new Map<string, RankRow>();
  for (const r of [...(inRows ?? []), ...(outRows ?? [])]) {
    if (!r.code || merged.has(r.code)) continue;
    merged.set(r.code, r);
  }
  let list = [...merged.values()];
  let fromThs = false;
  const allPlaceholder = list.length > 0 && list.every((r) => r.fundsMissing);
  if (!list.length || allPlaceholder) {
    const ths = await fetchThsBoards(kind);
    if (ths.length) {
      list = ths.map(thsToRankRow);
      fromThs = true;
    }
  }
  if (!list.length) {
    return NextResponse.json(
      { ok: false, error: "板块数据源暂不可用（东财 clist、腾讯板块兜底与同花顺资金流榜均无返回）" },
      { status: 502 },
    );
  }

  list.sort((a, b) => b.changePct - a.changePct);

  // 榜单内涨幅百分位（0-100）
  const n = list.length;
  list.forEach((row, i) => {
    row.rps = n > 1 ? ((n - 1 - i) / (n - 1)) * 100 : 100;
  });

  const missing = [
    "成交额（现有 fetchBoardReal 封装不含 f6 字段）",
    "上涨家数/涨停家数（现有封装不含板块广度字段）",
    "持续强势天数（需板块历史序列，现有封装无板块日K）",
  ];
  if (fromThs) {
    missing.push(
      kind === "concept"
        ? "净占比/超大单/大单拆分：本榜已切同花顺概念资金流榜（东财断源），净额=流入−流出、按涨幅取前 150，深跌净流出的概念可能不在榜"
        : "净占比/超大单/大单拆分：本榜已切同花顺行业资金流榜（东财断源），净额=流入−流出口径",
    );
  }

  return NextResponse.json({
    ok: true,
    kind,
    list,
    as_of: shanghaiStamp(),
    source: fromThs ? "ths" : "em",
    missing,
    note: fromThs
      ? "RPS=本榜单内涨幅截面百分位（非全市场口径）；主力净额为同花顺净额口径（流入−流出），非东财主力净额拆分口径"
      : "RPS=本榜单内涨幅截面百分位（非全市场口径）；主力净额缺失的板块不参与榜单",
  });
}
