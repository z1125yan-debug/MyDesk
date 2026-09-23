// P15-R18 快讯翻页纯核：把「一天到底有多少条快讯、什么时候该停止翻页」这件事的判定收在零依赖纯函数里。
//
// 为什么要单独一层：事件雷达以前只取上游最新 24 条（NEWS_WINDOW=24），而东财 7x24 实测一小时就发几十条
// ——一次日内扫描看得见的时间跨度只有约 20 分钟，一天下来库里自然只剩一两条事件。修法是照 realSort
// 游标往前翻页翻到跨日为止，但「翻页翻到哪算完」不能让 IO 层自己拍脑袋，所以判定放这里、请求放 em.ts。
//
// 纪律与仓库其它 core 层一致：不 import React、不发请求、不读时间以外的外部状态——
// 目标交易日由调用方传进来（服务端 shanghaiDate()），这里只做字符串比较。
// 认不出的时间戳一律按「不属于目标日」丢掉并计数，不猜它是哪天的。

/** 东财 7x24 快讯的单行原样字段（上游只给这些；code 是该条的稳定标识） */
export interface NewsRawRow {
  code: string;
  showTime: string; // "2026-09-23 13:34:41"（已是北京时区，不做二次换算）
  realSort: string; // 翻页游标：比 showTime 更细的排序键，末行的它就是下一页的 sortEnd
  title: string;
}

/** 快讯的最小输出形状（事件扫描层只吃这两个字段，与旧 NewsItem 口径一致） */
export interface NewsLiteRow {
  time: string; // "HH:MM"
  title: string;
}

/** 单页条数：上游实测 pageSize=100/200 都照给，取 100 是为了「不足一页即到底」这个判据干净 */
export const NEWS_PAGE_SIZE = 100;

/**
 * 翻页上限：一个交易日的 7x24 全球栏实测约 400~500 条（total=5000 是含往日的池子），
 * 8 页 = 800 条足够翻到跨日；上限存在的意义是上游游标坏掉（反复回同一页）时不无限循环。
 */
export const NEWS_MAX_PAGES = 8;

/** showTime 的日期位；形状不认就返回 ""（空串＝这条不进窗口，也不猜） */
export function newsDateOf(showTime: string): string {
  const s = String(showTime ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

/** showTime 的时分位；同样认不出给 ""，由上层计入 dropped */
export function newsClockOf(showTime: string): string {
  const s = String(showTime ?? "").trim();
  return /\d{2}:\d{2}/.test(s) ? s.slice(11, 16) : "";
}

/** 这一页末行的游标（= 下一页的 sortEnd）；空页给 ""，调用方据此停 */
export function lastCursor(rows: NewsRawRow[]): string {
  const last = rows[rows.length - 1];
  return String(last?.realSort ?? "").trim();
}

/**
 * 还要不要往前翻：
 * - 不满一页 → 上游到底了，停（不再多打一次空请求）；
 * - 末行已经不是目标交易日 → 跨到昨天了，当日窗口翻完，停；
 * - 其余（整页且末行仍是当天）→ 继续。
 */
export function shouldFetchMore(rows: NewsRawRow[], tradeDate: string): boolean {
  if (!rows.length || rows.length < NEWS_PAGE_SIZE) return false;
  const lastDate = newsDateOf(rows[rows.length - 1].showTime);
  return lastDate === tradeDate;
}

export interface NewsWindowResult {
  /** 目标交易日内、按上游给定顺序（新→旧）去重后的快讯 */
  items: NewsLiteRow[];
  /** 翻到的原始行数（含被丢掉的），用于如实说明「窗口到底看了多少条」 */
  fetchedRows: number;
  /** 因为不属于目标交易日而未进窗口的条数（翻页必然越界一次，这个数不是异常） */
  offDay: number;
  /** 跨页撞 code 被合并的条数（上游翻页有重叠，不合并就是同一事件入库两行） */
  duplicated: number;
  /** 时间戳/标题认不出、不猜所以丢弃的条数 */
  dropped: number;
}

/**
 * 把逐页拿到的原始行收成「目标交易日窗口」：同日过滤 → code 去重（留最先见到的，即最新一条）
 * → 坏行丢弃并分别计数。计数一并返回，页面/日志要说「看了 480 条、其中当日 452 条」时不用再算一遍。
 */
export function pickNewsWindow(pages: NewsRawRow[][], tradeDate: string): NewsWindowResult {
  const seen = new Set<string>();
  const items: NewsLiteRow[] = [];
  let fetchedRows = 0;
  let offDay = 0;
  let duplicated = 0;
  let dropped = 0;
  for (const rows of pages) {
    for (const r of rows) {
      fetchedRows++;
      const title = String(r?.title ?? "").trim();
      const date = newsDateOf(r?.showTime ?? "");
      if (!title || !date) {
        dropped++; // 没有标题就没法映射，日期认不出就不敢算进当天——丢掉但计数，不静默
        continue;
      }
      if (date !== tradeDate) {
        offDay++;
        continue;
      }
      const code = String(r?.code ?? "").trim();
      const key = code || `${date}|${newsClockOf(r.showTime)}|${title}`; // 没给 code 就退回「同日同时刻同标题」，仍是一眼可辨的原文键
      if (seen.has(key)) {
        duplicated++;
        continue;
      }
      seen.add(key);
      const time = newsClockOf(r.showTime);
      if (!time) {
        dropped++;
        continue;
      }
      items.push({ time, title });
    }
  }
  return { items, fetchedRows, offDay, duplicated, dropped };
}
