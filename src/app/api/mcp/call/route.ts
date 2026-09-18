import { NextRequest, NextResponse } from "next/server";
import { callTool } from "@/lib/desk/mcp-manager";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { server, tool, args } = await req.json();
    const result = await callTool(server, tool, args);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
