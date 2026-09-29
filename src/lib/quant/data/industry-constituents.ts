// 行业 → 成分股 本地归属快照（服务端）。Serenity 落点 A（2026-09-29）。
//
// 为什么需要它：六问第 2 步「这个题材里到底有谁」必须有**真实名单**，否则模型只能凭印象点名
// （那正是「拿概念标签冒充主营」的起点）。而本仓唯一现成的板块成分源是东财 b:BKxxxx
// （em-provider.listUniverse → fetchBoardMembers）——东财断源时那条路整条不可用
// （同花顺只有榜单页、无成分接口；china-stock-mcp 只有板块汇总、无成员）。
// 这里给**行业板**一条纯本地备胎：读 data/sector-constituents.json
// （由 industry-map.json 反向建「行业→成分」+ 腾讯补市值，见 scripts/quant/build-sector-constituents.mjs）。
//
// 口径纪律（与 data/industry-map.ts 一致，且更严——这里的返回值要直接进 AI 提示词）：
// 1) 只读本地文件，不发上游请求；
// 2) **只认行业名**（精确匹配优先，退一步去掉「板块/行业/概念/指数/产业」后缀再比一次）——
//    匹配不上返回 null，绝不拿相近名硬凑（「AI芯片」不是「半导体」，凑上去就是把猜测写成事实）；
// 3) 这是**快照**（生成于某一天）：只能证明「本地行业归属」，**不是东财板块成分**，
//    两者口径不同（覆盖面 ≈ 77%、无市值个股已剔除、无实时行情）。调用方必须把这句话带给模型。
import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "sector-constituents.json");

export interface ConstituentRow {
  code: string;
  name: string | null;
  mktCapYi: number | null;
  changePct: number | null;
  /** 静态市值档位：leader=龙头 / core=核心 / second=二线（脚本按中位市值分层） */
  tier: "leader" | "core" | "second" | string;
}
interface IndustryBlock { count: number; members: ConstituentRow[] }
interface Snapshot {
  generatedAt: string;
  source: string;
  note: string;
  industryCount: number;
  memberCount: number;
  industries: Record<string, IndustryBlock>;
}

let cache: Snapshot | null = null;
let cacheMtime = 0;

function load(): Snapshot | null {
  try {
    if (!fs.existsSync(FILE)) return null;
    const st = fs.statSync(FILE);
    // 文件被脚本重新生成时自动重载（按 mtime 判断，不用重启服务）——与 industry-map.ts 同手法
    if (cache && st.mtimeMs === cacheMtime) return cache;
    const raw = JSON.parse(fs.readFileSync(FILE, "utf-8")) as Snapshot;
    if (!raw || typeof raw !== "object" || !raw.industries) return null;
    cache = raw;
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    return null;
  }
}

/** 快照元信息（生成时点与规模）；文件缺失/损坏返回 null —— 调用方据此如实回 missing，不编造覆盖数 */
export function industrySnapshotMeta(): { generatedAt: string; industryCount: number; memberCount: number } | null {
  const s = load();
  if (!s) return null;
  return {
    generatedAt: s.generatedAt,
    industryCount: s.industryCount ?? Object.keys(s.industries).length,
    memberCount: s.memberCount ?? 0,
  };
}

/**
 * 快照里的全部行业名。供**服务层**判断「榜单上这个板块名本地认不认」——
 * 纯层（intent-core）不查字典、不猜名字，事实由服务层递进去（与 nameHits 同一条纪律）。
 */
export function industryNames(): string[] {
  const s = load();
  return s ? Object.keys(s.industries) : [];
}

const SUFFIX = /(板块|行业|概念|指数|产业)$/;
function normalize(name: string): string {
  return String(name ?? "").trim().replace(/\s+/g, "").replace(SUFFIX, "");
}

/**
 * 按行业名查本地成分（精确匹配优先，退一步去后缀再比一次）。
 * 查不到返回 null（如实露缺），**不返回空数组**——空数组会被读成「这个行业没有成分股」，那是另一件事。
 */
export function constituentsOfIndustry(
  name: string,
): { industry: string; count: number; members: ConstituentRow[] } | null {
  const s = load();
  if (!s) return null;
  const key = String(name ?? "").trim();
  if (!key) return null;
  let hit = s.industries[key];
  if (!hit) {
    const nk = normalize(key);
    if (nk) {
      for (const k of Object.keys(s.industries)) {
        if (normalize(k) === nk) { hit = s.industries[k]; break; }
      }
    }
  }
  if (!hit) return null;
  const members = Array.isArray(hit.members) ? hit.members : [];
  return { industry: key, count: hit.count ?? members.length, members };
}
