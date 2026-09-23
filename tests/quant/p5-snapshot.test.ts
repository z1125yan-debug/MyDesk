// P5 第五阶段 每日留档测试。两层结构与第四/五阶段其余测试一致：
// A) 纯内核（snapshot-core.ts）：一次接口响应 → 可入库列的提取、算不出的量保持 null、缺字段就拒绝留档、
//    人话摘要与口径文案。全在内存里跑，常规回归必做。
// B) 机制验收（隔离库副本）：把运行时库复制到 OS 临时目录，用真实写入层函数把「明显标成机制行」的
//    payload 写进三张快照表，再读回验证同日多条都保留、按留档时刻倒序、按日分组计数正确；
//    跑完删副本，并断言真实库文件的字节数与修改时间完全没变。
// 为什么绝不在真实库上试写：REAL_DATA_ONLY —— risk/theme/probability 快照表将是正式留档，
//    掺进伪造 payload 等于制造假的过去结果，之后的按天比较会被它污染。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SNAPSHOT_TABLE, SNAPSHOT_TEXT, emptyDaySnapshotNote, noSnapshotNote, parseSnapshotKind, probabilityColumnsFrom,
  probabilityHeadline, riskColumnsFrom, riskHeadline, sanitizeProbabilityRequest, snapshotBasis,
  snapshotDateBuckets, snapshotItem, themeColumnsFrom, themeHeadline,
  type ExtractErr, type ExtractOk,
} from "../../src/lib/quant/screener/snapshot-core.ts";
import {
  countSnapshots, insertProbabilitySnapshot, insertRiskSnapshot, insertThemeSnapshot, listSnapshotRows,
  snapshotDateRows, type SnapshotDb, type SnapshotRow,
} from "../../src/lib/quant/screener/snapshot.ts";

const DAY = "2026-09-19";
const AT = "2026-09-19 20:41:07";
const MK = "〔机制测试行·非真实计算结果〕";
const DB_FILE = path.join(process.cwd(), "prisma", "db", "custom.db");

const RISK_OK = {
  ok: true, trade_date: DAY, live: false, total: 5231, advancers: 1200, decliners: 3900, flat: 131,
  limit_up: 22, limit_down: 9, touched_limit: 40, limit_up_broken: 18, break_rate: 45,
  amount_total_yi: 9999.5, main_net_sum_yi: -612.3, median_pct: -1.82,
  indices: [{ symbol: "000001.SH", name: "上证指数", price: 3000, changePct: -0.5 }],
  risk: { level: "偏高", triggers: ["涨跌家数比 0.31（阈值 <0.5）", "炸板率升至 45%（阈值 >40%）"] },
  missing: ["北向净流入：交易所自2024-08-19起不再披露，无官方数据源"],
  source: { provider: "em（东财 clist 全A快照 + 腾讯指数）", universe_endpoint: "push2.eastmoney.com/api/qt/clist", indices_endpoint: "qt.gtimg.cn" },
  history_ref: null,
};

// ---------- A) 纯内核 ----------

/** 收窄「提取成功」分支：返回拒绝原因本身就是断言失败，测试里不用 as never 硬转 */
function cols<T>(r: ExtractOk<T> | ExtractErr): T {
  if (!r.ok) throw new Error(`本该提取出留档列，却返回了拒绝原因：${r.error}`);
  return r.columns;
}

/** 收窄「必须拒绝」分支：返回了可用列同样是断言失败（该拒的没拒 = 脏数据会进正式库） */
function errOf<T>(r: ExtractOk<T> | ExtractErr, what: string): string {
  if (r.ok) throw new Error(`${what}：本该拒绝留档，却返回了可用列`);
  return r.error;
}

test("kind 解析与表名映射：只有三页可留档，其它值直接拒", () => {
  assert.equal(parseSnapshotKind("risk"), "risk");
  assert.equal(parseSnapshotKind(" probability "), "probability");
  for (const bad of ["", "radar", "events", "MARKET", "risk;drop"]) assert.equal(parseSnapshotKind(bad), null, `${bad} 不是可留档页面`);
  assert.deepEqual(SNAPSHOT_TABLE, { risk: "risk_snapshot", themes: "theme_snapshot", probability: "probability_snapshot" });
  assert.deepEqual(Object.keys(SNAPSHOT_TEXT), ["risk", "themes", "probability"]);
});

test("Risk 列提取：正常响应逐列对上，算不出的炸板率保持 null 而不是 0", () => {
  const c = cols(riskColumnsFrom(RISK_OK, AT));
  assert.deepEqual(
    { tradeDate: c.tradeDate, level: c.level, total: c.total, advancers: c.advancers, decliners: c.decliners, limitUp: c.limitUp, limitDown: c.limitDown, mainNetYi: c.mainNetYi, medianPct: c.medianPct, live: c.live },
    { tradeDate: DAY, level: "偏高", total: 5231, advancers: 1200, decliners: 3900, limitUp: 22, limitDown: 9, mainNetYi: -612.3, medianPct: -1.82, live: false },
  );
  assert.equal(c.breakRate, 45);
  assert.deepEqual(c.missing, RISK_OK.missing, "当次缺失口径必须随留档一起存");
  assert.match(c.source, /东财 clist/);
  assert.match(c.source, new RegExp(AT.replace(/[:]/g, "\\$&")), "留档时刻没进来源：将来无法区分同日多条");

  assert.equal(cols(riskColumnsFrom({ ...RISK_OK, break_rate: null }, AT)).breakRate, null, "当日触板为 0 ⇒ 炸板率算不出，必须留 null，不能记成 0%");

  assert.match(errOf(riskColumnsFrom({ ...RISK_OK, trade_date: "" }, AT), "没有交易日就无法确定留档是哪一天"), /不是 YYYY-MM-DD/, "必须拒绝，而不是拿今天顶上");
  assert.match(errOf(riskColumnsFrom({ ok: false, error: "上游超时" }, AT), "接口失败"), /未留档/);
  errOf(riskColumnsFrom({ ...RISK_OK, risk: {} }, AT), "缺 risk.level 的响应不该成为一条可用留档");
});

test("Themes 列提取：四类角色计数与主线名前清单，失败响应拒绝留档", () => {
  const themes = {
    ok: true, trade_date: DAY,
    main: [{ name: "电力", score: 88, changePct: 3.1, mainYi: 20.5 }, { name: "机器人", score: 74.6, changePct: 2.2, mainYi: 10 }],
    sub: [{ name: "券商" }], rotation: [], watch: [{ name: "观察1" }, { name: "观察2" }],
    missing: ["RPS=行业+概念合并榜内涨幅百分位（非全市场）"],
    source: { provider: "em（东财板块榜 + 成分 clist + 板块资金日K/指数K）", note: "规则版主线/次主线/轮动，不接 LLM；无数据字段显式缺失" },
  };
  const c = cols(themeColumnsFrom(themes, AT));
  assert.deepEqual({ main: c.mainCount, sub: c.subCount, rot: c.rotationCount, watch: c.watchCount }, { main: 2, sub: 1, rot: 0, watch: 2 });
  assert.deepEqual(c.topMain, [
    { name: "电力", score: 88, changePct: 3.1, mainYi: 20.5 },
    { name: "机器人", score: 74.6, changePct: 2.2, mainYi: 10 },
  ]);
  assert.equal(cols(themeColumnsFrom({ ...themes, main: Array.from({ length: 10 }, (_, i) => ({ name: `板块${i}`, score: i })) }, AT)).topMain.length,
    6, "topMain 只留前 6 条：全量清单在 payload 里，提成列是为了按天快速比较");
  errOf(themeColumnsFrom({ ok: false, error: "板块数据源暂不可用" }, AT), "接口失败");
  const h = themeHeadline(themes, AT);
  assert.match(h, /主线 2 \/ 次主线 1 \/ 轮动 0 \/ 观察 2/);
  assert.match(h, /电力\(88\)、机器人\(75\)/, "评分四舍五入到整数显示");
  assert.match(themeHeadline({ ...themes, main: [] }, AT), /本次未产出主线/);
});

test("概率留档请求：条件必填、字段白名单、回看天数夹取、多余键丢弃、非法回放日不透传", () => {
  const missing = sanitizeProbabilityRequest({ universe: "index" });
  assert.equal(typeof missing, "string", "没有条件的胜率数字不可复现：必须拒绝留档并给出原因");
  assert.match(String(missing), /无法复现/);
  const ok = sanitizeProbabilityRequest({
    conditions: [{ field: "mainNet", op: ">", value: 5e7, window: 5, evil: "x" }, { field: "pct", op: "<", value: "-1.5" }],
    universe: "custom", symbols: [" 600000.sh ", "", "000001.SZ"], lookback: 5000, trade_date: "2026-06-30",
  }) as { conditions: Record<string, unknown>[]; universe: string; symbols?: string[]; lookback: number; trade_date?: string };
  assert.deepEqual(Object.keys(ok).sort(), ["conditions", "lookback", "symbols", "trade_date", "universe"]);
  assert.deepEqual(ok.conditions[0], { field: "mainNet", op: ">", value: 50000000, window: 5 }, "非白名单键（evil）必须被丢掉");
  assert.deepEqual(ok.conditions[1].value, "-1.5", "字符串数值原样保留（value 允许是字符串）");
  assert.equal(ok.lookback, 800, "回看天数按接口同一规则夹到 120..800：留档存的必须是真正生效的值");
  assert.deepEqual(ok.symbols, ["600000.SH", "000001.SZ"]);
  const junkDate = sanitizeProbabilityRequest({ conditions: [{ field: "a", op: ">", value: 1 }], trade_date: "2026-13-45" }) as { trade_date?: string };
  assert.equal(junkDate.trade_date, undefined, "非法回放日宁可不带，也不能让下游悄悄当成今天");
  const def = sanitizeProbabilityRequest({ conditions: [{ field: "a", op: ">", value: 1 }] }) as { lookback: number; universe: string };
  assert.equal(def.lookback, 520);
  assert.equal(def.universe, "index");
});

test("概率列提取与摘要：基准日/样本量口径/警告都留痕，历史回放被标明", () => {
  const req = sanitizeProbabilityRequest({ conditions: [{ field: "mainNet", op: ">", value: 1 }, { field: "pct", op: "<", value: 0 }] }) as
    Parameters<typeof probabilityColumnsFrom>[1];
  const payload = {
    ok: true, as_of_trade_date: "2026-06-30", trade_date_is_historical: true, lookback: 520,
    benchmark: { symbol: "000300.SH", name: "沪深300", bars: 520 }, universe: "index",
    per_symbol: [{ symbol: "000001.SH", name: "上证指数", bars: 520, error: null, stats: null }],
    pooled: [
      { h: 1, win_rate: 55.2, avg_return: 0.31, sample_size: 62, symbols_used: 3 },
      { h: 5, win_rate: null, avg_return: null, sample_size: 0, symbols_used: 0 },
      { h: 20, win_rate: 48, avg_return: -1.2, sample_size: 41, symbols_used: 3 },
    ],
    sample_ok: true,
    warnings: ["历史交易日回放 2026-06-30：仅K线口径条件参与匹配，快照口径条件无历史时点数据"],
  };
  const got = probabilityColumnsFrom(payload, req, AT);
  const c = cols(got);
  assert.equal(c.tradeDate, "2026-06-30", "概率留档的日期 = 结果对应的回放基准日，不是点按钮的那天");
  assert.equal(c.tradeDateIsHistorical, true);
  assert.equal(c.lookback, 520);
  assert.match(c.scope, /指数池 · 回看 520 根K线 · 条件 2 条/);
  assert.equal(c.conditions.length, 2);
  assert.equal(c.sampleOk, true);
  assert.match(c.benchmark, /沪深300（000300.SH）K线 520 根/);
  assert.deepEqual(c.missing, payload.warnings);
  const h = probabilityHeadline(payload, AT);
  assert.match(h, /基准日 2026-06-30（历史回放，非当日）/);
  assert.match(h, /1日 55\.2%（n=62，均值 0\.31%）/);
  assert.match(h, /5日 无样本（n=0）/, "无样本要写「无样本」，不能写成 0% 胜率");
  const weak = probabilityHeadline({ ...payload, sample_ok: false }, AT);
  assert.match(weak, /样本量不足 30：只作统计提示/);
  assert.match(probabilityHeadline({ ...payload, pooled: [] }, AT), /各期限都没有命中样本/);
  errOf(probabilityColumnsFrom({ ok: false, error: "K线不足" }, req, AT), "接口失败");
});

test("留档条目整形与日期分组：payload 损坏要标出来，不静默给空对象", () => {
  const item = snapshotItem("risk", { id: "r1", tradeDate: DAY, computedAt: AT, payload: JSON.stringify(RISK_OK), missing: "[]", source: "s" });
  assert.equal(item.kind, "risk");
  assert.match(item.headline, /风险等级 偏高/);
  assert.match(item.headline, /非交易时段（收盘\/休市值）/);
  assert.match(item.headline, /炸板率 45%/);
  assert.match(item.headline, /相似历史日参考：本次未取到/);
  assert.equal(item.payload_broken, false);
  const broken = snapshotItem("risk", { id: "r2", tradeDate: DAY, computedAt: AT, payload: "{坏掉的 JSON", missing: "[]", source: "" });
  assert.equal(broken.payload_broken, true);
  assert.deepEqual(broken.payload, {});
  const buckets = snapshotDateBuckets([{ tradeDate: "2026-09-18" }, { tradeDate: "2026-09-19" }, { tradeDate: "2026-09-18" }]);
  assert.deepEqual(buckets, [{ date: "2026-09-19", count: 1 }, { date: "2026-09-18", count: 2 }], "按日分组必须日期倒序，同日多条要合并计数");
  assert.equal(snapshotDateBuckets([]).length, 0);
  assert.match(snapshotBasis("risk"), /服务端在点击「留档今天」那一刻，用与页面同一套算法重新算出/, "口径没讲清「不是前端上传的数字」（P15-R15 只把人话读法换了，判定一字未动）");
  assert.doesNotMatch(snapshotBasis("risk"), /risk_snapshot|计算链路/, "口径文案不再向用户抛表名/黑话（表名留在代码常量里给钉与库用）");
  assert.match(snapshotBasis("probability"), /同日多次留档会各自成行、互不覆盖/);
  assert.match(noSnapshotNote("themes"), /主线发现 目前一条留档都没有/);
  assert.match(emptyDaySnapshotNote("risk", "2026-09-10", 3), /2026-09-10 没有留档行/);
  assert.match(emptyDaySnapshotNote("risk", "2026-09-10", 3), /库里已有 3 个留档日/);
  assert.match(emptyDaySnapshotNote("risk", "2026-09-10", 0), /库里还没有任何留档日/);
});

// ---------- B) 机制验收：真实库副本上跑「写入 → 读回 → 分组计数」 ----------

function statOf(file: string): { size: number; mtimeMs: number } {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

test("机制验收：副本里同日两次留档都保留、按留档时刻倒序读回、payload 完整可回看", async () => {
  assert.ok(fs.existsSync(DB_FILE), "运行时库不存在（prisma/db/custom.db）：本用例依赖真实表结构，不伪造");
  const before = statOf(DB_FILE);
  const tmp = path.join(os.tmpdir(), `p5-snapshot-mechanism-${Date.now()}.db`);
  fs.copyFileSync(DB_FILE, tmp);
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: `file:${tmp.replace(/\\/g, "/")}` }) as unknown as SnapshotDb & {
    $disconnect(): Promise<void>;
  };
  try {
    // 前提说明（重要）：本阶段之后，正式库里会出现用户真实点出来的留档行（今天已经真留过 risk/themes/probability 各一条），
    // 所以副本不再「一定是空表」。这里改用「基线 + 增量」的精确断言：先数副本里已有多少行，
    // 再断言写入后正好多 2/1/1 条，并且只对本用例写进去的机制行（computedAt 以 MK 前缀）下结论。
    // 这不是放宽断言：行数、条数、顺序仍然逐一精确比对，只是不再假设库是空的。
    const baseRisk = await countSnapshots(db, "risk");
    const baseTheme = await countSnapshots(db, "themes");
    const baseProb = await countSnapshots(db, "probability");
    const baseDayRisk = snapshotDateBuckets(await snapshotDateRows(db, "risk")).find((b) => b.date === DAY)?.count ?? 0;

    const riskA = await insertRiskSnapshot(db, `${MK} 15:30:00`, cols(riskColumnsFrom(RISK_OK, `${MK} 15:30:00`)), { ...RISK_OK, note: MK });
    const riskB = await insertRiskSnapshot(db, `${MK} 20:41:07`,
      cols(riskColumnsFrom({ ...RISK_OK, break_rate: null, risk: { level: "注意", triggers: [] } }, `${MK} 20:41:07`)), { ...RISK_OK, break_rate: null, note: MK });
    const themeRow = await insertThemeSnapshot(db, `${MK} 20:41:07`,
      cols(themeColumnsFrom({ ok: true, trade_date: DAY, main: [{ name: `${MK}主线`, score: 90 }], sub: [], rotation: [], watch: [], missing: [], source: {} }, `${MK} 20:41:07`)), { note: MK });
    const probReq = sanitizeProbabilityRequest({ conditions: [{ field: "mainNet", op: ">", value: 1 }] }) as Parameters<typeof probabilityColumnsFrom>[1];
    const probRow = await insertProbabilitySnapshot(db, `${MK} 20:41:07`, cols(probabilityColumnsFrom({
      ok: true, as_of_trade_date: DAY, trade_date_is_historical: false, lookback: 520,
      benchmark: { symbol: "000300.SH", name: "沪深300", bars: 520 }, universe: "index", per_symbol: [], pooled: [], sample_ok: false, warnings: [MK],
    }, probReq, `${MK} 20:41:07`)), { note: MK });
    for (const r of [riskA, riskB, themeRow, probRow]) assert.ok(String(r.id).length > 0, "留档行没有 id");

    const mkOnly = (rows: SnapshotRow[]): SnapshotRow[] => rows.filter((r) => String(r.computedAt).startsWith(MK));
    const riskRows = mkOnly(await listSnapshotRows(db, "risk"));
    assert.equal(riskRows.length, 2, "同日两次留档必须各成一行：后一次覆盖前一次就会抹掉一个真实计算结果");
    const dated = mkOnly(await listSnapshotRows(db, "risk", DAY));
    assert.equal(dated.length, 2, "指定留档日必须读回当天两条机制行");
    // 副本里没有机制行的历史日必须返回空 —— 挑一个确定没被写过的日子（2020 年，库里不可能有真实留档）
    assert.deepEqual(await listSnapshotRows(db, "risk", "2020-01-06"), [], "查一个没留过的日子必须返回空：拿别的日子顶上就是冒充");
    const grouped = snapshotDateBuckets(await snapshotDateRows(db, "risk"));
    const dayBucket = grouped.find((b) => b.date === DAY);
    assert.ok(dayBucket, "按日分组里找不到本用例写入的留档日");
    assert.equal(dayBucket?.count, baseDayRisk + 2, `留档日的条数必须正好多出两条机制行（基线 ${baseDayRisk}）`);
    assert.ok(grouped.every((b, i) => i === 0 || grouped[i - 1].date > b.date), "按日分组必须日期倒序");
    // 指定日取回 + 摘要按行内容生成（炸板率 null 的那条必须显示「算不出」而不是 0%）
    const items = dated.map((r) => snapshotItem("risk", r));
    assert.equal(items.length, 2);
    assert.ok(items.some((i) => /炸板率 45%/.test(i.headline)));
    assert.ok(items.some((i) => /炸板率 算不出（当日触板 0）/.test(i.headline)), "算不出的量在回看时被写成了 0：等于伪造一个比率");
    assert.ok(items.every((i) => i.payload_broken === false && (i.payload as { note?: string }).note === MK), "payload 原样存回：留档回看读的就是当次那份完整响应");
    // 未指定日时按留档时刻倒序返回（本用例两条机制行里，最新一次排在更早一次之前）
    assert.deepEqual(riskRows.map((r) => String(r.computedAt).slice(-8)), ["20:41:07", "15:30:00"],
      "同日多条必须最新一次在前：顺序反了会把旧结果当成最新留档");
    assert.equal(await countSnapshots(db, "themes"), baseTheme + 1);
    assert.equal(await countSnapshots(db, "probability"), baseProb + 1);
    assert.equal(await countSnapshots(db, "risk"), baseRisk + 2, `risk 表总行数必须正好多两条（基线 ${baseRisk}）：同日两条都要在`);
    const probItem = snapshotItem("probability", mkOnly(await listSnapshotRows(db, "probability"))[0]);
    assert.deepEqual(probItem.missing, [MK], "warnings 要随留档一起回读：样本量口径不能事后丢");
  } finally {
    await db.$disconnect();
    fs.rmSync(tmp, { force: true });
    const after = statOf(DB_FILE);
    assert.equal(after.size, before.size, "真实库字节数被改动：机制测试只允许写临时副本");
    assert.equal(after.mtimeMs, before.mtimeMs, "真实库修改时间被改动：机制行绝不允许进正式库");
  }
});
