import "dotenv/config";
import { fetchLongbridgeQuote, fetchLongbridgeHist, fetchLongbridgeFundamentals, fetchLongbridgeNews, longbridgeMcpConfigured } from "/home/hatch/workspace/kairotrend-p1/src/lib/desk/longbridge-mcp";
async function main() {
  console.log("configured:", longbridgeMcpConfigured());
  const q = await fetchLongbridgeQuote("NVDA");
  console.log("NVDA quote:", q ? `${q.symbol} price=${q.price} chgPct=${q.changePct?.toFixed(2)} vol=${q.volume}` : null);
  const qhk = await fetchLongbridgeQuote("00700");
  console.log("00700 quote:", qhk ? `${qhk.symbol} price=${qhk.price} chgPct=${qhk.changePct?.toFixed(2)}` : null);
  const h = await fetchLongbridgeHist("NVDA", "2026-08-01", "2026-10-16");
  console.log("NVDA hist bars:", h?.length, "last:", h?.[h.length - 1]?.date, h?.[h.length - 1]?.c);
  const f = await fetchLongbridgeFundamentals("NVDA");
  console.log("NVDA fund pe:", f?.pe, "pb:", f?.pb, "mktCap:", f?.marketCap);
  const n = await fetchLongbridgeNews("NVDA", 3);
  console.log("NVDA news:", n?.length, n?.[0]?.title?.slice(0, 60));
}
main();
