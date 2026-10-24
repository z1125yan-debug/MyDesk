// 巨潮公告（CNINFO，公开公告，非 VIP）：POST /new/hisAnnouncement/query。
//
// 只用公开公告接口，不碰 VIP / 付费内容，不绕付费墙。
// 接口实测（2026-10-16）：
//   - POST http://www.cninfo.com.cn/new/hisAnnouncement/query，form 表单
//   - stock 参数传代码返回 0（接口侧 stock 过滤失效），改用 seDate 按日期拉 + 客户端按 secCode 过滤
//   - seDate 格式 "YYYY-MM-DD+~+YYYY-MM-DD"，URL 编码后传
//   - column: szse/sse，plate: sz/sh，tabName: fulltext
//   - 返回 announcements[]：secCode / secName / announcementId / announcementTitle /
//     announcementTime（毫秒 UTC）/ adjunctUrl（PDF 相对路径）/ adjunctSize
//   - 10-15 实测：SZ 603 条，SH 415 条，合计约 1018 条；恒瑞医药 2 条（H 股公告）
// 本模块只发请求 + 解析 + 分类，不读 DB、不写库；
// 板块分类用 data/sector-constituents.json（与日报板块分类一致）；
// AI 优选引用走 ai-pick-generate.ts 的 enrichAiPickCandidates。

const CNINFO_BASE = "http://www.cninfo.com.cn";
const CNINFO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 巨潮公告原样字段（只取解析用到的） */
export interface CninfoRawItem {
  secCode?: string;
  secName?: string;
  announcementId?: string;
  announcementTitle?: string;
  announcementTime?: number; // 毫秒 UTC
  adjunctUrl?: string;
  adjunctSize?: number;
  adjunctType?: string;
}

interface CninfoResp {
  totalAnnouncement?: number;
  totalRecordNum?: number;
  announcements?: CninfoRawItem[];
}

/** 公告类型（按标题关键词分类，标题逐字匹配，不改写） */
export type CninfoAnnType =
  | "财报" // 年报 / 半年报 / 季报 / 一季报 / 三季报
  | "业绩预告" // 业绩预告 / 业绩快报
  | "回购" // 回购 / 增持回购
  | "增持" // 增持 / 增持计划
  | "减持" // 减持 / 减持计划
  | "分红" // 分红 / 派息 / 送股
  | "合同" // 合同 / 中标 / 订单
  | "股东大会" // 股东大会 / 股东会
  | "股权激励" // 股权激励 / 股票期权
  | "担保" // 担保
  | "质押" // 质押 / 解押
  | "其他";

export interface CninfoAnn {
  /** 6 位代码，如 600276 */
  code: string;
  /** 公司简称，如 恒瑞医药 */
  name: string;
  /** 公告标题（逐字，不改写） */
  title: string;
  /** 上海时区 "YYYY-MM-DD HH:MM:SS" */
  time: string;
  /** 公告日期 "YYYY-MM-DD"（上海时区） */
  date: string;
  /** 公告类型（标题关键词分类） */
  type: CninfoAnnType;
  /** PDF 相对路径，如 finalpage/2026-10-16/1225607726.PDF */
  pdfUrl: string;
  /** 公告 ID */
  announcementId: string;
  /** 所属板块（第一级，如 煤炭 / 医药生物 / 半导体，与日报板块分类一致；无映射则 null） */
  sector: string | null;
}

/** 标题 → 公告类型（关键词逐字匹配，顺序：先具体后泛） */
export function classifyCninfoAnn(title: string): CninfoAnnType {
  const t = String(title ?? "");
  if (/回购/.test(t)) return "回购";
  if (/增持/.test(t)) return "增持";
  if (/减持/.test(t)) return "减持";
  if (/业绩预告|业绩快报/.test(t)) return "业绩预告";
  if (/年度报告|半年度报告|一季度报告|三季度报告|第一季度报告|第三季度报告|定期报告|财务报告/.test(t)) return "财报";
  if (/分红|派息|送股|转增|利润分配/.test(t)) return "分红";
  if (/合同|中标|订单/.test(t)) return "合同";
  if (/股东大会|股东会/.test(t)) return "股东大会";
  if (/股权激励|股票期权|限制性股票/.test(t)) return "股权激励";
  if (/担保/.test(t)) return "担保";
  if (/质押|解押/.test(t)) return "质押";
  return "其他";
}

/** 毫秒 UTC → 上海时区 "YYYY-MM-DD HH:MM:SS"（ts+8h，与 A 股交易日对齐） */
export function cninfoShanghaiTime(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

async function fetchCninfoPage(
  column: "szse" | "sse",
  plate: "sz" | "sh",
  seDate: string,
  pageNum: number,
  pageSize = 30,
): Promise<CninfoResp> {
  const body = new URLSearchParams({
    pageNum: String(pageNum),
    pageSize: String(pageSize),
    column,
    tabName: "fulltext",
    plate,
    stock: "",
    searchkey: "",
    secid: "",
    category: "",
    trade: "",
    seDate,
  }).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${CNINFO_BASE}/new/hisAnnouncement/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": CNINFO_UA,
        Referer: "http://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search",
      },
      body,
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`巨潮公告 HTTP ${res.status}`);
    return (await res.json()) as CninfoResp;
  } finally {
    clearTimeout(timer);
  }
}

/** 板块映射（懒加载，data/sector-constituents.json，与日报板块分类一致） */
let sectorMapCache: Map<string, string> | null = null;
function sectorOf(code: string): string | null {
  if (!sectorMapCache) {
    sectorMapCache = new Map();
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const data = require("../../../data/sector-constituents.json") as {
        industries?: Record<string, { members?: { code?: string }[] }>;
      };
      for (const [sector, v] of Object.entries(data.industries ?? {})) {
        for (const m of v.members ?? []) {
          if (m.code) sectorMapCache.set(String(m.code), sector);
        }
      }
    } catch {
      // 映射文件缺失：sector 留 null，不编
    }
  }
  return sectorMapCache.get(String(code)) ?? null;
}

function toAnn(it: CninfoRawItem): CninfoAnn | null {
  const code = String(it.secCode ?? "").trim();
  const title = String(it.announcementTitle ?? "").trim();
  if (!code || !title) return null;
  const ms = Number(it.announcementTime);
  const time = Number.isFinite(ms) && ms > 0 ? cninfoShanghaiTime(ms) : "";
  return {
    code,
    name: String(it.secName ?? "").trim(),
    title,
    time,
    date: time.slice(0, 10),
    type: classifyCninfoAnn(title),
    pdfUrl: String(it.adjunctUrl ?? ""),
    announcementId: String(it.announcementId ?? ""),
    sector: sectorOf(code),
  };
}

/**
 * 拉回指定交易日（上海时区）全天的巨潮公告（沪 + 深，分页）。
 * 失败抛错（调用方据此写“未取到”，不拿空数组冒充“当日无公告”）。
 * 注意：只拉决策日当天的公告，不拿其它日期的当该日的——绝不能把其它日期的公告
 * 喂给该日的 AI 优选（那是未来数据 / 穿越）。
 */
export async function fetchCninfoDayAnnouncements(tradeDate: string): Promise<CninfoAnn[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error(`bad tradeDate ${tradeDate}`);
  const seDate = `${tradeDate}+~+${tradeDate}`;
  const out: CninfoAnn[] = [];
  const seen = new Set<string>();
  for (const [column, plate] of [["szse", "sz"], ["sse", "sh"]] as const) {
    // 先拉第 1 页拿总数，再按需翻页（每页 30 条）。按市场单独计数，不跨市场累计。
    let total = Infinity;
    let marketCount = 0;
    for (let page = 1; page <= 200; page++) {
      const j = await fetchCninfoPage(column, plate, seDate, page, 30);
      if (page === 1) total = Number(j.totalAnnouncement ?? 0) || 0;
      const items = j.announcements ?? [];
      let added = 0;
      for (const it of items) {
        const a = toAnn(it);
        if (!a) continue;
        // 只保留上海日期 == tradeDate 的条目（接口 seDate 已过滤，双保险）
        if (a.date !== tradeDate) continue;
        const key = `${a.code}-${a.announcementId || a.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a);
        added++;
      }
      marketCount += added;
      if (marketCount >= total) break;
      if (items.length < 30) break;
      // 安全上限：单市场单日超过 6000 条就停（正常单日约 400-600 条）
      if (page * 30 >= 6000) break;
    }
  }
  // 时间升序（与公告页一致）
  out.sort((a, b) => (a.time < b.time ? -1 : 1));
  return out;
}

/**
 * 拉指定符号在指定交易日的巨潮公告（按代码过滤 + 按类型分类）。
 * symbols：带 .SH/.SZ/.BJ 后缀或裸 6 位均可。
 * 返回：按符号分组的公告列表（无公告的符号对应空数组，不是 null）。
 */
export async function fetchCninfoStockAnnouncements(
  symbols: string[],
  tradeDate: string,
): Promise<Map<string, CninfoAnn[]>> {
  const norm = (s: string) => String(s).replace(/\.(SH|SZ|BJ)$/i, "").trim().toUpperCase();
  const wanted = new Set(symbols.map(norm).filter(Boolean));
  const out = new Map<string, CninfoAnn[]>();
  for (const w of wanted) out.set(w, []);
  if (!wanted.size) return out;
  const all = await fetchCninfoDayAnnouncements(tradeDate);
  for (const a of all) {
    if (wanted.has(a.code)) out.get(a.code)!.push(a);
  }
  return out;
}

/** 按板块分组（板块分类与日报一致，第一级板块名；无板块归 “未分类”） */
export function groupCninfoBySector(anns: CninfoAnn[]): Map<string, CninfoAnn[]> {
  const out = new Map<string, CninfoAnn[]>();
  for (const a of anns) {
    const key = a.sector ?? "未分类";
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(a);
  }
  return out;
}

/** 按类型分组 */
export function groupCninfoByType(anns: CninfoAnn[]): Map<CninfoAnnType, CninfoAnn[]> {
  const out = new Map<CninfoAnnType, CninfoAnn[]>();
  for (const a of anns) {
    if (!out.has(a.type)) out.set(a.type, []);
    out.get(a.type)!.push(a);
  }
  return out;
}

/** 小白语言一句话：公告类型 + 标题（供 AI 优选引用，如“XX 发布回购公告”） */
export function cninfoPlainLine(a: CninfoAnn): string {
  return `${a.name}（${a.code}）发布${a.type}公告：${a.title}`;
}

// ── 减持风险（2026-10-16：用户“巨潮能看到哪个股票的股东减持了比较大的是吧，
// 这个也可以作为风险，因为之前六月份的时候好像蛮多股票的大股东创始人什么的减持比较多”） ──
//
// 诚实边界（标题口径，不编）：
//   - 巨潮公告标题里能看出的只有：谁在减（控股股东 / 持股5%以上股东 / 董监高 / 股东）、
//     是计划还是结果（计划/预披露 vs 结果/完成/届满）、标题里带没带比例（如“触及1%”）。
//   - 标题里没有具体减持股数 / 金额 / 占总股本比例（那些在公告正文 PDF 里，本模块不解析 PDF，
//     不编一个数）。标题带比例的（如“触及1%”）才写比例；不带的写“具体数量看公告正文”。
//   - “创始人”标题里几乎不写，实际控制人往往就是创始人——控股股东 / 实际控制人 /
//     持股5%以上股东都算“大股东”，统一标高风险。

/** 减持人身份（从标题逐字匹配，顺序：先具体后泛） */
export type ReductionHolder =
  | "控股股东" // 控股股东 / 实际控制人（含一致行动人）
  | "大股东" // 持股5%以上股东
  | "董监高" // 董事 / 监事 / 高级管理人员 / 高管
  | "股东"; // 标题只写“股东”，没说是谁

/** 减持阶段：计划（还没卖，要卖） vs 结果（已经卖了 / 期限到了） */
export type ReductionStage = "计划" | "结果";

export interface CninfoReduction {
  /** 原公告 */
  ann: CninfoAnn;
  /** 谁在减 */
  holder: ReductionHolder;
  /** 计划还是结果 */
  stage: ReductionStage;
  /** 标题里带的比例（如“触及1%”→1；不带→null，不编） */
  pctInTitle: number | null;
  /** 风险等级：大股东减持 = 高；董监高 = 中；没说是谁的股东 = 低 */
  riskLevel: "高" | "中" | "低";
}

/** 标题 → 减持人身份 */
export function parseReductionHolder(title: string): ReductionHolder {
  const t = String(title ?? "");
  if (/控股股东|实际控制人/.test(t)) return "控股股东";
  if (/持股\s*5%\s*以上股东|5%\s*以上股东/.test(t)) return "大股东";
  if (/董事|监事|高级管理人员|高管/.test(t)) return "董监高";
  return "股东";
}

/** 标题 → 减持阶段：有“结果/完成/届满/实施”且无“计划/预披露” → 结果；否则计划 */
export function parseReductionStage(title: string): ReductionStage {
  const t = String(title ?? "");
  if (/计划|预披露/.test(t)) return "计划";
  if (/结果|完成|届满|实施|进展/.test(t)) return "结果";
  return "计划"; // 没写阶段，默认按计划（要卖）处理，不按已卖编
}

/** 标题 → 标题里带的减持比例：只认减持动作后带的比例（触及/达到/超过/减持…%），
 * 不认“持股5%以上”这种持股人资格描述（那是“谁有资格减”，不是“减了多少”）。
 * 如“触及1%”→1；“减持比例 2%”→2；不带 → null。 */
export function parseReductionPct(title: string): number | null {
  const t = String(title ?? "");
  // 先认触发词（触及/达到/超过）后的比例，最准
  const m1 = t.match(/(?:触及|达到|超过)\s*(\d+(?:\.\d+)?)\s*%/);
  if (m1) {
    const n = Number(m1[1]);
    return Number.isFinite(n) ? n : null;
  }
  // 再认“减持…%”（减持后 20 字内出现的比例，如“减持比例 2%”）
  const m2 = t.match(/减持[^%]{0,20}?(\d+(?:\.\d+)?)\s*%/);
  if (m2) {
    const n = Number(m2[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 一条公告 → 减持风险（非减持公告返回 null） */
export function reductionRiskOf(a: CninfoAnn): CninfoReduction | null {
  if (a.type !== "减持") return null;
  const holder = parseReductionHolder(a.title);
  const riskLevel: "高" | "中" | "低" = holder === "控股股东" || holder === "大股东" ? "高" : holder === "董监高" ? "中" : "低";
  return {
    ann: a,
    holder,
    stage: parseReductionStage(a.title),
    pctInTitle: parseReductionPct(a.title),
    riskLevel,
  };
}

/** 从一批公告里筛出减持风险（只含 type=减持 的，按风险高→低、计划→结果排序） */
export function filterReductionRisks(anns: readonly CninfoAnn[]): CninfoReduction[] {
  const out: CninfoReduction[] = [];
  for (const a of anns) {
    const r = reductionRiskOf(a);
    if (r) out.push(r);
  }
  const levelRank = (r: CninfoReduction) => (r.riskLevel === "高" ? 0 : r.riskLevel === "中" ? 1 : 2);
  out.sort((a, b) => levelRank(a) - levelRank(b) || (a.stage === "计划" && b.stage !== "计划" ? -1 : 1));
  return out;
}

/** 小白语言一句话减持风险：谁在减、计划还是结果、标题带比例就写比例，不带就说看正文 */
export function reductionPlainLine(r: CninfoReduction): string {
  const { ann, holder, stage, pctInTitle } = r;
  const who = holder === "控股股东" ? "控股股东" : holder === "大股东" ? "大股东（持股5%以上）" : holder === "董监高" ? "董事/高管" : "股东";
  const what = stage === "计划" ? "要减持（还没卖）" : "减持结果（已经卖了 / 期限到了）";
  const pct = pctInTitle != null ? `，标题里写了触及 ${pctInTitle}%` : "，具体减持多少股看公告正文（标题里没有，不编）";
  return `${ann.name}（${ann.code}）：${who}${what}${pct}`;
}

// ── 连续减持（2026-10-16 补充：主线板块里也要看减持） ──
//
// 用户：“主线是白酒，白酒里龙头是谁，白酒的钱是进还是出，这里可以加个
// 主线某个股票大股东在连续减持之类的。”
// 连续减持 = 同一公司在近期（默认近 30 天）有 2 次及以上减持公告，
// 或某条减持公告标题里写“连续减持 / 持续减持”。
//
// 拉法（实测，2026-10-16）：
//   - 区间全量拉太慢：30 天深市 12701 条，pageSize 被接口上限 30 截断，要 424 页。
//   - 按公司拉很快：secid（公司 orgId）+ seDate 区间，恒瑞 30 天 19 条，0.5 秒；
//     平安银行 30 天 5 条。stock 参数传代码返回 0（失效），必须用 secid。
//   - orgId 查法：GET http://www.cninfo.com.cn/new/data/szse_stock.json（全市场 6260 只，
//     SH/SZ/BJ 全含，code → orgId），内存缓存 24 小时。orgId 格式不统一
//     （gssh0600276 / gssz0000001 / 9900037542 / gfbj0430478），不猜，必须查表。

/** 代码 → orgId 映射（szse_stock.json，全市场；内存缓存 24 小时） */
let orgIdMapCache: { at: number; map: Map<string, string> } | null = null;
async function fetchOrgIdMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (orgIdMapCache && now - orgIdMapCache.at < 24 * 3600 * 1000) return orgIdMapCache.map;
  const res = await fetch(`${CNINFO_BASE}/new/data/szse_stock.json`, {
    headers: { "User-Agent": CNINFO_UA },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`巨潮股票索引 HTTP ${res.status}`);
  const j = (await res.json()) as { stockList?: { code?: string; orgId?: string }[] };
  const map = new Map<string, string>();
  for (const s of j.stockList ?? []) {
    const code = String(s.code ?? "").trim();
    const orgId = String(s.orgId ?? "").trim();
    if (code && orgId) map.set(code, orgId);
  }
  orgIdMapCache = { at: now, map };
  return map;
}

/** 某公司在指定区间 [startDate, endDate]（上海日期，含两端）的全部公告（按 secid 过滤）。 */
export async function fetchCninfoStockHistory(
  code: string,
  startDate: string,
  endDate: string,
): Promise<CninfoAnn[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error(`bad date range ${startDate}~${endDate}`);
  }
  const bare = String(code).replace(/\.(SH|SZ|BJ)$/i, "").trim().toUpperCase();
  const orgMap = await fetchOrgIdMap();
  const secid = orgMap.get(bare);
  if (!secid) return []; // 索引里没这只 → 当无公告处理，不编
  const seDate = `${startDate}+~+${endDate}`;
  const out: CninfoAnn[] = [];
  const seen = new Set<string>();
  // column/plate 必须按交易所传（2026-10-21 修复）：此前写死 szse/sz，沪市股用 secid 查
  // 历史公告恒返回空（600276 实测 0 条），连带连续减持检测对沪市股一并失效。
  // 沪 → sse/sh，深 → szse/sz（与 fetchCninfoDayAnnouncements 的两组口径一致）；
  // 北交所无实测口径 → 用空参数（实测空参数可返回结果）。首选口径查空时自动落空参数重试。
  const suffix = /\.(SH|SZ|BJ)$/i.exec(String(code).trim())?.[1]?.toUpperCase();
  const market = suffix ?? (bare.startsWith("6") ? "SH" : bare.startsWith("0") || bare.startsWith("3") ? "SZ" : "BJ");
  const primary: [string, string] = market === "SH" ? ["sse", "sh"] : market === "SZ" ? ["szse", "sz"] : ["", ""];
  const attempts: [string, string][] = primary[0] || primary[1] ? [primary, ["", ""]] : [primary];
  // 30 天单公司通常 <30 条，1 页就够；上限 100 页防失控
  for (const [column, plate] of attempts) {
  for (let page = 1; page <= 100; page++) {
    const body = new URLSearchParams({
      pageNum: String(page),
      pageSize: "30",
      column,
      tabName: "fulltext",
      plate,
      stock: "",
      searchkey: "",
      secid,
      category: "",
      trade: "",
      seDate,
    }).toString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${CNINFO_BASE}/new/hisAnnouncement/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": CNINFO_UA,
          Referer: "http://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search",
        },
        body,
        signal: ctrl.signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`巨潮公告 HTTP ${res.status}`);
      const j = (await res.json()) as CninfoResp;
      const items = j.announcements ?? [];
      let added = 0;
      for (const it of items) {
        const a = toAnn(it);
        if (!a) continue;
        if (a.code !== bare) continue; // secid 已过滤，双保险
        if (a.date < startDate || a.date > endDate) continue;
        const key = `${a.code}-${a.announcementId || a.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a);
        added++;
      }
      if (items.length < 30) break;
      if (added === 0) break;
    } finally {
      clearTimeout(timer);
    }
  }
  if (out.length) break;
  }
  out.sort((a, b) => (a.time < b.time ? -1 : 1));
  return out;
}

/** 连续减持判定结果（同一公司） */
export interface ContinuousReduction {
  code: string;
  name: string;
  /** 近期窗口内减持公告数 */
  count: number;
  /** 窗口 [startDate, endDate] */
  window: { startDate: string; endDate: string };
  /** 减持公告明细（按时间升序） */
  anns: CninfoAnn[];
  /** 是否有大股东（控股股东 / 持股5%以上）减持 */
  hasBigHolder: boolean;
  /** 是否标题里写了“连续减持 / 持续减持” */
  titleSaysContinuous: boolean;
  /** 小白一句话 */
  plainLine: string;
}

/** 一批减持公告 → 是否连续减持（纯函数：count>=2，或标题写连续/持续） */
export function detectContinuousReduction(
  code: string,
  name: string,
  reductionAnns: readonly CninfoAnn[],
  window: { startDate: string; endDate: string },
): ContinuousReduction | null {
  const anns = [...reductionAnns].sort((a, b) => (a.time < b.time ? -1 : 1));
  const titleSaysContinuous = anns.some((a) => /连续减持|持续减持/.test(a.title));
  if (anns.length < 2 && !titleSaysContinuous) return null;
  const risks = anns.map((a) => reductionRiskOf(a)).filter((r): r is NonNullable<typeof r> => !!r);
  const hasBigHolder = risks.some((r) => r.holder === "控股股东" || r.holder === "大股东");
  const holderWord = hasBigHolder ? "大股东" : "股东";
  const plainLine = titleSaysContinuous && anns.length < 2
    ? `${name}（${code}）：${holderWord}在连续减持（公告标题里写了连续减持），小心。`
    : `${name}（${code}）：${holderWord}在连续减持，近 ${window.startDate}~${window.endDate} 发了 ${anns.length} 次减持公告，小心。`;
  return { code, name, count: anns.length, window, anns, hasBigHolder, titleSaysContinuous, plainLine };
}

/** 某板块成员代码 → 各自的连续减持（并发 10，单只失败跳过，不阻塞其它）。 */
export async function fetchContinuousReductions(
  codes: readonly string[],
  endDate: string,
  windowDays = 30,
): Promise<ContinuousReduction[]> {
  const end = new Date(`${endDate}T00:00:00Z`);
  const start = new Date(end.getTime() - windowDays * 24 * 3600 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const out: ContinuousReduction[] = [];
  const queue = [...new Set(codes.map((c) => String(c).replace(/\.(SH|SZ|BJ)$/i, "").trim().toUpperCase()).filter(Boolean))];
  const CONC = 10;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < CONC; w++) {
    workers.push((async () => {
      while (queue.length) {
        const code = queue.shift();
        if (!code) break;
        try {
          const hist = await fetchCninfoStockHistory(code, startDate, endDate);
          const reds = hist.filter((a) => a.type === "减持");
          if (!reds.length) continue;
          const name = reds[0].name || code;
          const det = detectContinuousReduction(code, name, reds, { startDate, endDate });
          if (det) out.push(det);
        } catch {
          // 单只失败跳过，不阻塞其它
        }
      }
    })());
  }
  await Promise.all(workers);
  out.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return out;
}

/** 板块名 → 成员（code/name/tier，sector-constituents.json；无板块返回 []） */
export function membersOfSector(sectorName: string): { code: string; name: string; tier: string }[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const data = require("../../../data/sector-constituents.json") as {
      industries?: Record<string, { members?: { code?: string; name?: string; tier?: string }[] }>;
    };
    const members = data.industries?.[sectorName]?.members ?? [];
    return members
      .map((m) => ({ code: String(m.code ?? ""), name: String(m.name ?? ""), tier: String(m.tier ?? "") }))
      .filter((m) => !!m.code);
  } catch {
    return [];
  }
}
