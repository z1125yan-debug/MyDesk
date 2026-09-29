// 菜单页 → 首屏只读接口（声明式预取表）。
//
// 为什么需要这张表（2026-09-29 用户：「优化一下所有菜单打开的缓存」）：
//   api-cache 的自学习表只记「访问过哪一页、用过哪些接口」——于是**每个菜单项的第一次点击**
//   必然是冷的（实测首屏接口冷启动 1.3~9 秒：数据看板 5.6s、事件 6.5s、因子矩阵 9.0s）。
//   有了声明表，鼠标悬停时就能预取，更进一步：进站空闲后按这张表把所有菜单页都预热一遍，
//   之后点哪个菜单都是「点开即有内容」。
//
// 口径纪律：
//   · 只列**首屏一定会打、且可以安全重复拉**的只读 GET；
//   · 参数必须写页面真实用的默认值——SWR 的缓存键是「路径+query」全串，参数对不上就等于没预热；
//   · 按个股/搜索词变化的（/api/market/quote?symbols=、/api/market/search、/api/market/kline）不列；
//   · POST（选股筛选、AI 对话）不列——预取只针对 GET。

import type { PageKey } from "./types";

export const PAGE_ENDPOINTS: Partial<Record<PageKey, string[]>> = {
  // 大盘情绪：四卡（sentiment）+ 连板梯队（limitup，实时轮询）+ 历史图（trend/review/breadth）
  market: [
    "/api/market/sentiment",
    "/api/market/limitup",
    "/api/market/trend",
    "/api/market/review-stats",
    "/api/market/breadth?days=30&scope=all_markets",
  ],
  // 量化因子选股：因子目录 + 社区策略库 + 交易日选择器
  aiscreener: [
    "/api/quant/factors?catalog=1",
    "/api/quant/strategy-library?limit=2000",
    "/api/quant/screener/trade-dates",
  ],
  // 行业榜（默认行业 Tab）
  sectors: ["/api/market/sectors?kind=industry", "/api/market/sentiment"],
  // 行情组
  allstocks: ["/api/market/allstocks?page=1&page_size=50&order_by=amount_yi&dir=desc"],
  board: ["/api/market/board?kind=industry&dir=in", "/api/market/board?kind=industry&dir=out"],
  risk: ["/api/market/risk"],
  history: ["/api/quant/screener/trade-dates"],
  // 事件雷达
  events: ["/api/events", "/api/events/history"],
  // LLM分析门户（主题热点 + 研究池首屏）
  llmportal: ["/api/market/themes", "/api/events", "/api/market/limitup", "/api/pool/list"],
  // 板块风险（跨市场资金 + 见顶风险扫描）
  sectortop: ["/api/market/sectors/cross-market", "/api/market/sectors/top-risk"],
  // 血亲子页（hash 直达，但菜单悬停/空闲预热一样吃这张表）
  themes: ["/api/market/themes", "/api/market/sentiment"],
  themeoverview: ["/api/market/themes", "/api/market/risk", "/api/events"],
  dashboard: ["/api/market/sentiment"],
  // 研究/因子/条件概率
  pool: ["/api/pool/list"],
  radar: ["/api/radar"],
  // 实验台只预取因子目录：factor-test 是「跑完测试立刻要看新结果」的产物，不预取不进缓存
  factorlab: ["/api/quant/factors?catalog=1"],
  problab: ["/api/quant/screener/trade-dates"],
  quant: ["/api/pool/list", "/api/market/themes"],
  research: ["/api/market/risk", "/api/market/themes", "/api/radar", "/api/events"],
  settings: ["/api/llm/config"],
};

/** 该页声明的首屏接口（没有声明就返回空数组——不猜、不编 URL） */
export function endpointsForPage(page: string): string[] {
  return PAGE_ENDPOINTS[page as PageKey] ?? [];
}

/**
 * 空闲预热的顺序：按「用户最可能先点」排，重的往后放，避免进站就把上游打满。
 * 只列主菜单一级项（隐藏页不排——它们大多从对话/链接进来）。
 */
export const IDLE_PREFETCH_ORDER: PageKey[] = [
  "market", "sectors", "aiscreener", "allstocks", "board",
  "events", "llmportal", "sectortop",
];
