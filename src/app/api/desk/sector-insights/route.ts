// GET /api/desk/sector-insights — 板块全量看板三卡（轮动上行 / 低吸观察 / 高位风险）
//
// 数据源：scrape-aiwuchuan/cache/sector_insights_latest.json
//   - 由 scrape-aiwuchuan/scripts/sector_board_insights.py 周期生成
//   - 算法 1:1 复刻 aiwuchuan.com Settings-Ctoklwun.js:66054 的 `Da` computed
//   - 数据来自公开接口 /api/sector-panorama（615 板块，限免登录）
//
// 为什么走缓存而不是直接拉稳智：
//   1. 三卡每日算一次就够（盘后 15:30 跑），不需要每次页面打开都重算
//   2. 缓存文件由独立脚本维护（接口失败/被限流时仍能显示上次结果，不至于「暂无」）
//   3. 路径跨项目：D:/Zai/kairotrend-p1 读 C:/Users/Lenovo/WorkBuddy AI/.../scrape-aiwuchuan/cache
//      —— 用 WENZHI_INSIGHTS_PATH 环境变量可改路径，缺省走默认。
//
// 30 秒 TTL：盘内 30 秒陈旧可容忍；前端刷新按钮会失效缓存强制重读。
import { NextResponse } from "next/server";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { ttlCache, DEFAULT_TTL_MS, invalidateServerCache } from "@/lib/quant/server-cache";

export const dynamic = "force-dynamic";

const DEFAULT_CACHE_PATH =
  "C:/Users/Lenovo/WorkBuddy AI/2026-09-25-09-02-37/scrape-aiwuchuan/cache/sector_insights_latest.json";

function cachePath(): string {
  return process.env.WENZHI_INSIGHTS_PATH || DEFAULT_CACHE_PATH;
}

type Display = { flow3d?: string; pct3d?: string; pct5d?: string; flow1d?: string; ma20?: string; pct7d?: string; pop?: string; top100?: string };
type CardItem = { key: string | number; name: string; score: number; display?: Display; [k: string]: unknown };
type Cards = { rotation: CardItem[]; dip: CardItem[]; high: CardItem[] };
type CacheFile = {
  trade_date: string;
  updated_at: string;
  filter: string;
  top_n: number;
  all_count: number;
  cards: Cards;
};

async function readCache(): Promise<CacheFile | null> {
  const p = cachePath();
  try {
    const pointerBuf = await fs.readFile(p, "utf8");
    const pointer = JSON.parse(pointerBuf) as { abs_path?: string; rel_path?: string; path?: string };
    // 优先用绝对路径（最稳，跨盘符/跨项目都OK）；相对路径兜底（指向 latest 所在目录的上一级）
    let fullPath = pointer.abs_path;
    if (!fullPath) {
      const rel = pointer.rel_path ?? pointer.path;
      if (!rel) return null;
      fullPath = path.resolve(path.dirname(p), "..", rel);
    }
    const buf = await fs.readFile(fullPath, "utf8");
    const data = JSON.parse(buf) as CacheFile;
    if (!data?.cards) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 本地兜底（P33b，2026-09-30）：爬虫缓存停在 09-26（数据 09-24），而本地
 * data/sector-snapshots.json 由 15:20 定时任务每日留档（09-28/09-29 都有）。
 * 爬虫缓存缺失或 trade_date 落后于本地最新快照时，改用本地快照生成三卡——**当日口径**：
 *   轮动上行 = 当日涨跌>0 且 当日主力净额>0（按 涨跌×10+净额/10 打分）；
 *   高位风险 = 当日涨跌≥3%（当日大涨拥挤）；
 *   低吸观察 = 其余（按当日主力净额降序）。
 * 只有当日两个字段（涨跌/净额），3日/5日/7日/MA20 列随快照天数积累后再补——口径在响应里如实标注。
 */
function latestLocalSnapshotDate(): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(process.cwd(), "data", "sector-snapshots.json"), "utf8")) as {
      days?: Record<string, { computedAt?: string }>;
    };
    const dates = Object.keys(raw.days ?? {}).filter((k) => k.endsWith("|industry")).map((k) => k.split("|")[0]);
    return dates.length ? dates.sort().at(-1) ?? null : null;
  } catch {
    return null;
  }
}

function localCards(): (CacheFile & { day_scope: "1d" }) | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(process.cwd(), "data", "sector-snapshots.json"), "utf8")) as {
      days?: Record<string, { computedAt?: string; rows?: { code?: string; name?: string; changePct?: number | null; main?: number | null; rank?: number }[] }>;
    };
    const entries = Object.entries(raw.days ?? {})
      .filter(([k]) => k.endsWith("|industry"))
      .map(([k, v]) => ({ key: k, computedAt: v.computedAt ?? "", rows: v.rows ?? [] }));
    if (!entries.length) return null;
    entries.sort((x, y) => y.computedAt.localeCompare(x.computedAt));
    const latest = entries[0];
    const tradeDate = latest.key.split("|")[0];
    const rows = latest.rows.map((r) => ({
      name: r.name ?? "",
      pct: typeof r.changePct === "number" ? r.changePct : 0,
      main: typeof r.main === "number" ? r.main : 0,
    }));
    if (!rows.length) return null;
    const item = (r: { name: string; pct: number; main: number }, score: number): CardItem => ({
      key: r.name, name: r.name, score: Math.round(score * 100) / 100,
      // day_scope=1d 时前端把 flow3d/pct3d 槽位的标签切成本地「当日资金/当日涨跌」
      display: { flow3d: `${r.main >= 0 ? "+" : ""}${r.main.toFixed(2)}亿`, pct3d: `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(2)}%` },
    });
    const rotation = rows.filter((r) => r.pct > 0 && r.main > 0)
      .map((r) => item(r, r.pct * 10 + r.main / 10)).sort((x, y) => y.score - x.score);
    const high = rows.filter((r) => r.pct >= 3)
      .map((r) => item(r, r.pct * 10 + Math.max(r.main, 0) / 5)).sort((x, y) => y.score - x.score);
    const inOther = new Set([...rotation, ...high].map((x) => x.name));
    const dip = rows.filter((r) => !inOther.has(r.name))
      .map((r) => item(r, Math.max(r.main, 0))).sort((x, y) => y.score - x.score);
    return {
      trade_date: tradeDate,
      updated_at: latest.computedAt,
      filter: "当日口径（本地板块快照）",
      top_n: rows.length,
      all_count: rows.length,
      cards: { rotation: rotation.slice(0, 20), dip: dip.slice(0, 20), high: high.slice(0, 20) },
      day_scope: "1d",
    };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("refresh") === "1";
  const key = `desk/sector-insights?p=${encodeURIComponent(cachePath())}`;
  const ttl = force ? 0 : DEFAULT_TTL_MS;
  return ttlCache(key, ttl, async () => {
    const data = await readCache();
    const localDate = latestLocalSnapshotDate();
    // 爬虫缓存缺失，或它的 trade_date 落后于本地最新快照日 → 用本地快照（当日口径），不再展示 4 天前的旧榜
    if ((!data || !data.cards || (localDate != null && data.trade_date < localDate))) {
      const local = localCards();
      if (local) {
        return NextResponse.json({
          ok: true,
          trade_date: local.trade_date,
          updated_at: local.updated_at,
          filter: local.filter,
          top_n: local.top_n,
          all_count: local.all_count,
          age_sec: null,
          source: "本地板块快照（15:20 定时任务留档；当日口径，3日/MA20 列随快照天数积累后恢复）",
          day_scope: "1d" as const,
          cards: local.cards,
        });
      }
      if (!data || !data.cards) {
        return NextResponse.json({
          ok: false,
          error: "缓存不可用：未找到板块三卡缓存文件，请先跑 scrape-aiwuchuan/scripts/sector_board_insights.py",
          path: cachePath(),
        }, { status: 502 });
      }
    }
    const stat = await fs.stat(cachePath()).catch(() => null);
    const ageSec = stat ? Math.floor((Date.now() - stat.mtimeMs) / 1000) : null;
    return NextResponse.json({
      ok: true,
      trade_date: data.trade_date,
      updated_at: data.updated_at,
      filter: data.filter,
      top_n: data.top_n,
      all_count: data.all_count,
      age_sec: ageSec,
      source: "aiwuchuan.com /api/sector-panorama",
      day_scope: "3d" as const,
      cards: data.cards,
    });
  });
}

/** 外部脚本写完缓存后调一下，30s 内其他客户端也能立刻看到 */
export async function POST() {
  invalidateServerCache("desk/sector-insights");
  return NextResponse.json({ ok: true });
}