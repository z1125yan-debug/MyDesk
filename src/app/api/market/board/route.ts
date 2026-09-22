// GET /api/market/board — 板块/个股资金流向榜（数据看板 BoardPage 用）
// P15-R7：行业/概念两榜在东财断源（无返回或只剩腾讯涨幅占位）时整榜换同花顺资金流榜
// （独立上游，净额真数、无净占比拆分 → 行上 breakdownMissing，页面显「—」）；
// 同花顺榜按涨幅序取，流入向取净额>0 降序、流出向取净额<0 升序，各截前 30。
// 个股(stock)/地域(region)无同花顺对等榜——维持原样，缺就是缺。
import { NextResponse } from "next/server";
import { fetchBoardReal } from "@/lib/desk/em";
import { fetchThsBoards, thsToRankRow } from "@/lib/desk/ths";

export const dynamic = "force-dynamic";

const KINDS = new Set(["stock", "industry", "concept", "region"]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind") ?? "industry";
  const kind = (KINDS.has(kindParam) ? kindParam : "industry") as
    | "stock"
    | "industry"
    | "concept"
    | "region";
  const dir = url.searchParams.get("dir") === "out" ? "out" : "in";
  try {
    let rows = await fetchBoardReal(kind, dir);
    const needThs = kind === "industry" || kind === "concept";
    if (needThs && (!rows?.length || rows.every((r) => r.fundsMissing))) {
      const ths = await fetchThsBoards(kind);
      const picked = (dir === "in"
        ? ths.filter((r) => r.netYi > 0).sort((a, b) => b.netYi - a.netYi)
        : ths.filter((r) => r.netYi < 0).sort((a, b) => a.netYi - b.netYi)
      ).slice(0, 30);
      if (picked.length) rows = picked.map(thsToRankRow);
    }
    return NextResponse.json({ rows });
  } catch {
    return NextResponse.json({ rows: null, error: "数据源暂不可用" });
  }
}
