// 日/周/月K 磁盘缓存的有效性判定（纯核，node:test 直跑；em.ts 接线）。
//
// P67 体检红线 #1：旧规则「按自然日整天有效」在交易日会把当天**末根**K线冻结在
// 第一次抓取的值（em.ts 自己的注释都承认「只有末根在盘内变化」），且无任何标注——
// 旧数冒充现价。今天盘里抓的和 10 点抓的、盘前抓的，谁都不能替谁。
//
// 规则（宁多抓一次，不说谎）：
// - 跨自然日 → 失效（不变）。
// - 非交易日（节假日/周末）：上游整天无新数据，当天写的档整天可信（防限流的原意保留）。
// - 交易日：只有**收盘后写入**（at ≥ 收盘时刻）的档当天才可信；
//   盘中/盘前写的档一律回源重抓——盘前写的末根还是昨收，盘中写的末根随时会变。
export interface KlineDiskRaw {
  at?: number;
  day?: string;
}

export interface KlineDiskNow {
  /** 今天（北京时间 YYYY-MM-DD，shanghaiDate()） */
  today: string;
  /** 当前时刻 epoch ms */
  nowMs: number;
  /** 今天是否交易日（todayIsTradingDaySync()，判不出保守按工作日=true → 走更严的规则） */
  tradingDay: boolean;
  /** 今天收盘时刻 epoch ms（含集合竞价收尾的余量，接线方给 15:05） */
  closeMs: number;
}

export function klineDiskUsable(raw: KlineDiskRaw, now: KlineDiskNow): boolean {
  if (raw.day !== now.today) return false;
  if (!now.tradingDay) return true;
  return typeof raw.at === "number" && raw.at >= now.closeMs;
}
