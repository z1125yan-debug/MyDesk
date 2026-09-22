// P15-R8 板块榜兜底收口纯核：fetchBoardReal 的其余消费方（对话工具/Agent 台账/事件资金验证/
// 研究采集/个股画像）过去各自吊在东财 push2 上——断源日要么整块「无数据」，要么把腾讯兜底榜的
// 占位 0 当「主力净额 0.00 亿」报出去。本文件把「要不要换同花顺、换过去取哪一侧」做成零 IO 纯核，
// 与 sector-stats-core/ths 同一套纪律：判定可 node --test 直跑，IO 只在 desk/board-rescue.ts 薄壳里。
//
// 触发口径与 R6/R7 完全一致（同一把尺子量所有入口，不允许多套规则并存）：
//   该侧无返回（null/空数组）或 整榜都是腾讯占位 0（每行 fundsMissing）⇒ 整榜换同花顺；
//   东财正常 ⇒ 原样返回，一行数字都不碰。
// 同花顺侧的诚实约束：只有净额（流入−流出），无净占比/超大单/大单拆分 ⇒ breakdownMissing；
// 代码带 THS 前缀且 secid 留空 ⇒ 东财日K/成分池/资金明细递棒自然断掉，绝不跨系错接。

import type { BoardRow } from "@/lib/desk/em";
import type { ThsBoardRow } from "@/lib/desk/ths";

// em.ts 在不动清单里，BoardRow 不加字段——同花顺行的额外标记在本纯核侧扩展表达。
export interface RescueRow extends BoardRow {
  /** 同花顺资金流兜底榜（R8）：main 是净额真数，但 ratio/superBig/big 无对等拆分 ⇒ 消费方显「—」不报 0 */
  breakdownMissing?: boolean;
}

/** 同花顺原始行 → 板块榜行（对话/台账/事件验证用的形状与页面 RankRow 同构） */
export function thsToBoardRow(r: ThsBoardRow): RescueRow {
  return {
    code: r.code,
    secid: "",
    name: r.name,
    changePct: r.changePct,
    main: r.netYi,
    ratio: 0,
    superBig: 0,
    big: 0,
    leader: r.leader,
    breakdownMissing: true,
  };
}

/** 是否需要兜底：无返回，或整榜只剩腾讯占位 0（混榜不误伤，东财真数行优先） */
export function needsThsRescue(rows: { fundsMissing?: boolean }[] | null | undefined): boolean {
  return !rows || !rows.length || rows.every((r) => r.fundsMissing);
}

/** 只有行业/概念有同花顺对等榜；个股/地域维持「缺就是缺」，不硬造 */
export function rescuableKind(kind: string): kind is "industry" | "concept" {
  return kind === "industry" || kind === "concept";
}

/** 榜按涨幅序取，页面上分「流入/流出」两向：同花顺侧按净额正负拆（0 行是真没有，不补 0） */
export function pickThsSide(ths: ThsBoardRow[], dir: "in" | "out", size: number): RescueRow[] {
  return (dir === "in"
    ? ths.filter((r) => r.netYi > 0).sort((a, b) => b.netYi - a.netYi)
    : ths.filter((r) => r.netYi < 0).sort((a, b) => a.netYi - b.netYi)
  ).slice(0, size).map(thsToBoardRow);
}

/** 出身一句话：出现在所有引用该榜的文案/台账 source 字段里，不冒充东财口径 */
export function boardRescueSourceNote(kind: "industry" | "concept"): string {
  return `同花顺${kind === "concept" ? "概念" : "行业"}资金流榜（东财断源时的独立兜底；净额=流入−流出，无净占比/超大单/大单拆分；榜按涨幅排序取，深跌净流出的板块可能不在榜）`;
}

/** 混入同花顺榜后整榜出身判定：只要有一行是 THS 前缀码，这批行就不是纯东财数 */
export function boardRowsFromThs(rows: { code: string }[] | null | undefined): boolean {
  return (rows ?? []).some((r) => r.code.startsWith("THS"));
}
