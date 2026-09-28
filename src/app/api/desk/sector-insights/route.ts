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
import { promises as fs } from "node:fs";
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("refresh") === "1";
  const key = `desk/sector-insights?p=${encodeURIComponent(cachePath())}`;
  const ttl = force ? 0 : DEFAULT_TTL_MS;
  return ttlCache(key, ttl, async () => {
    const data = await readCache();
    if (!data || !data.cards) {
      return NextResponse.json({
        ok: false,
        error: "缓存不可用：未找到板块三卡缓存文件，请先跑 scrape-aiwuchuan/scripts/sector_board_insights.py",
        path: cachePath(),
      }, { status: 502 });
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
      cards: data.cards,
    });
  });
}

/** 外部脚本写完缓存后调一下，30s 内其他客户端也能立刻看到 */
export async function POST() {
  invalidateServerCache("desk/sector-insights");
  return NextResponse.json({ ok: true });
}