// P15-R20b 演示数据断根 + 页面接线钉测。
//
// 钉两件事：
// 1) **假数不能顶着真名字躺在兜底表里**。`desk/data.ts` 的 QUOTE_BASE 曾经挂着
//    `HS300=3987.51`、`NDX100=20184.33`——代码不在自选目录里、没有任何调用方会传进来，
//    但名字是「沪深300 / 纳指100」，一旦被转述就是造数。本轮删掉，真数另走通路
//    （沪深300 = 自选目录里的 000300.SH；纳指/标普/道指/半导体 = quant/data/overseas.ts，免 key 且带上游行情时刻）。
// 2) 见顶压力分与外盘背离**真的接进了页面**，而且页面拿不到数时显示的是「没读到」，不是 0 分、不是「无背离」。
//    这一条用源码形状钉：页面不许自己再算一套刻度，也不许给缺失读数兜一个 0。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const DEMO = src("src/lib/desk/data.ts");
const MARKET = src("src/components/desk/pages/MarketPage.tsx");
const SECTORS = src("src/components/desk/pages/SectorsPage.tsx");

/** 从文件里切出 QUOTE_BASE 那一段（对象字面量整体），免得把注释里的名字也算进去 */
function quoteBaseBlock(text: string): string {
  const i = text.indexOf("const QUOTE_BASE");
  assert.notEqual(i, -1, "QUOTE_BASE 这个兜底表还在文件里，钉测前提变了");
  const j = text.indexOf("};", i);
  return text.slice(i, j + 2);
}

test("R20b-① 兜底表里不许再顶着真指数名的假价格（HS300 / NDX100 已断根）", () => {
  const block = quoteBaseBlock(DEMO);
  for (const fake of ["HS300", "NDX100"]) {
    assert.ok(!block.includes(fake), `QUOTE_BASE 里又出现了 ${fake}：真名字配假数字，转述出去就是造数`);
  }
  // 断根不等于假装能取到：删掉的两条要留下「真数走哪条」的说明，否则下一个人又抄一份假的回来
  assert.ok(DEMO.includes("overseas"), "注释要指明外盘真数的通路，否则这条断根会被重新填上假数");
});

test("R20b-② 自选目录里那两个品种仍然标着「演示」，且沪深300 有真代码可走", () => {
  assert.ok(DEMO.includes("现货黄金（演示）") && DEMO.includes("比特币（演示）"), "演示品种必须在名字里就写明是演示");
  assert.ok(DEMO.includes("000300.SH"), "沪深300 要用真代码 000300.SH，不该靠兜底表");
  assert.ok(src("src/lib/desk/market.ts").includes('data_status: "DEMO"'), "合成卡片必须带 DEMO 标记，不能混进真数");
});

test("R20b-③(2026-09-29 撤牌) 市场页不再挂见顶压力档位牌；能力保留在 API 不删", () => {
  // 2026-09-29 用户拍板：档位牌从大盘情绪页整体摘除（判定：丑且不属于此页）。
  // 页面里不许留半截残留；数据能力（/api/market/sentiment 的 pressure 字段 + top-pressure-core 纯核）原样保留，
  // 以后接进板块风险页当「全市场背景」层时在这里补新钉。
  assert.ok(!MARKET.includes("PressurePanel"), "市场页不许再挂 PressurePanel 组件");
  assert.ok(!MARKET.includes("见顶压力"), "档位牌文案不许残留");
  assert.ok(!/sent\.pressure/.test(MARKET), "页面不再消费 pressure 字段");
  const sentimentRoute = src("src/app/api/market/sentiment/route.ts");
  assert.ok(sentimentRoute.includes("pressure"), "API 的 pressure 字段保留（能力不删）");
  assert.ok(src("src/lib/quant/screener/top-pressure-core.ts").includes("export"), "纯核 top-pressure-core 保留");
  // 通用纪律仍有效：真要把压力分画回任何页面，也不许在页面写第二套「分数→档位」判据、不许把 null 兜成 0
  assert.ok(!/score\s*\?\?\s*0/.test(MARKET), "页面把 score=null 兜成了 0 分——缺读数 ≠ 0");
});

test("R20b-④ 板块页那一行：用纯核给的 line，不重算背离、不把缺读数说成「无背离」", () => {
  assert.ok(SECTORS.includes("divergence"), "板块页没接 divergence");
  assert.ok(SECTORS.includes("line"), "板块页要原样显示纯核那句判定，别在页面拼第二套结论");
  assert.ok(!SECTORS.includes("无显著背离") || SECTORS.includes("没读到"),
    "缺读数时必须说「判不了」，不能显示成「无显著背离」这种看着像结论的话");
  // 取数失败不许把板块榜一起打挂：这一路必须单独 catch
  assert.ok(/catch/.test(SECTORS), "板块页外盘这一路没有 catch：它挂了不该连累榜单");
});

test("R20b-⑤ 档位词只许沿用原有那四个，不另立一套", () => {
  const core = src("src/lib/quant/screener/top-pressure-core.ts");
  for (const word of ["正常", "注意", "偏高", "高风险"]) assert.ok(core.includes(`"${word}"`), `档位词少了 ${word}`);
  assert.ok(!core.includes('"危险"') && !core.includes('"警告"'), "另立档位词了：页面/接口/风险页会各长出一套叫法");
});
