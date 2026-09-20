// P7-⑧③ 对话页右侧上下文面板的回归测试（纯内存：不 fetch、不碰库、不渲染组件）。
//
// 这一层唯一的风险是「把没有的读数画成有」，所以断言以缺数分支为主：
//  1) 缺数一律「本次未取到」，取数服务的占位 0 不许被格式化进面板（报价卡缺失时 price 就是 0）；
//  2) 反过来 0 是真读数时必须照原样显示成 0.00，不能和缺数混成同一个词；
//  3) 面板顶上那个标的必须带出处（本轮识别 / 会话沿用 / 界面焦点兜底，三种不是一回事）；
//  4) 来源词、状态词、标的来源词都断言「与既有那份同源」，防止面板另写一套说法。
// 用例里的代码与数值都是手写的形状样例，不是真实提问，也不是任何行情事实。
import test from "node:test";
import assert from "node:assert/strict";
import {
  DECISION_IDLE_TEXT, MISSING_TEXT, decisionStateText, decisionSummaryOf, evidenceRowsOf,
  numText, panelBadgeText, pctText, pickPanelSymbol, quoteRowsOf, sourceCountsOf, sourceRowsOf,
  symbolSourceNote, techRowsOf, type TechLike,
} from "../../src/lib/desk/context-panel-core.ts";
import { symbolSourceText } from "../../src/lib/desk/intent-core.ts";
import { STEP_STATUS_WORD, type IntentBadge, type StepInfo } from "../../src/lib/desk/chat-core.ts";
import { provenanceBadgeText } from "../../src/lib/desk/ai-context-core.ts";
import { buildDecision } from "../../src/lib/quant/screener/decision-core.ts";

const row = (rows: { label: string }[], label: string) => {
  const hit = rows.find((r) => r.label === label);
  assert.ok(hit, `面板里应有「${label}」这一行`);
  return hit as { label: string; value: string; provenance?: string; badge?: string; note?: string };
};

// ---------- 数字 → 文本：缺和零是两件事 ----------

test("numText/pctText：null 与 NaN/Infinity 都是「本次未取到」，而 0 照原样显示", () => {
  assert.equal(numText(null), MISSING_TEXT);
  assert.equal(numText(Number.NaN), MISSING_TEXT);
  assert.equal(numText(Number.POSITIVE_INFINITY), MISSING_TEXT);
  assert.equal(numText(undefined), MISSING_TEXT);
  assert.equal(numText(0, 2, " 元"), "0.00 元", "0 是真读数，写成缺数就是把「有值」抹掉");
  assert.equal(numText(12.345, 2, " 元"), "12.35 元");
  assert.equal(pctText(1.5), "+1.50%");
  assert.equal(pctText(-2.25), "-2.25%", "负号由 toFixed 带出，不加多余符号");
  assert.equal(pctText(0), "0.00%", "平盘不是缺数");
  assert.equal(pctText(null), MISSING_TEXT);
});

// ---------- 面板显示哪个标的、凭什么 ----------

test("标的优先级：本轮识别 > 会话已关联 > 界面焦点，三条各带一句出处", () => {
  const byIntent = pickPanelSymbol({ intent: { symbol: "600519", symbolSource: "question" }, sessionStock: "000001.SZ", focusSymbol: "000300.SH" });
  assert.equal(byIntent.symbol, "600519.SH", "裸六位按唯一那份号段口径补后缀");
  assert.ok(byIntent.basis.includes(symbolSourceText("question")), "出处文案复用意图层那份，面板不另写一套");

  const bySession = pickPanelSymbol({ sessionStock: "000001.sz", focusSymbol: "000300.SH" });
  assert.equal(bySession.symbol, "000001.SZ");
  assert.ok(bySession.basis.includes("追问沿用"));

  const byFocus = pickPanelSymbol({ focusSymbol: "000300.SH" });
  assert.ok(byFocus.basis.includes("分析页当前品种"));
  assert.ok(byFocus.basis.includes("不是 AI 认出来的"), "兜底必须写明是兜底，否则用户以为系统认出了标的");

  const none = pickPanelSymbol({});
  assert.equal(none.symbol, "");
  assert.ok(none.basis.includes("不需要具体标的"), "大盘/板块类问题没有标的是正常情形，不写成缺数");
});

test("服务端明说「未识别到标的」时不拿会话或界面焦点凑一只票", () => {
  const saidNone = pickPanelSymbol({ intent: { symbol: null, symbolSource: "none" }, sessionStock: "600519.SH", focusSymbol: "000300.SH" });
  assert.equal(saidNone.symbol, "", "面板画一只用户没问的票，比空着更糟");
  assert.ok(saidNone.basis.includes("不拿界面焦点凑"), saidNone.basis);
});

test("symbolSourceNote：已知来源走意图层文案，未知来源与空值都不猜", () => {
  assert.equal(symbolSourceNote("focus"), symbolSourceText("focus"));
  assert.equal(symbolSourceNote("none"), symbolSourceText("none"));
  assert.ok(symbolSourceNote("").includes("没标标的来源"));
  const odd = symbolSourceNote("question_x");
  assert.ok(odd.includes("不在已知口径里"), `未知来源必须原样交代，不能翻成任何一个已知说法：${odd}`);
  assert.ok(!odd.includes(symbolSourceText("question")), "未知值不得被就近翻译成「从提问里识别出的代码」");
});

// ---------- 实时行情快照 ----------

test("报价卡缺失时的占位 0 不许进面板：先判来源再取值", () => {
  const rows = quoteRowsOf({ price: 0, changePct: 0, missing: true, data_status: "MISSING" }, false, "");
  assert.equal(row(rows, "最新价").value, MISSING_TEXT, "missing 卡带的是 price=0 占位值，写成 0.00 元就是假行情");
  assert.equal(row(rows, "涨跌幅").value, MISSING_TEXT);
  assert.equal(row(rows, "昨收").value, MISSING_TEXT);
  assert.equal(row(rows, "最新价").provenance, "MISSING");
  assert.ok(row(rows, "最新价").note?.includes("不用 0"));
});

test("真实报价：价格/涨跌幅带单位，昨收没给时只标昨收那一格", () => {
  const rows = quoteRowsOf({ name: "贵州茅台", price: 1257.12, changePct: 1.5, prevClose: null, data_status: "REAL" }, false, "");
  assert.equal(row(rows, "最新价").value, "1257.12 元");
  assert.equal(row(rows, "涨跌幅").value, "+1.50%");
  assert.equal(row(rows, "最新价").provenance, "REAL");
  assert.equal(row(rows, "昨收").value, MISSING_TEXT);
  assert.ok(row(rows, "昨收").note?.includes("没给昨收"));
  assert.equal(row(rows, "最新价").note, undefined, "有值那一行不该被塞进无关口径");
});

test("演示品种的值照常显示，但整行标 DEMO 且写明不是行情", () => {
  const rows = quoteRowsOf({ price: 3.6, changePct: 0, data_status: "DEMO" }, true, "");
  assert.equal(row(rows, "最新价").provenance, "DEMO");
  assert.equal(row(rows, "最新价").value, "3.60 元");
  assert.ok(row(rows, "最新价").note?.includes("不是行情"));
  assert.equal(row(rows, "涨跌幅").value, "0.00%", "演示值本身是 0 时仍显示 0：DEMO 与缺数各标各的");
});

test("合成分时序列这一格必须自己交代（只用于画图，不是价量事实）", () => {
  const rows = quoteRowsOf({ price: 11.7, changePct: -0.32, data_status: "REAL", series_synthetic: true }, false, "2026-09-21 05:30:00");
  assert.ok(row(rows, "最新价").note?.includes("合成"));
  assert.equal(rows[0].label, "取数时刻（本机）", "面板现取的时刻单独占一行，不与注入模型的快照混成一个时间");
  assert.ok(row(rows, "取数时刻（本机）").note?.includes("不一定是同一秒"));
});

const snap = (over: Partial<TechLike> = {}): TechLike => ({
  tfs: [{ tf: "15分", trend: "上行", rsi: 61 }, { tf: "日线", trend: "震荡", rsi: null }],
  support: 10.8, resistance: 12.4, rr: 1.83, rangePos: 62.4, rangeLow: 9.1, rangeHigh: 13.5,
  source: "real", ...over,
});

test("技术面五行全标 DERIVED：是本机引擎算的，不是交易所发布的指标", () => {
  const rows = techRowsOf(snap());
  assert.equal(row(rows, "多周期趋势").value, "15分=上行｜日线=震荡");
  assert.ok(row(rows, "RSI(14)").value.includes("日线 本次未取到"), "某个周期没算出 RSI 时那一格写缺，不补 0 也不补 50");
  assert.equal(row(rows, "盈亏比").provenance, "DERIVED");
  assert.ok(row(rows, "盈亏比").note?.includes("本机引擎"));
  assert.equal(row(rows, "近半年区间位置").value, "62%（9.10 ~ 13.50）");
});

test("盈亏比没有读数时写「本次未取到」：现价不在支撑与阻力之间时不折成 0", () => {
  const rows = techRowsOf(snap({ rr: null }));
  assert.equal(row(rows, "盈亏比").value, MISSING_TEXT);
  assert.notEqual(row(rows, "盈亏比").value, "0.00（(阻力-现价)/(现价-支撑)）");
});

test("K 线是演示数据时降级成 DERIVED_ON_DEMO；整张快照没取到时五行全缺", () => {
  const demo = techRowsOf(snap({ source: "demo" }));
  assert.equal(row(demo, "多周期趋势").provenance, "DERIVED_ON_DEMO");
  assert.ok(row(demo, "多周期趋势").note?.includes("只能当演示"));
  const gone = techRowsOf(null);
  assert.equal(gone.length, 5);
  for (const r of gone) {
    assert.equal(r.value, MISSING_TEXT);
    assert.equal(r.provenance, "MISSING");
  }
});

// ---------- 数据来源：本轮调过哪些真实接口 ----------

const STEPS: StepInfo[] = [
  { step: 1, label: "行情快照", status: "ok", tool: "get_quote", source: "prefetch", reason: "按个股分析场景预取", ms: 42 },
  { step: 2, label: "板块主线", status: "missing", tool: "get_sector_radar", source: "model", detail: "本次没有返回板块" },
  { step: 3, label: "事件解读", status: "error", tool: "get_events" },
  { step: 4, label: "自选清单", status: "running", tool: "get_watchlist", source: "prefetch" },
];

test("来源行：顺序原样、状态词与发给模型那份同源、未标注来源不猜成系统预取", () => {
  const rows = sourceRowsOf(STEPS);
  assert.deepEqual(rows.map((r) => r.step), [1, 2, 3, 4], "面板不替调用记录重排序");
  assert.equal(rows[0].statusText, STEP_STATUS_WORD.ok);
  assert.equal(rows[1].statusText, STEP_STATUS_WORD.missing);
  assert.equal(rows[2].statusText, STEP_STATUS_WORD.error);
  assert.equal(rows[0].who, "系统预取");
  assert.equal(rows[1].who, "模型自取");
  assert.equal(rows[2].who, "未标注来源", "P7-⑥④ 之前的老会话没有 source 字段，标成任何一种都是编的");
  assert.equal(rows[0].reason, "按个股分析场景预取");
  assert.deepEqual(sourceRowsOf(undefined), []);
});

test("来源计数：ok/missing/error/running 与 prefetch/model/未标注分开算", () => {
  const c = sourceCountsOf(STEPS);
  assert.deepEqual(c, { total: 4, ok: 1, missing: 1, error: 1, running: 1, prefetch: 2, model: 1, unmarked: 1 });
  assert.equal(c.ok + c.missing + c.error + c.running, c.total, "四态必须互斥且穷尽，否则面板上的分数会自相矛盾");
});

// ---------- 分析依据 ----------

/** IntentBadge 是纯展示形状（服务端在 done 事件里回的就是这一份），测试里直接给字面量，不绕判定层 */
const badge = (over: Partial<IntentBadge> = {}): IntentBadge => ({
  scene: "stock_analysis",
  label: "个股分析",
  hits: ["分析", "结构"],
  symbol: "600519.SH",
  symbolSource: "question",
  inherited: false,
  followUp: false,
  skipped: ["事件解读：本次没有可用事件表"],
  prefetchChars: 1820,
  ...over,
});

test("分析依据把「注入多少字」写成读数：0 字就是没行情，不能显示成「0 字」当没事发生", () => {
  const rows = evidenceRowsOf(badge(), STEPS);
  assert.equal(row(rows, "随提问注入的真实数据块").value, "1820 字");
  assert.ok(row(rows, "随提问注入的真实数据块").note?.includes("预取"));
  const empty = evidenceRowsOf(badge({ prefetchChars: undefined }), STEPS);
  assert.equal(row(empty, "随提问注入的真实数据块").value, MISSING_TEXT);
  assert.ok(row(empty, "随提问注入的真实数据块").note?.includes("缺依据"));
});

test("场景徽章没有命中词 / 服务端没回判定，两种「不知道」的写法不一样", () => {
  const noHits = evidenceRowsOf(badge({ hits: [] }), STEPS);
  assert.ok(row(noHits, "本轮按哪个场景答").note?.includes("按通用问答处理"));
  const noIntent = evidenceRowsOf(null, STEPS);
  assert.equal(row(noIntent, "本轮按哪个场景答").value, MISSING_TEXT);
  assert.ok(row(noIntent, "本轮按哪个场景答").note?.includes("不替它编一个场景"));
  assert.ok(!noIntent.some((r) => r.label === "本轮标的"), "判定都没回来时不硬造一行标的：面板顶上那行已经写清了标的是从哪来的");
});

test("「本轮没预取的项」写「无登记」并补一句这不等于每样都取到了", () => {
  const none = evidenceRowsOf(badge({ skipped: [] }), STEPS);
  assert.equal(row(none, "本轮没预取的项").value, "无登记");
  assert.ok(row(none, "本轮没预取的项").note?.includes("不等于每样都取到了"));
  const some = evidenceRowsOf(badge({ skipped: ["板块主线：非交易日"] }), STEPS);
  assert.equal(row(some, "本轮没预取的项").value, "板块主线：非交易日");
});

test("取数步骤摘要把缺/失败/未结束与两种来源都摊开，一步都没有时说明白", () => {
  const hit = row(evidenceRowsOf(badge(), STEPS), "本轮取数步骤");
  assert.equal(hit.value, "1/4 步已取到");
  assert.ok(hit.note?.includes("缺数据 1 步") && hit.note?.includes("失败 1 步") && hit.note?.includes("未结束 1 步"));
  assert.ok(hit.note?.includes("系统预取 2 步") && hit.note?.includes("模型自取 1 步") && hit.note?.includes("未标注 1 步"));
  const bare = row(evidenceRowsOf(badge(), []), "本轮取数步骤");
  assert.equal(bare.value, MISSING_TEXT);
  assert.ok(bare.note?.includes("面板自己现取"));
  const warn = row(evidenceRowsOf(badge(), STEPS, "上游未流式，本机节奏展示"), "本轮登记的提示");
  assert.equal(warn.value, "上游未流式，本机节奏展示");
});

// ---------- 决策结论读数（按需取，不自动打接口） ----------

test("决策摘要默认写「未取」，点了才取，失败时把原因原样带出来", () => {
  assert.equal(decisionStateText({ fetched: false, busy: false }), DECISION_IDLE_TEXT);
  assert.equal(decisionStateText({ fetched: false, busy: true }), "正在取日K / 全A快照 / 板块主线 / 事件解读…");
  assert.equal(decisionStateText({ fetched: true, busy: false, error: "500 超时" }), "本次未取到：500 超时");
  assert.equal(decisionStateText({ fetched: true, busy: false }), "", "取到了就没有状态行");
});

test("决策摘要是结论卡那份三段式的截断，超出的条数如实写「另有 N 条未列」", () => {
  const d = buildDecision({ technical: { ma5: null, ma10: null, ma20: null, close: null, dif: null, dea: null, dif_prev: null, dea_prev: null, bar: null, bar_prev: null, rsi: null } });
  const view = { subject_name: null, as_of: "2026-09-21 05:30:00", trade_date: "2026-09-20", decision: d, sources: [{ id: "s1", label: "日K", detail: "本次没有读数", used: false, as_of: null }] };
  const s = decisionSummaryOf(view, 1);
  assert.ok(s.headline.includes("算不出"), "四维全空时结论就是算不出，面板不许给一个默认分");
  assert.ok(s.risk.length > 1 && s.risk.some((x) => x.includes("另有") && x.includes("未列")), `超出 limit 的条数必须见得到的：${s.risk.join(" / ")}`);
  assert.equal(s.sources[0].used, false);
  assert.equal(s.excludedCount, d.excluded.length);
  assert.equal(s.headline, decisionSummaryOf(view, 5).headline, "截断只影响条数，headline 是内核原文，不能被摘要层改写");
});

// ---------- 徽章文案与来源分层同源 ----------

test("面板徽章文案与注入模型那份同源，且 MISSING 就是任务书要的「本次未取到」", () => {
  assert.equal(provenanceBadgeText("MISSING"), MISSING_TEXT, "这是任务书点名的措辞：两个出口用同一个词");
  assert.equal(panelBadgeText({ label: "最新价", value: "—", provenance: "REAL" }), provenanceBadgeText("REAL"));
  assert.equal(panelBadgeText({ label: "本轮标的", value: "600519.SH", badge: "服务端意图判定" }), "服务端意图判定", "调用记录类行不套行情来源分层，避免被读成事实报价");
  assert.equal(panelBadgeText({ label: "x", value: "y" }), "未标注来源", "两样都没有时不猜");
});
