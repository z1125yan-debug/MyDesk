// P15-R8 板块榜兜底薄壳：fetchBoardReal + 同花顺整榜兜底 + MCP 板块资金流榜三级兜底。
// 对话工具、Agent 台账、事件资金验证、研究采集、个股画像五处消费方都走这里。
import { fetchBoardReal } from "@/lib/desk/em";
import { fetchThsBoards } from "@/lib/desk/ths";
import { fetchMcpIndustryBoard, type McpBoardRow } from "@/lib/quant/data/mcp-provider";
import {
  needsThsRescue, pickThsSide, rescuableKind, boardRowsFromThs, boardRescueSourceNote,
  type RescueRow,
} from "@/lib/quant/screener/board-rescue-core";

export type { RescueRow } from "@/lib/quant/screener/board-rescue-core";
export { boardRowsFromThs, boardRescueSourceNote };

export interface BoardFetchResult {
  rows: RescueRow[] | null;
  fromThs: boolean;
  /** 出身：em / ths / mcp / none（供上层文案如实标注） */
  origin: "em" | "ths" | "mcp" | "none";
}

/** MCP 板块榜 → RescueRow 转换：MCP 无主力净额/净占比/超大单/大单拆分 ⇒ fundsMissing + breakdownMissing 全标 true */
function mcpToRescueRows(rows: McpBoardRow[]): RescueRow[] {
  return rows.map((r) => ({
    code: r.code ?? "",
    secid: "",
    name: r.name ?? "",
    changePct: r.changePct ?? 0,
    main: 0,        // MCP 板块榜当前无主力净额口径
    ratio: 0,
    superBig: 0,
    big: 0,
    leader: r.leader ?? "",
    fundsMissing: true,       // 无净额/占比/超大单/大单
    breakdownMissing: true,   // 无超大单/大单拆分
    origin: "mcp",
  }));
}

/**
 * 与 fetchBoardReal 同形状的取榜入口：三级兜底（东财→同花顺→MCP）。
 * origin 让调用方把出身说清楚——不同来源净额口径不同，source 文案必须如实分标。
 */
export async function fetchBoardRowsRescued(
  kind: "stock" | "industry" | "concept" | "region",
  dir: "in" | "out",
  size = 30,
): Promise<{ rows: RescueRow[] | null; fromThs: boolean }> {
  return fetchBoardRowsRescuedV2(kind, dir, size);
}

/** 完整版（暴露 origin 给上层用） */
export async function fetchBoardRowsRescuedV2(
  kind: "stock" | "industry" | "concept" | "region",
  dir: "in" | "out",
  size = 30,
): Promise<BoardFetchResult> {
  const rows = await fetchBoardReal(kind, dir, size);
  if (!rescuableKind(kind)) {
    return { rows: rows as RescueRow[] | null, fromThs: false, origin: rows ? "em" : "none" };
  }
  if (!needsThsRescue(rows)) {
    return { rows: rows as RescueRow[] | null, fromThs: false, origin: "em" };
  }
  // 二级：同花顺
  const ths = await fetchThsBoards(kind);
  const picked = pickThsSide(ths, dir, size);
  if (picked.length) return { rows: picked, fromThs: true, origin: "ths" };

  // 三级：MCP 板块资金流榜（仅行业榜适用，MCP 无概念榜）
  if (kind === "industry") {
    const mcpRes = await fetchMcpIndustryBoard();
    if (mcpRes && mcpRes.data.length > 0) {
      // MCP 榜按涨跌幅已排序；dir="in" 取涨幅前 N，dir="out" 取跌幅后 N
      const sorted = [...mcpRes.data].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
      const slice = dir === "in" ? sorted.slice(0, size) : sorted.slice(-size).reverse();
      if (slice.length > 0) return { rows: mcpToRescueRows(slice), fromThs: false, origin: "mcp" };
    }
  }

  return { rows: rows as RescueRow[] | null, fromThs: false, origin: "none" };
}
