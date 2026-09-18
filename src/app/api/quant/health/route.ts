// Quant Research Lab — 健康检查：DB、数据源、任务状态
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { counts } from "@/lib/quant/store";
import { listProviderIds } from "@/lib/quant/data/index";
import { demoProvider } from "@/lib/quant/data/demo-provider";
import { emProvider } from "@/lib/quant/data/em-provider";
import { mcpProvider, configureMcpProvider, mcpConfigured } from "@/lib/quant/data/mcp-provider";
import { mcpUrl } from "@/lib/quant/data/quant-config";
import { jobsStats } from "@/lib/quant/jobs/registry";

export const dynamic = "force-dynamic";

export async function GET() {
  quantBootstrap();
  let dbCounts: Awaited<ReturnType<typeof counts>> | null = null;
  let dbError: string | null = null;
  try {
    dbCounts = await counts();
  } catch (e) {
    dbError = (e as Error).message;
  }
  if (!mcpConfigured() && mcpUrl()) configureMcpProvider(mcpUrl());
  return NextResponse.json({
    ok: !dbError,
    lab: "Quant Research Lab",
    version: "0.1.0",
    db: { counts: dbCounts, error: dbError },
    providers: [
      { id: "em", coverage: emProvider.coverage() },
      { id: "mcp", coverage: mcpProvider.coverage(), configured: mcpConfigured() },
      { id: "demo", coverage: demoProvider.coverage() },
    ],
    providerIds: listProviderIds(),
    jobs: jobsStats(),
    ts: new Date().toISOString(),
  });
}
