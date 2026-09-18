import { NextRequest, NextResponse } from "next/server";
import { listServers, startServer, stopServer, syncConfigs } from "@/lib/desk/mcp-manager";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ servers: listServers() });
}

// 客户端配置同步（含 trust 状态）
export async function POST(req: NextRequest) {
  try {
    const { servers } = await req.json();
    if (Array.isArray(servers)) syncConfigs(servers);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { action, id } = await req.json();
    const srv = listServers().find((s) => s.id === id);
    if (action === "start") {
      const config = srv?.config;
      if (!config) return NextResponse.json({ error: "配置不存在" }, { status: 404 });
      const { toolCount } = await startServer(config);
      return NextResponse.json({ ok: true, toolCount });
    }
    if (action === "stop") {
      await stopServer(id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "未知 action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
