import { NextResponse } from "next/server";
import { fetchBoardReal } from "@/lib/desk/em";

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
    const rows = await fetchBoardReal(kind, dir);
    return NextResponse.json({ rows });
  } catch {
    return NextResponse.json({ rows: null, error: "数据源暂不可用" });
  }
}
