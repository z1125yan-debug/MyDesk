// GET /api/market/sectors/[code] — 板块成分股（P1-2）
// 复用 emProvider.listUniverse({kind:"industry"|"concept", boardCode})（东财 b:BKxxxx 成分）。
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { getProvider } from "@/lib/quant/data/index";
import { shanghaiDate } from "@/lib/desk/session";
import { latestTradeDate } from "@/lib/desk/trade-date";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  quantBootstrap();
  const { code } = await params;
  if (!/^BK\d+$/i.test(code)) {
    return NextResponse.json({ ok: false, error: `板块代码非法：${code}（需 BK 开头）` }, { status: 400 });
  }
  const kind = new URL(req.url).searchParams.get("kind") === "concept" ? "concept" : "industry";
  try {
    const provider = await getProvider("em");
    // 成分股也按最近交易日取：休市日拿今天当数据日，取到的是上一交易日的成分却挂着今天的日期
    const tdate = await latestTradeDate().catch(() => shanghaiDate());
    const metas = await provider.listUniverse({ kind, boardCode: code.toUpperCase() }, tdate);
    if (!metas.length) {
      return NextResponse.json({ ok: false, error: "板块成分股为空（数据源无返回）" }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      list: metas.map((m) => ({
        symbol: m.symbol, name: m.name, industry: m.industry ?? null,
        price: m.price ?? null, changePct: m.changePct ?? null,
        amountYi: m.amount != null ? m.amount / 1e8 : null,
        turnover: m.turnover ?? null, mainNetYi: m.mainNet != null ? m.mainNet / 1e8 : null,
        st: m.st ?? false, suspended: m.suspended ?? false,
      })),
      total: metas.length,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `成分股获取失败：${(e as Error).message}` }, { status: 502 });
  }
}
