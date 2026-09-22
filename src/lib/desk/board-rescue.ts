// P15-R8 板块榜兜底薄壳：fetchBoardReal + 同花顺整榜兜底的单点入口（判定全在 board-rescue-core 纯核）。
// 对话工具、Agent 台账、事件资金验证、研究采集、个股画像五处消费方都走这里——
// 入口只有一份，触发口径就不会在五个文件里各写一遍再各自漂移。
// em.ts 在不动清单里，BoardRow 未含 breakdownMissing，故返回形状用纯核的 RescueRow 扩展表达。
import { fetchBoardReal } from "@/lib/desk/em";
import { fetchThsBoards } from "@/lib/desk/ths";
import {
  needsThsRescue, pickThsSide, rescuableKind, boardRowsFromThs, boardRescueSourceNote,
  type RescueRow,
} from "@/lib/quant/screener/board-rescue-core";

export type { RescueRow } from "@/lib/quant/screener/board-rescue-core";
export { boardRowsFromThs, boardRescueSourceNote };

/**
 * 与 fetchBoardReal 同形状的取榜入口：东财（含其内部腾讯兜底）拿不到资金读数时，
 * 行业/概念整榜换同花顺资金流榜；个股/地域原样返回（无对等榜，缺就是缺）。
 * fromThs 让调用方把出身说清楚——同花顺行 main 是净额真数，但 ratio/superBig/big 是占位，
 * 引用这批行的文案必须换 source，不冒充东财主力资金口径。
 */
export async function fetchBoardRowsRescued(
  kind: "stock" | "industry" | "concept" | "region",
  dir: "in" | "out",
  size = 30,
): Promise<{ rows: RescueRow[] | null; fromThs: boolean }> {
  const rows = await fetchBoardReal(kind, dir, size);
  if (!rescuableKind(kind) || !needsThsRescue(rows)) return { rows: rows as RescueRow[] | null, fromThs: false };
  const ths = await fetchThsBoards(kind);
  const picked = pickThsSide(ths, dir, size);
  return picked.length ? { rows: picked, fromThs: true } : { rows: rows as RescueRow[] | null, fromThs: false };
}
