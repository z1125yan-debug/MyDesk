// AI 优选版本化存储 · 每次运行存一版，绝不覆盖。
//
// 背景（2026-10-16）：之前 persistAiPick 是“一天一行、重跑覆盖”——中午 4 只版把早上 7 只版
// 覆盖了，早上那版就丢了，没法对比哪版更好。改成：每次运行追加一个版本文件，
// 用（决策日 + 运行时间戳）区分；读“最新”时取最近一版。
//
// 每版只存精简三项：运行时间戳 + 选出的票 + 每只票当时的涨跌幅（选股日当天的涨跌幅，
// 如恒瑞 10-15 那天 +2.44%）。不要往每版里堆其他指标（PE/主力/新闻等都在 StrategyPick
// 的 symbolsNote 里，版本文件保持精简，只做“哪版选了哪些票、当天涨多少”的账本）。
// 例外（2026-10-21）：每只票可带一个可选的 riskTags（风险观察标签名数组，只标注不拦截），
// 这是用户批准的观察口径；旧文件没有这个字段，不回改。
// 例外（2026-10-24）：每只票可再带 stamp / stampReasons（排雷盖章，只标注不拦截），
// 用户指示正式版从现在起加上排雷；旧文件没有这两个字段，不回改。
//
// 落档：data/ai-pick-versions/<决策日>-<运行时间戳>.json；同秒重跑加 -2/-3 后缀，绝不覆盖。
// StrategyPick 那张表继续维持“最新一版”指针（战绩回填/晚报 AI 优选节还读它），
// 版本文件是全量账本，两边不冲突。

import { promises as fs } from "node:fs";
import path from "node:path";
import type { RiskStamp } from "./pick-risk-tags-core.ts";

export interface AiPickVersionPick {
  symbol: string;
  name?: string;
  /** 选股日当天的涨跌幅 %（如恒瑞 10-15 那天 +2.44）；算不出为 null，不编 */
  changePct: number | null;
  /**
   * 风险观察标签（2026-10-21 加；只标注观察、攒样本，不拦截不降权）。
   * 只写确认命中的标签名（如 ["放量冲高回落"]）；没命中 / 没算（手动计入）不写这个字段。
   * 判定口径见 pick-risk-tags-core.ts；旧版本文件没有这个字段，不回改。
   */
  riskTags?: string[];
  /**
   * 排雷盖章（2026-10-24 加；只标注不拦截、不剔除、不重排）：riskStampOf 出的章。
   * 只在服务端自动优选且盖章算出时写；手动计入 / 没算 → 不写这个字段。
   */
  stamp?: RiskStamp;
  /** 盖章原因（如 ["温度 2 项热（过热）"]、["位置红格（历史胜率 <48%）"]）；合格 → 空数组。随 stamp 一起写。 */
  stampReasons?: string[];
}

export interface AiPickVersion {
  /** 决策日（选股日），如 2026-10-15 */
  tradeDate: string;
  /** 运行时间戳（北京时间 "YYYY-MM-DD HH:MM:SS"） */
  runAt: string;
  /** 本版选出的票（精简：只记票 + 当时涨跌幅） */
  picks: AiPickVersionPick[];
  /** 来源说明（可选）：如 "auto"（服务端自动）/ "manual"（手动计入）/ "backfill"（回补） */
  source?: string;
  /** 回补时的口径说明（可选）：如回补的 runAt 来源 */
  note?: string;
}

const VERSIONS_DIR = path.join(process.cwd(), "data", "ai-pick-versions");

function stampToFilePart(runAt: string): string {
  // "2026-10-16 07:09:10" → "070910"
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(runAt.trim());
  if (!m) return runAt.replace(/[^0-9]/g, "").slice(0, 14) || "00000000";
  return `${m[2]}${m[3]}${m[4]}`;
}

function fileOf(tradeDate: string, runAt: string, suffix = ""): string {
  return path.join(VERSIONS_DIR, `${tradeDate}-${stampToFilePart(runAt)}${suffix}.json`);
}

/** 追加一版（绝不覆盖：同秒已有文件则加 -2/-3 后缀）。返回写出的文件路径。 */
export async function appendAiPickVersion(
  version: AiPickVersion,
  dir: string = VERSIONS_DIR,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const base = `${version.tradeDate}-${stampToFilePart(version.runAt)}`;
  let file = path.join(dir, `${base}.json`);
  let n = 2;
  while (true) {
    try {
      await fs.access(file);
      file = path.join(dir, `${base}-${n}.json`);
      n++;
    } catch {
      break; // 不存在 → 可以写
    }
  }
  await fs.writeFile(file, JSON.stringify(version, null, 2), "utf-8");
  return file;
}

/** 读某决策日的所有版本（按 runAt 升序 = 第1版、第2版……）。没有返回 []。 */
export async function listAiPickVersions(
  tradeDate: string,
  dir: string = VERSIONS_DIR,
): Promise<AiPickVersion[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: AiPickVersion[] = [];
  for (const name of names) {
    if (!name.startsWith(`${tradeDate}-`) || !name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")) as AiPickVersion;
      if (parsed?.tradeDate === tradeDate && Array.isArray(parsed.picks)) out.push(parsed);
    } catch {
      // 坏文件跳过，不阻塞
    }
  }
  out.sort((a, b) => a.runAt.localeCompare(b.runAt));
  return out;
}

/** 读某决策日的最新一版（runAt 最大）；没有返回 null。 */
export async function latestAiPickVersion(
  tradeDate: string,
  dir: string = VERSIONS_DIR,
): Promise<AiPickVersion | null> {
  const list = await listAiPickVersions(tradeDate, dir);
  return list.length ? list[list.length - 1] : null;
}

/**
 * 读全部决策日的所有版本（按 tradeDate、runAt 升序）。
 * 用途：找“卖出日 = 某天”的版本（快照票池 / 分版胜率），不能只看最近一个决策日。
 */
export async function listAllAiPickVersions(
  dir: string = VERSIONS_DIR,
): Promise<AiPickVersion[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: AiPickVersion[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")) as AiPickVersion;
      if (parsed?.tradeDate && Array.isArray(parsed.picks)) out.push(parsed);
    } catch {
      // 坏文件跳过，不阻塞
    }
  }
  out.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.runAt.localeCompare(b.runAt));
  return out;
}

/** 某决策日所有版本票的并集（去重，符号归一为大写 000001.SH 形式）。 */
export async function aiPickVersionUnionSymbols(
  tradeDate: string,
  dir: string = VERSIONS_DIR,
): Promise<{ symbol: string; name: string }[]> {
  const versions = await listAiPickVersions(tradeDate, dir);
  const map = new Map<string, { symbol: string; name: string }>();
  for (const v of versions) {
    for (const p of v.picks) {
      const symbol = String(p.symbol || "").trim().toUpperCase();
      if (!symbol) continue;
      if (!map.has(symbol)) map.set(symbol, { symbol, name: p.name || symbol });
    }
  }
  return [...map.values()];
}

/**
 * 快照票池用的决策日：今天（上海日期）之前、最近一个有 AI 优选版本的决策日。
 * 快照是在“第二天”验证“第一天”的版本——今天拍的快照要含昨天版本的票，
 * 不能含今天刚生成的版本（今天的版本是今天收盘后才定的，验证日是明天）。
 * 没有任何版本时返回 null，调用方回退到 StrategyPick 最新行。
 */
export async function latestVersionDecisionDateBefore(
  today: string,
  dir: string = VERSIONS_DIR,
): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  let best: string | null = null;
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})-\d{6}(-\d+)?\.json$/.exec(name);
    if (!m) continue;
    const d = m[1];
    if (d < today && (best == null || d > best)) best = d;
  }
  return best;
}
