// 全 A 在册公司名册（只要 symbol + 简称）· 只读接口
//
// 为什么要单独一个轻接口：研报「受益标的」核对（report-tickers-core）只关心"这家是不是 A 股、
// 在册简称叫什么"，不需要行情。/api/market/allstocks 每行带 13 个字段且必须排序分页，
// 拿它当名册既慢又要翻页；这里一次把全量名称给出去（约 5400 条，几百 KB），服务端 15 分钟一缓存。
//
// 口径与 allstocks 完全一致：同一个 provider（东财全 A 快照，断源时自动退腾讯批量快照），
// 不另起一套 universe，避免"校验用的名册"和"页面看到的名册"不是同一批公司。
//
// 诚实边界：取不到就 502 + ok:false。调用方（研报校验）必须显式显示"无法校验"，
// 不许把"没拿到名册"混成"核对通过"。
import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/quant/server-cache";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { getProvider } from "@/lib/quant/data/index";
import { universeSource } from "@/lib/quant/data/tc-universe";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";

const TTL_MS = 15 * 60_000;

export async function GET() {
  return ttlCache("market/stock-names", TTL_MS, getHandler);
}

async function getHandler() {
  quantBootstrap();
  try {
    const provider = await getProvider("em");
    const tradeDate = shanghaiDate();
    const metas = await provider.listUniverse({ kind: "all" }, tradeDate);
    const names = metas
      .map((m) => ({ symbol: String(m.symbol ?? "").toUpperCase(), name: String(m.name ?? "").trim() }))
      .filter((x) => /^\d{6}\.(SH|SZ|BJ)$/.test(x.symbol) && x.name);
    if (!names.length) {
      return NextResponse.json({ ok: false, count: 0, names: [], error: "全 A 名册为空（数据源未返回公司名）" }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      count: names.length,
      trade_date: tradeDate,
      names,
      source: {
        provider: universeSource() === "tc" ? "腾讯批量快照代码表" : "全 A 快照",
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, count: 0, names: [], error: `全 A 名册获取失败：${(e as Error).message}` }, { status: 502 });
  }
}
