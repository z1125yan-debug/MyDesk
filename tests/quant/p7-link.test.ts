// P7-⑧② 对话正文可点片段（股票 / 板块跳转联动）的回归测试（纯内存：不 fetch、不碰库、不渲染组件）。
//
// 这层唯一的风险是「把不该点的东西画成可点」：用户点一下就被带去一只不相干的票或一个猜出来的板块。
// 所以这里的断言以「拒判」为主——每加一条闸门都要有对应用例，闸门松了测试得红。
// 用例里的代码（600519 / 688256 等）只是真实存在的代码形状，板块名是手写的清单，
// 不是任何真实提问，也不涉及任何行情数值。
import test from "node:test";
import assert from "node:assert/strict";
import { codeRe, extractSymbols, findSymbolMatches, suffixOf } from "../../src/lib/desk/intent-core.ts";
import {
  SECTOR_CUES, findLinkSpans, findSectorSpans, findSymbolSpans, sectorRejectReason,
  splitByLinks, symbolRejectReason, toSymbol, type DeskLink, type SectorRef,
} from "../../src/lib/desk/link-core.ts";

const BOARDS: SectorRef[] = [
  { code: "BK0478", name: "半导体" },
  { code: "BK1036", name: "半导体设备" },
  { code: "BK1033", name: "电池" },
  { code: "BK0438", name: "综合" },
  { code: "BK0450", name: "汽车" },
  { code: "BK0001", name: "酿酒行业" },
];

function linksOf(text: string, sectors: SectorRef[] = BOARDS): DeskLink[] {
  return splitByLinks(text, sectors).flatMap((s) => (s.link ? [s.link] : []));
}

// ---------- 代码：形状、位置、补后缀 ----------

test("意图层与链接层共用同一份代码形状：正则出自 codeRe，两次调用结果一致", () => {
  const text = "对比 600519 与 000001.SZ，再看 688256.SH";
  assert.deepEqual(extractSymbols(text), ["600519.SH", "000001.SZ", "688256.SH"]);
  assert.deepEqual(findSymbolMatches(text).map((m) => [m.raw, m.symbol]), [
    ["600519", "600519.SH"], ["000001.SZ", "000001.SZ"], ["688256.SH", "688256.SH"],
  ]);
  // 位置必须落在原文上：渲染层靠 start/end 就地替换，错位就是吞字
  for (const m of findSymbolMatches(text)) assert.equal(text.slice(m.start, m.end), m.raw, `${m.raw} 的位置不匹配`);
  // codeRe 每次给出全新实例：带 /g 的正则共享实例会因 lastIndex 推进而漏掉命中
  assert.notEqual(codeRe(), codeRe());
});

test("补后缀按号段：60/68/9/5→SH，43/83/87/92→BJ，其余→SZ", () => {
  assert.equal(suffixOf("600519"), "SH");
  assert.equal(suffixOf("688256"), "SH");
  assert.equal(suffixOf("900901"), "SH");
  assert.equal(suffixOf("500001"), "SH");
  assert.equal(suffixOf("430139"), "BJ");
  assert.equal(suffixOf("920819"), "BJ");
  assert.equal(suffixOf("000001"), "SZ");
  assert.equal(suffixOf("300750"), "SZ");
  assert.equal(toSymbol("600519"), "600519.SH");
  assert.equal(toSymbol("600519.sh"), "600519.SH");
});

test("链接层产出的代码必须是意图层也认出来的（两层不许各判一套）", () => {
  const text = "📊 600519 与 000001.SH 对比；20260919 是日期；我拿了 500000 股";
  const known = new Set(extractSymbols(text));
  for (const s of findSymbolSpans(text)) assert.ok(known.has(s.link.kind === "symbol" ? s.link.symbol : ""), `${s.start} 处生成了意图层不认的代码链接`);
});

// ---------- 代码：误识别闸门 ----------

test("日期 / 长数字 / 小数里的六位数字不当代码", () => {
  assert.deepEqual(findSymbolSpans("20260919 的行情").length, 0, "8 位日期的前六位不是代码");
  assert.deepEqual(findSymbolSpans("2026-09-19 收盘"), []);
  assert.deepEqual(findSymbolSpans("1234567 手"), []);
  assert.deepEqual(findSymbolSpans("成交额 4200.56 亿"), [], "带小数的读数不点");
  assert.equal(symbolRejectReason("1,600519", 2, 8), "千分位");
  assert.equal(symbolRejectReason("0.123456", 2, 8), "小数尾巴");
  assert.equal(symbolRejectReason("600519.5", 0, 6), "后接小数位");
  assert.equal(symbolRejectReason("500000 股", 0, 6), "带单位");
  assert.equal(symbolRejectReason("600519.SH 股", 0, 10), null, "带后缀就是代码声明，量词不影响");
  assert.equal(symbolRejectReason("看下 600519。", 3, 9), null, "句末中文句号前的代码照常可点");
});

test("六位数字紧跟单位 = 数量/金额，一律不可点；分开写则照常可点", () => {
  for (const t of ["我持有 300000 元", "买入 600519 股 前先算", "仓位 500000份"]) {
    assert.equal(findSymbolSpans(t).filter((s) => s.link.kind === "symbol").length, 0, `${t} 生成了假代码链接`);
  }
  // 「600519 股」这种是数量语境下的假阳性，但同一句里带后缀的那处仍该可点
  const both = "600519 股 与 600519.SH";
  assert.deepEqual(findSymbolSpans(both).map((s) => (s.link.kind === "symbol" ? s.link.symbol : "?")), ["600519.SH"]);
});

// ---------- 板块：只认清单 ----------

test("板块名只认已知清单：清单外的名字不生成链接，也不猜 code", () => {
  assert.deepEqual(findSectorSpans("AI 算力概念走强", BOARDS), [], "「AI 算力」不在本次清单里");
  assert.deepEqual(findSectorSpans("半导体", BOARDS).map((s) => (s.link.kind === "sector" ? s.link.code : "?")), ["BK0478"]);
  assert.deepEqual(findSectorSpans("半导体", []), [], "没有清单就没有任何板块链接");
});

test("板块名最长优先：长名命中时不再被其中的短名二次切", () => {
  const spans = findSectorSpans("半导体设备与半导体今日分化", BOARDS);
  assert.deepEqual(spans.map((s) => [s.start, s.end]), [[0, 5], [6, 9]]);
  assert.deepEqual(spans.map((s) => (s.link.kind === "sector" ? s.link.name : "?")), ["半导体设备", "半导体"]);
});

test("两字板块名必须挨着行业语境词：常用词不误跳（「其他综合收益」不是板块）", () => {
  assert.equal(sectorRejectReason("其他综合收益", 2, 4, "综合"), "两字板块名未挨着行业语境词");
  assert.equal(sectorRejectReason("综合板块走强", 0, 2, "综合"), null);
  assert.equal(sectorRejectReason("「电池」板块", 1, 3, "电池"), null, "被「」包着的两字名照例可点");
  assert.deepEqual(findSectorSpans("其他综合收益 与 电池行业", BOARDS).map((s) => (s.link.kind === "sector" ? s.link.name : "?")), ["电池"]);
  assert.ok(SECTOR_CUES.includes("板块") && SECTOR_CUES.includes("成分股"), "语境词表是判据的一部分，改动要能看到");
  // 三字及以上不受这条闸门约束
  assert.deepEqual(findSectorSpans("半导体今日分化", BOARDS).length, 1);
});

test("代码与板块重叠时只留一个：同一位置不叠两层链接（同位置代码优先）", () => {
  // 构造数据：板块名里带六位数字，才会和代码撞在同一区间上（真实行业榜不含数字代码）
  const weird: SectorRef[] = [{ code: "BK9999", name: "188888概念" }, { code: "BK9998", name: "888概念" }];
  assert.deepEqual(findLinkSpans("先看 188888概念", weird).map((s) => s.link.kind), ["symbol"],
    "同位置代码优先：这是 findLinkSpans 里写死的口径，改了要一起改注释");
  const spans = findLinkSpans("188888概念 与 600519.SH 的半导体板块", [...weird, ...BOARDS]);
  assert.deepEqual(spans.map((s) => s.link.kind), ["symbol", "symbol", "sector"],
    "板块名被代码吃掉的那段不重复出链接，后面正常的代码/板块照常在");
  // 真正的不变量：任意输入下产出的区间都严格递增且不相交
  let cursor = -1;
  for (const s of spans) {
    assert.ok(s.start > cursor, `区间重叠了：${s.start} 落在上一段 ${cursor} 之内`);
    cursor = s.end;
  }
});

// ---------- 切分无损 ----------

test("splitByLinks 拼回去逐字等于原文（含代码、板块、混合、无命中四种情况）", () => {
  const cases = [
    "",
    "今天大盘一般",
    "600519 现价 1456.00 元，20260919 成交 500000 股",
    "🎯 结论：半导体设备强于电池板块，关注 600519.SH 与 300750",
    "| 代码 | 名称 |\n| --- | --- |\n| 688256 | 寒武纪 |\n",
  ];
  for (const t of cases) {
    assert.equal(splitByLinks(t, BOARDS).map((s) => s.text).join(""), t, `切分丢字：${JSON.stringify(t)}`);
    assert.equal(splitByLinks(t).map((s) => s.text).join(""), t, `无清单时丢字：${JSON.stringify(t)}`);
  }
});

test("同一句正文连着切两次结果必须相同；换了清单必须按新清单判（缓存不能粘住上一份榜单）", () => {
  const t = "半导体 电池 半导体 600519 600519.SH 综合";
  const a = JSON.stringify(splitByLinks(t, BOARDS));
  const b = JSON.stringify(splitByLinks(t, BOARDS));
  assert.equal(a, b, "同输入两次结果不同 = 有状态正则的 lastIndex 泄漏了");
  const only: SectorRef[] = [{ code: "BK0001", name: "酿酒行业" }];
  assert.deepEqual(findSectorSpans("半导体 酿酒行业", only).map((s) => (s.link.kind === "sector" ? s.link.code : "?")), ["BK0001"],
    "换清单后只认新清单：旧榜单的名字不该还能点");
  const d = JSON.stringify(splitByLinks(t, BOARDS));
  assert.equal(d, a, "切完别的清单再切回来，结果不能漂");
});

test("无命中时返回一段原文，调用方不必特判", () => {
  const segs = splitByLinks("纯文字没有代码", BOARDS);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { text: "纯文字没有代码", link: null });
});

test("混合正文的片段顺序与类型都对：渲染层按数组顺序画，顺序错了会串行", () => {
  const segs = splitByLinks("资金流向 半导体板块，600519 涨 1.2%", BOARDS);
  assert.deepEqual(segs.map((s) => (s.link ? `${s.link.kind}:${s.text}` : `·${s.text}`)), [
    "·资金流向 ", "sector:半导体", "·板块，", "symbol:600519", "· 涨 1.2%",
  ]);
  assert.equal(linksOf("资金流向 半导体板块，600519 涨 1.2%").length, 2);
});
