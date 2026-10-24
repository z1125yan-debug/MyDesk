// 非交易日瘦身版早报 · 新增节（用户 2026-10-17 批准）。
//
// 1. 下周大事日历：日期全部经公开源核实（见文件内来源标注），核实不了的写“没取到”，不编。
//    日历只核实了 2026-10-19~10-25 这一周；issueDate 不在该周末窗口时返回“没取到”，
//    绝不把上周的日历当下周的日历。
// 2. 周末政策面：财联社电报按政策关键词过滤，只取周五（2026-10-16）收盘后至今；没有写“暂无”。
// 3. 大宗商品 + 汇率 + 比特币：Yahoo Finance 公开行情（免费，无 Key），取不到的品种写 NULL。
// 4. 周末公司公告（2026-10-17 新增）：巨潮公告，上一交易日收盘后至今，只留停牌 / 重大事项 /
//    业绩预告类；跟“周末政策面”不重复（那个是政策，这个是公司）。
// 5. 港股周五收盘 + AH 溢价（2026-10-17 新增）：Yahoo 公开行情 ^HSI + ^HSCE；AH 溢价指数
//    在公开免费源里无实时值（长桥 quote 不返回指数、Yahoo 无该代码、腾讯无该代码、新浪被禁、
//    东财自 VM 拉不到），写 NULL 不编。
// 每条新闻后追加“解读：方向——原因”（news-interpret.ts 关键词规则，看不懂写“不明确”）。
// 不做卖出提醒（用户明确说暂时不做），本文件不含任何卖出相关内容。

import {
  clsFullTitleOf,
  clsShanghaiShowTime,
  fetchClsTelegraphPage,
  type ClsRollItem,
} from "./cls-telegraph";
import { fetchCninfoDayAnnouncements } from "./cninfo";
import { interpretNewsTitle } from "./news-interpret";
import { isTradingDay } from "./trade-calendar";

/** 下周大事日历（纯函数，无 IO）：只服务已核实的一周 2026-10-19~10-25。 */
export function buildNextWeekCalendar(issueDate: string): string {
  // 本周末窗口：周六 10-17 / 周日 10-18 发的瘦身早报看的是下周 10-19~10-25。
  if (issueDate !== "2026-10-17" && issueDate !== "2026-10-18") {
    return "下周大事日历：没取到（本期日历仅核实了 2026-10-19~10-25 一周，当前日期不在该周末窗口内，不拿旧日历冒充下周）。";
  }
  // 以下日期均于 2026-10-17 经公开源核实（事实转述，非原文引用）：
  // · 美联储下次议息 10-27~10-28（路透 10-15 + 美联储 2026 全年日程）：不在下周。
  // · 美国 CPI 下次 11-10（BLS 11 月发布日程）、非农下次 11-06（BLS 就业报告发布日程）：都不在下周。
  // · 美股财报日程（ii.co.uk Q3 财报日历表）：Netflix 10-20 盘后、Tesla / Meta 10-21 盘后等。
  // · 中国三季度 GDP 等 10-19 公布（Sharecast 周前瞻）。
  // · A 股解禁（格隆汇经新浪财经 2026-10-16 报道，按 10-16 收盘价统计）。
  const lines = [
    "下周大事日历（2026-10-19~2026-10-25，日期均经公开源核实，来源见括号）：",
    "周一 10-19：中国三季度 GDP + 9 月社会消费品零售总额、工业增加值（Sharecast 周前瞻）；美股无重要财报。",
    "周二 10-20：美股财报——3M、GE Aerospace、通用汽车、菲利普莫里斯（盘前），Intuitive Surgical、Netflix（盘后）（ii.co.uk 财报日历）。",
    "周三 10-21：美股财报——Abbott、AT&T、CME、Thermo Fisher（盘前），IBM、Lam Research、Meta、Tesla（盘后）（ii.co.uk 财报日历）；A 股解禁高峰：9 家合计 643.84 亿元（格隆汇）。",
    "周四 10-22：美股财报——Blackstone、宝洁、Spotify（盘前）（ii.co.uk 财报日历）。",
    "周五 10-23：美股财报——美国运通、SLB（盘前）（ii.co.uk 财报日历）。",
    "下周没有美联储议息：下次议息 10-27~10-28（路透 10-15 + 美联储全年日程），在下下周。",
    "下周没有美国 CPI / 非农：下次 CPI 11-10、下次非农（10 月数据）11-06（BLS 发布日程），都在下下周及之后。",
    "A 股解禁：下周（10-19~10-23）45 家公司合计解禁 24.86 亿股，按 10-16 收盘价算解禁市值 1003.01 亿元；解禁市值前三：中船特气 595.58 亿元、颀中科技 109.89 亿元、润本股份 60.88 亿元（格隆汇经新浪财经 10-16）。",
    "A 股三季报密集披露：个股披露日期没取到（无公开全量日历核实到个股日期，不编）。",
  ];
  return lines.join("\n");
}

// ── 周末政策面 ──

const POLICY_KEYWORDS = [
  "证监会", "央行", "中国人民银行", "国务院", "发改委", "财政部",
  "金融监管总局", "上交所", "深交所", "北交所", "证券交易所", "降准", "降息", "政治局",
  "外汇局", "监管局", "常务会议",
];

/** 非中国政策面噪音（美国财政部、日本央行、欧洲央行、境外交易所数据等）与聚合类标题，过滤掉。 */
const POLICY_EXCLUDE = [
  "美国财政部", "日本央行", "欧洲央行", "欧洲中央银行", "美联储", "英国央行",
  "洲际交易所", "新闻精选", "新闻联播", "隔夜全球要闻",
];

/** 周五收盘后至今的政策面电报：周五 2026-10-16 15:00:00（含）之后。 */
export async function buildWeekendPolicy(): Promise<{ plain: string; missing: boolean }> {
  const cutoff = Date.parse("2026-10-16T15:00:00+08:00") / 1000;
  const nowSec = Math.floor(Date.now() / 1000);
  const picked: { time: string; title: string }[] = [];
  try {
    let lastTime = nowSec;
    let fetched = 0;
    for (let page = 0; page < 60; page++) {
      const items: ClsRollItem[] = await fetchClsTelegraphPage(lastTime, 20);
      if (!items.length) break;
      let minCtime = Infinity;
      for (const it of items) {
        fetched++;
        const ctime = Number(it.ctime);
        if (!Number.isFinite(ctime) || ctime <= 0) continue;
        if (ctime < minCtime) minCtime = ctime;
        if (ctime < cutoff) continue;
        const title = clsFullTitleOf(it);
        const content = String(it.content ?? it.brief ?? "");
        const hay = `${title}${content}`;
        // 标题带中国政策主体（中国人民银行 / 国务院 / 证监会 / 发改委）的保留，
        // 否则命中排除词（境外央行/财政部、聚合类标题）即丢弃。
        if (title.includes("美国财政部") || title.includes("日本央行")) continue;
        if (POLICY_EXCLUDE.some((k) => hay.includes(k)) && !/中国人民银行|国务院|证监会|发改委/.test(title)) continue;
        if (!POLICY_KEYWORDS.some((k) => hay.includes(k))) continue;
        if (title) picked.push({ time: clsShanghaiShowTime(ctime), title });
      }
      if (!Number.isFinite(minCtime) || minCtime < cutoff) break;
      lastTime = minCtime - 1;
      if (items.length < 20) break;
    }
    if (!picked.length) {
      return {
        plain: "周末政策面：暂无（周五 2026-10-16 收盘后至今，财联社电报里没有证监会 / 央行 / 国务院等政策面消息）。",
        missing: false,
      };
    }
    // 新→旧（fetch 已是新→旧，picked 保持该顺序），最多 15 条；能解释的直接跟一句自然解释
    const top = picked.slice(0, 15);
    const lines = top.map((p) => {
      const exp = interpretNewsTitle(p.title);
      return `${p.time.slice(5, 16)} ${p.title}${exp ? ` ${exp}` : ""}`;
    });
    return {
      plain: `周末政策面（周五 2026-10-16 收盘后至今，财联社电报按政策关键词过滤，共 ${picked.length} 条，最新 ${top.length} 条）：\n${lines.join("\n")}`,
      missing: false,
    };
  } catch {
    return {
      plain: "周末政策面：没取到（财联社电报拉不到，算不出周五收盘后至今的政策面消息）。",
      missing: true,
    };
  }
}

// ── 大宗商品 + 汇率 + 比特币 ──

interface QuoteDef {
  symbol: string;
  label: string;
  unit: string;
  decimals: number;
}

const QUOTE_DEFS: QuoteDef[] = [
  { symbol: "CL=F", label: "原油（WTI）", unit: "美元/桶", decimals: 2 },
  { symbol: "GC=F", label: "黄金", unit: "美元/盎司", decimals: 1 },
  { symbol: "HG=F", label: "铜", unit: "美元/磅", decimals: 3 },
  { symbol: "DX-Y.NYB", label: "美元指数", unit: "", decimals: 3 },
  { symbol: "CNY=X", label: "美元兑人民币", unit: "元", decimals: 4 },
  { symbol: "BTC-USD", label: "比特币", unit: "美元", decimals: 0 },
];

function shanghaiStampFromSec(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

async function fetchYahooQuote(def: QuoteDef): Promise<{ price: number; changePct: number | null; stamp: string | null } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(def.symbol)}?range=5d&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal, cache: "no-store" },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      chart?: { result?: { meta?: { regularMarketPrice?: number; regularMarketChangePercent?: number; fulldayChangePercent?: number; regularMarketTime?: number } }[] };
    };
    const meta = j?.chart?.result?.[0]?.meta;
    const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    if (price == null) return null;
    const changePct =
      typeof meta?.regularMarketChangePercent === "number"
        ? meta.regularMarketChangePercent
        : typeof meta?.fulldayChangePercent === "number"
          ? meta.fulldayChangePercent
          : null;
    const stamp = typeof meta?.regularMarketTime === "number" ? shanghaiStampFromSec(meta.regularMarketTime) : null;
    return { price, changePct, stamp };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function buildCommodities(): Promise<{ plain: string; missing: boolean }> {
  const results = await Promise.all(QUOTE_DEFS.map((d) => fetchYahooQuote(d)));
  let anyMissing = false;
  const stamps = results.map((r) => r?.stamp).filter(Boolean) as string[];
  const lines = QUOTE_DEFS.map((def, i) => {
    const r = results[i];
    if (!r) {
      anyMissing = true;
      return `${def.label}：NULL（没取到）`;
    }
    const priceStr = def.decimals === 0
      ? r.price.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : r.price.toFixed(def.decimals);
    const chg = r.changePct == null ? "涨跌幅没取到" : `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`;
    return `${def.label}：${priceStr}${def.unit ? ` ${def.unit}` : ""}，${chg}`;
  });
  const stampNote = stamps.length ? `（报价时间北京时间 ${stamps[0]}，各品种报价时刻以交易所为准）` : "";
  return {
    plain: `大宗商品 + 汇率 + 比特币${stampNote}：\n${lines.join("\n")}\n来源：Yahoo Finance 公开行情（免费，无 Key）。`,
    missing: anyMissing,
  };
}

// ── 周末公司公告 ──

/** YYYY-MM-DD 加减天数（纯函数，不依赖宿主机时区） */
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * issueDate 严格之前最近的一个交易日。日历读不到（null）时按周末退回：
 * 周六/周日 → 周五，周一 → 周五，其余 → 前一天（绝不猜一个交易日出来，
 * 退回值只用于定“收盘后至今”的起点，公告仍按时间过滤，不会把平日公告算进来）。
 */
export function prevTradingDayBefore(issueDate: string): string {
  for (let back = 1; back <= 10; back++) {
    const cand = addDaysYmd(issueDate, -back);
    if (isTradingDay(cand) === true) return cand;
  }
  const wd = new Date(`${issueDate}T12:00:00Z`).getUTCDay(); // 0=日 6=六
  if (wd === 0) return addDaysYmd(issueDate, -2);
  if (wd === 6) return addDaysYmd(issueDate, -1);
  if (wd === 1) return addDaysYmd(issueDate, -3);
  return addDaysYmd(issueDate, -1);
}

/** 只留对周一开盘有影响的公司公告：停牌 / 重大事项 / 业绩预告类；日常流程类（股东大会 / 股权激励 / 担保 / 质押等）不要。 */
const COMPANY_MATERIAL = /停牌|复牌|重大|重组|收购|合并|业绩预告|业绩快报|回购|增持|减持|立案|处罚|罚没|退市|分红|中标|合同|订单/;

/** 例行文书（法律意见书 / 股东名册 / 独立意见等）：标题带实质关键词也只是配套文件，不算重大事项。 */
const COMPANY_PAPERWORK = /法律意见书|前十大股东|持股情况|独立意见|保荐|审计报告|评估报告|验资|公证书|询价|路演/;

/** 例行更新（进展 / 补充 / 更正）：除非含停牌 / 复牌 / 业绩预告，否则只是流程推进，不单列。 */
const COMPANY_ROUTINE_UPDATE = /进展公告|补充公告|更正公告/;

/** 上一交易日收盘后至今的公司公告（巨潮，逐日拉 + 时间过滤）。 */
export async function buildWeekendCompanyAnnouncements(issueDate: string): Promise<{ plain: string; missing: boolean }> {
  const prevDay = prevTradingDayBefore(issueDate);
  const cutoff = `${prevDay} 15:00:00`;
  try {
    const dates: string[] = [];
    for (let d = prevDay; d <= issueDate; d = addDaysYmd(d, 1)) dates.push(d);
    const picked: { time: string; name: string; code: string; title: string }[] = [];
    for (const date of dates) {
      const anns = await fetchCninfoDayAnnouncements(date).catch(() => []);
      for (const a of anns) {
        if (!a.time) continue;
        if (a.time < cutoff) continue; // 上一交易日只取收盘后（15:00 之后）的
        if (!COMPANY_MATERIAL.test(a.title)) continue;
        if (COMPANY_PAPERWORK.test(a.title)) continue; // 例行文书不要
        if (COMPANY_ROUTINE_UPDATE.test(a.title) && !/停牌|复牌|业绩预告|业绩快报/.test(a.title)) continue;
        picked.push({ time: a.time, name: a.name, code: a.code, title: a.title });
      }
    }
    if (!picked.length) {
      return {
        plain: `周末公司公告：暂无（上一交易日 ${prevDay} 收盘后至今，巨潮没有停牌 / 重大事项 / 业绩预告类公司公告）。`,
        missing: false,
      };
    }
    // 新→旧；同一公司最多 2 条（避免同一件事的重复公告刷屏）；最多 15 条；能解释的直接跟一句自然解释
    picked.sort((a, b) => (a.time < b.time ? 1 : -1));
    const perCompany = new Map<string, number>();
    const deduped = picked.filter((p) => {
      const n = (perCompany.get(p.code) ?? 0) + 1;
      perCompany.set(p.code, n);
      return n <= 2;
    });
    const top = deduped.slice(0, 15);
    const lines = top.map((p) => {
      const exp = interpretNewsTitle(p.title);
      return `${p.time.slice(5, 16)} ${p.name}（${p.code}）${p.title}${exp ? ` ${exp}` : ""}`;
    });
    return {
      plain: `周末公司公告（上一交易日 ${prevDay} 收盘后至今，巨潮公告按停牌 / 重大事项 / 业绩预告过滤、去掉例行文书与例行更新，共 ${deduped.length} 条，最新 ${top.length} 条）：\n${lines.join("\n")}`,
      missing: false,
    };
  } catch {
    return {
      plain: "周末公司公告：没取到（巨潮公告拉不到，算不出上一交易日收盘后至今的公司公告）。",
      missing: true,
    };
  }
}

// ── 港股周五收盘 + AH 溢价 ──

async function fetchYahooIndex(symbol: string): Promise<{ price: number; changePct: number | null } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal, cache: "no-store" },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      chart?: { result?: { meta?: { regularMarketPrice?: number; regularMarketChangePercent?: number } }[] };
    };
    const meta = j?.chart?.result?.[0]?.meta;
    const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    if (price == null) return null;
    const changePct = typeof meta?.regularMarketChangePercent === "number" ? meta.regularMarketChangePercent : null;
    return { price, changePct };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 港股周五收盘 + AH 溢价：恒生指数 + 国企指数（Yahoo 公开行情，上一交易日收盘）。
 * AH 溢价指数在公开免费源里无实时值（长桥 quote 不返回指数、Yahoo 无该代码、
 * 腾讯无该代码、新浪被禁、东财自 VM 拉不到），写 NULL 不编。
 */
export async function buildHkFriday(issueDate: string): Promise<{ plain: string; missing: boolean }> {
  const prevDay = prevTradingDayBefore(issueDate);
  const [hsi, hsce] = await Promise.all([fetchYahooIndex("^HSI"), fetchYahooIndex("^HSCE")]);
  const fmt = (r: { price: number; changePct: number | null } | null, label: string, digits: number): string => {
    if (!r) return `${label}：NULL（没取到）`;
    const chg = r.changePct == null ? "涨跌幅没取到" : `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`;
    return `${label}：${r.price.toFixed(digits)}，${chg}`;
  };
  const missing = !hsi || !hsce;
  return {
    plain:
      `港股周五收盘 + AH 溢价（上一交易日 ${prevDay} 收盘，Yahoo 公开行情）：\n` +
      `${fmt(hsi, "恒生指数", 2)}\n` +
      `${fmt(hsce, "国企指数", 2)}\n` +
      `AH 溢价指数：NULL（没取到，公开免费源无该指数实时值，不编）。` +
      `\nAH 溢价 = 同一只票 A 股价 / H 股价：高于 100 说明 A 股比 H 股贵，越高说明 A 股相对越贵。`,
    missing: !!missing,
  };
}
