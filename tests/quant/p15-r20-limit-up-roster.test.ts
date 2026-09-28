import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ladderOf, moneyEffect, poolSymbol, promotionDayLine, promotionRates, parsePoolRows, rosterFromDb, sealClock,
  MONEY_EFFECT_MIN_COVERAGE, type RosterRow,
} from "../../src/lib/quant/screener/limit-up-roster-core.ts";
import { escalateToHighRisk, HIGH_RISK_MIN_SEVERE } from "../../src/lib/quant/screener/top-risk-core.ts";

// P15-R20a 涨停名单（晋级率 / 梯队断层 / 昨日涨停表现）+ 「高风险」死档补活。
// 红线：缺读数 ≠ 0。昨日该档 0 家 → 晋级率是 null（不是 0%）；boards 读不到 → 不进任何板数桶；
//       覆盖率不够 → 赚钱效应整组不出数；池子 0 条 → 一行都不写。

const readSrc = (p: string) => readFileSync(new URL(p, new URL("../../", import.meta.url)), "utf8");

const row = (symbol: string, boards: number | null, over: Partial<RosterRow> = {}): RosterRow => ({
  symbol, name: symbol.slice(0, 6), industry: "半导体", boards,
  changePct: 10, firstSeal: "09:30:06", lastSeal: "14:00:00",
  breakCount: 0, sealFund: 1e8, floatCap: 5e9, ...over,
});

test("R20-① 封板时刻：整数秒针补零到 6 位；分/秒越界判不可信（返回 null，不猜时间）", () => {
  assert.equal(sealClock(93006), "09:30:06", "五位数要当成 09:30:06 而不是 00:09:30");
  assert.equal(sealClock(92500), "09:25:00", "集合竞价 9:25 整");
  assert.equal(sealClock(150000), "15:00:00");
  assert.equal(sealClock(956000), null, "小时 95 不可能是时刻");
  assert.equal(sealClock(93660), null, "秒=60 越界：不返回一个看着像时间的字符串");
  assert.equal(sealClock(1234567), null, "七位数装不进 HHMMSS");
  assert.equal(sealClock(null), null);
  assert.equal(sealClock("103000"), "10:30:00", "字符串读数照收");
});

test("R20-② 代码认市只看号段（池子 m 字段深市与北交所同样返回 0，不信它）", () => {
  assert.equal(poolSymbol("600000"), "600000.SH");
  assert.equal(poolSymbol("000001"), "000001.SZ");
  assert.equal(poolSymbol("301234"), "301234.SZ");
  assert.equal(poolSymbol("688981"), "688981.SH");
  assert.equal(poolSymbol("920748"), "920748.BJ", "北交所 92 开头：m=0 也要落到 .BJ");
  assert.equal(poolSymbol("60000"), null, "五位不是代码");
  assert.equal(poolSymbol("600000.SH"), null, "带后缀的进来不是这个层的活");
});

test("R20-③ 池子行解析：认不出代码的行计入 dropped 不静默吞；lbc 读不到时 boards 是 null 不是首板", () => {
  const { rows, dropped } = parsePoolRows([
    { c: "601811", n: "文投控股", m: 1, lbc: 3, zdp: 10.02, fbt: 93006, lbt: 145959, zbc: 1, fund: 2e8, ltsz: 5e9, hybk: "影视" },
    { c: "920748", n: "某某北交所", m: 0, lbc: 1, zdp: 29.9, hybk: "汽配" },
    { c: "ABCDEF", n: "形状不对" },
    { c: "000001", n: "缺连板数", zdp: 10 },
    null,
  ]);
  assert.equal(dropped, 2, "非法代码 + null 行都要报出来（不静默吞）");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].symbol, "601811.SH");
  assert.equal(rows[0].boards, 3);
  assert.equal(rows[0].firstSeal, "09:30:06");
  assert.equal(rows[0].breakCount, 1);
  assert.equal(rows[1].symbol, "920748.BJ", "北交所按号段认，不看 m");
  assert.equal(rows[2].boards, null, "读不到 lbc → null，不能默认当首板（会虚增首板分母）");
});

test("R20-④ 梯队：最高板 / 逐板家数 / 断层只在 2..最高板之间找；boards 缺的行单独计数", () => {
  const l = ladderOf([row("600001.SH", 1), row("600002.SH", 1), row("600003.SH", 2), row("600004.SH", 5), row("600005.SH", null)]);
  assert.equal(l.highest, 5);
  assert.equal(l.unknownBoards, 1, "缺连板数的不进桶，但要报家数");
  assert.deepEqual(l.counts, [{ boards: 1, n: 2 }, { boards: 2, n: 1 }, { boards: 5, n: 1 }]);
  assert.deepEqual(l.gaps, [3, 4], "2 板有人、3/4 板没人 → 断层是 3、4");
  const full = ladderOf([row("A.SH", 1), row("B.SH", 2), row("C.SH", 3)]);
  assert.deepEqual(full.gaps, [], "板数连续不算断层");
  const none = ladderOf([row("A.SH", null)]);
  assert.equal(none.highest, null, "一个 boards 都没读到 → 最高板未知，不是 0 板");
  assert.deepEqual(none.gaps, []);
});

test("R20-⑤ 晋级率：分母是昨日那一档的家数；判据取严（今日仍在池且板数 +1）", () => {
  const prev = [
    row("600001.SH", 1), row("600002.SH", 1), row("600003.SH", 1),
    row("600011.SH", 2), row("600012.SH", 2),
    row("600021.SH", 4),
  ];
  const today = [
    row("600001.SH", 2), // 真晋级：1→2
    row("600002.SH", 1), // 又涨停但板数没涨（数据不对也要按判据算）→ 不算晋级
    row("600011.SH", 3), // 2→3
    row("600021.SH", 5), // 4→5，属「3板以上续住」
  ];
  const p = promotionRates(prev, today);
  assert.equal(p.oneToTwo.base, 3);
  assert.equal(p.oneToTwo.promoted, 1);
  assert.equal(p.oneToTwo.rate, (1 / 3) * 100);
  assert.equal(p.twoToThree.promoted, 1);
  assert.equal(p.threePlus.base, 1);
  assert.equal(p.threePlus.promoted, 1);
  assert.equal(p.computed, true);
  assert.equal(p.reason, "");
});

test("R20-⑥ 晋级率的「缺读数」姿势：昨日该档 0 家 → rate 是 null 不是 0%；两日名单空 → 整组算不出并报原因", () => {
  const p = promotionRates([row("A.SH", 1), row("B.SH", 1)], []);
  assert.equal(p.computed, false, "今日名单为空 → 整组不算");
  assert.match(p.reason, /今日名单为空/);
  assert.match(p.reason, /不拿 0% 冒充/, "原因要写成人话，页面直接显示");

  const q = promotionRates([], [row("A.SH", 2)]);
  assert.equal(q.computed, false);
  assert.match(q.reason, /昨日名单为空/);

  // 昨日只有 2 板票：1进2 与 3板以上 两档没有分母，是 null；只有 2进3 算得出来
  const r = promotionRates([row("A.SH", 2)], [row("A.SH", 3)]);
  assert.equal(r.oneToTwo.base, 0);
  assert.equal(r.oneToTwo.rate, null, "没有首板不等于「首板全军覆没」——后者才是坏消息");
  assert.equal(r.threePlus.rate, null);
  assert.equal(r.twoToThree.rate, 100);
  assert.equal(r.computed, true);
});

test("R20-⑦ 接力口径一行（页面/日志同一句）：算得出报三档与梯队，算不出原样说算不出", () => {
  const line = promotionDayLine("2026-09-28", "2026-09-25",
    promotionRates([row("A.SH", 1), row("B.SH", 2)], [row("A.SH", 2)]),
    ladderOf([row("A.SH", 2), row("B.SH", 2)]));
  assert.match(line, /2026-09-28 接力（对 2026-09-25）/);
  assert.match(line, /1进2 1\/1（100%）/);
  assert.match(line, /0 家（无分母）/, "没有分母的那档要写「0 家」而不是 0%");
  assert.match(line, /最高 2 板、梯队连续/);

  const bad = promotionDayLine("2026-09-28", "2026-09-25",
    promotionRates([], [row("A.SH", 1)]),
    ladderOf([row("A.SH", 1), row("B.SH", 5)]));
  assert.match(bad, /算不出/);
  assert.match(bad, /昨日名单为空/);
  const gapLine = promotionDayLine("2026-09-28", "2026-09-25",
    promotionRates([row("A.SH", 1)], [row("A.SH", 2), row("B.SH", 5)]),
    ladderOf([row("A.SH", 2), row("B.SH", 5)]));
  assert.match(gapLine, /中间断 3\/4 板/, "断层要在同一行里说出来");
});

test("R20-⑧ 赚钱效应（昨日涨停股今日表现）：覆盖率不过半就不出数，缺的票不补 0", () => {
  const prev = [row("A.SH", 1), row("B.SH", 1), row("C.SH", 2), row("D.SH", 1), row("E.SH", 1)];
  const thin = moneyEffect(prev, new Map([["A.SH", 5], ["B.SH", -2]]));
  assert.equal(thin.available, false, "5 只里只读到 2 只（40%）< 阈值 → 整组不出数");
  assert.equal(thin.coverage, 0.4);
  assert.match(thin.reason, /不报均值/);
  assert.ok(MONEY_EFFECT_MIN_COVERAGE === 0.5, "阈值就是这一处，页面与核认同一个数");

  const ok = moneyEffect(prev, new Map([["A.SH", 9.9], ["B.SH", -2], ["C.SH", 3], ["D.SH", 1], ["E.SH", null]]));
  assert.equal(ok.available, true);
  assert.equal(ok.sample, 4, "读到 null 的那只不参与，也不补 0");
  assert.equal(ok.positiveRate, 75);
  assert.equal(ok.median, 3, "排序取中位（4 个样本取第 3 个）");
  assert.ok(Math.abs((ok.avg ?? 0) - 2.975) < 1e-9, "均值只算读到的那 4 只");

  const empty = moneyEffect([], new Map());
  assert.equal(empty.available, false);
  assert.match(empty.reason, /昨日无涨停名单/);
});

test("R20-⑨ rosterFromDb：库里的空串/非法板数一律回落 null（别让缺列长成 0 的样子）", () => {
  const r = rosterFromDb({ symbol: "600001.SH", name: "", industry: "", boards: 0, changePct: NaN, firstSeal: "", breakCount: null });
  assert.equal(r.name, "");
  assert.equal(r.boards, null, "boards=0 不是合法连板数（最小 1）");
  assert.equal(r.changePct, null, "NaN 不算读数");
  assert.equal(r.firstSeal, null, "空串不是时刻");
  const good = rosterFromDb({ symbol: "600002.SH", boards: 3, changePct: 10.02, firstSeal: "09:30:06", breakCount: 2 });
  assert.equal(good.boards, 3);
  assert.equal(good.breakCount, 2);
});

test("R20-⑩ 高风险补活：两条「偏高」级读数同拍才升档；已有五条阈值一个字没改", () => {
  const esc = escalateToHighRisk("偏高", ["涨跌家数比<0.5", "炸板率>40%"]);
  assert.equal(esc.level, "高风险");
  assert.equal(esc.escalated, true);
  assert.equal(esc.severe, 2);
  assert.match(esc.text, /同拍命中 2 条/);
  assert.ok(HIGH_RISK_MIN_SEVERE === 2, "阈值写在常量里，页面能原样带出这个数字");

  assert.equal(escalateToHighRisk("偏高", ["涨跌家数比<0.5"]).level, "偏高", "单条读数再差也不升档");
  assert.equal(escalateToHighRisk("注意", ["涨跌家数比<0.5", "炸板率>40%"]).escalated, false, "停在注意说明规则没记到偏高，不越级");
  assert.equal(escalateToHighRisk("偏高", ["炸板率>40%", "炸板率>40%"]).escalated, false, "同一条读数重复不算两条");
  assert.equal(escalateToHighRisk("高风险", []).level, "高风险", "已经在最高档不再往上（往上没有定义）");

  // 接线钉：sentiment 里五条既有阈值原样在，且仍然没有任何一处 worse("高风险")
  const sent = readSrc("src/lib/quant/screener/sentiment.ts");
  for (const t of ["阈值 <0.5", "阈值 -500", "阈值 -300", "阈值 >40%", "median < -1.5"]) {
    assert.ok(sent.includes(t), `既有阈值不该被动过：${t}`);
  }
  assert.ok(!sent.includes('worse("高风险")'), "升高风险只走 escalateToHighRisk 这一条路，别再在规则里直接写");
  assert.ok(sent.includes("escalateToHighRisk"), "升档判据接进了情绪引擎");
});

test("R20-⑪ 取数层与写库层：qdate 不作校验、0 条不写行、15:05 前与周末拒跑", () => {
  const io = readSrc("src/lib/quant/data/em-ztpool.ts");
  assert.ok(io.includes("qdate 故意不使用") || io.includes("qdate 永远是"), "响应里的 qdate 是服务器今天，不能拿来校验所查日期");
  assert.ok(io.includes("分不出来"), "0 条分不清休市与超窗口，必须在取数层就说明白");
  assert.ok(io.includes("ok: false"), "0 条回 ok:false，由采集侧决定不写");

  const collect = readSrc("src/lib/quant/screener/limit-up-collect.ts");
  assert.ok(collect.includes("拒绝在周末执行"), "周末拒跑：周六的池子是周五的");
  assert.ok(collect.includes("拒绝在收盘前执行") && collect.includes("15:05"), "盘中池子只是「此刻封板的票」，不钉进历史");
  assert.ok(collect.includes("一条都不写"), "无有效名单 → 抛错留痕，不产出空存档");
  assert.ok(collect.includes("TRADING_DAY_MIN_CLOSE_ROWS"), "回填只跑本地收盘价表证明开过盘的日期");

  const schema = readSrc("prisma/schema.prisma");
  assert.ok(schema.includes("model MarketLimitUp") && schema.includes('@@unique([symbol, tradeDate])') && schema.includes('@@map("market_limit_up")'),
    "票×交易日唯一键：同日重跑以最后一次为准");
});

test("R20-⑫ 接线：roster 进调度白名单与手动接口，风险接口带出 promotion 块，页面读出接力卡", () => {
  const rules = readSrc("src/lib/quant/scheduler/rules.ts");
  const idx = readSrc("src/lib/quant/scheduler/index.ts");
  assert.ok(rules.includes('TaskKind = "radar" | "events" | "breadth" | "review" | "roster"'), "任务类型五值化");
  assert.ok(/KINDS: TaskKind\[\] = \[[^\]]*"roster"/.test(idx), "收盘后窗口自动跑名单沉淀（不写死整行，加第六种任务不该红）");
  assert.ok(idx.includes("archiveLimitUpRoster()"), "执行分支接上沉淀器");
  assert.ok(idx.includes('roster: "涨停名单不设增量游标'), "状态接口对 roster 也照实说「没有游标这回事」");

  const run = readSrc("src/app/api/tasks/run/route.ts");
  assert.ok(run.includes('body.kind === "roster"'), "手动接口白名单含 roster（收盘前跑会被沉淀器拒并如实报错）");

  const route = readSrc("src/app/api/market/risk/route.ts");
  assert.ok(route.includes("readPromotionBlock"), "风险接口带出接力/梯队/昨日涨停表现");
  assert.ok(route.includes("promotion ? promotion.missing"), "名单读不到的那句要进 missing，一起进页面「暂缺」");

  const page = readSrc("src/components/desk/pages/RiskPage.tsx");
  assert.ok(page.includes("接力与梯队") && page.includes("昨日这一档 0 家"), "页面显示三档接力并说清没有分母的样子");
  assert.ok(page.includes("不是「今天没人涨停」"), "整块读不到时，文案要挡住「0=没人涨停」这个误读");

  const api = readSrc("src/lib/desk/quant-api.ts");
  assert.ok(api.includes("PromotionBlock"), "客户端类型与纯核共用一份结构，不在页面抄第二遍");
});
