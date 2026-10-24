import { NextResponse } from "next/server";
import { fetchLongbridgeBatch, fetchLongbridgeQuote, getLongbridgeAuthStatus, longbridgeMcpConfigured } from "@/lib/desk/longbridge-mcp";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/usquote?symbols=NVDA,AAPL,VOO,00700
 * 美股/港股实时报价（长桥 MCP，OAuth）。未配置 Token 时返回 configured:false + null，
 * 不报错、不阻塞 A 股。A 股报价仍走 /api/market/quote。
 * 本接口只服务港股/美股：A 股符号（6 位数字 + .SH/.SZ/.BJ）规范化失败 → 该只返回 null，绝不拿 A 股数据顶包。
 */
export async function GET(req: Request) {
  const symbols = (new URL(req.url).searchParams.get("symbols") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!symbols.length) return NextResponse.json({ market: "HK/US", market_label: "港股/美股", configured: longbridgeMcpConfigured(), quotes: [] });
  if (!longbridgeMcpConfigured()) {
    return NextResponse.json({ market: "HK/US", market_label: "港股/美股", configured: false, quotes: symbols.map(() => null), error: "长桥 MCP 未配置（需 LONGBRIDGE_MCP_URL + LONGBRIDGE_MCP_TOKEN，OAuth 授权后填入）" });
  }
  try {
    const map = await fetchLongbridgeBatch(symbols, fetchLongbridgeQuote);
    const quotes = symbols.map((s) => {
      const key = s.trim().toUpperCase();
      // batch key 为规范化符号（NVDA.US / 00700.HK），按后缀匹配
      for (const [k, v] of map) {
        if (k === key || k.startsWith(`${key}.`) || k === `${key}.US` || k === `${key}.HK`) return v;
      }
      return null;
    });
    const auth = getLongbridgeAuthStatus();
    return NextResponse.json({ market: "HK/US", market_label: "港股/美股", configured: true, quotes, needsReauth: auth.needsReauth, authReason: auth.reason });
  } catch {
    const auth = getLongbridgeAuthStatus();
    return NextResponse.json({ market: "HK/US", market_label: "港股/美股", configured: true, quotes: symbols.map(() => null), error: "长桥 MCP 暂不可用", needsReauth: auth.needsReauth, authReason: auth.reason });
  }
}
