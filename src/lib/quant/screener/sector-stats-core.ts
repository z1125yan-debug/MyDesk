// P12 板块统计行纯核：把板块/概念榜单聚合成 5 个卡片数字（总榜数/平均涨跌幅/上涨板块数/下跌板块数/主力净额合计）。
// 零 IO、node --test 可直跑——与情绪温度纯核同一套纪律：缺读数就是 null，绝不拿占位 0 求和。
//
// 两条口径说明（对齐稳智《行业板块页》统计行，但以我们真实有的读数为准）：
//  * 稳智原文的「总上涨家数/总下跌家数」是板块内个股家数（up_count/down_count），
//    现有 fetchBoardReal 封装不含板块广度字段（榜单 missing 已列明）——这里改用
//    「上涨/下跌板块数」替代，同为 0 基数的广度口径，界面文案必须写「板块」不写「个股」，不冒充原口径。
//  * 腾讯板块兜底榜的 main/ratio 等是占位 0（fundsMissing 标记）：只要榜上混进一条占位行，
//    主力合计就整体不可信 ⇒ mainSumYi=null，页面显「—」。半真半假的合计比没有合计更坏。

export interface SectorAggRow {
  changePct: number;
  /** 主力净额（亿）；fundsMissing 的行该值是占位 0，不可入合计 */
  main: number;
  fundsMissing?: boolean;
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
  /** mainSumYi 为 null 时为什么（页面 tooltip/副行用；可算时为空串） */
  mainMissingNote: string;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;

export function aggregateSectors(rows: SectorAggRow[]): SectorStats {
  const count = rows.length;
  if (!count) {
    return { count: 0, avgChangePct: null, upBoards: 0, downBoards: 0, mainSumYi: null, mainMissingNote: "榜单为空，没有任何可聚合的读数" };
  }
  const avgChangePct = r1(rows.reduce((a, r) => a + r.changePct, 0) / count);
  const upBoards = rows.filter((r) => r.changePct > 0).length;
  const downBoards = rows.filter((r) => r.changePct < 0).length;
  const placeholder = rows.filter((r) => r.fundsMissing).length;
  const mainSumYi = placeholder ? null : r1(rows.reduce((a, r) => a + r.main, 0));
  const mainMissingNote = placeholder
    ? `榜上 ${placeholder}/${count} 条来自腾讯兜底榜（涨幅口径，主力资金为占位 0）——半真半假的合计不如不给，此项显「—」`
    : "";
  return { count, avgChangePct, upBoards, downBoards, mainSumYi, mainMissingNote };
}
