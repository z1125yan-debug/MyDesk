// P66：菜单页「点开即有内容」的两条腿——服务端热缓存 + 客户端声明式预取。
//
// 用户 2026-09-29：「优化一下所有菜单打开的缓存」。
// 实测问题（本轮量的）：菜单页首屏接口**冷启动** 1.3~17 秒（数据看板板资金榜 16.9s、
// 板块成分股 11.6s、主题热度 7.2s、跨市场 7.6s、事件 6.5s、因子矩阵 9.0s），
// 而服务端 TTL 只有 30 秒——比页面 60 秒的轮询还短 ⇒ 每次打开都必然过期重算，用户就得等。
//
// 三条纪律钉在这里：
//   ① 慢的菜单只读接口必须有服务端 TTL 缓存（命中后 20~30ms）；
//   ② 客户端要有一张**声明式**页面→接口表（自学习表只在访问过之后才有记录，
//      第一次点菜单时它还是空的 ⇒ 第一次必然冷等）；
//   ③ 服务端开机预热名单必须与客户端声明表对得上（对不上 = 预热的那份没人用）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PAGE_ENDPOINTS, IDLE_PREFETCH_ORDER, endpointsForPage } from "../../src/lib/desk/prefetch-map.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* ---------------- ① 慢接口必须有服务端 TTL ---------------- */

test("首屏慢接口都上了服务端 TTL 缓存（实测冷启动 1.3~17s 的那些）", () => {
  const mustCache = [
    "src/app/api/market/board/route.ts",
    "src/app/api/market/board-detail/route.ts",
    "src/app/api/market/theme-heat/route.ts",
    "src/app/api/market/allstocks/route.ts",
    "src/app/api/market/sectors/cross-market/route.ts",
    "src/app/api/market/sectors/top-risk/route.ts",
    "src/app/api/market/sectors/[code]/route.ts",
    "src/app/api/quant/factor-matrix/route.ts",
    "src/app/api/market/sentiment/route.ts",
  ];
  for (const p of mustCache) {
    const src = read(p);
    assert.match(src, /ttlCache\(/, `${p} 必须走进程内 TTL 缓存`);
    assert.match(src, /async function getHandler\(/, `${p} 原实现要收进 getHandler（缓存包一层，业务零改动）`);
  }
});

test("默认 TTL 与页面轮询同档（TTL 短于轮询 = 每次打开都必然重算）", () => {
  const cache = read("src/lib/quant/server-cache.ts");
  assert.match(cache, /export const DEFAULT_TTL_MS = 60_000;/);
  assert.match(cache, /比它短等于\*\*每次打开都必然过期重算\*\*/);
});

test("sectors/[code] 的缓存键带上 kind（行业/概念是两套成分，不能互相串）", () => {
  const src = read("src/app/api/market/sectors/[code]/route.ts");
  assert.match(src, /market\/sectors\/\$\{code\.toUpperCase\(\)\}\?kind=\$\{kindQs\}/);
});

/* ---------------- ② 客户端声明式预取表 ---------------- */

test("声明表覆盖空闲预热顺序里的每一页，且只列可安全重复拉的只读 GET", () => {
  for (const page of IDLE_PREFETCH_ORDER) {
    const urls = endpointsForPage(page);
    assert.ok(urls.length > 0, `空闲预热名单里的 ${page} 必须有声明接口`);
  }
  const all = Object.values(PAGE_ENDPOINTS).flat();
  assert.ok(all.length >= 15, `声明条目太少（${all.length}）起不到预热作用`);
  for (const url of all) {
    assert.match(url, /^\/api\//, `预取项必须是站内接口：${url}`);
    assert.ok(!/symbols=|q=|search|kline\?/.test(url), `带个股/搜索参数的接口不能进声明表（键对不上，白拉）：${url}`);
    assert.ok(!url.startsWith("/api/quant/screener?") && url !== "/api/quant/screener", "筛选是 POST，不能预取");
  }
});

test("预取接线：hover 先吃声明表；进站空闲按顺序预热所有主菜单页", () => {
  const cache = read("src/lib/desk/api-cache.ts");
  assert.match(cache, /import \{ endpointsForPage, IDLE_PREFETCH_ORDER \} from "\.\/prefetch-map\.ts";/);
  assert.match(cache, /for \(const url of endpointsForPage\(page\)\)/, "hover 预取必须合并声明表（否则第一次点还是冷的）");
  assert.match(cache, /export function prefetchMenuPages\(/, "要有「进站空闲预热全部菜单页」的入口");
  assert.match(cache, /if \(page === currentPage\) continue;/, "别抢当前页的上游");

  const shell = read("src/components/desk/AppShell.tsx");
  assert.match(shell, /prefetchMenuPages\(\{ gapMs: 700 \}\)/, "AppShell 要在进站后调它");
});

/* ---------------- ③ 服务端预热名单与客户端声明表对齐 ---------------- */

test("开机预热名单覆盖客户端声明表的路径（对不上＝预热的那份没人用）", () => {
  const warm = read("src/instrumentation.ts");
  const warmed = [...warm.matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1]);
  const warmedPaths = new Set(warmed.map((u) => u.split("?")[0]));
  const declaredPaths = new Set(Object.values(PAGE_ENDPOINTS).flat().map((u) => u.split("?")[0]));
  const missing = [...declaredPaths].filter((p) => !warmedPaths.has(p));
  assert.deepEqual(missing, [], `这些声明接口没进开机预热：${missing.join(", ")}`);
});

/* ---------------- ④ 行业页资金流向图：横条改竖柱 ---------------- */

test("资金流向分布图＝竖柱：x 轴放板块名（斜排）、y 轴放亿、零线画出来，红上绿下", () => {
  const ui = read("src/components/desk/pages/SectorsPage.tsx");
  assert.match(ui, /竖柱：左→右由流入到流出/, "口径说明要写清左红右绿、上流入下流出");
  assert.match(ui, /xAxis: \{\s*\n\s*type: "category", data: desc\.map\(\(r\) => r\.name\)/, "x 轴必须是板块名（竖柱）");
  assert.match(ui, /rotate: 45, interval: 0/, "20 个板块名要全显并斜排");
  assert.match(ui, /markLine: \{[\s\S]{0,200}data: \[\{ yAxis: 0 \}\]/, "零线要画出来，否则分不清净流入/净流出");
  assert.match(ui, /const desc = rows\.slice\(\)\.sort\(\(a, b\) => b\.main - a\.main\)/, "左→右按资金流向从大到小");
  assert.ok(!/asc\.map\(\(r\) => r\.name\)/.test(ui), "旧的水平条（y 轴放名称）要删干净");
});
