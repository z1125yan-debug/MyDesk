import { NextResponse } from "next/server";
import { fetchDetailReal } from "@/lib/desk/em";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secid = new URL(req.url).searchParams.get("secid")?.trim() ?? "";
  if (!secid) return NextResponse.json({ detail: null });
  try {
    const detail = await fetchDetailReal(secid);
    return NextResponse.json({ detail });
  } catch {
    return NextResponse.json({ detail: null, error: "数据源暂不可用" });
  }
}
