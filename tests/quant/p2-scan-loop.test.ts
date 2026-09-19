// P2 收尾：Radar / Events 真实闭环集成测试（默认跳过，需显式开启）
// 开启条件：MYDESK_INTEGRATION=1，且本地 dev 服务指向本副本（MYDESK_BASE_URL，默认 http://127.0.0.1:3000）
//   例：MYDESK_INTEGRATION=1 MYDESK_BASE_URL=http://127.0.0.1:3010 node --test tests/quant/p2-scan-loop.test.ts
// 为什么默认跳过：本文件会真实调用行情/快讯数据源并写库（当日覆盖），不属于无网络的常规回归；
//   常规 `node --test tests/**/*.test.ts` 下它报 skipped 而不是 pass，避免把「没跑」当成「已通过」。
// 覆盖：手动扫描→真实数据→规则计算→落库→接口读回→页面同源数据 的一致性、同日幂等（重扫不产生重复）、
//       跨交易日历史不被破坏、以及 P2 五个接口的响应契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const ENABLED = process.env.MYDESK_INTEGRATION === "1";
const BASE = (process.env.MYDESK_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const SKIP_REASON = ENABLED ? false : "未设置 MYDESK_INTEGRATION=1（该用例需真实数据源 + 本地服务 + 写库）";
const TIMEOUT_MS = 240_000;

async function api(method: "GET" | "POST", p: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${p}`, { method, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "content-type": "application/json" } });
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
