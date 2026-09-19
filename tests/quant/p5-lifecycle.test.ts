// P5 第五阶段 数据生命周期测试。与第四阶段同样的两层结构（都是真断言，不为通过而放宽）：
// A) 纯内核（lifecycle-core.ts）：保留期日期算术、候选/受保护分类、plan 指纹、执行闸门、导出口径文案。
// B) 机制验收（隔离库副本）：把运行时库复制到 OS 临时目录，在副本里插入「明显是机制行」的过期日 / 未满期 /
//    当日数据，真跑一遍「按日分组计数 → 清理计划 → 读全部列 → 写导出文件并回读 → 按整天删除 → 复核」，
//    跑完删副本与临时导出目录，并断言真实库文件的字节数与修改时间完全没变。
// 为什么绝不在真实库上试删：REAL_DATA_ONLY + 库里只有 2026-09-19 一天的真实归档，
//    在真库上验证删除 = 拿唯一一份真实历史当测试品；删除能力只能在副本上验收。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PURGE_CONFIRM_TEXT, RETENTION_DAYS, addDays, ageDays, buildExportEnvelope, buildPlan, cutoffOf,
  exportCountCheck, exportFileName, isValidDate, noCandidateNote, planHash, policyNotes, purgeGate,
  runTablesNote, stateAgnosticNote, type DayBucket,
} from "../../src/lib/quant/screener/lifecycle-core.ts";
import {
  deleteRowsForPlan, detailDayBuckets, readRowsForPlan, runTablesExpired, totalDetailRows,
  writeExportFileSync, type LifecycleDb,
} from "../../src/lib/quant/screener/lifecycle.ts";

const TODAY = "2026-09-19";
const DB_FILE = path.join(process.cwd(), "prisma", "db", "custom.db");

// ---------- A) 纯内核 ----------

test("保留期算术：180 天阈值按 UTC 日历日计算，边界那天本身还不算过期", () => {
  assert.equal(RETENTION_DAYS, 180, "保留天数必须由用户决定并固定成常量：改成别的值要走 worklog，不能由接口参数临时决定");
  assert.equal(cutoffOf(TODAY), "2026-03-23", `今天 ${TODAY} 往前 180 天的边界日算错，整条清理线都会错一天`);
  assert.equal(addDays("2026-03-01", -1), "2026-02-28", "闰年判断（2028 才是闰年）");
  assert.equal(addDays("2028-03-01", -1), "2028-02-29", "闰年 2/29 必须存在");
  assert.equal(addDays("2026-01-05", -10), "2025-12-26", "跨年回退");
  assert.equal(ageDays("2026-03-23", TODAY), 180, "刚好 180 天：还没「严格早于」边界");
  assert.equal(ageDays("2026-03-22", TODAY), 181, "181 天：进候选");
  assert.equal(ageDays("2026-09-19", TODAY), 0);
  assert.equal(ageDays("2026-09-20", TODAY), -1, "未来日期给出负年龄，由分类层判成异常而不是当成 0 天");
  assert.equal(ageDays("2026-02-30", TODAY), null, "非法日历日判不出年龄");
  assert.equal(ageDays("昨天", TODAY), null);
  assert.equal(isValidDate("2026-02-30"), false);
  assert.equal(isValidDate("2026-02-28"), true);
});

test("清理计划分类：过期日进候选，当日 / 未满期 / 判不出年龄的都进受保护并各给原因", () => {
  const buckets: DayBucket[] = [
    { table: "radar_finding", date: "2026-01-10", rows: 5, live: 3, superseded: 2 }, // 过期
    { table: "global_event", date: "2026-01-10", rows: 2, live: 2, superseded: 0 }, // 同日的另一张表
    { table: "radar_finding", date: "2026-03-23", rows: 1, live: 1, superseded: 0 }, // 刚好 180 天：未满期
    { table: "radar_finding", date: "2026-09-16", rows: 4, live: 4, superseded: 0 }, // 未满期
    { table: "radar_finding", date: TODAY, rows: 8, live: 8, superseded: 0 }, // 当日
    { table: "global_event", date: "2026-09-30", rows: 1, live: 1, superseded: 0 }, // 晚于今天：异常
    { table: "radar_finding", date: "2026-02-30", rows: 1, live: 1, superseded: 0 }, // 非法日历日
    { table: "radar_finding", date: "2026-01-01", rows: 0, live: 0, superseded: 0 }, // 0 行：不进清单
  ];
  const plan = buildPlan(TODAY, buckets);
  assert.equal(plan.cutoff, "2026-03-23");
  assert.deepEqual(plan.candidates.map((c) => `${c.table}@${c.date}`),
    ["global_event@2026-01-10", "radar_finding@2026-01-10"],
    "只有 2026-01-10 的两个表够旧：候选集不对等于删错天（同日按表名升序排，保证预览与执行看到同一顺序）");
  assert.deepEqual(plan.candidates.map((c) => c.age_days), [252, 252]);
  assert.equal(plan.totals.candidate_rows, 7, "候选行数：5+2（含 2 条 superseded 消失行）");
  assert.equal(plan.totals.candidate_days, 2);
  const protectedKeys = plan.protected_days.map((p) => `${p.table}@${p.date}`).sort();
  assert.deepEqual(protectedKeys, [
    "global_event@2026-09-30", "radar_finding@2026-02-30",
    "radar_finding@2026-03-23", "radar_finding@2026-09-16", `radar_finding@${TODAY}`,
  ].sort(), "受保护清单漏了或多了一天：都是判错口径");
  const by = new Map(plan.protected_days.map((p) => [`${p.table}@${p.date}`, p.reason]));
  assert.match(by.get(`radar_finding@${TODAY}`)!, /当日归档/, "当天行必须写明「清理不碰当天」");
  assert.match(by.get("radar_finding@2026-03-23")!, /未满保留期 180 天/, "刚好 180 天要说明是边界未满，不是漏判");
  assert.match(by.get("radar_finding@2026-02-30")!, /不是合法日历日/, "判不出年龄必须给「宁可少删」的原因");
  assert.match(by.get("global_event@2026-09-30")!, /晚于今天/, "异常的未来日期也要留在库里");
  assert.ok(!plan.protected_days.some((p) => p.rows === 0), "0 行的日期不该出现在任何清单里");
  // 口径文案里必须出现的具体事实（页面直接展示，不让前端自己拼）
  assert.match(plan.basis, /asOf 严格早于 2026-03-23/);
  assert.match(plan.basis, /当日（asOf=2026-09-19）/);
  assert.match(plan.basis, /不挂调度器/);
  const notes = policyNotes(plan);
  assert.ok(notes.some((n) => n.includes("180 天由用户于 2026-09-19 决定")), "保留天数的来源没写清：用户决定不能被实现者悄悄改掉");
  assert.ok(notes.some((n) => n.includes("导出") && n.includes("写盘成功后才允许删除") && n.includes("一行都不删")),
    `清理语义没写全：${notes.join(" | ")}`);
  assert.ok(notes.some((n) => n.includes("task_run") && n.includes("不在本阶段清理范围")));
  assert.match(stateAgnosticNote(), /只看 asOf/);
});

test("plan 指纹：同一天同批候选稳定；候选变多 / 边界日变化 / 计数变化都会让旧指纹失效", () => {
  const base: DayBucket[] = [
    { table: "radar_finding", date: "2026-01-10", rows: 5, live: 3, superseded: 2 },
    { table: "global_event", date: "2026-01-10", rows: 2, live: 2, superseded: 0 },
  ];
  const p1 = buildPlan(TODAY, base);
  const p2 = buildPlan(TODAY, base.map((b) => ({ ...b })));
  assert.equal(p1.plan_hash, p2.plan_hash, "同一批数据两次预览指纹不同：预览与执行之间会被误判为库已改动");
  assert.equal(p1.plan_hash, planHash(p1.cutoff, p1.retention_days, p1.candidates));
  // 多一天的候选
  const p3 = buildPlan(TODAY, [...base, { table: "radar_finding" as const, date: "2026-01-11", rows: 1, live: 1, superseded: 0 }]);
  assert.notEqual(p3.plan_hash, p1.plan_hash, "候选天数变了而指纹没变：闸门会放行过期的确认");
  // 同日但行数变了（例如当日归档被扫描重刷）
  const p4 = buildPlan(TODAY, [{ table: "radar_finding", date: "2026-01-10", rows: 6, live: 4, superseded: 2 }, base[1]]);
  assert.notEqual(p4.plan_hash, p1.plan_hash, "行数变了指纹必须变");
  // 保留期变了（只能改常量，接口不给参数；这里直接构造来验证指纹覆盖它）
  assert.notEqual(planHash(p1.cutoff, 180, p1.candidates), planHash(p1.cutoff, 90, p1.candidates),
    "指纹没覆盖保留天数：改常量后旧的确认仍可能被当成有效");
  assert.match(p1.plan_hash, /^fnv1a-[0-9a-f]{8}[0-9a-f]{4}$/, "指纹格式变了要同步改文档与页面展示口径");
});

test("执行闸门：缺确认串 / 无候选 / 缺指纹 / 指纹过期 四种情况都拒绝执行，且都声明「未删除任何行」", () => {
  const plan = buildPlan(TODAY, [
    { table: "radar_finding", date: "2026-01-10", rows: 5, live: 3, superseded: 2 },
    { table: "radar_finding", date: TODAY, rows: 8, live: 8, superseded: 0 },
  ]);
  const ok = purgeGate({ confirm: PURGE_CONFIRM_TEXT, plan_hash: plan.plan_hash }, plan, 13);
  assert.equal(ok.ok, true);
  const missConfirm = purgeGate({ plan_hash: plan.plan_hash }, plan, 13) as { ok: false; status: number; error: string };
  assert.equal(missConfirm.ok, false);
  assert.equal(missConfirm.status, 400);
  assert.match(missConfirm.error, /缺少正确确认串/);
  assert.match(missConfirm.error, /未删除任何行/);
  const wrongConfirm = purgeGate({ confirm: "yes", plan_hash: plan.plan_hash }, plan, 13) as { ok: false; error: string };
  assert.match(wrongConfirm.error, /确认串/);
  const noHash = purgeGate({ confirm: PURGE_CONFIRM_TEXT }, plan, 13) as { ok: false; status: number; error: string };
  assert.equal(noHash.status, 400);
  assert.match(noHash.error, /必须先调 GET \/api\/lifecycle\/preview/);
  const stale = purgeGate({ confirm: PURGE_CONFIRM_TEXT, plan_hash: "fnv1a-deadbeef0001" }, plan, 13) as { ok: false; status: number; error: string };
  assert.equal(stale.status, 409, "预览之后库内容变了 ⇒ 冲突，而不是继续删");
  assert.match(stale.error, /预览与当前库内容已不一致/);
  assert.match(stale.error, /未删除任何行/);
  // 没有候选时：连「确认串正确」也不给执行
  const emptyPlan = buildPlan(TODAY, [{ table: "radar_finding", date: TODAY, rows: 8, live: 8, superseded: 0 }]);
  const none = purgeGate({ confirm: PURGE_CONFIRM_TEXT, plan_hash: emptyPlan.plan_hash }, emptyPlan, 8) as { ok: false; error: string };
  assert.equal(none.ok, false);
  assert.match(none.error, /可清理 0 行/);
  assert.ok(!emptyPlan.candidates.length);
});

test("空候选说明分得清「库里没行」与「有行但都还没过期」，运行记录只报告不删", () => {
  const empty = buildPlan(TODAY, []);
  assert.match(noCandidateNote(empty, 0), /明细行一共 0 条/);
  assert.match(noCandidateNote(empty, 8), /库里共 8 条明细行/);
  assert.match(noCandidateNote(empty, 8), /真实数据还没有那么旧/);
  assert.match(noCandidateNote(empty, 8), /未执行任何删除/);
  const note = runTablesNote([{ table: "task_run", rows: 61 }, { table: "scan_cursor", rows: 2 }]);
  assert.ok(note.includes("扫描运行记录（task_run） 61 条"), `运行记录条数没写进说明：${note}`);
  assert.ok(note.includes("增量扫描游标（scan_cursor） 2 条"), "游标条数没写进说明");
  assert.ok(note.includes("不在本阶段清理范围内"), "没说明这两张表为什么不动");
  assert.match(runTablesNote([]), /都没有 asOf\/tradeDate 早于清理阈值/);
});

test("导出：文件名可安全落盘、封套带口径与恢复说明、行数与计划不符就拒绝删除", () => {
  const name = exportFileName("2026-09-19 20:41:07");
  assert.equal(name, "expired-2026-09-19-20-41-07.json");
  assert.ok(!/[ :\\]/.test(name), "文件名残留分隔符会在 Windows 上落不了盘");
  const plan = buildPlan(TODAY, [{ table: "radar_finding", date: "2026-01-10", rows: 2, live: 1, superseded: 1 }]);
  const env = buildExportEnvelope(plan, "2026-09-19 20:41:07", [
    { table: "radar_finding", id: "a", asOf: "2026-01-10", title: "t1" },
    { table: "radar_finding", id: "b", asOf: "2026-01-10", title: "t2" },
  ]);
  assert.equal(env.row_count, 2);
  assert.equal(env.cutoff, plan.cutoff);
  assert.equal(env.plan_hash, plan.plan_hash);
  assert.deepEqual(env.tables, [{ table: "radar_finding", date: "2026-01-10", rows: 2, live: 1, superseded: 1 }]);
  assert.match(env.restore_note, /没有提供一键回滚/);
  assert.equal(exportCountCheck(plan, 2).ok, true);
  const short = exportCountCheck(plan, 1) as { ok: false; error: string };
  assert.equal(short.ok, false);
  assert.match(short.error, /导出行数 1 与清理计划的候选行数 2 不相等/);
  assert.match(short.error, /未删除任何行/);
});

// ---------- B) 机制验收：真实库副本上跑完整「预览 → 导出 → 删除 → 复核」 ----------

/** 机制行标记：一眼可辨「这是测试机制行，不是市场信号」，且只存在于临时副本里 */
const MK = "〔机制测试行·非行情数据〕";
const OLD1 = "2020-01-06"; // 过期（远超 180 天）
const OLD2 = "2020-01-07"; // 过期
const RECENT = addDays(TODAY, -3); // 未满期
const CUT_OFF = addDays(TODAY, -RETENTION_DAYS); // 边界当天：未满期

async function withTempCopy<T>(fn: (client: LifecycleDb & { $disconnect(): Promise<void> }) => Promise<T>): Promise<T> {
  assert.ok(fs.existsSync(DB_FILE), "运行时库不存在（prisma/db/custom.db）：本文件验证依赖真实库的表结构，不伪造");
  const tmp = path.join(os.tmpdir(), `p5-lifecycle-mechanism-${Date.now()}.db`);
  fs.copyFileSync(DB_FILE, tmp);
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ datasourceUrl: `file:${tmp.replace(/\\/g, "/")}` }) as unknown as LifecycleDb & {
    $disconnect(): Promise<void>;
  };
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
    fs.rmSync(tmp, { force: true });
  }
}

test("机制验收：副本上「过期日整天被删、未满期与当日一行不少、删除前行数与导出文件完全一致」", async () => {
  const before = statOf(DB_FILE);
  const exportDir = path.join(os.tmpdir(), `p5-lifecycle-export-${Date.now()}`);
  try {
    await withTempCopy(async (db) => {
      // 前提：真实库里绝不会有这些日期的行（否则机制行会混进真实计数）
      const preBuckets = await detailDayBuckets(db);
      for (const d of [OLD1, OLD2, RECENT]) {
        assert.equal(preBuckets.filter((b) => b.date === d).reduce((s, b) => s + b.rows, 0), 0,
          `真实库里已存在 asOf=${d} 的行：本用例的精确计数前提不成立，应该改测试而不是放宽断言`);
      }
      const realTodayRows = preBuckets.filter((b) => b.date === TODAY && b.table === "radar_finding")
        .reduce((s, b) => s + b.rows, 0);
      // 造机制行：OLD1 雷达 2 条（1 live + 1 superseded）+ 事件 1 条；OLD2 雷达 1 条；
      // RECENT 雷达 1 条（未满期）；今天雷达 1 条（当日，绝不允许被删）；边界日 CUT_OFF 1 条（未满 180 天）
      await db.radarFinding.createMany({ data: [
        { asOf: OLD1, kind: "risk", title: `${MK}过期日 A·live`, state: "live", dedupeKey: "mech-a1", contentHash: "h1" },
        { asOf: OLD1, kind: "theme", title: `${MK}过期日 A·superseded`, state: "superseded", dedupeKey: "mech-a2", contentHash: "h2" },
        { asOf: OLD2, kind: "news", title: `${MK}过期日 B`, state: "live", dedupeKey: "mech-b1", contentHash: "h3" },
        { asOf: RECENT, kind: "risk", title: `${MK}未满期`, state: "live", dedupeKey: "mech-r1", contentHash: "h4" },
        { asOf: TODAY, kind: "risk", title: `${MK}当日`, state: "live", dedupeKey: "mech-t1", contentHash: "h5" },
        { asOf: CUT_OFF, kind: "risk", title: `${MK}边界日`, state: "live", dedupeKey: "mech-c1", contentHash: "h6" },
      ] });
      await db.globalEvent.create({ data: { asOf: OLD1, title: `${MK}过期日 A 的事件`, level: "普通新闻" } });

      const plan = buildPlan(TODAY, await detailDayBuckets(db));
      assert.equal(plan.cutoff, CUT_OFF);
      assert.deepEqual(plan.candidates.map((c) => `${c.table}@${c.date}`).sort(),
        ["global_event@2020-01-06", "radar_finding@2020-01-06", "radar_finding@2020-01-07"],
        "候选必须是「过期日的整天、两张表分别一条」，多一天少一天都是判错");
      assert.equal(plan.totals.candidate_rows, 4, "候选行数 = 2(OLD1 雷达) + 1(OLD1 事件) + 1(OLD2 雷达)");
      const radarOld1 = plan.candidates.find((c) => c.table === "radar_finding" && c.date === OLD1)!;
      assert.deepEqual({ live: radarOld1.live, superseded: radarOld1.superseded }, { live: 1, superseded: 1 },
        "live 与 superseded 要一起进候选：消失行不是「先删的便宜货」");
      for (const keep of [RECENT, TODAY, CUT_OFF]) {
        assert.ok(!plan.candidates.some((c) => c.date === keep), `asOf=${keep} 被误判为过期：会删掉未满期/当日/边界日的数据`);
      }
      assert.equal(purgeGate({ confirm: PURGE_CONFIRM_TEXT, plan_hash: plan.plan_hash }, plan, 4).ok, true);

      // 先导出：行数必须等于计划行数，文件写到临时目录（绝不写仓库的 data/lifecycle）
      const rows = await readRowsForPlan(db, plan);
      assert.equal(rows.length, plan.totals.candidate_rows);
      assert.ok(rows.every((r) => String(r.title).startsWith(MK)), "导出内容里混进了非机制行 ⇒ 真实归档被当成过期行导出了");
      const env = buildExportEnvelope(plan, "2026-09-19 20:41:07", rows);
      const written = writeExportFileSync(exportDir, exportFileName("2026-09-19 20:41:07"), env);
      assert.equal(written.readback_rows, 4);
      const parsed = JSON.parse(fs.readFileSync(written.path, "utf8")) as { rows: { table: string; asOf: string; id: string; createdAt: string }[] };
      assert.deepEqual([...new Set(parsed.rows.map((r) => r.asOf))].sort(), [OLD1, OLD2]);
      assert.ok(parsed.rows.every((r) => r.id && r.createdAt), "导出缺 id/createdAt：这份快照就没法按列回插，恢复说明成了空话");

      const deleted = await deleteRowsForPlan(db, plan);
      assert.deepEqual(deleted.map((d) => `${d.table}@${d.date}:${d.count}`).sort(),
        ["global_event@2020-01-06:1", "radar_finding@2020-01-06:2", "radar_finding@2020-01-07:1"]);
      assert.equal(deleted.reduce((s, d) => s + d.count, 0), written.readback_rows, "删除行数与导出行数不一致：导出的不是被删的那批");

      // 复核：过期日整天消失，未满期 / 当日 / 边界日的机制行仍在，真实库带来的行也一条没少
      assert.equal(await db.radarFinding.count({ where: { asOf: { in: [OLD1, OLD2] } } }), 0);
      assert.equal(await db.globalEvent.count({ where: { asOf: OLD1 } }), 0);
      for (const keep of [RECENT, TODAY, CUT_OFF]) {
        assert.equal(await db.radarFinding.count({ where: { asOf: keep, title: { startsWith: MK } } }), 1,
          `未过期日 ${keep} 的机制行被误删`);
      }
      const after = buildPlan(TODAY, await detailDayBuckets(db));
      assert.equal(after.candidates.length, 0, "删完之后仍有候选：按整天清理没有真正闭合");
      assert.notEqual(after.plan_hash, plan.plan_hash, "删完之后指纹没变：闸门会放行一次针对已过期计划的确认");
      assert.equal(after.totals.candidate_rows, 0);
      // 真实库带进来的当天归档不受影响（副本里当天 = 真实 N 条 + 机制 1 条）
      assert.equal(await db.radarFinding.count({ where: { asOf: TODAY, title: { not: { startsWith: MK } } } }),
        realTodayRows, "当日真实归档条数被清理改动：P5 只能删过期整天，当天行归扫描口径负责");
      // 只报告、不删除：task_run / scan_cursor 一条都没被动过
      assert.match(runTablesNote(await runTablesExpired(db, after.cutoff)), /不在本阶段清理范围内/);
      assert.ok(await totalDetailRows(db) > 0, "删完之后库里应该还剩当日真实归档");
    });
  } finally {
    fs.rmSync(exportDir, { recursive: true, force: true });
    const after = statOf(DB_FILE);
    assert.equal(after.size, before.size, "真实库字节数被改动：机制测试只允许写临时副本");
    assert.equal(after.mtimeMs, before.mtimeMs, "真实库修改时间被改动：本用例必须全程只读");
    assert.equal(fs.existsSync(path.join(process.cwd(), "data", "lifecycle", "expired-2026-09-19-20-41-07.json")), false,
      "机制测试把导出文件写进了仓库目录");
  }
});

test("机制验收：副本里预览后计划被改动 ⇒ 旧 plan_hash 失效，闸门拒绝执行", async () => {
  await withTempCopy(async (db) => {
    await db.radarFinding.createMany({ data: [
      { asOf: "2020-02-01", kind: "risk", title: `${MK}闸门·第一批`, state: "live", dedupeKey: "mech-g1", contentHash: "g1" },
    ] });
    const plan1 = buildPlan(TODAY, await detailDayBuckets(db));
    assert.equal(plan1.candidates.length, 1);
    // 预览之后又落进一天的过期数据（等价于「预览与执行之间库被改过」）
    await db.radarFinding.create({ data: { asOf: "2020-02-02", kind: "risk", title: `${MK}闸门·第二批`, state: "live" } });
    const plan2 = buildPlan(TODAY, await detailDayBuckets(db));
    const gate = purgeGate({ confirm: PURGE_CONFIRM_TEXT, plan_hash: plan1.plan_hash }, plan2, 2) as
      { ok: false; status: number; error: string };
    assert.equal(gate.ok, false);
    assert.equal(gate.status, 409);
    assert.match(gate.error, /请重新预览后再确认/);
    assert.equal(await db.radarFinding.count({ where: { asOf: { in: ["2020-02-01", "2020-02-02"] } } }), 2,
      "闸门拒绝执行却还是删了行");
    // 用当前计划的新指纹才能通过
    assert.equal(purgeGate({ confirm: PURGE_CONFIRM_TEXT, plan_hash: plan2.plan_hash }, plan2, 2).ok, true);
  });
});

function statOf(file: string): { size: number; mtimeMs: number } {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: st.mtimeMs };
}
