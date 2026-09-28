// R20 主力净额「该显示哪个数」——纯核，三个页面共用同一套取舍。
//
// R21 改口径：**通达信为主源**。
// 为什么换：全 A 快照那个 mainNet 字段长期不返回（known 恒为 0），每次都先试它再退通达信，
// 等于每个页面都多念一遍「某家数据源断了」——用户要的是数，不是上游故障播报。
// 通达信是直连交易所行情服务器的当日逐笔自算，稳定可得，所以定为主源；
// 全 A 快照只在通达信也没数时才兜底（它覆盖全 A，比前 N 只广）。
// 主源也不是全 A：只覆盖成交额前 N 只，所以卡面恒显「前 N 只自算」，不冒充全市场合计。

export interface MainNetTdxClient {
  sum_yi: number | null;
  known: number;
  universe: number;
  complete: number;
  amount_yi: number;
  as_of: string;
  basis: string;
  note: string;
}

export interface SentimentMainNetLike {
  main_net_sum_yi: number;
  main_net_known: number;
  main_net_tdx?: MainNetTdxClient | null;
}

export interface MainNetDisplay {
  /** 要显示的净额（亿） */
  value: number;
  /** 卡面上的短标注（说明这个数覆盖多大范围） */
  label: string;
  /** hover 长说明（口径与出身） */
  hint: string;
  /** 这个数是自算出来的（页面应当显式标「自算」） */
  selfComputed: boolean;
}

/**
 * 返回 null = 两个源都没有可信读数，页面显示「—」，**不要显示 0 亿**。
 * 取舍顺序：全 A 快照真有数就用它（覆盖最广）；否则退回自算子集（如实标注范围）。
 */
export function mainNetDisplay(s: SentimentMainNetLike | null | undefined): MainNetDisplay | null {
  if (!s) return null;
  // ① 通达信当日逐笔自算（主源：稳定可得，但只覆盖成交额前 N 只）
  const t = s.main_net_tdx;
  if (t && typeof t.sum_yi === "number" && isFinite(t.sum_yi)) {
    return {
      value: t.sum_yi,
      label: `前 ${t.universe} 只自算`,
      hint: `${t.note}；口径：${t.basis}`,
      selfComputed: true,
    };
  }
  // ② 全 A 快照（唯一覆盖全 A 的口径；拿不到就当它不存在，不播报上游状态）
  if (typeof s.main_net_known === "number" && s.main_net_known > 0) {
    return {
      value: s.main_net_sum_yi,
      label: `全A ${s.main_net_known} 家`,
      hint: `全 A 快照里带主力净额字段的 ${s.main_net_known} 家的合计`,
      selfComputed: false,
    };
  }
  return null;
}
