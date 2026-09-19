import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchNewsReal, fetchBoardReal, type BoardRow } from "@/lib/desk/em";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import {
  classifyNewsTitle, fundStage, type ThemeMapItem, type EventMatch,
} from "./events-rules.ts";

export interface EventScanItem extends EventMatch {
  fund: { stage: string; note: string; boards: { name: string; changePct: number; mainYi: number; rank: number }[] };
  relatedLeaders: string[];
  source: string;
}

function loadMap(): ThemeMapItem[] {
  const p = join(process.cwd(), "data", "theme-chain-map.json");
  const raw = JSON.parse(readFileSync(p, "utf8")) as { themes: ThemeMapItem[] };
  return raw.themes ?? [];
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

export async function scanGlobalEvents(): Promise<{
  as_of: string;
  trade_date: string;
  items: EventScanItem[];
  unmatched: number;
  missing: string[];
  source: string;
}> {
  const themes = loadMap();
  const news = await fetchNewsReal(24);
  if (!news?.length) throw new Error("新闻源暂不可用（东财7x24/新浪均无返回）");

  const [indIn, indOut, cptIn, cptOut] = await Promise.all([
    fetchBoardReal("industry", "in", 60),
    fetchBoardReal("industry", "out", 40),
    fetchBoardReal("concept", "in", 60),
    fetchBoardReal("concept", "out", 40),
  ]);
  const boards = mergeBoards(mergeBoards(indIn, indOut), mergeBoards(cptIn, cptOut));
  const missing: string[] = [];
  if (!boards.length) missing.push("板块榜无返回，资金验证全部为「无资金验证」");

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
