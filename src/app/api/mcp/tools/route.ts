import { NextResponse } from "next/server";
import { listAllTools } from "@/lib/desk/mcp-manager";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ tools: listAllTools() });
}
