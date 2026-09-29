// P64：代码显示口径（通达信格式）+ 选股结果表宽度不溢出。
//
// 需求（2026-09-29 用户）：
//   ①「把现在这个代码统一改成通达信这样的，不需要 SH」——列表里只显示 6 位数字；
//   ②「把这整个宽度调一下，我现在还得拉一下才能看完，参考稳智」——结果表不许横向拖动。
//
// 纪律：显示层剥离后缀，**数据层不动**（symbol 仍带 .SH 供接口/映射/工具调用使用），
// 全码放 title——信息没丢，只是不占地方。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { plainCode, codeTitle } from "../../src/lib/desk/code-format.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("plainCode：剥掉交易所后缀（大小写不敏感），通达信口径只留 6 位", () => {
  assert.equal(plainCode("600825.SH"), "600825");
  assert.equal(plainCode("000678.SZ"), "000678");
  assert.equal(plainCode("430047.BJ"), "430047");
  assert.equal(plainCode("600825.sh"), "600825");
  assert.equal(plainCode("  600825.SH  "), "600825");
});

test("plainCode：非个股代码原样返回，不误伤板块码/纯数字/空值", () => {
  assert.equal(plainCode("BK0493"), "BK0493", "东财板块码不是个股，不能按后缀规则处理");
  assert.equal(plainCode("881321"), "881321", "通达信板块指数码本来就是纯数字");
  assert.equal(plainCode("600825"), "600825");
  assert.equal(plainCode(null), "");
  assert.equal(plainCode(undefined), "");
  assert.equal(plainCode(""), "");
});

test("codeTitle：全码只进悬停提示；本来就是纯码时不给空提示", () => {
  assert.equal(codeTitle("600825.SH"), "600825（数据层全码 600825.SH）");
  assert.equal(codeTitle("600825"), undefined);
  assert.equal(codeTitle("BK0493"), undefined);
  assert.equal(codeTitle(""), undefined);
});

test("接线：各列表页一律走 plainCode 显示（不允许再直接渲染带后缀的 symbol）", () => {
  const pages = [
    "src/components/desk/pages/ScreenerWorkbench.tsx",
    "src/components/desk/pages/AiScanPage.tsx",
    "src/components/desk/pages/AllStocksPage.tsx",
    "src/components/desk/pages/PoolPage.tsx",
    "src/components/desk/pages/ProbabilityPage.tsx",
    "src/components/desk/pages/ScreenerPage.tsx",
    "src/components/desk/pages/SectorsPage.tsx",
    "src/components/desk/pages/WatchlistPage.tsx",
    "src/components/desk/QuantPage.tsx",
  ];
  for (const p of pages) {
    const src = read(p);
    assert.match(src, /plainCode/, `${p} 必须用 plainCode 显示代码`);
    assert.ok(!/>\{r\.symbol\}</.test(src) && !/>\{row\.symbol\}</.test(src) && !/>\{m\.symbol\}</.test(src),
      `${p} 还在直接渲染带后缀的 symbol`);
  }
});

test("选股结果表：table-fixed + colgroup 百分比列宽 → 恒等于容器宽，不再横向拖动", () => {
  const ui = read("src/components/desk/pages/ScreenerWorkbench.tsx");
  assert.match(ui, /table-fixed/, "必须锁表宽，否则列多时溢出");
  assert.match(ui, /<colgroup>/, "列宽要按 colgroup 分配");
  assert.match(ui, /overflow-x-hidden/, "结果区不许再出现横向滚动条");
  assert.match(ui, /const colWidth = useMemo/, "列宽按列数动态分配（百分比合计 100）");
  // 表头必须允许换行——否则长列名（行业整体RPS_120 等）会把整列撑宽回到老样子
  assert.match(ui, /break-words px-2 py-2 text-left align-bottom font-medium leading-tight/);
  assert.ok(!/whitespace-nowrap px-3 py-2\.5 text-left font-medium/.test(ui), "旧的不换行表头必须删掉");
});

test("选股结果表：代码格子不再装成可点（假手型）——它本来就没有点击行为", () => {
  const ui = read("src/components/desk/pages/ScreenerWorkbench.tsx");
  assert.ok(!/cursor-pointer font-mono text-sky-400 hover:underline/.test(ui),
    "看着能点却没行为的样式必须去掉（用户实测被它误导过）");
});
