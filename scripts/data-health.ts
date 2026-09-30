/**
 * 数据体检（只读，不写盘）：一条命令看清「缺什么、缺哪天、为什么」。
 *
 * 为什么要有这个脚本：此前缺数据全靠用户打开页面才发现，再逐个调试。
 * 体检把「数据源 → 应有新鲜度 → 实际最新 → 缺口」一次性列清楚，
 * 并给出对应的补抓命令（自愈入口），把「发现缺数据」从人工变成一条命令。
 *
 * 用法：node --experimental-strip-types scripts/data-health.ts
 */
import fs from "node:fs";
import path from "node:path";

type Status = "OK" | "STALE" | "MISSING" | "UPSTREAM_FAIL";

type Check = {
  name: string;
  status: Status;
  detail: string;
  fix: string;
};

const ROOT = process.cwd();
const now = new Date();
const today = beijingDate(now);

function beijingDate(d: Date): string {
  // 北京时间 = UTC+8
  const t = new Date(d.getTime() + 8 * 3600_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(
    t.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** 判断交易日的粗口径：周一~周五（不含节假日，节假日会误判为交易日，仅用于「是否该有数据」提示） */
function isWeekday(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd >= 1 && wd <= 5;
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 文件新鲜度：返回 mtime 的北京时间字符串 */
function fileMtime(file: string): { date: string; ageDays: number; sizeKb: number } | null {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  const d = beijingDate(st.mtime);
  return { date: d, ageDays: daysBetween(d, today), sizeKb: Math.round(st.size / 1024) };
}

/** 读 JSON 里的最新日期字段（自动探测常见字段名与结构） */
function jsonLatestDate(file: string): { latest: string | null; key: string | null; rows: number | null } {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return { latest: null, key: null, rows: null };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return probeLatest(j);
  } catch {
    return { latest: null, key: null, rows: null };
  }
}

function probeLatest(j: unknown): { latest: string | null; key: string | null; rows: number | null } {
  if (Array.isArray(j)) {
    const dates = j
      .map((r) => firstDateString(r))
      .filter((x): x is string => !!x)
      .sort();
    return { latest: dates.at(-1) ?? null, key: "array[].date", rows: j.length };
  }
  if (j && typeof j === "object") {
    const obj = j as Record<string, unknown>;
    for (const k of ["latestDate", "asOf", "as_of", "date", "tradeDate", "updatedAt", "generatedAt", "builtAt"]) {
      const v = obj[k];
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        return { latest: v.slice(0, 10), key: k, rows: null };
      }
    }
    // 形如 { "2026-09-29|industry": {...} } 的按日期字典（键可带后缀，如 "|industry"/"|concept"）
    const keys = Object.keys(obj)
      .filter((k) => /^\d{4}-\d{2}-\d{2}/.test(k))
      .map((k) => k.slice(0, 10))
      .sort();
    if (keys.length) return { latest: keys.at(-1) ?? null, key: "dateMap(" + keys.length + ")", rows: keys.length };
    // 递归一层
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) || (v && typeof v === "object")) {
        const r = probeLatest(v);
        if (r.latest) return { ...r, key: `${k}.${r.key}` };
      }
    }
  }
  return { latest: null, key: null, rows: null };
}

function firstDateString(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  for (const k of ["tradeDate", "date", "asOf", "as_of", "d"]) {
    const v = o[k];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return null;
}

/**
 * 上游探活：区分「连不上」与「有响应」。
 * 判定不能只看 HTTP 状态——eltdx 网关根路径就是 404，但服务是活的；
 * 只有 ECONNREFUSED / 超时才算挂。
 */
async function upstreamCheck(name: string, url: string, timeoutMs = 8000): Promise<Check> {
  const started = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    const ms = Date.now() - started;
    return {
      name,
      status: "OK",
      detail: `服务在（HTTP ${r.status} · ${ms}ms）`,
      fix: "",
    };
  } catch (e) {
    const ms = Date.now() - started;
    return {
      name,
      status: "UPSTREAM_FAIL",
      detail: `连不上 · ${ms}ms · ${String((e as Error).message).slice(0, 60)}`,
      fix: "上游不通，本地缓存兜底；检查网关/代理",
    };
  }
}

async function main() {
  const checks: Check[] = [];
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();

  // ---------- 1. DB 表新鲜度 ----------
  const tableChecks: { name: string; dateField: string; label: string; fix: string }[] = [
    { name: "stockDailyClose", dateField: "tradeDate", label: "全A收盘价(breadth)", fix: "curl -X POST :3000/api/tasks/run -d '{\"kind\":\"breadth\",\"force\":true}'" },
    { name: "marketLimitUp", dateField: "tradeDate", label: "涨停名单(roster)", fix: "curl -X POST :3000/api/tasks/run -d '{\"kind\":\"roster\",\"force\":true}'" },
    { name: "dailySnapshot", dateField: "tradeDate", label: "每日快照(dailysnap)", fix: "curl -X POST :3000/api/tasks/run -d '{\"kind\":\"dailysnap\",\"force\":true}'" },
  ];

  for (const t of tableChecks) {
    try {
      const fn = (db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown[]>>>)[t.name];
      if (!fn) {
        checks.push({ name: t.label, status: "MISSING", detail: "DB 无此表", fix: "npx prisma db push" });
        continue;
      }
      const rows = await fn.findMany({
        distinct: [t.dateField],
        orderBy: { [t.dateField]: "desc" },
        select: { [t.dateField]: true },
        take: 3,
      });
      const dates = rows.map((r: unknown) => (r as Record<string, string>)[t.dateField]).sort().reverse();
      const latest = dates[0] ?? null;
      if (!latest) {
        checks.push({ name: t.label, status: "MISSING", detail: "表里没有任何数据", fix: t.fix });
        continue;
      }
      // 关键：数据由收盘后 15:20 的定时窗口写入。盘中（<15:20）今天本来就不该有数据，
      // 把「今天还没有」判成缺口 = 每天上午都在误报，反而淹没真缺口。
      const bj = new Date(now.getTime() + 8 * 3600_000);
      const hhmm = bj.getUTCHours() * 60 + bj.getUTCMinutes();
      const settled = hhmm >= 15 * 60 + 20;
      const expectToday = isWeekday(today) && settled;
      const maxGap = expectToday ? 0 : 1;
      const gap = daysBetween(latest, today);
      let status: Status = gap > maxGap ? "STALE" : "OK";
      let detail = `最新 ${latest}（距今 ${gap} 天）· 近 3 天：${dates.join(", ")}`;
      if (status === "STALE") {
        detail += settled ? " ← 收盘后仍缺今天，真缺口" : " ← 盘中未到 15:20，属正常";
      }
      checks.push({ name: t.label, status, detail, fix: status === "OK" ? "" : t.fix });
    } catch (e) {
      checks.push({ name: t.label, status: "MISSING", detail: `查询失败 ${String((e as Error).message).slice(0, 60)}`, fix: "检查 schema/client 是否最新" });
    }
  }

  await db.$disconnect();

  // ---------- 2. JSON 缓存新鲜度 ----------
  const jsonChecks: { file: string; label: string; maxAgeDays: number; fix: string }[] = [
    { file: "data/sector-snapshots.json", label: "板块快照 JSON", maxAgeDays: 1, fix: "curl -X POST :3000/api/tasks/run -d '{\"kind\":\"sectorsnap\",\"force\":true}'" },
    { file: "data/sector-daily-snapshots.json", label: "板块日快照 JSON", maxAgeDays: 1, fix: "同上（sectorsnap）" },
    { file: "data/market-trend-cache.json", label: "大盘走势缓存", maxAgeDays: 1, fix: "打开全景看板触发重算" },
    { file: "data/strategy-regime.json", label: "分档回测排名", maxAgeDays: 30, fix: "node --experimental-strip-types scripts/backtest-strategy-regime.ts" },
  ];
  for (const c of jsonChecks) {
    const mt = fileMtime(c.file);
    if (!mt) {
      checks.push({ name: c.label, status: "MISSING", detail: `${c.file} 不存在`, fix: c.fix });
      continue;
    }
    const jd = jsonLatestDate(c.file);
    const stale = mt.ageDays > c.maxAgeDays;
    checks.push({
      name: c.label,
      status: stale ? "STALE" : "OK",
      detail: `文件 ${mt.date}（${mt.ageDays} 天前，${mt.sizeKb}KB）${jd.latest ? ` · 内容最新 ${jd.latest}（字段 ${jd.key}）` : ""}${jd.rows != null ? ` · ${jd.rows} 条` : ""}${stale ? " ← 过期" : ""}`,
      fix: stale ? c.fix : "",
    });
  }

  // ---------- 3. 上游连通性 ----------
  checks.push(await upstreamCheck("eltdx 行情网关 :8756", "http://127.0.0.1:8756/", 6000));
  checks.push(await upstreamCheck("东财 push2", "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=1&fs=m:0+t:6&fields=f12", 8000));

  // ---------- 输出 ----------
  const icons: Record<Status, string> = { OK: "✅", STALE: "⚠️", MISSING: "❌", UPSTREAM_FAIL: "🔌" };
  console.log(`\n=== 数据体检 ${today} ${new Date(now.getTime() + 8 * 3600_000).toISOString().slice(11, 19)} (北京) ===\n`);
  for (const c of checks) {
    console.log(`${icons[c.status]} ${c.name}`);
    console.log(`   ${c.detail}`);
    if (c.fix) console.log(`   → 补：${c.fix}`);
  }
  const bad = checks.filter((c) => c.status !== "OK");
  console.log(`\n合计 ${checks.length} 项：${checks.length - bad.length} 正常 / ${bad.length} 需处理\n`);
  if (bad.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("体检脚本自身出错：", e);
  process.exit(1);
});
