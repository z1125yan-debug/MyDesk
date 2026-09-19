// P2 收尾：归档库不变式测试（只读真实库，不发网络请求、不写任何数据）
// 覆盖：RadarFinding / GlobalEvent 的落库形态与「同日先删后插」幂等策略的实际结果——
//       同一天内不得出现重复行；JSON 字段必须可解析；asOf 必须是交易日字符串；kind/level 取值受控。
// 说明：本文件不构造测试数据（REAL_DATA_ONLY）。库为空或表未创建时按 skip 处理，不伪造通过。
// 运行：node --test tests/quant/p2-archive-db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DB_FILE = path.join(process.cwd(), "prisma", "db", "custom.db");
const DB_EXISTS = fs.existsSync(DB_FILE);
// Prisma 的相对 sqlite 路径按 schema 目录解析，这里给绝对 file: URL，避免 cwd 依赖
const DATASOURCE_URL = `file:${DB_FILE.replace(/\\/g, "/")}`;

const RADAR_KINDS = new Set(["risk", "theme", "fund", "news", "anomaly"]);
const EVENT_LEVELS = new Set(["普通新闻", "行业新闻", "重要行业事件", "重大产业事件", "全球级事件"]);

type Row = Record<string, unknown>;
async function query(sql: string, ...params: unknown[]): Promise<Row[]> {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: DATASOURCE_URL });
  try {
    return (await db.$queryRawUnsafe(sql, ...params)) as Row[];
  } finally {
    await db.$disconnect();
  }
}

// 表是否已创建（新克隆未跑 prisma db push 时应跳过，而不是失败伪装成"已验证"）
const TABLES = DB_EXISTS
  ? await query("SELECT name AS n FROM sqlite_master WHERE type='table'").then((r) => new Set(r.map((x) => String(x.n))))
  : new Set<string>();
const HAS_RADAR = TABLES.has("radar_finding");
const HAS_EVENTS = TABLES.has("global_event");

const skipNoDb = !DB_EXISTS ? "prisma/db/custom.db 不存在（运行时库，未初始化）" : false;

test("radar_finding：asOf 为 YYYY-MM-DD、kind 取值受控、evidence 为合法 JSON", { skip: skipNoDb || (!HAS_RADAR && "radar_finding 表未创建") }, async () => {
  const rows = await query("SELECT asOf AS d, kind AS k, title AS t, evidence AS e FROM radar_finding");
  for (const r of rows) {
    assert.match(String(r.d), /^\d{4}-\d{2}-\d{2}$/, `asOf 非法：${String(r.d)}`);
    assert.ok(RADAR_KINDS.has(String(r.k)), `未知 kind：${String(r.k)}`);
    assert.ok(String(r.t).length > 0, "title 不得为空（空标题会让同日去重失效）");
    const parsed = JSON.parse(String(r.e ?? "{}")) as unknown;
    assert.equal(typeof parsed, "object");
  }
});

test("radar_finding：同一交易日无重复 (asOf,kind,title) 行 —— 同日重扫幂等", { skip: skipNoDb || (!HAS_RADAR && "radar_finding 表未创建") }, async () => {
  const dups = await query(
    "SELECT asOf AS d, kind AS k, title AS t, COUNT(*) AS n FROM radar_finding " +
    "GROUP BY asOf, kind, title HAVING COUNT(*) > 1",
  );
  assert.deepEqual(dups, [], `同日重复行：${JSON.stringify(dups)}`);
});

test("global_event：asOf/level 受控，三个 JSON 列可解析", { skip: skipNoDb || (!HAS_EVENTS && "global_event 表未创建") }, async () => {
  const rows = await query(
    "SELECT asOf AS d, title AS t, level AS l, mappedSectors AS ms, relatedStocks AS rs, fundCheck AS fc FROM global_event",
  );
  for (const r of rows) {
    assert.match(String(r.d), /^\d{4}-\d{2}-\d{2}$/, `asOf 非法：${String(r.d)}`);
    assert.ok(EVENT_LEVELS.has(String(r.l)), `未知事件分级：${String(r.l)}`);
    assert.ok(Array.isArray(JSON.parse(String(r.ms ?? "[]"))), "mappedSectors 必须是数组 JSON");
    assert.ok(Array.isArray(JSON.parse(String(r.rs ?? "[]"))), "relatedStocks 必须是数组 JSON");
    assert.equal(typeof JSON.parse(String(r.fc ?? "{}")), "object");
  }
});

test("global_event：同一交易日无重复 (asOf,title) 行 —— 同日重扫幂等", { skip: skipNoDb || (!HAS_EVENTS && "global_event 表未创建") }, async () => {
  const dups = await query(
    "SELECT asOf AS d, title AS t, COUNT(*) AS n FROM global_event " +
    "GROUP BY asOf, title HAVING COUNT(*) > 1",
  );
  assert.deepEqual(dups, [], `同日重复行：${JSON.stringify(dups)}`);
});

test("跨交易日历史不被当日扫描破坏：每个 asOf 的行数等于其去重后行数", { skip: skipNoDb || (!HAS_RADAR && "radar_finding 表未创建") }, async () => {
  const perDay = await query(
    "SELECT asOf AS d, COUNT(*) AS n, COUNT(DISTINCT kind || '|' || title) AS dn FROM radar_finding GROUP BY asOf",
  );
  assert.ok(perDay.length >= 1, "至少应有一天的归档（当前为空库则说明尚未扫描）");
  for (const r of perDay) {
    assert.equal(Number(r.n), Number(r.dn), `交易日 ${String(r.d)} 内出现重复发现，说明当日 deleteMany 未生效`);
  }
});
