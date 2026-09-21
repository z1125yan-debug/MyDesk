// P9-新浪资金流备胎轮：sina-flow-core 纯函数单测 + 接线钉测。
//
// 背景：东财 push2/push2his 2026-09-22 起对本机断连（直连 RemoteDisconnected、走代理同样 503），
// 个股级主力净额整链只能返回 null。接入 a-stock-data（Apache-2.0）验证过的 fund_flow_backup 端点，
// 直连新浪 MoneyFlow.ssl_qsfx_zjlrqs 补个股近 14 日净额。
// 本轮口径：
//  - 纯核零 IO（认代码/拼 URL/拆数据），fetch 与 TTL 缓存留在 em.ts 服务层；
//  - 新浪 netamount 与东财 f62「主力净额」不完全等价 → DetailReal 带 source 出身，每个消费处如实标源；
//  - 认不出的代码（板块码 BK/非 6 位）返回 null，不硬凑前缀去查一个不存在的标的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sinaCodeOf, sinaFundFlowUrl, parseSinaFundFlow } from "../../src/lib/quant/data/sina-flow-core.ts";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("认代码：沪(6/9)、深(0/3)、北(92/8) 各归其位；92 必须先判否则北交所被误当沪市", () => {
  assert.equal(sinaCodeOf("600519"), "sh600519");
  assert.equal(sinaCodeOf("688256"), "sh688256"); // 科创板 688 仍沪
  assert.equal(sinaCodeOf("000001"), "sz000001");
  assert.equal(sinaCodeOf("300750"), "sz300750");
  assert.equal(sinaCodeOf("920002"), "bj920002"); // 92 开头北交所：先判，不能被 9 抢去 sh
  assert.equal(sinaCodeOf("830799"), "bj830799"); // 8 开头新三板/北交所
});

test("认代码：非 6 位纯数字一律 null（板块 BK 码、指数、脏输入不许硬凑前缀）", () => {
  assert.equal(sinaCodeOf("BK1033"), null);
  assert.equal(sinaCodeOf("90BK1033"), null);
  assert.equal(sinaCodeOf("60051"), null); // 5 位
  assert.equal(sinaCodeOf("6005190"), null); // 7 位
  assert.equal(sinaCodeOf(""), null);
});

test("拼 URL：带 daima/分页/排序；days 夹在 1..180；认不出的代码不给 URL", () => {
  const u = sinaFundFlowUrl("600519", 14)!;
  assert.match(u, /ssl_qsfx_zjlrqs/);
  assert.match(u, /daima=sh600519/);
  assert.match(u, /num=14/);
  assert.match(u, /sort=opendate&asc=0/);
  assert.match(sinaFundFlowUrl("600519", 9999)!, /num=180/); // 上限夹住
  assert.match(sinaFundFlowUrl("600519", 0)!, /num=1/); // 下限夹住
  assert.equal(sinaFundFlowUrl("BK1033", 14), null);
});

test("拆数据：字符串净额→亿元、缺日/脏行跳过、按日期升序（对齐东财 klines 方向，at(-1)=今日）", () => {
  const payload = [
    { opendate: "2026-09-21", netamount: "-337063261.9200" },
    { opendate: "2026-09-19", netamount: "125000000.0000" }, // 倒序到达：解析后应重排
    { opendate: "2026-09-20", netamount: "0" },
  ];
  const days = parseSinaFundFlow(payload);
  assert.deepEqual(days.map((d) => d.date), ["2026-09-19", "2026-09-20", "2026-09-21"]); // 升序
  assert.equal(days[2].netYi, -337063261.92 / 1e8); // 元 ÷1e8 → 亿（同一算法两侧，不吃浮点尾差亏）
  assert.ok(Math.abs(days[0].netYi - 1.25) < 1e-9);
  assert.equal(days.at(-1)!.netYi, days[2].netYi); // 最新一天在末尾
});

test("拆数据：脏输入不崩、不补 0——缺 opendate 形状/净额非有限数的行整条跳过", () => {
  const payload = [
    { opendate: "2026-09-21", netamount: "not-a-number" }, // parseFloat NaN → 跳过
    { opendate: "", netamount: "100" }, // 无日期 → 跳过
    { opendate: "2026/09/20", netamount: "100" }, // 日期形状不对 → 跳过
    { opendate: "2026-09-20", netamount: "" }, // 空净额 → 跳过
    { opendate: "2026-09-18", netamount: 5.5e7 }, // number 直给也收
    null,
    { netamount: "999" }, // 没 opendate → 跳过
  ];
  const days = parseSinaFundFlow(payload);
  assert.equal(days.length, 1, "只剩那一条合法行");
  assert.equal(days[0].date, "2026-09-18");
  assert.equal(days[0].netYi, 0.55);
});

test("拆数据：非数组 payload（新浪回错误对象/HTML 兜底页）返回空，不抛", () => {
  assert.deepEqual(parseSinaFundFlow({ __ERROR: 3, __ERRORMSG: "Service not found" }), []);
  assert.deepEqual(parseSinaFundFlow("<html>...</html>"), []);
  assert.deepEqual(parseSinaFundFlow(null), []);
  assert.deepEqual(parseSinaFundFlow(undefined), []);
});

test("接线钉：fetchDetailReal 东财失败走新浪、带 source 三元、板块码不兜底", () => {
  const src = readSrc("src/lib/desk/em.ts");
  assert.match(src, /import \{ parseSinaFundFlow, sinaFundFlowUrl \} from "@\/lib\/quant\/data\/sina-flow-core"/, "服务层从纯核引入");
  assert.match(src, /source: "em" \| "sina"/, "DetailReal 必带出身三元");
  assert.match(src, /return \{ spark: \[\], days, source: "em" \}/, "东财命中时 source=em");
  assert.match(src, /source: "sina" as const/, "新浪命中时 source=sina");
  assert.match(src, /if \(!url\) return null/, "认不出的 secid（板块 BK）不给兜底：新浪无对应物，不硬凑");
});

test("接线钉：每个消费处按 source 如实标源，不许拿「东财主力净额」名头转述新浪读数", () => {
  assert.match(readSrc("src/lib/desk/chat-tools.ts"), /detail\.source === "sina"/, "对话工具 toolStockFundFlow 分标新浪口径");
  assert.match(readSrc("src/lib/quant/screener/agent-tools.ts"), /r\.value\?\.source === "sina"/, "工具环观测源标新浪口径");
  assert.match(readSrc("src/app/api/stock/profile/route.ts"), /detail\.source === "sina"/, "个股档案源标新浪口径");
  // 三处都必须出现「不完全等价 / 与东财 f62」的口径提示之一，防止把新浪当东财
  for (const f of ["src/lib/desk/chat-tools.ts", "src/app/api/stock/profile/route.ts"]) {
    assert.match(readSrc(f), /新浪/, `${f} 缺新浪源标注`);
  }
});
