// P4 第四阶段 历史复盘测试。分两层，两层都是真断言（不为通过而放宽）：
// A) 纯内核（history-core.ts）：日期/状态参数判定、口径文案、库行整形 —— 无库、无网络，常规回归必跑。
// B) 隔离库副本（机制验收）：把运行时库复制到一个临时文件（OS 临时目录，绝不在仓库内、绝不写真实库），
//    在副本里插入「明显是机制行」的两日数据，用真实读取层函数验证跨日不串、live/superseded 过滤、
//    无数据日返回空且不回退今天。跑完删除副本，并断言真实库文件的字节数与修改时间完全没变。
// 为什么不让机制行进正式库：REAL_DATA_ONLY —— radar_finding / global_event 是真实扫描归档，
//    掺进测试行等于伪造市场历史，后续复盘会被它污染。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  availableDates, dayRunItems, emptyDayNote, eventHistoryItem, historyNavState, latestDate, parseKind,
  parseQueryDate, parseStateFilter, radarHistoryItem, radarSourceOf, stateFilterBasis, stateLabel, viewBasis,
} from "../../src/lib/quant/screener/history-core.ts";
import {
  countDayRuns, dayCounts, dateBuckets, readDayRuns, readEventDay, readRadarDay, type HistoryDb,
} from "../../src/lib/quant/screener/history.ts";
import { MODE_TEXT } from "../../src/lib/quant/screener/incremental-core.ts";

const TODAY = "2026-09-19";
const DB_FILE = path.join(process.cwd(), "prisma", "db", "custom.db");

// ---------- A) 纯内核：参数判定与口径文案 ----------

test("日期参数：只接受 YYYY-MM-DD 的真实日历日，未来日期直接拒绝而不是返回空", () => {
  assert.deepEqual(parseQueryDate("2026-09-18", TODAY), { ok: true, date: "2026-09-18" });
  assert.deepEqual(parseQueryDate(TODAY, TODAY), { ok: true, date: TODAY }, "今天本身允许查（这一天也有归档行）");
  for (const bad of ["2026-9-8", "20260918", "", "   ", "2026-09-18 12:00", "昨天"]) {
    assert.equal(parseQueryDate(bad, TODAY).ok, false, `格式不合规范的「${bad}」必须被拒，不能当成一次真实的历史查询`);
  }
  // 格式对但不存在的日子：不能伪装成「这天没数据」
  const fake = parseQueryDate("2026-02-30", TODAY);
  assert.equal(fake.ok, false);
  assert.match((fake as { error: string }).error, /不是存在的日历日/);
  const future = parseQueryDate("2026-09-20", TODAY);
  assert.equal(future.ok, false);
  assert.match((future as { error: string }).error, /不得晚于服务端当日/, "历史查询不能预测未来：未来日期不是「库里没有数据」");
});

test("kind / state 参数：认不出的值交回 null 由接口拒绝，不默认成某一种蒙混", () => {
  assert.equal(parseKind("radar"), "radar");
  assert.equal(parseKind("events"), "events");
  assert.equal(parseKind("Radar"), null, "大小写不同的脏值必须被拒");
  assert.equal(parseKind(null), null);
  assert.equal(parseStateFilter(undefined), "all", "缺省=全部：复盘默认要把消失行也看到");
  assert.equal(parseStateFilter("superseded"), "superseded");
  assert.equal(parseStateFilter("whatever"), null);
});

test("可查日期清单：按日期倒序、负数计数夹到 0、格式错的日期不进入清单", () => {
  const buckets = availableDates([
    { date: "2026-09-17", rows: 3, live: 2, superseded: 1 },
    { date: TODAY, rows: 8, live: 8, superseded: 0 },
    { date: "2026-09-18", rows: -5, live: -1, superseded: null },
    { date: "not-a-date", rows: 99, live: 99, superseded: 0 },
  ], TODAY);
  assert.deepEqual(buckets.map((b) => b.date), [TODAY, "2026-09-18", "2026-09-17"], "倒序，且非法日期不得混进页面入口");
  assert.equal(buckets[0].is_today, true);
  assert.equal(buckets[1].rows, 0, "脏计数夹到 0，不给页面一个负数行数");
  assert.equal(buckets[1].superseded, null, "事件表没有 state 列：superseded 保持 null，页面据此不显示该栏");
  assert.equal(latestDate(["2026-09-17", TODAY]), TODAY);
  assert.equal(latestDate([]), null, "库里没有归档时返回 null，调用方必须如实说明，不能拿今天顶上");
});

test("口径文案：历史视图不得出现「实时/LIVE」字样，今日视图必须说明会被扫描改写", () => {
  const hist = viewBasis("radar", "2026-09-17", false, "all");
  assert.match(hist, /历史归档（只读）/);
  assert.match(hist, /留档日=2026-09-17/);
  assert.doesNotMatch(hist, /实时|LIVE/i, "把历史归档说成实时数据就是撒谎");
  assert.doesNotMatch(hist, /随每次扫描/, "历史视图的内容不会被后续扫描改写（P3 只写当日）");
  const today = viewBasis("events", TODAY, true, "all");
  assert.match(today, /今日/);
  assert.match(today, /随每次扫描/);
  // 状态筛选说明必须讲清 superseded 的行仍在库里（P3 的设计意图）
  assert.match(stateFilterBasis("radar", "live"), /行仍在库里/);
  assert.match(stateFilterBasis("events", "superseded"), /没有 state 列/);
});

test("空结果说明：区分「筛掉了」「今天当前为 0」「有运行记录但没留下行」「根本没扫过」，都不回退到别的数据", () => {
  const filtered = emptyDayNote("radar", "2026-09-17", "superseded", 5);
  assert.match(filtered, /共有 5 行/);
  assert.match(filtered, /不代表这天没有记录/);
  const none = emptyDayNote("events", "2026-09-17", "all", 0);
  assert.match(none, /库里没有留档日=2026-09-17/);
  assert.match(none, /这一天没有被扫描过/);
  assert.match(none, /不会用别的数据顶上/);
  assert.match(none, /不会重新计算/);
  // 查的是今天：不能说"今天没被扫描过"——今天的行会被每次扫描重写，空只表示当前库里为 0
  const today = emptyDayNote("events", "2026-09-19", "all", 0, { isToday: true, runCount: 8 });
  assert.doesNotMatch(today, /这一天没有被扫描过/, "查今天时不得断言今天没扫过");
  assert.match(today, /当日行会随每次扫描被重写/);
  // 那天有运行记录、但库里没留下行：如实说"落库 0 条或被全量重刷改写"，不写成"没扫过"
  const ran = emptyDayNote("radar", "2026-09-17", "all", 0, { runCount: 3 });
  assert.match(ran, /那天有扫描记录/);
  assert.doesNotMatch(ran, /这一天没有被扫描过/);
});

test("雷达行的「来源」：库里没有逐行来源列，只按 kind+evidence 推导并附推导依据；认不出就不猜", () => {
  assert.match(radarSourceOf("theme", { code: "BK0001", changePct: 3 }).source, /discoverThemes/);
  assert.match(radarSourceOf("theme", { code: "BK0001" }).source, /BK0001/);
  assert.match(radarSourceOf("news", { keywords: ["算力"] }).source, /算力/);
  assert.match(radarSourceOf("risk", {}).source, /computeSentiment/);
  const unknown = radarSourceOf("mystery", {});
  assert.match(unknown.source, /未知（库内该行没有来源字段）/, "没有依据时必须承认未知");
  assert.match(unknown.basis, /不做猜测/);
  // 推导依据字段必须始终存在：页面 title 上展示它，用户才能区分「库里存的」与「界面推的」
  for (const kind of ["risk", "theme", "fund", "news", "anomaly"]) {
    assert.ok(radarSourceOf(kind, {}).basis.length > 10, `kind=${kind} 缺少推导依据`);
  }
});

test("库行整形：JSON 列损坏如实标记，未命中映射显示为「未命中」而不是丢行", () => {
  const radar = radarHistoryItem({
    id: "r1", asOf: "2026-09-17", kind: "theme", title: "T", detail: "D",
    evidence: "{坏掉的 JSON", state: "superseded", createdAt: new Date("2026-09-17T07:00:00Z"),
  });
  assert.equal(radar.evidence_broken, true);
  assert.deepEqual(radar.evidence, {}, "解析失败时给空对象继续渲染，但 broken 标记必须为 true");
  assert.equal(radar.superseded, true);
  assert.equal(radar.state_label, "已标记消失");
  assert.equal(radar.as_of, "2026-09-17");
  assert.equal(radar.created_at, "2026-09-17T07:00:00.000Z");

  const ev = eventHistoryItem({
    id: "e1", asOf: "2026-09-17", title: "快讯标题", time: "09:30", level: "行业新闻", category: "半导体",
    mappedSectors: "[]", relatedStocks: "[]", fundCheck: "{坏", stage: "", source: "金十快讯",
    createdAt: new Date("2026-09-17T01:00:00Z"),
  });
  assert.equal(ev.chain_mapped, false, "未命中映射的行必须还能被页面识别为「未命中」，不得被当成不存在");
  assert.deepEqual(ev.broken_columns, ["fundCheck"]);
  assert.equal(stateLabel(""), "未知状态（原值 空）", "非 live/superseded 的历史脏值如实暴露原值");
});

test("task_run 复盘条目：口径从 basis 写读同源，读不出就说未记录", () => {
  const basis = `上证指数日线截至 ${TODAY}；${MODE_TEXT.incremental}：候选 8 条 → 新增 0`;
  const [run] = dayRunItems([{
    id: "t1", kind: "radar", tradeDate: TODAY, status: "success", trigger: "schedule",
    startedAt: new Date("2026-09-19T07:20:00Z"), finishedAt: new Date("2026-09-19T07:21:00Z"),
    scanned: 8, results: 8, missing: '["a"]', error: "", basis, note: "收盘后自动：第 1 次尝试",
  }]);
  assert.equal(run.mode, "incremental");
  assert.equal(run.mode_label, "增量");
  assert.equal(run.trigger_label, "收盘后自动");
  assert.deepEqual(run.missing, ["a"]);
  const [legacy] = dayRunItems([{
    id: "t2", kind: "radar", tradeDate: TODAY, status: "success", trigger: "manual",
    startedAt: new Date(), finishedAt: null, scanned: 0, results: 0, missing: "不是数组", error: "",
    basis: "交易日确证（P3 之前没有写口径）", note: "",
  }]);
  assert.equal(legacy.mode, "", "P3 之前的历史记录读不出口径时必须为空串");
  assert.match(legacy.mode_label, /未记录/);
  assert.deepEqual(legacy.missing, [], "缺省列内容不是数组时按空处理，不让页面崩");
  assert.equal(legacy.trigger_label, "手动触发");
});

test("日期入口可用性：没有任何归档时要如实说明，而不是摆出一个能点的日期", () => {
  const nav = historyNavState(TODAY, availableDates([{ date: TODAY, rows: 0, live: 0, superseded: 0 }], TODAY));
  assert.equal(nav.has_any, false);
  assert.equal(nav.latest_with_data, "");
  assert.match(nav.note, /不会凭空造出可查询的历史日期/);
  const withData = historyNavState(TODAY, availableDates([
    { date: TODAY, rows: 8, live: 8, superseded: 0 },
    { date: "2026-09-17", rows: 5, live: 4, superseded: 1 },
  ], TODAY));
  assert.equal(withData.has_any, true);
  assert.equal(withData.latest_with_data, TODAY);
  assert.equal(withData.today_has_data, true);
});

// ---------- B) 隔离库副本：真实读取层的跨日 / 状态过滤验证 ----------

/** 机制行标记：一眼可辨「这是测试机制行，不是市场信号」，且只存在于临时副本里 */
const MK = "〔机制测试行·非行情数据〕";
const D1 = "2020-01-06";
const D2 = "2020-01-07";

async function withTempCopy<T>(fn: (client: HistoryDb) => Promise<T>): Promise<T> {
  assert.ok(fs.existsSync(DB_FILE), "运行时库不存在（prisma/db/custom.db）：本文件验证依赖真实库的表结构，不伪造");
  const tmp = path.join(os.tmpdir(), `p4-history-mechanism-${Date.now()}.db`);
  fs.copyFileSync(DB_FILE, tmp);
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ datasourceUrl: `file:${tmp.replace(/\\/g, "/")}` }) as unknown as HistoryDb & {
    $disconnect(): Promise<void>;
  };
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
    fs.rmSync(tmp, { force: true });
  }
}

test("隔离库副本：跨日不串、live/superseded 过滤正确、无数据日为空且不回退今天；真实库全程只读", { timeout: 120_000 }, async () => {
  const before = fs.statSync(DB_FILE);
  await withTempCopy(async (client) => {
    // 副本里塞两个交易日 + 一条今天的机制行，验证「按 asOf 取数」不会串日、也不会把今天混进来
    await client.radarFinding.create({
      data: { asOf: D1, kind: "theme", title: `${MK} D1 信号一`, detail: "live", evidence: '{"code":"BK1"}', dedupeKey: "k-d1-1", contentHash: "h1", state: "live", createdAt: new Date(`${D1}T07:00:00Z`) },
    });
    await client.radarFinding.create({
      data: { asOf: D1, kind: "fund", title: `${MK} D1 信号二`, detail: "live", evidence: '{"code":"BK2"}', dedupeKey: "k-d1-2", contentHash: "h2", state: "live", createdAt: new Date(`${D1}T07:01:00Z`) },
    });
    await client.radarFinding.create({
      data: { asOf: D1, kind: "risk", title: `${MK} D1 已消失信号`, detail: "superseded", evidence: '{"break_rate":1}', dedupeKey: "k-d1-3", contentHash: "h3", state: "superseded", createdAt: new Date(`${D1}T07:02:00Z`) },
    });
    await client.radarFinding.create({
      data: { asOf: D2, kind: "theme", title: `${MK} D2 信号一`, detail: "live", evidence: '{"code":"BK9"}', dedupeKey: "k-d2-1", contentHash: "h9", state: "live", createdAt: new Date(`${D2}T07:00:00Z`) },
    });
    await client.radarFinding.create({
      data: { asOf: TODAY, kind: "theme", title: `${MK} 今天这一天的机制行`, detail: "live", evidence: "{}", dedupeKey: "k-today-mk", contentHash: "ht", state: "live", createdAt: new Date(`${TODAY}T07:00:00Z`) },
    });
    await client.globalEvent.create({
      data: { asOf: D2, title: `${MK} D2 事件`, time: "10:00", level: "行业新闻", category: "测试", mappedSectors: '["算力"]', relatedStocks: "[]", fundCheck: '{"stage":"已验证"}', stage: "已验证", source: "机制副本", dedupeKey: "ev-d2", contentHash: "he", createdAt: new Date(`${D2}T02:00:00Z`) },
    });

    // 1) 指定日期查得到对应那天的行；live / superseded 计数与真实写入完全对账
    const all = await readRadarDay(client, D1, "all");
    assert.equal(all.length, 3, "D1 应有 3 行（2 live + 1 superseded）");
    const counts = await dayCounts(client, "radar", D1);
    assert.deepEqual(counts, { rows: 3, live: 2, superseded: 1 });
    assert.deepEqual((await readRadarDay(client, D1, "live")).map((r) => r.state), ["live", "live"]);
    const gone = await readRadarDay(client, D1, "superseded");
    assert.equal(gone.length, 1);
    assert.equal(gone[0].state, "superseded", "消失行必须还能查得出来：P3 是标记不删除，第四阶段靠它复盘");
    const shaped = radarHistoryItem(gone[0]);
    assert.equal(shaped.superseded, true);
    assert.match(shaped.title, /已消失/);

    // 2) 不同日期不串数据：D2 只返回 D2 的行，也不带出今天
    const d2 = await readRadarDay(client, D2, "all");
    assert.equal(d2.length, 1);
    assert.ok(d2.every((r) => r.asOf === D2), "返回行必须全部是所查日期");
    assert.ok(!d2.some((r) => r.title.includes("D1")), "D2 查询里不得出现 D1 的行");
    const dToday = await readRadarDay(client, TODAY, "all");
    assert.ok(dToday.some((r) => r.title.includes("今天这一天")), "今天的归档也要查得到");
    assert.ok(!dToday.some((r) => r.asOf !== TODAY), "今日视图不得混入别的日子");

    // 3) 没有数据的日期 ⇒ 空 + 明确缺失说明，绝不回退今天
    const empty = await readRadarDay(client, "2020-01-03", "all");
    assert.equal(empty.length, 0);
    const emptyCounts = await dayCounts(client, "radar", "2020-01-03");
    assert.deepEqual(emptyCounts, { rows: 0, live: 0, superseded: 0 });
    assert.match(emptyDayNote("radar", "2020-01-03", "all", emptyCounts.rows), /库里没有留档日=2020-01-03/);

    // 4) 事件按日期读取：D2 有、D1 没有；且事件没有 state 列 ⇒ 计数里 superseded 恒为 0、清单里为 null
    const ev = await readEventDay(client, D2);
    assert.equal(ev.length, 1);
    const evItem = eventHistoryItem(ev[0]);
    assert.deepEqual(evItem.mapped_sectors, ["算力"], "历史查询必须原样读回入库时的产业链映射");
    assert.equal(evItem.chain_mapped, true);
    assert.equal((await readEventDay(client, D1)).length, 0, "D1 没有事件行：不得回退到 D2 或今天");
    assert.deepEqual(await dayCounts(client, "events", D2), { rows: 1, live: 1, superseded: 0 });
    const evBuckets = availableDates(await dateBuckets(client, "events"), TODAY);
    // 清单只按「副本里真实存在的日子」断言：真实库当日若已有归档事件，也必须原样出现在清单里（不伪造、不屏蔽）
    assert.ok(evBuckets.every((b) => b.superseded === null), "事件日期清单的 superseded 必须是 null（表里没有这一列）");
    assert.deepEqual(
      evBuckets.filter((b) => b.date === D1 || b.date === D2).map((b) => [b.date, b.rows]),
      [[D2, 1]],
      "机制日期里只有 D2 有 1 条：D1 的空档不得被别的日子顶上",
    );

    // 5) 日期清单按倒序，且今天的机制行也在其中（副本内自洽；真实库的既有归档日照原参与清单）
    const buckets = availableDates(await dateBuckets(client, "radar"), TODAY);
    const bucketDates = buckets.map((b) => b.date);
    assert.deepEqual(bucketDates.slice().sort((a, b) => b.localeCompare(a)), bucketDates, "倒序：最近的日子排在前面");
    assert.ok([TODAY, D2, D1].every((d) => bucketDates.includes(d)), "三个有机制行的日期都要进清单");
    assert.equal(latestDate(bucketDates), bucketDates[0]);
    assert.equal(buckets.find((b) => b.date === D1)?.superseded, 1);
    assert.equal(buckets.find((b) => b.date === D2)?.rows, 1);

    // 6) task_run：没有运行记录的日期返回空清单（页面据此写「无法说明这批行是哪次扫描写入」，不推测）
    assert.equal((await readDayRuns(client, "radar", D1)).length, 0);
    // countDayRuns 必须与 readDayRuns 同源：库里 COUNT 为 0 时不得凭空报数（页面按它写「当日共 N 条」）
    assert.equal(await countDayRuns(client, "radar", D1), 0);
    assert.equal(await countDayRuns(client, "events", D1), 0);

    // 7) 只读性：历史查询本身不改任何状态计数（读取前后当日计数一致）
    const before20 = await dayCounts(client, "radar", D1);
    await readRadarDay(client, D1, "all");
    await dayCounts(client, "radar", D1);
    assert.deepEqual(await dayCounts(client, "radar", D1), before20);
  });

  const after = fs.statSync(DB_FILE);
  assert.equal(after.size, before.size, "真实库字节数被改动：机制测试只允许写临时副本");
  assert.equal(after.mtimeMs, before.mtimeMs, "真实库修改时间被改动：本用例必须全程只读");
});
