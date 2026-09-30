/**
 * 页面级数据体检（只读）：把主要接口真调一遍，列出「哪个接口慢、哪个字段是空的」。
 * 目的：用户反馈「又缺数据」时，一条命令定位到具体接口与字段，而不是逐个页面翻。
 * 用法：node scripts/page-health.ts
 */
const BASE = "http://127.0.0.1:3000";

const routes = [
  "/api/market/sentiment",
  // 参数必须与页面真实默认值一致（缓存键含 query），否则测的是另一个 key、误报慢
  "/api/market/breadth?days=30&scope=all_markets",
  "/api/market/limitup",
  "/api/market/theme-heat",
  "/api/market/review-stats",
  "/api/market/risk",
  "/api/market/sectors",
  "/api/market/trend",
  "/api/market/signals",
  "/api/market/themes",
  "/api/desk/sector-insights",
  "/api/quant/strategy-forecast",
  "/api/market/kline?symbol=000001.SH&tf=day&lmt=5",
  "/api/market/quotes-all?page=1&page_size=20",
  "/api/market/board?kind=industry&dir=in",
];

const EMPTY = new Set(["", "—", "-", "暂无", "无", "null", "N/A"]);
const SKIP_KEYS = new Set(["ok", "as_of", "asOf", "note", "error", "notes", "disclaimer", "updatedAt", "generatedAt", "source"]);

function scan(obj: unknown, path = "", out: [string, string][] = []): [string, string][] {
  if (obj == null) {
    out.push([path, String(obj)]);
    return out;
  }
  if (Array.isArray(obj)) {
    if (!obj.length) out.push([path, "空数组"]);
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SKIP_KEYS.has(k)) continue;
      scan(v, path ? path + "." + k : k, out);
    }
    return out;
  }
  if (typeof obj === "string" && EMPTY.has(obj.trim())) out.push([path, '"' + obj + '"']);
  if (typeof obj === "number" && Number.isNaN(obj)) out.push([path, "NaN"]);
  return out;
}

async function main() {
  for (const r of routes) {
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 45000);
      const res = await fetch(BASE + r, { signal: ctl.signal });
      clearTimeout(tm);
      const ms = Date.now() - t0;
      const txt = await res.text();
      let j: Record<string, unknown> | null = null;
      try {
        j = JSON.parse(txt) as Record<string, unknown>;
      } catch {
        j = null;
      }
      if (!j) {
        console.log("[BADJSON] " + r + " -> HTTP " + res.status + " (" + ms + "ms) " + txt.slice(0, 100));
        continue;
      }
      const tag = j.ok === false ? "[FAIL]  " : "[OK]    ";
      const err = j.error ? String(j.error).slice(0, 70) : "-";
      console.log(tag + r + "  [" + res.status + " " + ms + "ms]  err=" + err);
      const empties = scan(j);
      if (empties.length) {
        const show = empties.slice(0, 8);
        console.log("        空字段 " + empties.length + " 处: " + show.map((x) => x[0] + "=" + x[1]).join(" | "));
      }
    } catch (e) {
      console.log("[DOWN]   " + r + " -> " + String((e as Error).message).slice(0, 70) + " (" + (Date.now() - t0) + "ms)");
    }
  }
}

main();
