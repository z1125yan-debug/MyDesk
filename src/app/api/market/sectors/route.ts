// GET /api/market/sectors — 行业/概念板块排行（P1-2）
// 复用 fetchBoardRowsRescuedV2 三级兜底：东财 → 同花顺 → MCP（仅 industry）。
// origin 字段如实标注来源；RPS 为本榜单内涨幅截面百分位（口径随榜单范围变化，前端已警示）。
import { NextResponse } from "next/server";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { fetchBoardRowsRescuedV2 } from "@/lib/desk/board-rescue";
import { shanghaiStamp } from "@/lib/desk/session";
import { latestTradeDate } from "@/lib/desk/trade-date";
import { fetchMcpIndustryBoard } from "@/lib/quant/data/mcp-provider";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import {
  limitUpCountsByIndustry, loadPrevSnapshot, rankChangeMap, saveSectorSnapshot,
  type SectorSnapshotRow,
} from "@/lib/quant/review/sector-stats";

export const dynamic = "force-dynamic";

interface RankRow {
  code: string; secid: string; name: string;
  changePct: number; main: number; ratio: number; superBig: number; big: number; leader: string;
  fundsMissing?: boolean; breakdownMissing?: boolean; rps?: number;
  /** 板块广度（MCP 板块汇总口径）：板块内上涨/下跌家数；取不到则 undefined，页面显「暂无」 */
  up_count?: number | null;
  down_count?: number | null;
  /** 板块内涨停家数（本地涨停池 × 本地行业映射统计）；取不到则 undefined */
  limit_up_count?: number | null;
  /** 较上一交易日的排名变化（负=名次前进）；没有上一交易日快照则 null */
  rank_change?: number | null;
}

export async function GET(req: Request) {
  // 板块榜要串三级兜底 + MCP 汇总，冷算 1~2 秒：30s 内同一份榜只算一次
  return ttlCache(`market/sectors?${new URL(req.url).search}`, DEFAULT_TTL_MS, () => getHandler(req));
}
async function getHandler(req: Request) {
  quantBootstrap(); // 确保 MCP 客户端已构造（板块广度走 MCP get_stock_board_industry_summary）
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") === "concept" ? "concept" : "industry";
  const size = Math.max(20, Math.min(500, Number(url.searchParams.get("size") ?? 200)));

  const [inRes, outRes] = await Promise.all([
    fetchBoardRowsRescuedV2(kind, "in", size),
    fetchBoardRowsRescuedV2(kind, "out", size),
  ]);

  const merged = new Map<string, RankRow>();
  for (const r of [...(inRes.rows ?? []), ...(outRes.rows ?? [])]) {
    if (!r.code || merged.has(r.code)) continue;
    merged.set(r.code, r);
  }
  let list = [...merged.values()];

  if (!list.length) {
    return NextResponse.json(
      { ok: false, error: "板块数据源暂不可用（东财榜单、腾讯兜底、同花顺资金流榜、MCP 板块榜均无返回）" },
      { status: 502 },
    );
  }

  list.sort((a, b) => b.changePct - a.changePct);
  const n = list.length;
  list.forEach((row, i) => { row.rps = n > 1 ? ((n - 1 - i) / (n - 1)) * 100 : 100; });

  // 板块广度（上涨家数/下跌家数）：走 MCP get_stock_board_industry_summary（东财 push2 断源时的独立口径），
  // 按板块名 join。取不到就留空（页面显「暂无」），绝不造数。
  let breadthOk = false;
  try {
    const mcp = await fetchMcpIndustryBoard();
    if (mcp?.data?.length) {
      const byName = new Map<string, { up: number | null; down: number | null }>();
      for (const b of mcp.data) if (b.name) byName.set(b.name, { up: b.upCount, down: b.downCount });
      for (const row of list) {
        const b = byName.get(row.name);
        if (b) {
          row.up_count = b.up;
          row.down_count = b.down;
          if (b.up != null || b.down != null) breadthOk = true;
        }
      }
    }
  } catch { /* MCP 未配置/失败：广度留空，页面显「暂无」 */ }

  // 数据日 ≠ 服务器时钟：休市日（周末/节假日）这一列要停在最近交易日，不拿取数当天冒充数据日。
  // 真值由行情源日K给（节假日自动识别，见 trade-date.ts），开盘日就是当天，不会误伤。
  // 提前算：涨停家数与排名快照都要落在这一天名下，用系统当天会把休市日写成数据日。
  const tradeDate = await latestTradeDate().catch(() => shanghaiStamp().slice(0, 10));

  // 涨停家数（板块内）：本地涨停池 × 本地行业映射（data/industry-map.json，与榜内 89 个行业名实测全对得上）。
  // 只对 industry 榜有意义（概念榜没有这套映射，硬套就是拿行业冒充概念）。
  let limitUpOk = false;
  let limitUpUnmapped = 0;
  let limitUpTotal = 0;
  if (kind === "industry") {
    try {
      const lu = await limitUpCountsByIndustry();
      limitUpUnmapped = lu.unmapped;
      limitUpTotal = lu.total;
      if (lu.total > 0) {
        for (const row of list) {
          const c = lu.counts[row.name];
          if (c != null) { row.limit_up_count = c; limitUpOk = true; }
        }
      }
    } catch { /* 涨停池算不出来就留空，页面显「—」 */ }
  }

  // 排名变化：今日名次 − 上一交易日名次。先取上一份快照，再把今天这份留档。
  // 第一次跑没有上一份 → 该列全 null（页面显「—」），第二个交易日起自动有数。
  let rankBaseDate: string | null = null;
  {
    const prev = loadPrevSnapshot(tradeDate || shanghaiStamp().slice(0, 10), kind);
    if (prev) {
      rankBaseDate = prev.tradeDate;
      const prevRank = rankChangeMap(prev);
      for (const row of list) {
        const p = prevRank.get(row.code) ?? prevRank.get(row.name);
        row.rank_change = p == null ? null : p - (list.indexOf(row) + 1);
      }
    }
    saveSectorSnapshot(tradeDate || shanghaiStamp().slice(0, 10), kind, list.map((row, i) => ({
      code: row.code, name: row.name,
      changePct: Number.isFinite(row.changePct) ? row.changePct : null,
      main: Number.isFinite(row.main) ? row.main : null,
      rank: i + 1,
    })) satisfies SectorSnapshotRow[]);
  }

  // 以「涨幅侧」的 origin 作为总出处标注（东财 → 同花顺 → MCP 递降）
  const origin = inRes.origin;
  const missing: string[] = [
    "成交额（现有板块封装不含 f6 字段）",
    "持续强势天数（需板块历史序列，现有封装无板块日K）",
  ];
  if (kind === "industry" && !limitUpOk) missing.unshift("涨停家数（涨停池或行业映射未取到）");
  if (!rankBaseDate) missing.unshift(`排名变化（缺上一交易日板块快照，自 ${tradeDate || "今日"} 留档起第 2 个交易日起自动有数）`);
  if (kind === "concept") missing.unshift("涨停家数（概念榜无本地行业映射，不拿行业数冒充概念数）");
  if (!breadthOk) missing.unshift("上涨家数/下跌家数（MCP 板块汇总未取到）");
  if (origin === "ths") {
    missing.push(
      kind === "concept"
        ? "净占比/超大单/大单拆分：本榜为同花顺概念资金流榜，净额=流入−流出、按涨幅取前 N，深跌净流出的概念可能不在榜"
        : "净占比/超大单/大单拆分：本榜为同花顺行业资金流榜，净额=流入−流出口径",
    );
  } else if (origin === "mcp") {
    missing.push("净占比/超大单/大单拆分：本榜为 china-stock-mcp 板块涨幅榜，不含资金字段，净额为占位 0，请显「—」");
  }

  const sourceLabel = origin === "em" ? "em" : origin === "ths" ? "ths" : origin === "mcp" ? "china-stock-mcp" : "none";
  return NextResponse.json({
    ok: true,
    kind,
    list,
    as_of: shanghaiStamp(),
    trade_date: tradeDate || undefined,
    rank_base_date: rankBaseDate || undefined,
    limit_up: kind === "industry"
      ? { counted: limitUpTotal, unmapped: limitUpUnmapped, note: "涨停池 × 本地行业映射（data/industry-map.json）" }
      : undefined,
    source: sourceLabel,
    origin,
    missing,
    note: origin === "em"
      ? "RPS=本榜单内涨幅截面百分位（非全市场口径）；主力净额缺失的板块不参与榜单"
      : `RPS=本榜单内涨幅截面百分位（非全市场口径）；origin=${origin}，净额口径见 missing 说明`,
  });
}
