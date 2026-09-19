import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchNewsReal, fetchBoardReal, type BoardRow } from "@/lib/desk/em";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import {
  classifyNewsTitle, fundStage, type ThemeMapItem, type EventMatch,
} from "./events-rules.ts";
import { contentHash } from "./incremental-core.ts";

export interface EventScanItem extends EventMatch {
  fund: { stage: string; note: string; boards: { name: string; changePct: number; mainYi: number; rank: number }[] };
  relatedLeaders: string[];
  source: string;
}

function loadMap(): ThemeMapItem[] {
  return loadThemeMapFile().themes;
}

/** P3 增量链路要复用同一份映射表与文件指纹，故把读取动作单点暴露（不改任何判定逻辑） */
export function loadThemeMapFile(): { path: string; raw: string; themes: ThemeMapItem[] } {
  const p = join(process.cwd(), "data", "theme-chain-map.json");
  const raw = readFileSync(p, "utf8");
  const themes = (JSON.parse(raw) as { themes?: ThemeMapItem[] }).themes ?? [];
  return { path: p, raw, themes };
}

/** 映射表内容指纹：游标里的「未命中」记录只在映射表没变时才允许永久跳过 */
export function themeMapFingerprint(): string {
  return contentHash(loadThemeMapFile().raw);
}

function mergeBoards(a: BoardRow[] | null, b: BoardRow[] | null): BoardRow[] {
  const m = new Map<string, BoardRow>();
  for (const r of [...(a ?? []), ...(b ?? [])]) if (r.code && !m.has(r.code)) m.set(r.code, r);
  return [...m.values()].sort((x, y) => y.changePct - x.changePct);
}

function matchBoards(names: string[], boards: BoardRow[]): { name: string; changePct: number; mainYi: number; rank: number }[] {
  const hits: { name: string; changePct: number; mainYi: number; rank: number }[] = [];
  boards.forEach((b, i) => {
    if (names.some((n) => n && (b.name.includes(n) || n.includes(b.name)))) {
      hits.push({ name: b.name, changePct: b.changePct, mainYi: b.main, rank: i + 1 });
    }
  });
  return hits.slice(0, 5);
}

/** 板块资金榜（4 次请求合并去重）；全量与增量两条链路共用同一份实现 */
export async function fetchBoardContext(): Promise<{ boards: BoardRow[]; missing: string[] }> {
  const [indIn, indOut, cptIn, cptOut] = await Promise.all([
    fetchBoardReal("industry", "in", 60),
    fetchBoardReal("industry", "out", 40),
    fetchBoardReal("concept", "in", 60),
    fetchBoardReal("concept", "out", 40),
  ]);
  const boards = mergeBoards(mergeBoards(indIn, indOut), mergeBoards(cptIn, cptOut));
  const missing: string[] = [];
  if (!boards.length) missing.push("板块榜无返回，资金验证全部为「无资金验证」");
  return { boards, missing };
}

/**
 * 关键词映射 + 资金验证（逐条）。
 * 与重构前 scanGlobalEvents 的循环体逐字一致：同样的 classifyNewsTitle、同样的 themeId 判空即 unmatched、
 * 同样的 matchBoards/fundStage、同样的 relatedLeaders 取前 3、同样的 source 文案 —— 增量链路复用此函数，
 * 所以「只处理新增快讯」不会带来第二份映射实现，也就不会漂移。
 */
export function verifyNewsItems(
  news: { time: string; title: string }[],
  themes: ThemeMapItem[],
  boards: BoardRow[],
): { items: EventScanItem[]; unmatched: number } {
  const items: EventScanItem[] = [];
  let unmatched = 0;
  for (const n of news) {
    const m = classifyNewsTitle(n.title, n.time, themes);
    if (!m.themeId) { unmatched++; continue; }
    const names = [...m.mappedSectors, ...m.mappedConcepts];
    const boardHits = matchBoards(names, boards);
    const fs = fundStage({ boardHits });
    items.push({
      ...m,
      fund: { stage: fs.stage, note: fs.note, boards: boardHits },
      relatedLeaders: boardHits.map((b) => b.name).slice(0, 3),
      source: "东财7x24/新浪快讯 + 手工映射表 + 东财板块资金",
    });
  }
  return { items, unmatched };
}

/** 上游快讯窗口大小：全量与增量必须同源，故在此单点定义 */
export const NEWS_WINDOW = 24;

/** 快讯的最小字段形状（上游只给这两个字段，没有 id） */
export interface NewsLite { time: string; title: string }

/** 取上游快讯窗口；取不到就抛错，不允许静默当成「今天没有事件」 */
export async function collectNews(): Promise<NewsLite[]> {
  const news = await fetchNewsReal(NEWS_WINDOW);
  if (!news?.length) throw new Error("新闻源暂不可用（东财7x24/新浪均无返回）");
  return news.map((n) => ({ time: n.time, title: n.title }));
}

export interface BoardContext { boards: BoardRow[]; missing: string[] }

export async function scanGlobalEvents(opts?: { news?: NewsLite[]; boards?: BoardContext }): Promise<{
  as_of: string;
  trade_date: string;
  items: EventScanItem[];
  unmatched: number;
  missing: string[];
  source: string;
}> {
  const themes = loadMap();
  // 增量链路会传入「只有新增的那部分快讯」和「已经取过的板块榜」，其余口径与本函数完全一致
  const news = opts?.news ?? await collectNews();
  const { boards, missing } = opts?.boards ?? await fetchBoardContext();
  const { items, unmatched } = verifyNewsItems(news, themes, boards);

  return {
    as_of: shanghaiStamp(),
    trade_date: shanghaiDate(),
    items,
    unmatched,
    missing: [
      ...missing,
      "事件分级为关键词规则（未配置 AI 时不走 LLM）",
      "产业链映射来自 data/theme-chain-map.json 起步表，未覆盖的新闻不入库",
    ],
    source: "fetchNewsReal + theme-chain-map.json + fetchBoardReal",
  };
}
