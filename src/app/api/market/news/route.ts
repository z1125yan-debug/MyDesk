import { NextResponse } from "next/server";
import { fetchNewsReal } from "@/lib/desk/em";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const news = await fetchNewsReal();
    return NextResponse.json({ news });
  } catch {
    return NextResponse.json({ news: null });
  }
}
