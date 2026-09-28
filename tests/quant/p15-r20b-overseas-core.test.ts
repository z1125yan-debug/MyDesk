import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OVERSEAS_CODES, splitTcVars, parseTcOverseasRow, parseA50, a50Url, tcOverseasUrl,
  buildOverseasSnapshot, judgeDivergence,
  A50_WEAK_PCT, A50_STRONG_PCT, US_TECH_WEAK_PCT, A_SHARE_FLAT_PCT, A_SHARE_WEAK_PCT,
  type OverseasRow, type OverseasSnapshot,
} from "../../src/lib/quant/data/overseas-core.ts";

// P15-R20b 外盘与 A50：免 key 两路的解析 + 背离判定形状。
// 这一份的坑全在「字段位」上：腾讯外盘沿用 A 股那套 ~ 分隔布局、新浪 hf_ 那条是另一套逗号布局，
// 两边都不是抄文档抄来的（对照证据写在 overseas-core 的注释里）。所以解析层要钉的是**位置**，
// 判定层要钉的是**形状**：什么算背离、什么算「读不出来」，以及恒指凭什么只算同步不算前瞻。

/** 造一条腾讯外盘正文：只填我们认的那些位，其余留空但保证长度够 */
function tcBody(vals: Record<number, string>): string {
  const f = Array.from({ length: 40 }, (_, i) => (vals[i] ?? `x${i}`));
  return f.join("~");
}

const row = (key: string, changePct: number | null): OverseasRow => ({
  key, label: key, upstreamName: key, code: "C", price: 100, prevClose: 100,
  change: 0, changePct, stamp: "2026-09-28 10:00:00", stampDate: "2026-09-28", tz: "", pctCheck: 0,
});

const snap = (o: {
  rows?: OverseasRow[]; a50Pct?: number | null; today?: string; usAge?: number | null; missing?: string[];
}): OverseasSnapshot => ({
  rows: o.rows ?? [],
  a50: o.a50Pct === undefined || o.a50Pct === null ? null : {
    name: "富时中国A50期货", price: 14000, prevSettle: 14100, open: 14100, high: 14200, low: 13900,
    changePct: o.a50Pct, openInterest: 575819, date: o.today ?? "2026-09-28", time: "10:29:51",
  },
  today: o.today ?? "2026-09-28",
  us_age_days: o.usAge ?? null,
  missing: o.missing ?? [],
  basis: "test",
});

// ---------- 解析层：位置错了要能自己发现 ----------

test("R20b-外① splitTcVars：认外盘键（已有的 splitTcQuoteText 只认 sh/sz/bj 六位，进不去）", () => {
  const text = 'v_usIXIC="a~b~c";v_hkHSI="d~e";v_usNVDA="";nope=1;';
  const m = splitTcVars(text);
  assert.equal(m.get("usIXIC"), "a~b~c");
  assert.equal(m.get("hkHSI"), "d~e");
  assert.equal(m.get("usNVDA"), "", "键在正文空：留着，让上层按「这一路没回数」点名（不在这里偷偷丢）");
  assert.equal(m.size, 3, "没有引号正文的行（nope=1）不计入");
  assert.equal(splitTcVars("").size, 0);
});

test("R20b-外② 腾讯外盘行的字段位：1 名称 / 2 代码 / 3 现价 / 4 昨收 / 30 时刻 / 31 涨跌额 / 32 涨跌幅", () => {
  const body = tcBody({
    1: "纳斯达克", 2: ".IXIC", 3: "22000.00", 4: "21900.00",
    30: "2026-09-25 17:15:59", 31: "100.00", 32: "0.46", 33: "22050.00", 34: "21880.00",
  });
  const r = parseTcOverseasRow("usIXIC", body)!;
  assert.equal(r.label, "纳斯达克", "认得出的代码用中文标签（上游名字会改）");
  assert.equal(r.upstreamName, "纳斯达克");
  assert.equal(r.code, ".IXIC");
  assert.equal(r.price, 22000);
  assert.equal(r.prevClose, 21900);
  assert.equal(r.change, 100);
  assert.equal(r.changePct, 0.46, "涨跌幅照上游字段，不自算覆盖");
  assert.equal(r.stamp, "2026-09-25 17:15:59", "行情时刻原样不折算（美东就是美东）");
  assert.equal(r.stampDate, "2026-09-25");
  assert.equal(r.tz, "美东");
  assert.ok(Math.abs(r.pctCheck as number) <= 0.05, `自算与上游该对得上：${r.pctCheck}`);

  // 恒指 2026-09-28 实测回的是斜杠日期（od 看过字节是 0x2f）。只认连字符时 stampDate 是空串：
  // 时刻照样显示，但凡是按日期算的口径（美股距今几天）会**静默**失效——所以两种分隔符都要认。
  const hsi = parseTcOverseasRow("hkHSI", tcBody({
    1: "恒生指数", 2: "HSI", 3: "26000.00", 4: "25800.00",
    30: "2026/09/28 10:29:09", 31: "200.00", 32: "0.78",
  }))!;
  assert.equal(hsi.stampDate, "2026-09-28", "斜杠日期也要切成 YYYY-MM-DD");
  assert.equal(hsi.tz, "北京");
  assert.equal(hsi.label, "恒生指数");

  // 紧凑 14 位戳（20260924161430）也认，取前 8 位当日期
  const tight = parseTcOverseasRow("usINX", tcBody({ 1: "标普500", 3: "100", 4: "100", 30: "20260924161430" }))!;
  assert.equal(tight.stampDate, "2026-09-24");
  assert.equal(tight.label, "标普500");
});

test("R20b-外③ 现价为 0 / 空 / 行太短：整行不要，不给你造一个「跌到 0」的外盘", () => {
  assert.equal(parseTcOverseasRow("usIXIC", tcBody({ 1: "纳斯达克", 3: "0.00", 4: "21900" })), null, "未开盘回 0 是真有的");
  assert.equal(parseTcOverseasRow("usIXIC", tcBody({ 1: "纳斯达克", 3: "", 4: "21900" })), null);
  assert.equal(parseTcOverseasRow("usIXIC", "a~b~c"), null, "字段不足 35 个：形状变了就当不认");
  assert.equal(parseTcOverseasRow("usIXIC", ""), null);
  // 昨收缺 → 自算涨跌幅拿不到分母，但上游那一条照用；pctCheck 空着说明「没法交叉核对」
  const noPrev = parseTcOverseasRow("usDJI", tcBody({ 1: "道琼斯", 3: "45000", 4: "", 30: "2026-09-25 17:15:59", 32: "-0.31" }))!;
  assert.equal(noPrev.changePct, -0.31);
  assert.equal(noPrev.pctCheck, null);
});

test("R20b-外④ A50（新浪 hf_）字段位：0 现价 / 4 最高 / 5 最低 / 6 时间 / 7 昨收 / 8 今开 / 9 持仓 / 12 日期 / 13 名称", () => {
  const text = 'var hq_str_hf_CHA50CFD="14152.0,0,14153.5,14154.0,14210.0,14150.0,10:29:51,14440.0,14181.0,575819,120,80,2026-09-28,富时中国A50指数期货,209618;";';
  const a = parseA50(text)!;
  assert.equal(a.price, 14152);
  assert.equal(a.prevSettle, 14440, "7 是昨收/昨结：涨跌幅的分母（不是 8 那个今开）");
  assert.equal(a.open, 14181);
  assert.equal(a.high, 14210);
  assert.equal(a.low, 14150);
  assert.equal(a.openInterest, 575819, "9 是持仓量：连取三次不动、而 14 在涨（证据在 core 注释里）");
  assert.equal(a.date, "2026-09-28");
  assert.equal(a.time, "10:29:51");
  assert.equal(a.name, "富时中国A50指数期货");
  assert.equal(Math.round((a.changePct as number) * 1000) / 1000, -1.994, "(14152-14440)/14440：A50 有隔夜时段，必须自算不能信「今天」");

  assert.equal(parseA50('var hq_str_hf_CHA50CFD="0,0,0,0,0,0,10:00:00,14440.0,14181.0,1,1,1,2026-09-28,名称,1";'), null, "现价为 0 → 不是一条报价");
  assert.equal(parseA50('var hq_str_hf_CHA50CFD="14152.0,0,14153.5,14154.0,14210.0,14150.0";'), null, "字段不足 13 个：位置对不上就不猜");
  assert.equal(parseA50("没有引号"), null);
  assert.equal(parseA50(""), null);
  // 名称缺失时退回一个能读的名字，页面不至于空着
  const noName = parseA50('var x="14152.0,0,1,1,1,1,10:00:00,14440.0,1,1,1,1,2026-09-28,,1";')!;
  assert.equal(noName.name, "富时中国A50期货");
  assert.ok(a50Url().includes("hf_CHA50CFD") && tcOverseasUrl().includes(OVERSEAS_CODES.join(",")));
});

test("R20b-外⑤ 上游涨跌幅与「现价/昨收」自算对不上：数照上游显示，但要自己发现并说出来", () => {
  const body = tcBody({ 1: "纳斯达克", 3: "22000.00", 4: "21900.00", 30: "2026-09-25 17:15:59", 32: "-3.00" });
  const snap1 = buildOverseasSnapshot({
    tcText: `v_usIXIC="${body}";`, a50Text: null, today: "2026-09-28", a50Error: "新浪没回",
  });
  assert.equal(snap1.rows.length, 1);
  assert.equal(snap1.rows[0].changePct, -3, "显示仍按上游，不自算覆盖");
  assert.ok(snap1.missing.some((m) => m.includes("字段位置可能变了")), snap1.missing.join("｜"));
  // 另一路没取到：报的是「哪一路没取到」，不是把缺的说成 0
  assert.ok(snap1.missing.some((m) => m.includes("A50 期货未取到")), snap1.missing.join("｜"));
  assert.equal(snap1.a50, null);
});

test("R20b-外⑥ 快照拼装：美股陈旧要点名、按最新那条算距今几天；缺的行逐条报", () => {
  const mk = (key: string, stamp: string) => `v_${key}="${tcBody({ 1: key, 3: "100.00", 4: "99.00", 30: stamp, 32: "1.01" })}";`;
  const s = buildOverseasSnapshot({
    tcText: mk("usIXIC", "2026-09-25 17:15:59") + mk("usSMH", "2026-09-24 16:00:00") + mk("hkHSI", "2026/09/28 10:29:09"),
    a50Text: null, today: "2026-09-28",
  });
  assert.equal(s.rows.length, 3);
  assert.equal(s.us_age_days, 3, "取**最新**那条美股的日期（09-25），不是最早那条");
  assert.ok(!s.missing.some((m) => m.includes("超出一个正常周末")), "3 天在窗口内，不该报陈旧");

  const stale = buildOverseasSnapshot({ tcText: mk("usIXIC", "2026-09-19 17:15:59"), a50Text: null, today: "2026-09-28" });
  assert.equal(stale.us_age_days, 9);
  assert.ok(stale.missing.some((m) => m.includes("别当隔夜读数用")), stale.missing.join("｜"));

  const partial = buildOverseasSnapshot({ tcText: mk("usIXIC", "2026-09-25 17:15:59") + 'v_usSMH="";', a50Text: null, today: "2026-09-28" });
  assert.ok(partial.missing.some((m) => m.includes("usSMH")), "空的行要按代码点名");
  assert.ok(partial.missing.some((m) => m.includes("外盘 usINX：腾讯这次没回这一行")), "OVERSEAS_CODES 里没回来的也要点名（不是静默少一条）");
});

// ---------- 判定层：形状只有这五种 ----------

test("R20b-外⑦ 背离阈值都是导出的常量（页面/取数层不许自己写死一套数）", () => {
  assert.ok(A50_WEAK_PCT < 0 && A50_STRONG_PCT > 0);
  assert.ok(US_TECH_WEAK_PCT < 0);
  assert.ok(A_SHARE_FLAT_PCT > A_SHARE_WEAK_PCT, "「没跟」与「已同步跌」之间要有一段缓冲：-0.2 / -0.5");
});

test("R20b-外⑧ 四种形状各判各的：外盘弱没跟 / 同向下跌 / 外盘强A股弱 / 都不弱", () => {
  const rows = [row("usIXIC", 0.48), row("usSMH", -1.6), row("hkHSI", -1.1)];

  const ahead = judgeDivergence(snap({ rows, a50Pct: -1.2 }), -0.1);
  assert.equal(ahead.kind, "外盘弱而A股没跟");
  assert.equal(ahead.not_priced_in, true, "前瞻背离：这一格要按满额记，压力还没进价格");
  assert.ok(ahead.line.includes("前瞻背离"), ahead.line);

  const same = judgeDivergence(snap({ rows, a50Pct: -1.2 }), -1.8);
  assert.equal(same.kind, "外盘与A股同向下跌");
  assert.ok(same.line.includes("减半"), same.line);

  // 外盘强而 A 股弱：A50 在涨、隔夜科技也不差，A 股自己往下走 → 问题在内部
  const benign = [row("usIXIC", 0.48), row("usSMH", 0.3)];
  const internal = judgeDivergence(snap({ rows: benign, a50Pct: 0.9 }), -1.2);
  assert.equal(internal.kind, "外盘强而A股弱");
  assert.ok(internal.line.includes("问题在内部"), internal.line);

  // 同一批读数里只要有一档弱（半导体 -1.6%），判定就取更差的那一边：A50 在涨也盖不住
  const mixed = judgeDivergence(snap({ rows, a50Pct: 0.9 }), -1.2);
  assert.equal(mixed.kind, "外盘与A股同向下跌", "us_tech 弱 + A 股弱：同向，不是「外盘强而A股弱」");

  const calm = judgeDivergence(snap({ rows: [row("usIXIC", 0.48), row("usSMH", 0.2)], a50Pct: -0.1 }), -0.05);
  assert.equal(calm.kind, "无显著背离", "A50 没到 -0.5、隔夜科技没到 -1.0：这才叫「没有背离」");
});

test("R20b-外⑨ 读不出来的三种样子都要跟「没有背离」区分开", () => {
  const none = judgeDivergence(snap({ rows: [] }), -1.5);
  assert.equal(none.kind, "读数不足");
  assert.ok(none.line.includes("不是「没有背离」"), none.line);
  assert.equal(none.a50_pct, null);
  assert.equal(none.us_tech_pct, null);

  // A 股中位没读到：外盘再弱也判不了是不是背离（不拿 0 当中位）
  const noBase = judgeDivergence(snap({ rows: [], a50Pct: -1.2 }), null);
  assert.equal(noBase.kind, "读数不足");
  assert.ok(noBase.line.includes("中位涨跌幅没读到"), noBase.line);

  // 恒指与 A 股是同一时段：它能进证据，但不能把「没跟」抬成前瞻
  const hkOnly = judgeDivergence(snap({ rows: [row("hkHSI", -2.2)] }), -0.1);
  assert.equal(hkOnly.kind, "读数不足", "只有恒指时 A50/美股都缺：前瞻判不了");
  assert.ok(hkOnly.evidence.some((e) => e.includes("只能算同步、不算前瞻")), hkOnly.evidence.join("｜"));
});

test("R20b-外⑩ 证据四条逐个带时刻；纳指与半导体取更差的那一档", () => {
  const rows = [row("usIXIC", 0.48), row("usSMH", -1.6), row("hkHSI", -1.1)];
  const d = judgeDivergence(snap({ rows, a50Pct: -1.2, usAge: 3 }), -1.8);
  assert.equal(d.us_tech_pct, -1.6, "取 min(纳指, 半导体)，不是平均");
  assert.equal(d.evidence.length, 4);
  assert.ok(d.evidence[0].includes("2026-09-28 10:29:51") && d.evidence[0].includes("上游原样"), d.evidence[0]);
  assert.ok(d.evidence[2].includes("距今 3 天"), d.evidence[2]);
  assert.ok(d.evidence[3].includes("A 股今日中位涨跌幅 -1.80%"), d.evidence[3]);
  assert.equal(d.a_share_median, -1.8, "A 股那一头是调用方从同一份快照带进来的，纯核不取数");
});
