// P12 板块统计行纯核：把板块/概念榜单聚合成 5 个卡片数字（总榜数/平均涨跌幅/上涨板块数/下跌板块数/主力净额合计）。
// 零 IO、node --test 可直跑——与情绪温度纯核同一套纪律：缺读数就是 null，绝不拿占位 0 求和。
//
// 两条口径说明（对齐稳智《行业板块页》统计行，但以我们真实有的读数为准）：
//  * 稳智原文的「总上涨家数/总下跌家数」是板块内个股家数（up_count/down_count）。
//    MCP get_stock_board_industry_summary 取到板块广度时，这里就按**个股口径**真实求和（upStocks/downStocks）；
//    取不到才回落板块条数（upBoards/downBoards），两者不许混着叫——界面文案必须跟着实际口径走。
//  * 腾讯板块兜底榜的 main/ratio 等是占位 0（fundsMissing 标记）：只要榜上混进一条占位行，
//    主力合计就整体不可信 ⇒ mainSumYi=null，页面显「—」。半真半假的合计比没有合计更坏。

export interface SectorAggRow {
  changePct: number;
  /** 主力净额（亿）；fundsMissing 的行该值是占位 0，不可入合计 */
  main: number;
  fundsMissing?: boolean;
  /** 板块内上涨/下跌家数（MCP 板块汇总口径）；取不到为 null —— 不参与求和也不冒充 0 */
  up_count?: number | null;
  down_count?: number | null;
  /** 板块内涨停家数（本地涨停池 × 行业映射） */
  limit_up_count?: number | null;
}

export interface SectorStats {
  /** 榜单条数（去重后的榜内板块数——不是全市场板块总数，口径由界面文案交代） */
  count: number;
  /** 平均涨跌幅 %（榜内截面）；空榜 null */
  avgChangePct: number | null;
  /** 上涨板块数（changePct > 0，板块口径非个股口径） */
  upBoards: number;
  /** 下跌板块数（changePct < 0）；平盘两边都不计 */
  downBoards: number;
  /** 主力净额合计（亿）；混入占位 0 行或空榜时 null */
  mainSumYi: number | null;
  /** 总上涨家数（个股口径 = Σ up_count）；没有任何一条板块广度时 null */
  upStocks: number | null;
  /** 总下跌家数（个股口径 = Σ down_count）；同上 */
  downStocks: number | null;
  /** 总涨停家数（Σ limit_up_count）；同上 */
  limitUpStocks: number | null;
  /** 有多少条榜行真的带上了板块广度（用来交代「这个家数覆盖了几个板块」） */
  breadthBoards: number;
  /** mainSumYi 为 null 时为什么（页面 tooltip/副行用；可算时为空串） */
  mainMissingNote: string;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;

export function aggregateSectors(rows: SectorAggRow[]): SectorStats {
  const count = rows.length;
  if (!count) {
    return { count: 0, avgChangePct: null, upBoards: 0, downBoards: 0, mainSumYi: null, mainMissingNote: "榜单为空，没有任何可聚合的读数", upStocks: null, downStocks: null, limitUpStocks: null, breadthBoards: 0 };
  }
  const avgChangePct = r1(rows.reduce((a, r) => a + r.changePct, 0) / count);
  const upBoards = rows.filter((r) => r.changePct > 0).length;
  const downBoards = rows.filter((r) => r.changePct < 0).length;
  const placeholder = rows.filter((r) => r.fundsMissing).length;
  const mainSumYi = placeholder ? null : r1(rows.reduce((a, r) => a + r.main, 0));
  const mainMissingNote = placeholder
    ? `榜上 ${placeholder}/${count} 条来自腾讯兜底榜（涨幅口径，主力资金为占位 0）——半真半假的合计不如不给，此项显「—」`
    : "";
  // 个股口径的家数：只对**真有广度读数**的榜行求和，缺的板块不按 0 计入——
  // 按 0 计就是把「没取到」说成「这家数就是 0」，与本项目补 0 冒充的老毛病同源。
  const breadthBoards = rows.filter((r) => r.up_count != null || r.down_count != null).length;
  const sum = (pick: (r: SectorAggRow) => number | null | undefined): number | null => {
    if (!breadthBoards) return null;
    let n = 0;
    for (const r of rows) n += pick(r) ?? 0;
    return n;
  };
  const luBoards = rows.filter((r) => r.limit_up_count != null).length;
  return {
    count, avgChangePct, upBoards, downBoards, mainSumYi, mainMissingNote,
    upStocks: sum((r) => r.up_count),
    downStocks: sum((r) => r.down_count),
    limitUpStocks: luBoards ? rows.reduce((a, r) => a + (r.limit_up_count ?? 0), 0) : null,
    breadthBoards,
  };
}
