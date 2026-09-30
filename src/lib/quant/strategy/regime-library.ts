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
import type { RegimeRow, RegimeStat } from "./regime-core.ts";
import { pctWithCI } from "@/lib/quant/factors/wilson-core";

const FILE = path.join(process.cwd(), "data", "strategy-regime.json");

export interface RegimeRankItem {
  id: number;
  name: string;
  stat: RegimeStat;
  win1: number;
  n1: number;
  /** 这条是按什么排上来的（「扣费后 · 样本外 N=xxx」），页面直接显示 */
  basis?: string;
}

export interface RegimeFile {
  generatedAt: string | null;
  builtAt: string;
  source: string;
  window: { universe: number; bars: number; note: string; from?: string; to?: string };
  regimeMethod: string;
  thresholds: { minHits: number; minTotal: number; note: string };
  /** P36-B：口径说明（成交价/成本/时间切分），页面上每个数字旁都要按它标口径 */
  basis?: {
    entry?: string;
    exit?: string;
    cost?: string;
    costAdjusted?: boolean;
    untradeable?: string;
    split?: string;
    caveat?: string;
  };
  /** 三档排序的实际依据：「样本外」或「全期」 */
  rankBasis?: string;
  counts: { rows: number; 强势: number; 震荡: number; 弱势: number; [k: string]: number };
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
    // P1（2026-09-30）：胜率的 Wilson 95% CI 在加载层派生（数据文件不带，刻度只有一处）。
    // 点估计不许当真值卖——样本小的策略区间会宽，模型/页面转述必须带区间。
    enrichWinCi(raw);
    cache = raw;
    cacheMtimeMs = st.mtimeMs;
    return cache;
  } catch {
    return null;
  }
}

function enrichWinCi(raw: RegimeFile): void {
  for (const row of raw.rows) {
    for (const k of ["强势", "震荡", "弱势"] as const) {
      const s = row[k];
      if (s && s.winCi == null) s.winCi = pctWithCI(s.win, s.n);
    }
  }
  for (const key of ["强势", "震荡", "弱势"] as const) {
    for (const item of raw.rank?.[key] ?? []) {
      if (item.stat && item.stat.winCi == null) item.stat.winCi = pctWithCI(item.stat.win, item.stat.n);
    }
  }
}

/** 只取 rows（排名在调用方用纯核算，保证口径只有一处） */
export function regimeRows(): RegimeRow[] {
  return regimeLibrary()?.rows ?? [];
}
