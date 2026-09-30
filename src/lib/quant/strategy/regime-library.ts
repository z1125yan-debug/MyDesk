// 分档回测榜（服务端只读）：data/strategy-regime.json
//
// 与 strategy-library 同一套读法（mtime 缓存、读失败返回空而不是抛），
// 区别只有一点：这份是**回测成绩**，不是策略条件本身，
// 所以它只回答「历史上这个档位哪几条策略表现好」，不参与筛选条件装配。
//
// 纪律：
// 1) 只读本地文件，不发上游请求；
// 2) 文件缺失/损坏 → 返回空榜（regimeRank 拿到空数组 → 页面如实说「回测榜没读到」），
//    绝不用赞/踩排序冒充回测排名（那是两件事，混了就等于拿 popularity 当 edge）。

import fs from "fs";
import path from "path";
import type { RegimeRow } from "./regime-core.ts";

const FILE = path.join(process.cwd(), "data", "strategy-regime.json");

export interface RegimeRankItem {
  id: number;
  name: string;
  stat: { n: number; win: number; avg: number; avg5: number };
  win1: number;
  n1: number;
}

export interface RegimeFile {
  generatedAt: string | null;
  builtAt: string;
  source: string;
  window: { universe: number; bars: number; note: string };
  regimeMethod: string;
  thresholds: { minHits: number; minTotal: number; note: string };
  counts: { rows: number; 强势: number; 震荡: number; 弱势: number };
  rank: { 强势?: RegimeRankItem[]; 震荡?: RegimeRankItem[]; 弱势?: RegimeRankItem[] };
  rows: RegimeRow[];
}

let cache: RegimeFile | null = null;
let cacheMtimeMs = -1;

export function regimeLibrary(): RegimeFile | null {
  try {
    if (!fs.existsSync(FILE)) return null;
    const st = fs.statSync(FILE);
    if (cache && st.mtimeMs === cacheMtimeMs) return cache;
    const raw = JSON.parse(fs.readFileSync(FILE, "utf-8")) as RegimeFile;
    if (!raw || !Array.isArray(raw.rows)) return null;
    cache = raw;
    cacheMtimeMs = st.mtimeMs;
    return cache;
  } catch {
    return null;
  }
}

/** 只取 rows（排名在调用方用纯核算，保证口径只有一处） */
export function regimeRows(): RegimeRow[] {
  return regimeLibrary()?.rows ?? [];
}
