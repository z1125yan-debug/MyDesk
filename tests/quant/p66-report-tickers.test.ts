// P66 研报「受益标的」的 A 股合规核对（2026-09-27，用户的第 3 件事：核对受益公司）
//
// 触发点：09-24 那份真实产出的受益栏里写着 **华虹半导体**、**华润微电子**、**金山云**。
// 前两个是港股叫法/多写了后缀（A 股在册简称分别是「华虹宏力」「华润微」），第三个根本不是 A 股。
// prompt 里那时已经有红线「受益标的只写 A 股上市公司」——**禁令挡不住模型**，
// 所以这一轮补的是"生成完拿全 A 在册名册逐条对，并把不合规的点名叫出来"这一层。
//
// 钉住的行为：
// ① 只认「核心受益/次级受益/受益标的」行里的名字，结论段的加粗公司名不算标的（不误伤）；
// ② 判定分三档：在册同名 = 合规；名册里对得上同主体但写法不同 = 疑似简称（给在册候选，不自动改）；
//    名册里彻底对不上 = 点名"非 A 股"；
// ③ 名册取不到 → 一律"无法校验"，**绝不因为没查到问题就说合规**；
// ④ 路由失败回 502 + ok:false，不许空名册冒充成功；
// ⑤ 接线：正文落定后才校、名册进程内只拉一次、核对条独立于研报纸面。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const page = () => read("src/components/desk/LlmAnalysisPage.tsx");
const namesRoute = () => read("src/app/api/market/stock-names/route.ts");
const warmSrc = () => read("src/instrumentation.ts");

const core = await import("../../src/lib/desk/report-tickers-core.ts");
const {
  normalizeCompanyName, extractBeneficiaryNames, buildRosterIndex,
  checkBeneficiaryNames, summarizeTickerCheck, tickerCheckLinesZh,
} = core;

// 09-24 那份研报的真实片段（原样摘，不美化：模型写的是加粗名 +（一句理由））
const MD = [
  "## 1. 半导体（🔥 热度：高）",
  "- **产业链受益**：  ",
  "  **① 芯片制造**  ",
  "  - 核心受益：**中芯国际**（国产晶圆产能提升），**华虹半导体**（新产线投产），**长电科技**（封装测试扩容）  ",
  "  - 次级受益：**通富微电**（封装材料），**华润微电子**（晶圆代工）  ",
  "  **② 设备材料**  ",
  "  - 核心受益：**北方华创**（光刻机关键部件），**华天科技**（光刻胶）  ",
  "",
  "## 2. 人工智能（🔥 热度：高）",
  "  - 核心受益：**科大讯飞**（语音交互），**寒武纪**（AI加速卡）  ",
  "  - 核心受益：**东方通信**（光纤宽带），**金山云**（云计算服务）  ",
  "",
  "当前市场处于退潮反抽阶段，重点关注**半导体**与**人工智能**核心受益龙头。  ",
].join("\n");

// 名册样本：写法按**真实在册名册**（2026-09-27 实测 /api/market/stock-names：
// 华虹的 A 股在册简称是「华虹宏力」688347、华润微是 688396 —— 不是 688398，那是赛特新材）
const ROSTER = [
  { symbol: "688981.SH", name: "中芯国际" },
  { symbol: "688347.SH", name: "华虹宏力" },
  { symbol: "600584.SH", name: "XD长电科" }, // 除息日行情源的简称：带 XD 标记且被 8 字节截断（真实回包实测）
  { symbol: "002156.SZ", name: "通富微电" },
  { symbol: "688396.SH", name: "华润微" },
  { symbol: "002371.SZ", name: "北方华创" },
  { symbol: "002185.SZ", name: "华天科技" },
  { symbol: "002230.SZ", name: "科大讯飞" },
  { symbol: "688256.SH", name: "寒武纪" },
  { symbol: "600776.SH", name: "东方通信" },
  { symbol: "688111.SH", name: "金山办公" }, // 与「金山云」只差后缀：同头异尾也不许混过去
  { symbol: "603986.SH", name: "兆易创新" },
  { symbol: "300044.SZ", name: "*ST赛为" }, // 真实在册写法：模型仍写老名「赛为智能」（09-24 那份重新生成的产出）
];

// ─── 抽取：只认受益栏 ────────────────────────────────────────────

test("受益栏抽取：拿到加粗公司名、带上所属主线与档位", () => {
  const items = extractBeneficiaryNames(MD);
  const names = items.map((x) => x.name);
  assert.deepEqual(
    names,
    ["中芯国际", "华虹半导体", "长电科技", "通富微电", "华润微电子", "北方华创", "华天科技", "科大讯飞", "寒武纪", "东方通信", "金山云"],
    "按正文顺序逐条抽出（含不合规的写法，抽取层不做过滤）",
  );
  const hh = items.find((x) => x.name === "华虹半导体")!;
  assert.equal(hh.tier, "核心受益", "档位取自行首标签");
  assert.equal(hh.theme, "半导体", "主线名把序号与热度括号洗掉，核对条才读得通");
  assert.equal(hh.line, 4, "带行号便于回查原文");
});

test("结论段里的加粗公司名不当标的：只认核心/次级受益行", () => {
  const items = extractBeneficiaryNames(MD);
  assert.ok(!items.some((x) => x.name === "人工智能"), "正文别处的加粗（半导体/人工智能）不进标的清单");
  assert.equal(items.filter((x) => x.line === 14).length, 0, "最后一行那句「核心受益龙头」不是受益栏");
});

test("标签自身被加粗时不会抽出「核心受益」这种假公司名", () => {
  const items = extractBeneficiaryNames("## 光通信\n- **核心受益**：**中兴通讯**（设备）**烽火通信**（光缆）");
  assert.deepEqual(items.map((x) => x.name), ["中兴通讯", "烽火通信"], "标签本身被剥掉");
  assert.equal(items[0].tier, "核心受益");
});

test("模型漏写星号时按分隔符退化切分", () => {
  const items = extractBeneficiaryNames("## 储能\n  - 核心受益：阳光电源（逆变器）、宁德时代（电芯）");
  assert.deepEqual(items.map((x) => x.name), ["阳光电源", "宁德时代"], "无加粗也抽得到，且剥掉（理由）");
});

// ↓ 两条真实回归：来自 09-24「重新生成」的那份研报（data/industry-reports.json，2313 字），
//   第一版核对条把「赛为智能科大讯飞」「中光电亨通光电」当成两家公司点名成非 A 股 —— 
//   原因是模型把两家用顿号写进了同一对星号里，而归一化又把顿号当标点吃掉，名字粘成了一坨。
test("一对加粗里写两家公司：先拆顿号再归一化，不能粘成一个假名字", () => {
  const md = [
    "## 1. 半导体（🔥 热度：极高）",
    "  - 核心受益：**兆易创新、华虹宏力**（国产设计需求提升）  ",
    "  - 次级受益：**中芯国际**（产能扩张）  ",
  ].join("\n");
  const items = extractBeneficiaryNames(md);
  assert.deepEqual(
    items.map((x) => `${x.tier}|${x.name}`),
    ["核心受益|兆易创新", "核心受益|华虹宏力", "次级受益|中芯国际"],
    "拆开成三条，且都归到同一行号/主线下",
  );
  const v = checkBeneficiaryNames(items, ROSTER);
  assert.equal(v.filter((x) => x.kind === "not_a_share").length, 0, "拆开之后三家都在册：一个都不该被点名");
});

test("在册带风险警示标记（*ST赛为）：算疑似简称并单独提示，不许误点名成非 A 股", () => {
  const items = extractBeneficiaryNames("## 2. 人工智能\n  - 核心受益：**赛为智能**（算力芯片与大模型研发）");
  const v = checkBeneficiaryNames(items, ROSTER);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.kind, "alias", "ST 股照样是 A 股在册标的，只是写法变了，不能判成不在这册子里");
  assert.equal(v[0]!.risk, "*ST", "标记必须在剥掉星号之前认：反过来 S\\*ST 永远匹配不上");
  assert.equal(normalizeCompanyName("*ST赛为"), "赛为", "比对键剥掉风险警示标记，老名才认得回来");
  const lines = tickerCheckLinesZh(summarizeTickerCheck(v, ROSTER));
  assert.ok(lines.some((l) => l.includes("*ST赛为")), "在册写法连标记一起上屏，不把 ST 洗掉");
  assert.ok(lines.some((l) => l.startsWith("风险警示") && l.includes("300044")), "风险警示单独一条，带代码");
  assert.ok(lines[0].includes("在册已被风险警示 1 处"), "计数行也要说清有几处被警示");
});

test("riskMarkOf：只认风险警示标记，XD/DR 这类当日除权标记不算", () => {
  assert.equal(core.riskMarkOf("*ST康佳A"), "*ST");
  assert.equal(core.riskMarkOf("ST海王"), "ST");
  assert.equal(core.riskMarkOf("XD长电科"), null, "XD 是当天除息标记，不是风险警示，别拿出来吓人");
  assert.equal(core.riskMarkOf("兆易创新"), null);
  assert.equal(core.displayRosterName("*ST赛为"), "*ST赛为", "展示保留标记，与比对键分开");
});

test("归一化：剥括号注释、去空白、ASCII 转大写、折全角、剥当日状态标记", () => {
  assert.equal(normalizeCompanyName(" 华润微电子（688398 ） "), "华润微电子");
  assert.equal(normalizeCompanyName("tcl科技"), "TCL科技");
  assert.equal(normalizeCompanyName("**中芯国际**(688981)"), "中芯国际");
  assert.equal(normalizeCompanyName("京东方Ａ"), "京东方A", "名册里是全角角标（腾讯回包实测）→ 折成半角才对得上");
  assert.equal(normalizeCompanyName("万  科Ａ"), "万科A");
  assert.equal(normalizeCompanyName("XD长电科"), "长电科", "除息标记不是公司名的一部分");
  assert.equal(normalizeCompanyName("N某某 tech"), "某某TECH", "新股标记同样剥掉");
});

// ─── 判定：三档 ──────────────────────────────────────────────────

test("在册同名=合规；简称差异=疑似并给在册候选", () => {
  const v = checkBeneficiaryNames(extractBeneficiaryNames(MD), ROSTER);
  const by = Object.fromEntries(v.map((x) => [x.name, x]));
  assert.equal(by["中芯国际"].kind, "ok");
  assert.equal(by["中芯国际"].match?.symbol, "688981.SH");
  assert.equal(by["金山云"].kind, "not_a_share", "名册对不上 → 点名非 A 股（哪怕名册里有「金山办公」）");
  assert.equal(by["金山云"].match, null);
  // 华润微电子 vs 在册「华润微」：后缀差异，剥到同主体
  assert.equal(by["华润微电子"].kind, "alias");
  assert.equal(by["华润微电子"].match?.name, "华润微");
  assert.equal(by["华润微电子"].match?.symbol, "688396.SH");
});

test("在册简称被行情源截断时（XD长电科）靠前缀关系认出来，仍标疑似并给出在册代码", () => {
  const v = checkBeneficiaryNames(extractBeneficiaryNames(MD), ROSTER);
  const cd = v.find((x) => x.name === "长电科技")!;
  assert.equal(cd.kind, "alias", "名册里那个全称确实对不上，程序不冒充「就是同一家」");
  assert.equal(cd.match?.symbol, "600584.SH", "但代码要对上");
});

test("疑似行的在册写法：补省略号说明是源截了字", () => {
  const r = summarizeTickerCheck(checkBeneficiaryNames(extractBeneficiaryNames(MD), ROSTER), ROSTER);
  const line = tickerCheckLinesZh(r).find((l) => l.includes("长电科技"))!;
  assert.ok(line.includes("长电科…"), `截断名要显式标出来（实际：${line}）`);
  assert.ok(line.includes("600584"));
});

test("港股叫法「华虹半导体」被认成在册「华虹宏力」的疑似简称", () => {
  const v = checkBeneficiaryNames(extractBeneficiaryNames(MD), ROSTER);
  const hh = v.find((x) => x.name === "华虹半导体")!;
  assert.equal(hh.kind, "alias", "同头（华虹）+ 多出来的是行业后缀 → 疑似异名，不算合规也不算非 A 股");
  assert.equal(hh.match?.name, "华虹宏力");
  assert.ok(hh.candidates.length >= 1);
});

test("同头但多出来的不是行业后缀 → 仍按非 A 股点名（金山云 ≠ 金山办公）", () => {
  const v = checkBeneficiaryNames(extractBeneficiaryNames(MD), ROSTER);
  assert.equal(v.find((x) => x.name === "金山云")!.kind, "not_a_share");
});

test("在册写法展示：只有带状态标记的前缀才补省略号，正常简称差异不补", () => {
  assert.equal(core.displayRosterName("XD长电科", "长电科技"), "长电科…");
  assert.equal(core.displayRosterName("华润微", "华润微电子"), "华润微", "华润微本来就是华润微电子的在册简称，不是被截断");
  assert.equal(core.displayRosterName("京东方Ａ", "京东方A"), "京东方A");
});

test("名册为空时不判定：宁可不结论，也不默认合规", () => {
  assert.deepEqual(checkBeneficiaryNames(extractBeneficiaryNames(MD), []), []);
  assert.deepEqual(checkBeneficiaryNames(extractBeneficiaryNames(MD), null as unknown as typeof ROSTER), []);
});

test("名册索引按归一化键建：多市场同名不覆盖", () => {
  const idx = buildRosterIndex([
    { symbol: "600000.SH", name: "测试股份" },
    { symbol: "000001.SZ", name: "测试股份" },
  ]);
  assert.equal(idx.byName.get("测试股份")?.length, 2, "同名两条都留着");
  assert.equal(idx.size, 1);
});

// ─── 汇总与说人话 ────────────────────────────────────────────────

test("汇总：合规/疑似/非A 计数分档", () => {
  const r = summarizeTickerCheck(checkBeneficiaryNames(extractBeneficiaryNames(MD), ROSTER), ROSTER);
  assert.ok(r.checked);
  assert.equal(r.total, 11);
  assert.equal(r.bad.length, 1, "只有金山云是非 A 股");
  assert.equal(r.alias.length, 3, "华虹半导体 + 华润微电子 + 长电科技（名册名被源截断）");
  assert.equal(r.okCount, 7);
});

test("核对条文案：非 A 股要点名到名字和主线", () => {
  const r = summarizeTickerCheck(checkBeneficiaryNames(extractBeneficiaryNames(MD), ROSTER), ROSTER);
  const lines = tickerCheckLinesZh(r).join("\n");
  assert.ok(lines.includes("非 A 股 1 处"), "先给结论计数");
  assert.ok(lines.includes("「金山云」"), "点名到具体写法");
  assert.ok(lines.includes("人工智能"), "带所属主线");
  assert.ok(lines.includes("疑似简称"), "简称差异单列一档");
  assert.ok(lines.includes("华润微 688396"), "疑似档要把在册简称和代码摆出来（真实名册核对过）");
});

test("名册取不到 → 只能说无法校验（口径不许撒谎）", () => {
  const r = summarizeTickerCheck(checkBeneficiaryNames(extractBeneficiaryNames(MD), []), null);
  assert.equal(r.checked, false);
  assert.ok(r.reason.includes("无法校验"));
  assert.ok(r.reason.includes("不代表"), "必须显式声明「没取到名册」不等于「标的都合规」");
});

test("正文没有受益栏：说清没得核，而不是全过", () => {
  const r = summarizeTickerCheck([], ROSTER);
  assert.equal(r.checked, false);
  assert.ok(r.reason.includes("没有「核心受益/次级受益」栏"));
});

// ─── 接线钉测 ────────────────────────────────────────────────────

test("名册路由：只给 symbol+name，取不到回 502 不冒充空名册", () => {
  const src = namesRoute();
  assert.ok(src.includes('listUniverse({ kind: "all" }'), "与 allstocks 同一 provider 口径");
  assert.ok(src.includes('status: 502'), "空名册 / 抛错都回 502");
  assert.ok(src.includes("universeSource()"), "如实标东财快照还是腾讯兜底代码表");
  assert.ok(/names\.length/.test(src), "空返回要有拦截");
});

test("组件接线：名册进程内只拉一次、正文落定才校、失败如实上屏", () => {
  const src = page();
  assert.ok(src.includes('getJson<RosterPayload>("/api/market/stock-names")'), "打的是轻量名册接口");
  assert.ok(src.includes("let rosterLoading: Promise<"), "共享 promise：切研报/重生成都不重复打接口");
  assert.ok(src.includes("const activeText = active?.text ?? \"\""), "只校成稿正文，不一流式一校");
  assert.ok(src.includes("[activeText, busy]"), "依赖：正文或生成状态变了才重校");
  assert.ok(src.includes("受益标的本次无法校验"), "名册没取到时的界面文案");
  assert.ok(src.includes("受益标的 A 股核对"), "核对条标题");
});

test("prompt 补了三个真实反面例子（华虹/华润微/金山云）", () => {
  const src = page();
  assert.ok(src.includes("「华虹宏力」"), "港股叫法要给回 A 股在册简称");
  assert.ok(src.includes("「华润微」"));
  assert.ok(src.includes("「金山云」不是 A 股公司"));
  assert.ok(src.includes("300044 现在在册叫「*ST赛为」"), "风险警示改名也要有例子：老名「赛为智能」是这次真实产出里写的");
});

test("开机预热带上名册接口：校验条不该长时间停在核对中", () => {
  assert.ok(warmSrc().includes('"/api/market/stock-names"'), "WARM_TARGETS 里有名册路由");
});

test("页面副标题跟着 P65 改口：不再宣称喂的是「当日快讯」", () => {
  const src = page();
  const line = src.split("\n").find((l) => l.includes("主题榜单"));
  assert.ok(line, "研报页有数据来源说明");
  assert.ok(line.includes("研报区间三个交易日的快讯池"), "口径要说清是三天窗口");
  assert.ok(!line.includes("当日快讯"), "旧措辞不许留着骗读者（P65 之后喂的已经不是当日）");
});
