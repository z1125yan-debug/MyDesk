// P2 收尾：Radar / Events 真实闭环集成测试（默认跳过，需显式开启）
// 开启条件：MYDESK_INTEGRATION=1，且本地服务指向本副本（MYDESK_BASE_URL，默认 http://127.0.0.1:3000）
//   例：MYDESK_INTEGRATION=1 MYDESK_BASE_URL=http://127.0.0.1:3010 node --test tests/quant/p2-scan-loop.test.ts
// 为什么默认跳过：本文件会真实调用行情/快讯数据源并写库（当日覆盖），不属于无网络的常规回归；
//   常规 `node --test tests/**/*.test.ts` 下它报 skipped 而不是 pass，避免把「没跑」当成「已通过」。
// 覆盖：手动扫描→真实数据→规则计算→落库→接口读回→页面同源数据 的一致性、同日幂等（重扫不产生重复）、
//       跨交易日历史不被破坏、P2 五个接口的响应契约、以及自动化任务记录（task_run）闭环与幂等拦截。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const ENABLED = process.env.MYDESK_INTEGRATION === "1";
const BASE = (process.env.MYDESK_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const SKIP_REASON = ENABLED ? false : "未设置 MYDESK_INTEGRATION=1（该用例需真实数据源 + 本地服务 + 写库）";
const TIMEOUT_MS = 240_000;

async function api(method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 保留 null，由断言报出真实响应片段 */ }
  assert.ok(json, `${method} ${p} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  return { status: res.status, json };
}

function titlesOf(items: any[]): string[] {
  return items.map((i) => `${i.kind ?? "event"}|${i.title}`);
}
function dupesOf(keys: string[]): string[] {
  const seen = new Map<string, number>();
  for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
}

// 直连运行时库，用于校验「跨交易日历史不被破坏」——只读，不写
const DB_FILE = path.join(process.cwd(), "prisma", "db", "custom.db");
async function perDay(table: "radar_finding" | "global_event"): Promise<Record<string, number>> {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: `file:${DB_FILE.replace(/\\/g, "/")}` });
  try {
    const rows = (await db.$queryRawUnsafe(`SELECT asOf AS d, COUNT(*) AS n FROM ${table} GROUP BY asOf`)) as { d: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [String(r.d), Number(r.n)]));
  } finally {
    await db.$disconnect();
  }
}

function sameExceptToday(before: Record<string, number>, after: Record<string, number>, today: string) {
  const past = Object.entries(before).filter(([d]) => d !== today);
  for (const [d, n] of past) assert.equal(after[d], n, `历史交易日 ${d} 的行数被改动（${n} → ${after[d]}），当日扫描不得越界`);
}

// task_run 只读快照：自动化验收用（P2-自动化 13）
async function taskRunRows(kind: string, tradeDate: string): Promise<{ status: string; trigger: string; results: number }[]> {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: `file:${DB_FILE.replace(/\\/g, "/")}` });
  try {
    // 裸 SQL 必须给每列 AS 别名，否则返回对象拿不到稳定键名；trigger 是 SQL 关键字，需加引号
    const rows = (await db.$queryRawUnsafe(
      `SELECT status AS st, "trigger" AS tg, results AS n FROM task_run WHERE kind = ? AND tradeDate = ? ORDER BY startedAt DESC`,
      kind, tradeDate,
    )) as { st: string; tg: string; n: number }[];
    return rows.map((r) => ({ status: String(r.st), trigger: String(r.tg), results: Number(r.n) }));
  } finally {
    await db.$disconnect();
  }
}

/** P3：读回当日最近若干条 task_run 的 basis / note，用来核对「口径」是否真被如实记录（只读） */
async function taskRunTexts(kind: string, tradeDate: string, take = 6): Promise<{ status: string; basis: string; note: string }[]> {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: `file:${DB_FILE.replace(/\\/g, "/")}` });
  try {
    const rows = (await db.$queryRawUnsafe(
      `SELECT status AS st, basis AS b, note AS n FROM task_run WHERE kind = ? AND tradeDate = ? ORDER BY startedAt DESC LIMIT ?`,
      kind, tradeDate, take,
    )) as { st: string; b: string; n: string }[];
    return rows.map((r) => ({ status: String(r.st), basis: String(r.b ?? ""), note: String(r.n ?? "") }));
  } finally {
    await db.$disconnect();
  }
}

/**
 * P3：当日库内自然键的重复情况（只读）。
 * 增量口径的正确性判据不是「条数没变」，而是「同一自然键不会有多行」——重复插一条同名信号同样会让条数看起来正常。
 */
async function keyDupes(table: "radar_finding" | "global_event", tradeDate: string): Promise<{ rows: number; keys: number; dupes: string[] }> {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: `file:${DB_FILE.replace(/\\/g, "/")}` });
  const where = table === "radar_finding" ? `asOf = ? AND state = 'live'` : `asOf = ?`;
  try {
    const cnt = (await db.$queryRawUnsafe(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT dedupeKey) AS k FROM ${table} WHERE ${where}`, tradeDate,
    )) as { n: number; k: number }[];
    const dup = (await db.$queryRawUnsafe(
      `SELECT dedupeKey AS k, COUNT(*) AS n FROM ${table} WHERE ${where} AND dedupeKey <> '' GROUP BY dedupeKey HAVING COUNT(*) > 1`,
      tradeDate,
    )) as { k: string; n: number }[];
    return {
      rows: Number(cnt[0]?.n ?? 0), keys: Number(cnt[0]?.k ?? 0),
      dupes: dup.map((d) => `${d.k} ×${d.n}`),
    };
  } finally {
    await db.$disconnect();
  }
}

/** 游标只读快照：回答「今天有没有成功基准、基准建立后有没有被失败推进」 */
async function cursorRow(kind: string, tradeDate: string): Promise<{ exists: boolean; watermark: string; note: string }> {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: `file:${DB_FILE.replace(/\\/g, "/")}` });
  try {
    const rows = (await db.$queryRawUnsafe(
      `SELECT watermark AS w, note AS n FROM scan_cursor WHERE kind = ? AND tradeDate = ?`, kind, tradeDate,
    )) as { w: string; n: string }[];
    return rows.length ? { exists: true, watermark: String(rows[0].w ?? ""), note: String(rows[0].n ?? "") } : { exists: false, watermark: "", note: "" };
  } finally {
    await db.$disconnect();
  }
}

test("Radar 闭环：扫描→落库→读回 一致，且同日重扫不产生重复行", { skip: SKIP_REASON }, async () => {
  const scan1 = await api("POST", "/api/radar");
  assert.equal(scan1.status, 200);
  assert.equal(scan1.json.ok, true, `扫描失败：${scan1.json.error}`);
  const day = String(scan1.json.trade_date);
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  const items1: any[] = scan1.json.items ?? [];
  assert.ok(Array.isArray(items1));
  // 空结果只允许在数据源缺失并给出 missing 口径时出现——不接受静默空库
  if (!items1.length) assert.ok(Array.isArray(scan1.json.missing) && scan1.json.missing.length > 0, "扫描为空但未给出任何缺失口径说明");
  for (const it of items1) {
    assert.ok(["risk", "theme", "fund", "news", "anomaly"].includes(String(it.kind)), `未知 kind：${it.kind}`);
    assert.ok(String(it.title).trim().length > 0);
    assert.equal(typeof it.evidence, "object");
  }
  assert.deepEqual(dupesOf(titlesOf(items1)), [], "同日出现重复发现，说明当日先删后插未生效");

  const read = await api("GET", "/api/radar");
  assert.equal(read.json.ok, true);
  assert.deepEqual(titlesOf(read.json.items ?? []), titlesOf(items1), "接口读回与扫描落库结果不一致");

  const scan2 = await api("POST", "/api/radar");
  assert.equal(scan2.json.ok, true);
  const items2: any[] = scan2.json.items ?? [];
  assert.equal(items2.length, items1.length, `同日第二次扫描条数变化（${items1.length} → ${items2.length}），应幂等覆盖而非累积`);
  assert.deepEqual(dupesOf(titlesOf(items2)), [], "重扫后同日出现重复行");
});

test("Radar 跨日安全：多次扫描只影响当日，历史交易日行数不变", { skip: SKIP_REASON }, async () => {
  const before = await perDay("radar_finding");
  await api("POST", "/api/radar");
  const after = await perDay("radar_finding");
  const today = String((await api("GET", "/api/radar")).json.as_of).slice(0, 10);
  sameExceptToday(before, after, today);
});

test("Events 闭环：扫描→落库→读回 一致，未映射快讯只计数不入库", { skip: SKIP_REASON }, async () => {
  const scan = await api("POST", "/api/events");
  assert.equal(scan.status, 200);
  assert.equal(scan.json.ok, true, `扫描失败：${scan.json.error}`);
  const items: any[] = scan.json.items ?? [];
  assert.ok(Array.isArray(items));
  if (!items.length) assert.ok(Array.isArray(scan.json.missing) && scan.json.missing.length > 0, "事件扫描为空但未给出缺失口径");
  for (const it of items) {
    assert.ok(String(it.title).trim().length > 0);
    assert.ok(Array.isArray(it.mappedSectors) && Array.isArray(it.relatedStocks), "映射板块/关联标的必须是数组（未命中不得编造）");
    assert.equal(typeof it.fundCheck, "object");
  }
  assert.deepEqual(dupesOf(titlesOf(items)), [], "同日出现重复事件行");
  assert.ok(Number.isFinite(Number(scan.json.unmatched)) && Number(scan.json.unmatched) >= 0, "未映射条数必须如实计数");

  const read = await api("GET", "/api/events");
  assert.equal(read.json.ok, true);
  assert.deepEqual(read.json.items.map((i: any) => i.title), items.map((i) => i.title), "接口读回与扫描落库不一致");

  const before = await perDay("global_event");
  await api("POST", "/api/events");
  const after = await perDay("global_event");
  sameExceptToday(before, after, String(scan.json.trade_date));
});

test("P2 接口响应契约：risk / themes / radar / events / probability 均返回可读 JSON", { skip: SKIP_REASON }, async () => {
  const risk = await api("GET", "/api/market/risk");
  assert.equal(risk.json.ok, true);
  assert.equal(typeof risk.json.live, "boolean", "risk 必须如实声明是否为实时口径");
  assert.ok(Array.isArray(risk.json.missing));

  const themes = await api("GET", "/api/market/themes");
  assert.equal(themes.json.ok, true);
  const BUCKETS = ["main", "sub", "rotation", "watch"] as const;
  const cards: any[] = [];
  for (const k of BUCKETS) {
    assert.ok(Array.isArray(themes.json[k]), `themes.${k} 必须是数组`);
    cards.push(...(themes.json[k] as any[]));
  }
  // 空集合只允许伴随明确的缺失口径（数据源被限流/无返回）出现
  if (!cards.length) assert.ok((themes.json.missing as string[]).length > 0, "主线为空但未给出缺失口径说明");
  for (const c of cards) {
    assert.ok(BUCKETS.includes(c.role as any), `未知主线角色：${c.role}`);
    assert.ok(typeof c.name === "string" && c.name.length > 0);
    assert.ok(c.changePct === null || Number.isFinite(c.changePct), "涨幅不可计算时必须为 null，不得填 0");
    assert.ok(c.streakPct === null || Number.isFinite(c.streakPct), "连续强势天数无数据时必须为 null（东财日K无返回不得当 0）");
  }

  const radar = await api("GET", "/api/radar");
  assert.equal(radar.json.ok, true);
  assert.equal(typeof radar.json.scanned, "boolean", "radar 必须区分「今日已扫描」与「空库未扫描」");

  const events = await api("GET", "/api/events");
  assert.equal(events.json.ok, true);
  assert.ok(Array.isArray(events.json.items));

  const prob = await api("POST", "/api/quant/probability");
  // probability 需要 body，单独发一次带真实K线口径条件的请求
  const probRes = await fetch(`${BASE}/api/quant/probability`, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conditions: [{ field: "above_ma_20", op: ">", value: 0 }], universe: "index" }),
  });
  const probJson = await probRes.json() as any;
  assert.equal(probJson.ok, true, `概率接口失败：${probJson.error}`);
  assert.ok(Array.isArray(probJson.pooled) && probJson.pooled.length === 3, "应返回 h=1/5/20 三档");
  for (const row of probJson.pooled) {
    assert.ok(row.win_rate === null || Number.isFinite(row.win_rate), "胜率不可计算时必须为 null，不得以 0 代替");
    assert.ok(row.benchmark_return === null || Number.isFinite(row.benchmark_return));
  }
  assert.equal(typeof probJson.benchmark?.bars, "number");
  assert.ok(Array.isArray(probJson.warnings));
  void prob;
});

test("自动化任务记录闭环：手动扫描留 task_run 行，重复触发不产生新数据", { skip: SKIP_REASON }, async () => {
  // 1) 状态接口本身必须可读且如实声明能力边界（不得出现「无人值守」式承诺）
  const st = await api("GET", "/api/tasks/status");
  assert.equal(st.json.ok, true, `状态接口失败：${st.json.error}`);
  assert.equal(typeof st.json.enabled, "boolean", "必须如实说明调度器是否启用");
  assert.equal(typeof st.json.running, "boolean", "必须如实说明本进程定时器是否在跑");
  assert.match(String(st.json.today), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(st.json.next && typeof st.json.next.at === "string", "必须给出下一次执行窗口，供人核对是否真会跑");
  assert.equal(typeof st.json.boundary, "string");
  assert.doesNotMatch(String(st.json.boundary), /无人值守|每天自动运行/, "边界文案不得承诺无人值守");
  for (const k of ["radar", "events"]) {
    const sum = (st.json.today_summary as any[]).find((s) => s.kind === k);
    assert.ok(sum, `today_summary 缺少 ${k} 的汇总`);
    assert.equal(typeof sum.settled, "boolean");
  }

  // 2) 手动扫描必须留下与之对应的 task_run 行（结果条数与接口返回一致）
  const scan = await api("POST", "/api/radar");
  assert.equal(scan.json.ok, true, `扫描失败：${scan.json.error}`);
  const day = String(scan.json.trade_date);
  assert.equal(scan.json.task?.status, "success", `扫描未记为成功：${JSON.stringify(scan.json.task)}`);
  assert.equal(scan.json.task?.kind, "radar");
  const rows = await taskRunRows("radar", day);
  assert.ok(rows.length > 0, `扫描成功但 task_run 无记录（${day}）：无法回答「到底有没有运行」`);
  const ok = rows.find((r) => r.status === "success");
  assert.ok(ok, "task_run 无 success 行");
  assert.equal(ok.trigger, "manual", "手动扫描记录的 trigger 必须是 manual，不得与自动混为一谈");
  assert.equal(ok.results, (scan.json.items ?? []).length, "task_run 记录的落库条数与接口返回条数不一致");

  // 3) 再次经任务接口触发（不带 force）：必须被幂等拦截，且不新增任何行
  const before = (await taskRunRows("radar", day)).length;
  const again = await api("POST", "/api/tasks/run", { kind: "radar" });
  assert.equal(again.json.outcome.status, "skipped", `重复触发未被拦截：${JSON.stringify(again.json.outcome)}`);
  assert.ok(["already_success", "non_trading_day", "running", "max_attempts"].includes(String(again.json.outcome.reason)),
    `拦截原因必须是可枚举的机器码，实际：${again.json.outcome.reason}`);
  const after = await taskRunRows("radar", day);
  assert.equal(after.length, before, "被幂等拦截的触发仍写了记录，会产生无意义重复数据");
  const readBack = await api("GET", "/api/radar");
  assert.equal((readBack.json.items ?? []).length, (scan.json.items ?? []).length, "重复触发改变了当日结果条数");

  // 4) 非当日日期不得被接受（避免用当前行情冒充历史结果）
  const bad = await fetch(`${BASE}/api/tasks/run`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "radar", trade_date: "2000-01-01" }),
  });
  assert.equal(bad.status, 400, "历史日期的任务触发必须被拒绝");
});

// ---------- P3 第三阶段：增量扫描的真实数据闭环 ----------
// 这里只验「真实数据在增量口径下不会被写坏」：不重复、行数与写库明细对得上、口径被如实记录。
// 失败恢复（失败不推进游标）无法用真实行情安全触发（要人为让数据源报错），因此只在
// tests/quant/p3-incremental.test.ts 里做机制验证，不在此处伪造。

test("P3 Radar 增量：显式增量补跑不重复落库，行数与写库明细严格对账，口径落进 task_run", { skip: SKIP_REASON }, async () => {
  const full = await api("POST", "/api/radar"); // 手动扫描 = 全量口径，同时建立当日游标
  assert.equal(full.json.ok, true, `全量扫描失败：${full.json.error}`);
  const day = String(full.json.trade_date);
  assert.equal(full.json.mode, "full", "手动「立即扫描」必须真跑全量，不允许被游标跳过（否则用户无法强制重刷）");
  const cur1 = await cursorRow("radar", day);
  assert.equal(cur1.exists, true, "全量成功后必须写入当日游标，否则收盘后那次自动扫描无从判定增量基准");
  assert.ok(cur1.watermark.length > 0, "游标必须有数据基准水位线");
  const base = await keyDupes("radar_finding", day);
  assert.deepEqual(base.dupes, [], "全量结果本身就有重复自然键");
  assert.equal(base.rows, (full.json.items ?? []).length, "接口返回条数与库内 live 行数不一致");
  assert.equal(base.keys, base.rows, "自然键必须一行一键");

  const inc = await api("POST", "/api/tasks/run", { kind: "radar", force: true, mode: "incremental" });
  assert.equal(inc.json.ok, true, `增量补跑失败：${inc.json.outcome?.error ?? inc.json.error}`);
  assert.equal(inc.json.outcome.mode, "incremental", "显式指定增量时必须按增量执行，不能被 force 改回全量");
  const d = inc.json.outcome.delta as any;
  assert.ok(d, "增量结果未返回写库明细 delta");
  const after = await keyDupes("radar_finding", day);
  assert.deepEqual(after.dupes, [], "增量后同日出现重复自然键 —— 同一信号被写了两遍");
  assert.equal(after.rows, base.rows + Number(d.inserted) - Number(d.superseded),
    `库内 live 行数变化（${base.rows}→${after.rows}）与写库明细（新增 ${d.inserted}、标记消失 ${d.superseded}）对不上`);
  assert.equal(after.keys, after.rows, "增量后自然键不再是一行一键");
  assert.ok(Number(d.inserted) <= Number(d.scanned) && Number(d.superseded) <= base.rows, "写库明细出现不自洽计数");

  const texts = await taskRunTexts("radar", day);
  const row = texts.find((t) => t.status === "success" && t.basis.includes("口径 增量"));
  assert.ok(row, "task_run.basis 必须如实记录本次用的是增量口径，否则事后无法回答「那天到底怎么跑的」");
  assert.match(row.note, /写入：新增/, "task_run.note 必须写明本次新增/更新/未变/标记消失的条数");

  const st = await api("GET", "/api/tasks/status");
  const sum = (st.json.today_summary as any[]).find((s) => s.kind === "radar");
  assert.equal(sum?.cursor?.exists, true, "状态接口必须回报当日游标是否存在");
  assert.ok(Number(sum.cursor.done_keys) > 0, "游标确认键数为 0 说明成功后没有记账，下次会整批重写");
});

test("P3 Events 增量：重复扫描不重复入库，已入库事件的资金验证不被悄悄改写", { skip: SKIP_REASON }, async () => {
  const full = await api("POST", "/api/events");
  assert.equal(full.json.ok, true, `全量事件扫描失败：${full.json.error}`);
  const day = String(full.json.trade_date);
  assert.equal(full.json.mode, "full");
  const base = await keyDupes("global_event", day);
  assert.deepEqual(base.dupes, [], "全量事件结果本身就有重复自然键");
  assert.equal(base.rows, (full.json.items ?? []).length, "接口返回条数与库内事件行数不一致");

  const inc = await api("POST", "/api/tasks/run", { kind: "events", force: true, mode: "incremental" });
  assert.equal(inc.json.ok, true, `事件增量补跑失败：${inc.json.outcome?.error ?? inc.json.error}`);
  assert.equal(inc.json.outcome.mode, "incremental");
  const d = inc.json.outcome.delta as any;
  assert.equal(Number(d.updated), 0, "增量口径不得覆盖已入库事件（其资金验证保持首次入库时的值，这条口径必须在实现里成立）");
  const after = await keyDupes("global_event", day);
  assert.deepEqual(after.dupes, [], "增量后同日出现重复事件行");
  assert.equal(after.rows, base.rows + Number(d.inserted), "库内事件行数变化与新增条数不一致（增量把老事件重写成了新行？）");
  assert.equal(after.keys, after.rows, "增量后事件自然键不再是一行一键");
  assert.ok(Number(d.inserted) <= Number(d.scanned), "写库明细出现不自洽计数");

  const texts = await taskRunTexts("events", day);
  assert.ok(texts.some((t) => t.status === "success" && t.basis.includes("口径 增量")),
    "事件任务的 task_run.basis 未记录增量口径");
});

// ---------- P4 历史查询（第四阶段）：全程只读真实服务 + 真实库，不触发任何扫描、不写一行数据 ----------
// 这一组用例证明的是「读得到的东西与库里真的一致」，因此刻意不调用 POST：
// 历史查询若依赖扫描才成立，那就还是「重算」，不是本阶段要验收的「回看已落库的真实历史」。
test("P4 雷达历史：与今日视图同源一致、live/superseded 可分、无数据日期明确空且不回退今天", { skip: SKIP_REASON }, async () => {
  const today = (await api("GET", "/api/radar")).json;
  const day = String(today.as_of);
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);

  // 1) 今天这一天：历史接口按 state=live 取，必须与今日接口读到同一批库行（同源，不是两套数据）
  const live = await api("GET", `/api/radar/history?date=${day}&state=live`);
  assert.equal(live.status, 200);
  assert.equal(live.json.ok, true);
  assert.equal(live.json.date, day);
  assert.equal(live.json.is_today, true);
  assert.deepEqual(live.json.items.map((i: any) => i.title), (today.items ?? []).map((i: any) => i.title),
    "历史接口与今日接口读同一批 asOf=今天的 live 行，标题序列必须一致");
  assert.ok(live.json.items.every((i: any) => i.as_of === day), "返回行必须全部带所查日期的 asOf");
  assert.ok(live.json.items.every((i: any) => i.state === "live"), "state=live 的查询里不得混入消失行");

  // 2) 全部：rows = live + superseded 必须自洽（消失行保留、可查，不因页面显示而被抹掉）
  const all = await api("GET", `/api/radar/history?date=${day}&state=all`);
  assert.equal(all.json.counts.rows, all.json.counts.live + all.json.counts.superseded, "当日行数与 live/superseded 分开计数不自洽");
  assert.equal(all.json.items.length, all.json.counts.rows, "state=all 返回的行数必须等于当日全部行");
  assert.equal(all.json.items.filter((i: any) => i.superseded).length, all.json.counts.superseded);
  assert.equal(Number(today.superseded_today ?? 0), all.json.counts.superseded, "今日接口报的消失条数与历史接口的消失行数必须一致");
  const gone = all.json.items.filter((i: any) => i.state === "superseded");
  for (const g of gone) assert.ok(String(g.state_label).includes("已标记消失"), "消失行必须带可读状态，不得伪装成成立中");

  // 3) 口径文案：必须点名所查日期；历史视图不得自称实时，今日视图必须说明会被扫描改写（REAL_DATA_ONLY）
  assert.ok(String(all.json.view_basis).includes(day), `口径说明必须写清查看的是哪一天：${all.json.view_basis}`);
  assert.match(String(all.json.date_basis), /date=/);
  if (all.json.is_today) {
    assert.match(String(all.json.view_basis), /今日/);
    assert.match(String(all.json.view_basis), /随每次扫描/);
  } else {
    assert.match(String(all.json.view_basis), /历史归档（只读）/);
    assert.doesNotMatch(String(all.json.view_basis), /实时|LIVE/i, "历史归档不得被写成实时口径");
  }

  // 3.5) 运行记录：当日总数与「接口返回的最近若干条」必须分开报，页面才不会把少列当成没扫过
  assert.ok(Number.isInteger(all.json.runs_total) && all.json.runs_total >= all.json.runs.length,
    `runs_total(${all.json.runs_total}) 必须 ≥ 返回条数(${all.json.runs.length})：两者口径反了就是编数`);
  assert.ok(all.json.runs.length <= 20, "接口按倒序最多返回最近 20 条，不得把整天的运行记录灌进页面");

  // 4) 库里确实没有的一天：明确空结果 + 缺失说明，且不回退到今天
  const none = await api("GET", "/api/radar/history?date=1990-01-02");
  assert.equal(none.status, 200);
  assert.equal(none.json.ok, true);
  assert.equal(none.json.date, "1990-01-02", "无数据也必须回显所查日期，不能悄悄换成今天");
  assert.equal(none.json.is_today, false);
  assert.deepEqual(none.json.items, []);
  assert.equal(none.json.counts.rows, 0);
  assert.ok(String(none.json.missing.join(" ")).includes("库里没有留档日=1990-01-02"), `无数据日期必须给出缺失口径：${JSON.stringify(none.json.missing)}`);
  assert.ok(!String(none.json.missing.join(" ")).includes("今日"), "缺失说明不得夹带今天的口径");
  assert.ok(!Array.isArray(none.json.available_dates) || !none.json.available_dates.some((b: any) => b.date === "1990-01-02"),
    "1990-01-02 不在真实归档清单里：不能为了页面好看把它列成可查询日期");

  // 5) 脏参数与未来日期：400 + 可读 JSON，不返回半套数据
  for (const bad of ["1990-1-2", "not-a-date", "2999-01-01", "2026-02-30"]) {
    const r = await api("GET", `/api/radar/history?date=${bad}`);
    assert.equal(r.status, 400, `非法/未来日期必须被拒：${bad}`);
    assert.equal(r.json.ok, false);
    assert.ok(String(r.json.error).length > 4, "错误必须可读，不能空 body");
  }
  const badState = await api("GET", `/api/radar/history?date=${day}&state=nope`);
  assert.equal(badState.status, 400, "state 脏值必须被拒，不能默认成某一种口径返回");

  // 6) 真实库里的每个归档日各查一次：跨日不得串数据（id 集合互不相交）
  const dates: string[] = (all.json.available_dates as any[]).filter((b) => b.rows > 0).map((b) => b.date).slice(0, 6);
  assert.ok(dates.length >= 1 && dates.includes(day), `归档清单必须至少含今天（真实库现状）：${JSON.stringify(dates)}`);
  const seen = new Map<string, string>();
  for (const d of dates) {
    const one = await api("GET", `/api/radar/history?date=${d}&state=all`);
    assert.equal(one.json.date, d);
    for (const it of one.json.items) {
      assert.equal(it.as_of, d, `${d} 的查询里出现了 asOf=${it.as_of} 的行：跨日串数据`);
      const prev = seen.get(String(it.id));
      assert.ok(!prev, `行 ${it.id} 同时出现在 ${prev} 与 ${d} 的查询结果里：按日期过滤失效`);
      seen.set(String(it.id), d);
    }
  }

  // 7) 只读性：以上全部查询跑完，今日视图必须一个字都没变
  const after = (await api("GET", "/api/radar")).json;
  assert.deepEqual(after.items.map((i: any) => i.title), (today.items ?? []).map((i: any) => i.title), "历史查询改动了今日视图：读取路径不允许写库");
  assert.equal(after.superseded_today ?? 0, today.superseded_today ?? 0);
});

test("P4 事件历史：契约如实（无 state 列 ⇒ superseded 为 null）、与今日事件同源、无数据日期不回退", { skip: SKIP_REASON }, async () => {
  const hist = await api("GET", "/api/events/history");
  assert.equal(hist.status, 200);
  assert.equal(hist.json.ok, true);
  assert.equal(hist.json.kind, "events");
  assert.equal(hist.json.counts.superseded, null, "事件表没有 state 列：接口不得编造「已消失」计数");
  assert.match(String(hist.json.state_filter_basis), /没有 state 列/);
  const day = hist.json.date === null ? "" : String(hist.json.date);
  if (!day) {
    // 库里没有任何事件归档：如实返回 date:null + 空清单，不允许拿今天的事件列表冒充
    assert.deepEqual(hist.json.items, []);
    assert.ok(String(hist.json.missing.join(" ")).length > 0, "空库必须给出缺失口径");
    assert.ok(!Array.isArray(hist.json.runs) || hist.json.runs.length === 0);
  } else {
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
    for (const it of hist.json.items) assert.equal(it.as_of, day);
    const todays = (await api("GET", "/api/events")).json;
    if (String(todays.as_of) === day) {
      assert.deepEqual((hist.json.items as any[]).map((i) => i.title), (todays.items ?? []).map((i: any) => i.title),
        "同一天里历史接口与今日接口必须读到同一批 global_event 行");
    }
    // 产业链映射与资金验证必须是入库时的真实值原样读回（历史查询不重算）
    for (const it of hist.json.items) {
      assert.ok(Array.isArray(it.mapped_sectors) && Array.isArray(it.related_stocks), "映射板块/关联标的必须是数组");
      assert.equal(typeof it.fund_check, "object");
      if (!it.mapped_sectors.length) assert.equal(it.chain_mapped, false, "未命中映射要如实标记，不得当作已映射展示");
    }
    const none = await api("GET", "/api/events/history?date=1990-01-02");
    assert.equal(none.json.date, "1990-01-02");
    assert.deepEqual(none.json.items, [], "没有归档的日期必须返回空，不得回退到已有数据的那天");
    assert.ok(String(none.json.missing.join(" ")).includes("库里没有留档日=1990-01-02"));
  }
  for (const bad of ["1990-1-2", "2999-01-01"]) {
    const r = await api("GET", `/api/events/history?date=${bad}`);
    assert.equal(r.status, 400, `非法/未来日期必须被拒：${bad}`);
  }
});
