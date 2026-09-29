// 链研究二阶段预取的**服务层事实注入**（Serenity 落点 A，2026-09-29）。
//
// 为什么单独一层：判定必须留在纯核（intent-core.chainFollowUpCalls，可 node --test 直跑），
// 但「本地行业归属快照认得哪些行业名」是**事实**（要读 data/sector-constituents.json 才知道），
// 纯层不查字典、不猜名字。这里只做「读事实 → 递给纯核」，与 stock-news.resolveStockName
// （把东财搜索结果当事实递给 classifyIntent 的 nameHits）是同一条纪律：
//  - 本层不写任何判定（判什么由纯核决定）；
//  - 事实读不到（快照缺失）时给空集，纯核据此不启用行业名那条路——宁可少取一步，也不拿本地没有的名字去凑。
//
// 放 desk 层而不是直接让 scene-dispatch 引量化取数层：scene-dispatch 是「不写判定、不引别的量化依赖」的接线层
// （tests/quant/p7-dispatch.test.ts「分层不破」钉着这条），事实注入统一落到本模块。
import { chainFollowUpCalls, type DispatchCall } from "./intent-core";
import { industryNames } from "@/lib/quant/data/industry-constituents";

/**
 * 算出链研究问法的第二棒（顺榜首板块追一层成分股）。
 * @param firstRound 第一棒的原始取数结果（含 sector_rank 的榜单）
 * @param question   本轮用户原话
 */
export function planChainFollowUps(
  firstRound: { tool: string; out: unknown }[],
  question: string,
): DispatchCall[] {
  // industryNames() 读不到快照时返回 []：纯核看到空集不会启用同花顺行业名那条路（不算故障）
  return chainFollowUpCalls(firstRound, question, industryNames());
}
