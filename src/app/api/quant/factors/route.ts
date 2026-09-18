// Quant Research Lab — 因子库 API（Phase 3）
// GET  列表（支持 status/category/latestOnly 过滤；?key= 查询单个因子最新版）
// POST 手动录入因子（版本化 insert-only；同 key 旧版本永不覆盖）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { getFactor, listFactors, listLatestFactors, saveFactorVersion } from "@/lib/quant/store";
import { parseExpression, parseAndNormalize, auditExpression } from "@/lib/quant/factors/expression";
import { FACTOR_CATEGORIES, FACTOR_STATUSES, type FactorCategory, type FactorStatus } from "@/lib/quant/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const status = url.searchParams.get("status") as FactorStatus | null;
  const category = url.searchParams.get("category") as FactorCategory | null;
  const factorKey = url.searchParams.get("key") ?? undefined;
  const latestOnly = url.searchParams.get("latestOnly") !== "0";

  try {
    if (factorKey) {
      const factor = await getFactor(factorKey);
      return NextResponse.json({ factor });
    }
    const base = latestOnly
      ? await listLatestFactors({ category: category ?? undefined })
      : await listFactors({ status: status ?? undefined, category: category ?? undefined });
    const factors = status ? base.filter((f) => f.status === status) : base;
    return NextResponse.json({ factors, categories: FACTOR_CATEGORIES, statuses: FACTOR_STATUSES });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  quantBootstrap();
  const body = (await request.json().catch(() => ({}))) as {
    factorKey?: string;
    name?: string;
    category?: FactorCategory;
    expression?: string;
    dataSource?: string;
    note?: string;
  };
  if (!body.factorKey || !body.expression || !body.category) {
    return NextResponse.json({ error: "需要 factorKey / expression / category" }, { status: 400 });
  }
  if (!FACTOR_CATEGORIES.includes(body.category)) {
    return NextResponse.json({ error: `非法类目：${body.category}` }, { status: 400 });
  }
  // 表达式规范化 + 静态审计（未来函数/白名单）——手动录入同样不可绕过
  let normalized: string;
  try {
    normalized = parseAndNormalize(body.expression);
    const audit = auditExpression(parseExpression(body.expression));
    if (!audit.ok) {
      return NextResponse.json({ error: `审计未通过：${audit.problems.join("；")}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: `表达式非法：${(e as Error).message}` }, { status: 400 });
  }
  try {
    const factor = await saveFactorVersion({
      factorKey: body.factorKey,
      name: body.name || body.factorKey,
      category: body.category,
      expression: normalized,
      dataSource: body.dataSource ?? "em",
      status: "Candidate",
      note: body.note ?? "手动录入",
    });
    return NextResponse.json({ factor });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
