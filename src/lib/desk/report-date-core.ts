// 产业链研报 · 日期口径（纯函数，P63）
//
// 背景（用户拿稳智的研报页对比后要求「看看是他们的错了还是我们的错了」）：
// 两边的「交易观察日」都是 2026-09-24，**都是对的** —— 2026-09-25 是中秋节休市、09-26 周六、
// 09-27 周日，最后一个交易日就是 09-24。真正错的是我们自己的表述：
// 研报日取的是复盘统计种子的覆盖终点（range.to，当前冻结在 09-24，种子不续写它就永远停在 09-24），
// 页面上却把它说成「最新交易日」—— 那是拿一个会过期的数冒充实时日历。
//
// 所以这里把两个人数分开收：
//   · dataEnd    = 复盘统计数据止于哪天（正文里的读数只到这天，研报就得按这天归档）
//   · marketDay  = 行情源给的最近交易日（会跟着日历往前走；fromCalendar=true 时它只是工作日推算，不可信）
// 两者一致才允许出现「最新交易日」这个说法；不一致就照实说「数据止于 X」。

export interface ReportDayInput {
  /** 复盘统计覆盖终点（/api/market/review-stats 的 range.to） */
  dataEnd: string;
  /** 行情源最近交易日（/api/market/trade-date 的 tradeDate） */
  marketDay: string;
  /** marketDay 是行情源给的，还是本地日历按工作日推算的（推算值不能用来宣称"最新交易日"） */
  marketFromCalendar: boolean;
  /** 本机日历日（上海时区） */
  today: string;
}

export interface ReportDayCaliber {
  /** 研报正文归属的交易日：标题、留档键、按钮文案都走它 */
  day: string;
  /** 元信息行「交易观察日」后面那句口径说明 */
  note: string;
  /** 页顶黄色提示条；不需要提示时为空串 */
  banner: string;
  /** 今天是不是研报日（决定按钮写「今日研报」还是「X 研报」） */
  isTradingToday: boolean;
  /** 有没有资格说「最新交易日」 */
  canClaimLatest: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ok = (d: string) => DATE_RE.test(d);

export function reportDayCaliber(input: ReportDayInput): ReportDayCaliber {
  const dataEnd = ok(input.dataEnd) ? input.dataEnd : "";
  const marketDay = ok(input.marketDay) ? input.marketDay : "";
  const today = input.today;
  const day = dataEnd || marketDay || today;
  const isTradingToday = day === today;
  // 行情源可信，且和种子终点同一天 —— 这时"数据止于的那天"就是"最新交易日"，两话说得通
  const reliableMarket = !!marketDay && !input.marketFromCalendar;
  const canClaimLatest = !!dataEnd && reliableMarket && dataEnd === marketDay;

  if (!dataEnd && !marketDay) {
    return { day, note: "口径待确认", banner: "", isTradingToday, canClaimLatest: false };
  }
  if (canClaimLatest) {
    return {
      day,
      note: "即最新交易日",
      banner: isTradingToday ? "" : `今日休市（${today}），研报按最新交易日 ${dataEnd} 归档。`,
      isTradingToday,
      canClaimLatest: true,
    };
  }
  // 可信行情源比种子终点更新 → 种子落后。研报正文的数还是旧那天那一套，不能拿更新的交易日命名，
  // 否则又是一份「标题写新一天、内容还是老数据」的错日报（这正是当初引入交易日口径要防的事）。
  // 注意 reliableMarket：日历推算出的 09-25（中秋）不算数，不能拿来当"行情已往前走"的证据。
  if (dataEnd && reliableMarket && marketDay > dataEnd) {
    return {
      day,
      note: `复盘统计数据止于 ${dataEnd}`,
      banner: `复盘统计数据止于 ${dataEnd}，行情源最近交易日已是 ${marketDay}。`
        + `研报按数据覆盖的那天归档；等本地回填把种子续到 ${marketDay} 再点生成，才是那份新的研报。`,
      isTradingToday,
      canClaimLatest: false,
    };
  }
  // 行情源问不到（网关和腾讯都没通）或只给出工作日推算：只用种子终点，且不提"最新交易日"
  return {
    day,
    note: `复盘统计数据止于 ${dataEnd || marketDay}`,
    banner: isTradingToday
      ? ""
      : `今天（${today}）没有行情数据，研报按复盘数据止于的 ${dataEnd || marketDay} 归档。`
        + "（行情源未接通，这次不宣称『最新交易日』。）",
    isTradingToday,
    canClaimLatest: false,
  };
}
