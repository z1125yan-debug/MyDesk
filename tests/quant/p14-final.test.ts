// P14 收口轮：自选分组 / 行内走势 / 奇门友好多色卡 / 情绪页遗留 — 2026-09-22
// 背景：《稳智AI 逆向+对齐》§四/§五/§七 与《大盘情绪页》☆P2/P3 遗留的最后一轮。
// 四条口径在本文件钉死：
//  1) 删组只销组——成员全部回未分组，一票不丢（丢票=把管理动作做成破坏动作）；
//  2) 行内展开只有「分时」就老实写分时，不冒充日K，没分时不画直线顶替；
//  3) 友好多色卡是给已解析段落换色贴标签，模型没按格式回就整段展示，不为凑四张卡硬切假分层；
//  4) 连板分档是「3连板+」名单实数归档不是新读数；成交额万亿换算前先过 amount_known——
//     合计 0 可能是「一家都没抓到」，宁显「暂无数据」不出「0.00 万亿」。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addGroupCore, removeGroupCore, moveWatchCore, filterWatchlist, type WatchGroup,
} from "../../src/lib/desk/watchlist-group-core.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------------- 纯核：分组三操作 + 视图过滤 ---------------- */

type Row = { symbol: string; groupId?: string | null };
const wl: Row[] = [
  { symbol: "600519.SH" },
  { symbol: "300750.SZ", groupId: "gA" },
  { symbol: "688256.SH", groupId: "gA" },
  { symbol: "000001.SZ", groupId: "gB" },
];

test("建组：空名/全空白拒绝；同名不重建、返回既有 id；入库前 trim", () => {
  const gs: WatchGroup[] = [{ id: "gA", name: "短线" }];
  assert.deepEqual(addGroupCore(gs, "   ", () => "gx"), { groups: gs, id: null }, "空名不动表");
  const dup = addGroupCore(gs, "短线", () => "gx");
  assert.equal(dup.id, "gA", "同名回既有组 id");
  assert.equal(dup.groups, gs, "同名不产生新数组（表没动）");
  const made = addGroupCore(gs, "  中线  ", () => "gN");
  assert.equal(made.id, "gN");
  assert.equal(made.groups[1].name, "中线", "trim 后入库");
});

test("删组只销组：组消失、成员全回未分组、票一根不丢（本轮最易写坏的一条）", () => {
  const gs: WatchGroup[] = [{ id: "gA", name: "短线" }, { id: "gB", name: "长线" }];
  const r = removeGroupCore(gs, wl, "gA");
  assert.deepEqual(r.groups.map((g) => g.id), ["gB"]);
  assert.equal(r.watchlist.length, wl.length, "删组不减一只票");
  assert.equal(r.watchlist.find((x) => x.symbol === "300750.SZ")?.groupId ?? null, null);
  assert.equal(r.watchlist.find((x) => x.symbol === "688256.SH")?.groupId ?? null, null);
  assert.equal(r.watchlist.find((x) => x.symbol === "000001.SZ")?.groupId, "gB", "别的组不动");
});

test("移组只动目标一身；过滤视图 all/none/未知组语义清楚", () => {
  const moved = moveWatchCore(wl, "600519.SH", "gA");
  assert.equal(moved[0].groupId, "gA");
  assert.equal(moved[1].groupId, "gA", "原成员不变");
  assert.equal(moved[3].groupId, "gB", "其余原样");
  assert.deepEqual(filterWatchlist(wl, "all"), wl);
  assert.deepEqual(filterWatchlist(wl, "none").map((x) => x.symbol), ["600519.SH"], "无 groupId 字段的旧条目=未分组，无需迁移");
  assert.deepEqual(filterWatchlist(wl, "gA").map((x) => x.symbol), ["300750.SZ", "688256.SH"]);
  assert.deepEqual(filterWatchlist(wl, "gGone"), [], "已删/未知组回空集，不硬兜成全部（页面空态自己分文案）");
});

/* ---------------- 装配钉：store / WatchlistPage ---------------- */

const storeSrc = read("../../src/lib/desk/store.ts");
const watchSrc = read("../../src/components/desk/pages/WatchlistPage.tsx");

test("store 接线：三 action 全部转调纯核，组与自选同进本机存档", () => {
  assert.ok(storeSrc.includes("addGroupCore") && storeSrc.includes("removeGroupCore") && storeSrc.includes("moveWatchCore"),
    "语义不埋在 action 里——node 测不到的客户端 store 只留接线");
  assert.ok(storeSrc.includes("watchlistGroups: s.watchlistGroups"), "组进 partialize：刷新后组还在（与对话留存同纪律）");
  assert.ok(storeSrc.includes("watchlistGroups: r.groups"),
    "纯核返回 {groups,watchlist}，store 必须把键对回 watchlistGroups——实机抓到过直塞 set 导致「组删不掉」");
  assert.ok(storeSrc.includes("watchlistGroups: []"), "默认无组：未分组不是一条假组记录");
});

test("自选页工具条：截断如实、删组按钮自解释「股票退回未分组」、移入下拉 null=回未分组", () => {
  assert.ok(watchSrc.includes("仅取前 ${BATCH} 只报价（接口单次上限，其余未取）"), "按当前视图数如实报截断");
  assert.ok(watchSrc.includes("删组（股票退回未分组）"), "删组这一破坏性观感要先在标签上说清不是删票");
  assert.ok(watchSrc.includes("moveWatch(r.symbol, e.target.value || null)"), '空 option 值 = null = 移回未分组');
  assert.ok(watchSrc.includes("filterWatchlist(watchlist, groupFilter"), "视图过滤消费纯核，不自己抄 filter");
});

test("行内展开：分时口径如实标注、日K请去完整分析页、没分时不画直线顶替", () => {
  assert.ok(watchSrc.includes("分时口径（报价接口随带分时线 · 日K请看完整分析页）"), "有分时线也不冒充日K蜡烛图");
  assert.ok(watchSrc.includes("不以直线冒充"), "spark 缺失走诚实行，不给一条平线");
  assert.ok(watchSrc.includes("打开完整分析 →"), "展开是省一跳，不是替代跳页出口");
  assert.ok(watchSrc.includes("<Sparkline data={r.spark}") && watchSrc.includes("width={260} height={44}"),
    "复用既有 Sparkline 放大画，不新写一套 K 线渲染");
});

/* ---------------- 装配钉：奇门友好多色卡 ---------------- */

const qimenSrc = read("../../src/components/desk/QimenPanel.tsx");

test("友好多色卡：蓝/绿/橙三色 + 灰=技术补充折叠；未解析整段照展示，不硬切假分层", () => {
  for (const tone of ["blue: ", "green: ", "orange: "]) {
    assert.ok(qimenSrc.includes(tone), `缺色 ${tone.trim()}`);
  }
  assert.ok(qimenSrc.includes('tone="blue" title="整体判断 · 核心结论"'), "蓝=整体判断");
  assert.ok(qimenSrc.includes('tone="green" title="正面 · 操作建议"'), "绿=正面");
  assert.ok(qimenSrc.includes('tone="orange" title="警示 · 风险提示"'), "橙=警示");
  assert.ok(qimenSrc.includes("FriendlyTechCard") && qimenSrc.includes("技术补充 · 盘面要项"), "灰=技术补充（可折叠）");
  assert.ok(qimenSrc.includes("模型未按三段格式返回，原文整段如下（不硬切成假标题）"), "parsed=false 的整段分支原样保住");
  assert.ok(qimenSrc.includes("不是市场事实、不是研究结论、不构成投资建议"), "风险声明恒在（文档 §七 P3②）");
});

/* ---------------- 装配钉：情绪页遗留（万亿格式 + 连板分档） ---------------- */

const marketSrc = read("../../src/components/desk/pages/MarketPage.tsx");
const quantApi = read("../../src/lib/desk/quant-api.ts");

test("成交额卡：先过 tLatest 再换算万亿；vs昨日只在趋势真带回 delta 时给，缺就显「—」不凑", () => {
  assert.ok(quantApi.includes("amount_known: number"), "客户端类型补上真实读数家数（合计 0≠全市场 0 亿）");
  assert.ok(marketSrc.includes('tLatest ? `${((tLatest.totalYi as number) / 1e4).toFixed(2)}万亿` : "—"'),
    "一家都没抓到 → 暂无数据（—），不出 0.00 万亿");
  assert.ok(marketSrc.includes("万亿"), "≥万亿对齐稳智格式");
  assert.ok(marketSrc.includes("delta?.yi != null"), "vs昨日只在趋势真带回 delta 时给，缺就是缺、不硬凑");
});

test("连板分档 chips：三/四/五板+ 从「3连板+」名单实数归档，20+ 计入五板+", () => {
  assert.ok(marketSrc.includes('t.label === "3连板+"'), "分档基数是既有的 3连板+ 真实名单");
  assert.ok(marketSrc.includes("s.boards === 3") && marketSrc.includes("s.boards === 4") && marketSrc.includes("s.boards >= 5"),
    "三/四/五板+ 三档计数");
  assert.ok(marketSrc.includes("三板") && marketSrc.includes("四板") && marketSrc.includes("五板+"), "chips 上屏");
});
