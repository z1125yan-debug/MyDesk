// 产业链研报 · 服务端本地留档（P-当日记录）
//
// 为什么要有它：研报原本只存在浏览器 localStorage 里，换浏览器/清缓存就丢，
// 而且每次打开页面都得等 AI 重新生成（一轮要几十秒）。这里把研报落到
// data/industry-reports.json，页面打开先读服务端 —— 当日有记录就秒开，不再等 AI。
//
// 口径：
// 1) 一天一份：tradeDate（北京时间 YYYY-MM-DD）为自然键，同一天重复生成 = 覆盖当天那条；
// 2) 只保留最近 MAX_KEEP 份，避免文件无限增长；
// 3) 读失败/文件损坏一律当「无记录」返回，绝不让页面因此报错；
// 4) 写失败如实抛错，由调用方决定怎么提示 —— 不假装保存成功。
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "industry-reports.json");
const MAX_KEEP = 30;

export interface IndustryReportRecord {
  /** 生成时刻（毫秒时间戳），前端用它做历史标签 */
  ts: number;
  /** 报告标题（正文首个非空行去掉 # 标记） */
  title: string;
  /** 报告正文（markdown 原文） */
  text: string;
  /** 北京时间交易日 YYYY-MM-DD —— 一天一份的自然键 */
  tradeDate: string;
  /** 落档时刻（ISO 串），与 ts 区分：ts 是生成时间，createdAt 是入库时间 */
  createdAt?: string;
}

interface StoreShape {
  reports: IndustryReportRecord[];
}

/** 北京时间日期串（与项目其它接口同口径：en-CA 输出 YYYY-MM-DD） */
export function shanghaiDateStr(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function readStore(): StoreShape {
  try {
    if (!fs.existsSync(STORE_FILE)) return { reports: [] };
    const raw = fs.readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as StoreShape;
    if (!parsed || !Array.isArray(parsed.reports)) return { reports: [] };
    // 只保留结构完整的记录，脏数据直接跳过（不因为一条坏记录让整页读不出）
    const reports = parsed.reports.filter(
      (r) => r && typeof r.text === "string" && r.text.length > 0 && typeof r.ts === "number",
    );
    return { reports };
  } catch {
    // 解析失败视为无记录
    return { reports: [] };
  }
}

function writeStore(store: StoreShape): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // 先写临时文件再改名：避免写一半被读到（原子替换）
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmp, STORE_FILE);
}

/** 列出研报：默认按生成时间倒序（最新在前） */
export function listIndustryReports(limit = MAX_KEEP): IndustryReportRecord[] {
  const { reports } = readStore();
  return [...reports].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/** 取指定交易日（默认今天，北京时间）的研报；没有则返回 null —— 前端据此决定「秒开」还是「要生成」 */
export function getIndustryReportByDate(date?: string): IndustryReportRecord | null {
  const target = date || shanghaiDateStr();
  const { reports } = readStore();
  const hit = reports.filter((r) => r.tradeDate === target).sort((a, b) => b.ts - a.ts)[0];
  return hit ?? null;
}

/** 保存一份研报：同一天覆盖（一天一份），并裁剪到 MAX_KEEP 条 */
export function saveIndustryReport(input: {
  ts: number;
  title: string;
  text: string;
  tradeDate?: string;
}): IndustryReportRecord {
  const tradeDate = input.tradeDate || shanghaiDateStr();
  const record: IndustryReportRecord = {
    ts: typeof input.ts === "number" && input.ts > 0 ? input.ts : Date.now(),
    title: String(input.title ?? "").slice(0, 300),
    text: String(input.text ?? ""),
    tradeDate,
    createdAt: new Date().toISOString(),
  };
  if (!record.text.trim()) throw new Error("研报正文为空，拒绝入库");

  const store = readStore();
  // 同一天只留最新一条
  const others = store.reports.filter((r) => r.tradeDate !== tradeDate);
  const next = [record, ...others].sort((a, b) => b.ts - a.ts).slice(0, MAX_KEEP);
  writeStore({ reports: next });
  return record;
}

/** 删除某一天的研报（供将来做「重生成」用；当前未接 UI） */
export function deleteIndustryReportByDate(date: string): boolean {
  const store = readStore();
  const next = store.reports.filter((r) => r.tradeDate !== date);
  if (next.length === store.reports.length) return false;
  writeStore({ reports: next });
  return true;
}
