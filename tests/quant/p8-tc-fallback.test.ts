// 东财 push2 断源 → 腾讯批量快照/板块兜底 回归测试（2026-09-22 修「行情中心整片没数据」）。
//
// 背景口径（对应用户所见）：
//  - 东财 push2/push2delay/push2his 对本机出口 IP 全局性拒连（实测 curl schannel reset / Node UND_ERR_SOCKET），
//    大盘情绪/行业板块/主线热点/全A列表/风险监控/涨停梯队/选股扫描 同挂；
//  - 兜底不造数：腾讯批量快照没有的字段（主力净额/行业/上市日）保持 undefined，由既有「家数登记」口径显式露缺；
//  - 板块兜底榜只有涨幅口径：fundsMissing 标记一路传到页面，资金列显示「—」，流向图与明细绝不落回演示数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  chunk, parseTcBoardRankList, parseTcBoardRow, parseTcQuoteBody,
  splitTcQuoteText, symbolToTcCode, tcCodeToSymbol,
} from "../../src/lib/quant/data/tc-snapshot-core.ts";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

// 2026-09-22 真机实测样本（qt.gtimg.cn GBK 解码后原文，字段序即上游序）
const SH688256 =
  "1~寒武纪~688256~1112.77~1113.14~1123.94~7541306~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~" +
  "20260921161453~-0.37~-0.03~1137.50~1101.00~7541306/842202/1~7541306~842202~1.20~210.01~~" +
  "1137.50~1101.00~3.28~6997.70~6997.70~51.52~1335.77~890.51~0.71~尾~部~填~充~字~段~不~参~与~解~析";
const BJ920819 = SH688256.replace("寒武纪", "颖泰生物").replace("1112.77", "3.08");

test("符号↔腾讯代码双向映射：沪深京三所都认，板块码/坏输入返回 null", () => {
  assert.equal(symbolToTcCode("688256.SH"), "sh688256");
  assert.equal(symbolToTcCode("000001.sz"), "sz000001");
  assert.equal(symbolToTcCode("920819.BJ"), "bj920819");
  assert.equal(symbolToTcCode("90.BK1036"), null);
  assert.equal(tcCodeToSymbol("sh688256"), "688256.SH");
  assert.equal(tcCodeToSymbol("bj920819"), "920819.BJ");
  assert.equal(tcCodeToSymbol("usAAPL"), null);
});

test("批量响应切行：只收 v_六码行，杂散片段不炸", () => {
  const text = `v_sh688256="${SH688256}";\nv_bj920819="${BJ920819}";\nv_usAAPL="1~苹果";\ngarbage`;
  const m = splitTcQuoteText(text);
  assert.equal(m.size, 2);
  assert.ok(m.get("sh688256")!.startsWith("1~寒武纪"));
});

test("单行解析：价/昨收/最高/涨跌%/换手/PE/PB/市值/量比逐项对上真机读数，量(手)→股、额(万)→元、亿→元", () => {
  const m = parseTcQuoteBody("sh688256", SH688256)!;
  assert.equal(m.symbol, "688256.SH");
  assert.equal(m.name, "寒武纪");
  assert.equal(m.price, 1112.77);
  assert.equal(m.prevClose, 1113.14);
  assert.equal(m.high, 1137.5);
  assert.equal(m.changePct, -0.03);
  assert.equal(m.turnover, 1.2);
  assert.equal(m.pe, 210.01);
  assert.equal(m.amplitude, 3.28);
  assert.equal(m.floatCap, 6997.7e8);
  assert.equal(m.marketCap, 6997.7e8);
  assert.equal(m.pb, 51.52);
  assert.equal(m.volume, 7541306 * 100);
  assert.equal(m.amount, 842202 * 1e4);
  assert.equal(m.volumeRatio, 0.71);
  // 诚实口径：腾讯快照给不出的字段必须缺席而不是 0
  assert.equal(m.mainNet, undefined);
  assert.equal(m.industry, undefined);
  assert.equal(m.listDate, undefined);
  assert.equal(m.suspended, false);
});

test("停牌行（现价 0.00）→ price 缺席 + suspended=true，与东财「无价=停牌」快照口径一致", () => {
  const body = SH688256.replace("~1112.77~", "~0.00~");
  const m = parseTcQuoteBody("sh688256", body)!;
  assert.equal(m.price, undefined);
  assert.equal(m.changePct, undefined); // 无价时涨跌不采信（sentiment 循环按 price===undefined 跳过）
  assert.equal(m.suspended, true);
});

test("坏行不猜：字段数不足 50 或代码不认识 → null", () => {
  assert.equal(parseTcQuoteBody("sh688256", "1~寒武纪~688256"), null);
  assert.equal(parseTcQuoteBody("usAAPL", SH688256), null);
});

test("ST 判定与东财口径同源：名称含 ST 即 st=true", () => {
  const m = parseTcQuoteBody("sz000001", SH688256.replace("寒武纪", "*ST某文"))!;
  assert.equal(m.st, true);
});

test("chunk：按批切分不丢不重；size<1 直接抛", () => {
  const a = [1, 2, 3, 4, 5];
  assert.deepEqual(chunk(a, 2), [[1, 2], [3, 4], [5]]);
  assert.equal(chunk(a, 60).length, 1);
  assert.throws(() => chunk(a, 0));
});

test("板块兜底行：缺涨幅/缺名 → null（宁缺勿造）；榜单按方向排序并去重", () => {
  assert.equal(parseTcBoardRow({ bd_name: "半导体", bd_code: "pt01", bd_zdf: "-" }), null);
  assert.equal(parseTcBoardRow({ bd_code: "pt01", bd_zdf: "3.2" }), null);
  const rows = parseTcBoardRankList([
    { bd_name: "半导体", bd_code: "pt01", bd_zdf: "6.04", nzg_name: "世联行" },
    { bd_name: "房地产服务", bd_code: "pt02", bd_zdf: "1.2", nzg_name: "" },
    { bd_name: "半导体", bd_code: "pt01", bd_zdf: "6.04", nzg_name: "世联行" },
  ], "in");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "半导体");
  assert.equal(rows[0].fundsMissing, true);
  const out = parseTcBoardRankList([
    { bd_name: "半导体", bd_code: "pt01", bd_zdf: "6.04" },
    { bd_name: "房地产服务", bd_code: "pt02", bd_zdf: "-1.2" },
  ], "out");
  assert.equal(out[0].name, "房地产服务"); // 流出方向 = 跌幅在前
});

// ---------- 接线钉：兜底顺序与露缺姿势 ----------

test("全A快照：东财抛错/空返回才走腾讯兜底，两路都挂抛合并错误（不静默换源）", () => {
  const src = readSrc("src/lib/quant/data/em-provider.ts");
  assert.match(src, /async function fetchUniverseAllARaw/);
  assert.match(src, /setUniverseSource\("em"\)/);
  assert.match(src, /const tc = await fetchTcUniverseAllA\(\);\s*\n\s*setUniverseSource\("tc"\)/);
  assert.match(src, /东财榜单接口与腾讯兜底均失败/);
  assert.match(src, /cached\("universe", `all`, fetchUniverseAllARaw\)/, "TTL 缓存包住整条兜底链");
});

test("兜底编排：代码表走 mcp provider、行情 60 只/批并发 6、成功率过半才认，来源标记放 globalThis", () => {
  const src = readSrc("src/lib/quant/data/tc-universe.ts");
  assert.match(src, /getProvider\("mcp"\)/);
  assert.match(src, /const BATCH = 60/);
  assert.match(src, /腾讯批量快照成功率过低/);
  assert.match(src, /兜底代码表过少/);
  assert.match(src, /__quantUniverseSource/, "模块双实例教训（data/index.ts）同款全局标记");
});

test("东财板块榜断源：行业换腾讯涨幅榜（概念/个股不假兜底），fundsMissing 随行带出", () => {
  const src = readSrc("src/lib/desk/em.ts");
  assert.match(src, /if \(kind === "industry"\) return fetchTcIndustryBoard\(dir, size\);/);
  assert.match(src, /fundsMissing\?: boolean/);
  // \r?\n：钉的是映射形状，不是行的换行符写法（autocrlf=true 的机器上 checkout 出来就是 CRLF，
  // 2026-09-22 兜底轮提交后被 stash 对照改写过一次行尾，这条曾被误报挂——形状断言不该依赖 EOL）
  assert.match(src, /secid: "", .*\r?\n\s*name: b\.name,\r?\n\s*changePct: b\.changePct,\r?\n\s*main: 0/);
});

test("上层 source 文案跟着真实来源走：sentiment/limitup/全A/主线热点四处都按 universeSource 分支，不冒充东财口径", () => {
  for (const f of [
    "src/lib/quant/screener/sentiment.ts",
    "src/lib/quant/screener/limitup.ts",
    "src/app/api/market/allstocks/route.ts",
  ]) {
    assert.match(readSrc(f), /universeSource\(\) === "tc"/, f);
  }
  const th = readSrc("src/lib/quant/screener/themes.ts");
  assert.match(th, /东财榜单接口与腾讯板块兜底均无返回/);
  assert.match(th, /腾讯兜底榜不含资金读数/);
  assert.match(th, /boardFundsMissing/, "整榜 fundsMissing 才登记缺失（混榜不误报）");
});

test("页面不拿占位 0 装真数：资金列「—」、明细不落演示数据、流向图拒绝作画", () => {
  const sec = readSrc("src/components/desk/pages/SectorsPage.tsx");
  // R7 同花顺兜底后口径：主力净额列只查 fundsMissing（腾讯占位 0 显「—」；同花顺该列是真数不能遮），
  // 净占比/超大单/大单三列查 fundsMissing||breakdownMissing（两家兜底都没有拆分读数）。
  // 四列的「—」分支一个不能少——只是遮的理由分了两类。
  assert.equal((sec.match(/board\.fundsMissing \? <span className="text-muted-foreground">—<\/span>/g) ?? []).length, 1,
    "主力净额列：腾讯占位 0 显「—」（同花顺是真数，不遮）");
  assert.equal((sec.match(/board\.fundsMissing \|\| board\.breakdownMissing \? <span className="text-muted-foreground">—<\/span>/g) ?? []).length, 3,
    "净占比/超大单/大单 三列：两家兜底都无拆分读数，全走「—」分支");
  assert.match(sec, /腾讯板块兜底榜（东财板块榜断源：涨幅口径，无主力资金读数）/);
  const board = readSrc("src/components/desk/pages/BoardPage.tsx");
  assert.match(board, /if \(selected\.fundsMissing(?: \|\| selected\.breakdownMissing)?\) \{ setDetail\(null\); return; \}/, "点兜底榜行绝不落回演示明细（R7 起同花顺行同样不落演示明细）");
  assert.match(board, /不拿占位 0 画流向、不编造线宽/);
  assert.match(board, /腾讯板块兜底榜：涨幅口径，无主力资金读数/);
});
